import fs from 'fs';
import os from 'os';
import path from 'path';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

const CONFIG_DIR = path.join(os.homedir(), '.nansen-oracle');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface ChannelConfig {
  id: string;
  name: string;
  gateToken?: string;
  gateMinBalance?: number;
  watchlist?: string[];
  alertThreshold?: number;
}

export interface WatchItem {
  type: 'token' | 'wallet';
  address: string;
  label?: string;
  threshold?: number;
  chain: string;
}

export interface OracleConfig {
  nansenApiKey: string;
  veilSigningKey: string;
  veilEncryptionKey: string;
  veilDid: string;
  veilAgentKey?: string;
  channels: ChannelConfig[];
  watchlist: WatchItem[];
  defaultChains: string[];
}

function isValidBase64Key(s: unknown, expectedBytes: number): boolean {
  if (typeof s !== 'string' || !s) return false;
  try {
    const bytes = decodeBase64(s);
    return bytes.length === expectedBytes;
  } catch {
    return false;
  }
}

function isValidDid(s: unknown): boolean {
  return typeof s === 'string' && s.startsWith('did:voidly:') && s.length > 15;
}

export function validateConfig(raw: unknown): { valid: boolean; repaired: OracleConfig | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, repaired: null, warnings: ['Config is not a valid JSON object'] };
  }
  const c = raw as Record<string, unknown>;

  // Check critical key material — can't repair these
  if (!isValidBase64Key(c.veilSigningKey, 64)) {
    return { valid: false, repaired: null, warnings: ['veilSigningKey is missing or invalid (must be 64-byte base64 Ed25519 secret key)'] };
  }
  if (!isValidBase64Key(c.veilEncryptionKey, 32)) {
    return { valid: false, repaired: null, warnings: ['veilEncryptionKey is missing or invalid (must be 32-byte base64 X25519 secret key)'] };
  }
  if (!isValidDid(c.veilDid)) {
    return { valid: false, repaired: null, warnings: ['veilDid is missing or invalid (must be did:voidly:... format)'] };
  }

  // Repair optional/restorable fields
  const repaired: OracleConfig = {
    nansenApiKey: typeof c.nansenApiKey === 'string' ? c.nansenApiKey : '',
    veilSigningKey: c.veilSigningKey as string,
    veilEncryptionKey: c.veilEncryptionKey as string,
    veilDid: c.veilDid as string,
    veilAgentKey: typeof c.veilAgentKey === 'string' ? c.veilAgentKey : undefined,
    channels: [],
    watchlist: [],
    defaultChains: ['ethereum', 'base', 'solana'],
  };

  if (Array.isArray(c.channels)) {
    repaired.channels = c.channels.filter(
      ch => ch && typeof ch === 'object' && typeof (ch as Record<string,unknown>).id === 'string',
    ) as ChannelConfig[];
    if (repaired.channels.length < c.channels.length) {
      warnings.push(`Dropped ${c.channels.length - repaired.channels.length} malformed channel entries`);
    }
  } else if (c.channels !== undefined) {
    warnings.push('channels field was not an array — reset to []');
  }

  if (Array.isArray(c.watchlist)) {
    repaired.watchlist = c.watchlist.filter(
      w => w && typeof w === 'object' && typeof (w as Record<string,unknown>).address === 'string',
    ) as WatchItem[];
    if (repaired.watchlist.length < c.watchlist.length) {
      warnings.push(`Dropped ${c.watchlist.length - repaired.watchlist.length} malformed watchlist entries`);
    }
  } else if (c.watchlist !== undefined) {
    warnings.push('watchlist field was not an array — reset to []');
  }

  if (Array.isArray(c.defaultChains) && c.defaultChains.every(x => typeof x === 'string')) {
    repaired.defaultChains = c.defaultChains as string[];
  }

  return { valid: true, repaired, warnings };
}

export function loadConfig(): OracleConfig | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    console.error(`  ⚠  Config file is corrupted (bad JSON): ${CONFIG_FILE}`);
    console.error('  Run: nansen-oracle reset   to generate a new identity');
    console.error('  Your channels/watchlist cannot be recovered from a corrupted file.\n');
    return null;
  }

  const { valid, repaired, warnings } = validateConfig(raw);

  if (!valid) {
    const msg = warnings[0] || 'unknown validation error';
    console.error(`  ⚠  Config is invalid: ${msg}`);
    console.error(`  File: ${CONFIG_FILE}`);
    console.error('  Run: nansen-oracle reset   to generate a new identity\n');
    return null;
  }

  if (warnings.length) {
    for (const w of warnings) {
      console.error(`  ⚠  Config warning: ${w}`);
    }
    // Auto-save the repaired version
    saveConfig(repaired!);
  }

  return repaired;
}

export function saveConfig(config: OracleConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function generateVeilKeys(): { signingKey: string; encryptionKey: string; did: string } {
  const signingPair = nacl.sign.keyPair();
  const encryptionPair = nacl.box.keyPair();

  // DID = did:voidly:{base58 of first 16 bytes of signing pubkey}
  const pubkeyBytes = signingPair.publicKey.slice(0, 16);
  const did = `did:voidly:${toBase58(pubkeyBytes)}`;

  return {
    signingKey: encodeBase64(signingPair.secretKey),
    encryptionKey: encodeBase64(encryptionPair.secretKey),
    did,
  };
}

function toBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }
  let result = '';
  while (num > BigInt(0)) {
    result = ALPHABET[Number(num % BigInt(58))] + result;
    num = num / BigInt(58);
  }
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result;
}

export function getNansenKey(): string {
  const key = process.env.NANSEN_API_KEY || loadConfig()?.nansenApiKey;
  if (!key) {
    console.error('No Nansen API key found. Set NANSEN_API_KEY env var or run: nansen-oracle init');
    process.exit(1);
  }
  return key;
}

export async function ensureConfig(): Promise<OracleConfig> {
  let config = loadConfig();
  if (config) return config;

  // First run — generate Veil identity silently
  const keys = generateVeilKeys();
  const nansenApiKey = process.env.NANSEN_API_KEY || '';

  config = {
    nansenApiKey,
    veilSigningKey: keys.signingKey,
    veilEncryptionKey: keys.encryptionKey,
    veilDid: keys.did,
    channels: [],
    watchlist: [],
    defaultChains: ['ethereum', 'base', 'solana'],
  };

  saveConfig(config);
  return config;
}
