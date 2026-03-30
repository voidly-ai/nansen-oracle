import { OracleConfig, saveConfig, generateVeilKeys } from './config.js';

const RELAY = 'https://api.voidly.ai';

// Cache of DID → encryption public key to avoid repeated lookups
const pubKeyCache = new Map<string, string>();

export class VeilClient {
  private config: OracleConfig;
  private agentKey: string | null = null;

  constructor(config: OracleConfig) {
    this.config = config;
  }

  // ── Registration ─────────────────────────────────────────────────────────

  async register(): Promise<string> {
    if (this.agentKey) return this.config.veilDid;
    if (this.config.veilAgentKey) {
      this.agentKey = this.config.veilAgentKey;
      return this.config.veilDid;
    }
    return this._doRegister(false);
  }

  private async _doRegister(forceNewKeys: boolean): Promise<string> {
    const nacl = await import('tweetnacl');
    const { encodeBase64, decodeBase64 } = await import('tweetnacl-util');

    if (forceNewKeys) {
      const keys = generateVeilKeys();
      this.config.veilSigningKey = keys.signingKey;
      this.config.veilEncryptionKey = keys.encryptionKey;
      this.config.veilDid = keys.did;
      this.config.veilAgentKey = undefined;
      saveConfig(this.config);
    }

    const signingSecret = decodeBase64(this.config.veilSigningKey);
    const signingPair = nacl.sign.keyPair.fromSecretKey(signingSecret);
    const encSecret = decodeBase64(this.config.veilEncryptionKey);
    const encPair = nacl.box.keyPair.fromSecretKey(encSecret);

    let res: Response;
    try {
      res = await fetch(`${RELAY}/v1/agent/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `nansen-oracle-${Date.now().toString(36)}`,
          bio: 'Smart money signals via Nansen Oracle',
          signing_public_key: encodeBase64(signingPair.publicKey),
          encryption_public_key: encodeBase64(encPair.publicKey),
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: unknown) {
      throw new Error(`Veil relay unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 409 = DID collision — regenerate fresh identity and retry once
    if (res.status === 409 && !forceNewKeys) {
      return this._doRegister(true);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Veil register failed: ${res.status}${body ? ' — ' + body.slice(0, 100) : ''}`);
    }

    // Relay returns { did, api_key, ... } — api_key shown only once, must save it
    const data = await res.json() as { api_key?: string; did?: string };
    if (data.api_key) {
      this.agentKey = data.api_key;
      this.config.veilAgentKey = data.api_key;
      this.config.veilDid = data.did || this.config.veilDid;
      saveConfig(this.config);
    }
    return this.config.veilDid;
  }

  private getKey(): string {
    return this.agentKey || this.config.veilAgentKey || '';
  }

  // ── Encryption helpers ────────────────────────────────────────────────────

  // Fetch a DID's encryption public key (cached)
  private async getRecipientEncKey(did: string): Promise<Uint8Array> {
    const { decodeBase64 } = await import('tweetnacl-util');

    const cached = pubKeyCache.get(did);
    if (cached) return decodeBase64(cached);

    // Do NOT encode colons — the relay route regex expects literal did:voidly:...
    const res = await fetch(`${RELAY}/v1/agent/identity/${did}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Cannot fetch identity for ${did}: ${res.status}`);
    const data = await res.json() as { encryption_public_key?: string };
    if (!data.encryption_public_key) throw new Error(`No encryption key for ${did}`);

    pubKeyCache.set(did, data.encryption_public_key);
    return decodeBase64(data.encryption_public_key);
  }

  // Encrypt a plaintext message for a recipient using NaCl box
  private async encryptForRecipient(plaintext: string, recipientDid: string): Promise<{
    ciphertext: string; nonce: string; signature: string;
  }> {
    const nacl = await import('tweetnacl');
    const { encodeBase64, decodeBase64 } = await import('tweetnacl-util');

    const recipientEncPub = await this.getRecipientEncKey(recipientDid);
    const ourEncSecret = decodeBase64(this.config.veilEncryptionKey);
    const ourSignSecret = decodeBase64(this.config.veilSigningKey);

    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const messageBytes = new TextEncoder().encode(plaintext);
    const ciphertext = nacl.box(messageBytes, nonce, recipientEncPub, ourEncSecret);

    if (!ciphertext) throw new Error('Encryption failed');

    const signature = nacl.sign.detached(ciphertext, ourSignSecret);

    return {
      ciphertext: encodeBase64(ciphertext),
      nonce: encodeBase64(nonce),
      signature: encodeBase64(signature),
    };
  }

  // Decrypt a message envelope received via /v1/agent/receive/raw
  private async decryptEnvelope(envelope: {
    ciphertext: string; nonce: string; sender_encryption_key?: string;
  }): Promise<string | null> {
    try {
      const nacl = await import('tweetnacl');
      const { decodeBase64 } = await import('tweetnacl-util');

      if (!envelope.ciphertext || !envelope.nonce || !envelope.sender_encryption_key) return null;

      const ciphertext = decodeBase64(envelope.ciphertext);
      const nonce = decodeBase64(envelope.nonce);
      const senderEncPub = decodeBase64(envelope.sender_encryption_key);
      const ourEncSecret = decodeBase64(this.config.veilEncryptionKey);

      const plaintext = nacl.box.open(ciphertext, nonce, senderEncPub, ourEncSecret);
      if (!plaintext) return null;

      return new TextDecoder().decode(plaintext);
    } catch {
      return null;
    }
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  // Send an E2E encrypted DM (client-side NaCl box)
  async sendDM(toDid: string, plaintext: string): Promise<void> {
    const key = this.getKey();
    if (!key) throw new Error('Not registered. Call register() first.');

    const { ciphertext, nonce, signature } = await this.encryptForRecipient(plaintext, toDid);

    const res = await fetch(`${RELAY}/v1/agent/send/encrypted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
      body: JSON.stringify({ to: toDid, ciphertext, nonce, signature }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`sendDM failed: ${res.status}${body ? ' — ' + body.slice(0, 120) : ''}`);
    }
  }

  // Fetch and decrypt messages from relay inbox (raw E2E mode)
  async fetchMessages(): Promise<Array<{ id: string; from_did: string; content: string }>> {
    const key = this.getKey();
    if (!key) return [];

    try {
      const res = await fetch(`${RELAY}/v1/agent/receive/raw`, {
        headers: { 'X-Agent-Key': key },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];

      const data = await res.json() as {
        messages?: Array<{
          id: string; from: string; ciphertext: string; nonce: string;
          sender_encryption_key?: string; signature?: string;
        }>;
      };

      const messages: Array<{ id: string; from_did: string; content: string }> = [];
      for (const msg of data.messages || []) {
        const content = await this.decryptEnvelope({
          ciphertext: msg.ciphertext,
          nonce: msg.nonce,
          sender_encryption_key: msg.sender_encryption_key,
        });
        if (content !== null) {
          messages.push({ id: msg.id, from_did: msg.from, content });
        } else {
          // Undecryptable — mark read so it doesn't re-appear on every poll
          await this.markRead(msg.id).catch(() => {});
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  // Mark a message as read
  async markRead(messageId: string): Promise<void> {
    const key = this.getKey();
    await fetch(`${RELAY}/v1/agent/messages/${messageId}/read`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key },
    }).catch(() => {});
  }

  // Post a plaintext message to a channel
  // (channel encrypts server-side with its own key — different from DM flow)
  async postToChannel(channelId: string, content: string): Promise<void> {
    const key = this.getKey();
    const res = await fetch(`${RELAY}/v1/agent/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
      body: JSON.stringify({ message: content }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`postToChannel failed: ${res.status}${body ? ' — ' + body.slice(0, 100) : ''}`);
    }
  }

  // Create a channel — name is slugified automatically
  async createChannel(displayName: string, description: string): Promise<{ id: string; name: string; displayName: string }> {
    const key = this.getKey();
    const slug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      || `ch-${Date.now().toString(36)}`;

    const name = slug.length < 3 ? slug + '-ch' : slug;

    const res = await fetch(`${RELAY}/v1/agent/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
      body: JSON.stringify({ name, description: description.slice(0, 256), is_private: true }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 409) throw new Error(`Channel slug "${name}" already taken. Try a different name.`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Create channel failed: ${res.status}${body ? ' — ' + body : ''}`);
    }
    const data = await res.json() as { id: string; name: string };
    return { ...data, displayName };
  }

  // Invite another DID to a channel
  async inviteToChannel(channelId: string, targetDid: string): Promise<void> {
    const key = this.getKey();
    const res = await fetch(`${RELAY}/v1/agent/channels/${channelId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
      body: JSON.stringify({ invitee_did: targetDid }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Invite failed: ${res.status}${body ? ' — ' + body.slice(0, 100) : ''}`);
    }
  }

  // List channels the agent is in
  async listChannels(): Promise<Array<{ id: string; name: string; topic: string; member_count: number }>> {
    const key = this.getKey();
    try {
      const res = await fetch(`${RELAY}/v1/agent/channels?mine=true`, {
        headers: { 'X-Agent-Key': key },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { channels?: Array<{ id: string; name: string; topic: string; member_count: number }> };
      return data.channels || [];
    } catch {
      return [];
    }
  }

  getDid(): string { return this.config.veilDid; }
  getAgentKey(): string { return this.getKey(); }
  getJoinLink(channelId: string): string { return `https://msg.voidly.ai/join/${channelId}`; }
}
