/**
 * Per-user store for the Oracle bot.
 *
 * Persists to ~/.nansen-oracle/users.json so subscribers survive bot restarts.
 * Each entry keyed by the user's Veil DID.
 *
 * Nansen API keys are encrypted at rest using AES-256-GCM.
 * The encryption key is derived from the bot's veilSigningKey (never stored here).
 * Encrypted values are stored as "ek:<iv>:<tag>:<ciphertext>" (all base64).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const STORE_FILE = path.join(os.homedir(), '.nansen-oracle', 'users.json');
const ENC_PREFIX = 'ek:';

export interface UserPrefs {
  flows: boolean;
  trades: boolean;
  screener: boolean;
}

export const DEFAULT_PREFS: UserPrefs = { flows: true, trades: true, screener: true };

export interface UserRecord {
  nansenKey: string;    // plaintext in memory, encrypted on disk
  subscribedAt: string; // ISO timestamp
  defaultChains: string[];
  prefs?: UserPrefs;
}

// On-disk format — nansenKey stored encrypted
interface StoredRecord {
  nansenKey: string;    // "ek:<iv>:<tag>:<ciphertext>" or legacy plaintext
  subscribedAt: string;
  defaultChains: string[];
  prefs?: UserPrefs;
}

type UserStore = Record<string, StoredRecord>;

// ── Encryption ────────────────────────────────────────────────────────────────

function deriveKey(secret: string): Buffer {
  // HKDF-style: SHA-256 of the secret → 32-byte AES key
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptKey(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptKey(stored: string, secret: string): string | null {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext fallback
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  try {
    const [ivB64, tagB64, encB64] = parts;
    const key = deriveKey(secret);
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const enc = Buffer.from(encB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

function load(): UserStore {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as UserStore;
  } catch {
    return {};
  }
}

function save(store: UserStore): void {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getUser(did: string, encryptionSecret: string): UserRecord | null {
  const store = load();
  const rec = store[did];
  if (!rec) return null;
  const nansenKey = decryptKey(rec.nansenKey, encryptionSecret);
  if (nansenKey === null) {
    console.error(`  ⚠  Could not decrypt Nansen key for ${did} — treating as unregistered`);
    return null;
  }
  return { ...rec, nansenKey };
}

export function setUser(did: string, record: UserRecord, encryptionSecret: string): void {
  const store = load();
  store[did] = {
    ...record,
    nansenKey: encryptKey(record.nansenKey, encryptionSecret),
  };
  save(store);
}

export function removeUser(did: string): void {
  const store = load();
  delete store[did];
  save(store);
}

export function getAllUsers(encryptionSecret: string): Array<{ did: string; record: UserRecord }> {
  const store = load();
  const results: Array<{ did: string; record: UserRecord }> = [];
  for (const [did, rec] of Object.entries(store)) {
    const nansenKey = decryptKey(rec.nansenKey, encryptionSecret);
    if (nansenKey === null) {
      console.error(`  ⚠  Could not decrypt Nansen key for ${did} — skipping subscriber`);
      continue;
    }
    results.push({ did, record: { ...rec, nansenKey } });
  }
  return results;
}
