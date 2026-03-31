/**
 * Nansen Oracle Bot
 *
 * A persistent agent on the Veil relay answering DM commands.
 * Uses the VoidlyAgent SDK (Double Ratchet) — compatible with msg.voidly.ai PWA.
 *
 * Setup flow:
 *   1. User DMs the bot (any message)
 *   2. Bot prompts for their Nansen API key
 *   3. User replies with key — bot validates it live against Nansen
 *   4. On success: stored, hourly digest starts immediately
 *
 * Commands (once set up):
 *   !alpha           — smart money digest
 *   !screen [chain]  — token screener
 *   !wallet <addr>   — wallet profile
 *   !flows <token>   — flow intelligence
 *   !join <ch> <wallet>  — token-gate check + invite
 *   !stop            — unsubscribe
 *   !help            — list commands
 *
 * Self-healing:
 *   - Exponential backoff on consecutive poll failures
 *   - Relay heartbeat every 5 minutes (keeps bot online/discoverable)
 *   - systemd Restart=always catches unrecoverable crashes
 */

import chalk from 'chalk';
import ora from 'ora';
import { VoidlyAgent } from '@voidly/agent-sdk';
import { NansenClient, normalizeSmartTrade, normalizeTgmTrade, normalizeProfilerTx, TradeEvent, TgmDexTrade } from '../nansen.js';
import { OracleConfig, saveConfig } from '../config.js';
import { buildAlphaDigest, formatUsd, shortAddr, DigestPrefs } from '../display.js';
import { checkGate } from '../commands/channel.js';
import { VALID_CHAINS } from '../commands/alpha.js';
import { getUser, setUser, removeUser, getAllUsers, UserRecord, UserPrefs, DEFAULT_PREFS } from './user-store.js';

const POLL_INTERVAL = 3000;         // 3 seconds between polls
const DIGEST_INTERVAL = 60 * 60 * 1000; // 1 hour between digests
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minute relay heartbeat
const MAX_BACKOFF_MS = 30_000;      // 30s max backoff on failures

// In-progress onboarding sessions — keyed by sender DID
type OnboardingState = 'awaiting_key';
const onboarding = new Map<string, OnboardingState>();

// Active digest intervals — keyed by subscriber DID
const digestIntervals = new Map<string, ReturnType<typeof setInterval>>();

// Per-user NansenClient cache — keyed by DID, NOT by API key
// (avoids holding plaintext keys as Map keys in memory)
const nansenClients = new Map<string, NansenClient>();

function timeAgo(ts: string): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (isNaN(diff)) return '';
  const mins = Math.floor(Math.abs(diff) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getNansenClient(did: string, apiKey: string): NansenClient {
  if (!nansenClients.has(did)) {
    nansenClients.set(did, new NansenClient(apiKey));
  }
  return nansenClients.get(did)!;
}

async function validateNansenKey(apiKey: string): Promise<'valid' | 'invalid' | 'error'> {
  try {
    const client = new NansenClient(apiKey);
    const result = await client.getSmartMoneyFlows(['ethereum'], 1);
    return Array.isArray(result) ? 'valid' : 'invalid';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('401') || msg.includes('Unauthorized')) return 'invalid';
    // 403 "Insufficient credits" = valid key, no quota — treat as error not invalid
    if (msg.includes('403') && !msg.includes('credits') && !msg.includes('quota') && !msg.includes('Credit')) return 'invalid';
    return 'error';
  }
}

/**
 * Register the bot's existing identity on the relay (or retrieve stored apiKey).
 * Handles first-run and cases where veilAgentKey was lost from config.
 */
async function getOrRegisterApiKey(config: OracleConfig): Promise<string> {
  if (config.veilAgentKey) return config.veilAgentKey;

  const nacl = await import('tweetnacl');
  const { encodeBase64, decodeBase64 } = await import('tweetnacl-util');

  const signingSecret = decodeBase64(config.veilSigningKey);
  const signingPair = nacl.sign.keyPair.fromSecretKey(signingSecret);
  const encSecret = decodeBase64(config.veilEncryptionKey);
  const encPair = nacl.box.keyPair.fromSecretKey(encSecret);

  const res = await fetch('https://api.voidly.ai/v1/agent/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'nansenbot',
      bio: 'Smart money signals via Nansen Oracle',
      signing_public_key: encodeBase64(signingPair.publicKey),
      encryption_public_key: encodeBase64(encPair.publicKey),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Veil register failed: ${res.status}${body ? ' — ' + body.slice(0, 100) : ''}`);
  }

  const data = await res.json() as { api_key?: string; did?: string };
  if (!data.api_key) throw new Error('Registration returned no api_key');

  config.veilAgentKey = data.api_key;
  if (data.did) config.veilDid = data.did;
  saveConfig(config);
  return data.api_key;
}

function startHourlyDigest(
  did: string,
  record: UserRecord,
  veil: VoidlyAgent,
): void {
  if (digestIntervals.has(did)) return; // already running

  const postDigest = async () => {
    try {
      const nansen = getNansenClient(did, record.nansenKey);
      const chains = record.defaultChains;
      const [flows, rawTrades, screener] = await Promise.all([
        nansen.getSmartMoneyFlows(chains, 8),
        nansen.getSmartMoneyDexTrades(chains, 8),
        nansen.screenTokens(chains, '1h', 8),
      ]);
      const trades = rawTrades.map(normalizeSmartTrade);
      const prefs: DigestPrefs = record.prefs ?? DEFAULT_PREFS;
      const digest = buildAlphaDigest(flows, trades, screener, '1h', prefs);
      await veil.send(did, digest);
      console.log(chalk.gray(`  [digest] Sent to ${shortAddr(did)} ${new Date().toLocaleTimeString()}`));
    } catch (err: unknown) {
      console.log(chalk.yellow(`  [digest] Failed for ${shortAddr(did)}: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  postDigest();
  const interval = setInterval(postDigest, DIGEST_INTERVAL);
  digestIntervals.set(did, interval);
}

function stopHourlyDigest(did: string): void {
  const interval = digestIntervals.get(did);
  if (interval) {
    clearInterval(interval);
    digestIntervals.delete(did);
  }
}

export async function startBot(config: OracleConfig, options: { channel?: string }): Promise<void> {
  console.log(chalk.cyan.bold('\n  🔱 NANSEN ORACLE BOT'));
  console.log(chalk.gray(`  DID:   ${config.veilDid}`));
  console.log(chalk.gray(`  Relay: https://api.voidly.ai`));

  const spinner = ora({ text: chalk.gray('Connecting to Veil relay...'), spinner: 'dots' }).start();

  let veil: VoidlyAgent;
  try {
    const apiKey = await getOrRegisterApiKey(config);
    veil = VoidlyAgent.fromCredentials({
      did: config.veilDid,
      apiKey,
      signingSecretKey: config.veilSigningKey,
      encryptionSecretKey: config.veilEncryptionKey,
    }, { baseUrl: 'https://api.voidly.ai' });
    spinner.succeed(chalk.green(`✔ Online — ${config.veilDid}`));
  } catch (err: unknown) {
    spinner.fail(chalk.red(`Connect failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const encSecret = config.veilSigningKey || '';

  // Resume hourly digests for existing subscribers
  const existing = getAllUsers(encSecret);
  if (existing.length > 0) {
    console.log(chalk.gray(`  Resuming ${existing.length} subscriber digest(s)...`));
    for (const { did, record } of existing) {
      startHourlyDigest(did, record, veil);
    }
  }

  // Optional channel feed (uses operator's own key)
  if (options.channel) {
    const apiKey = config.nansenApiKey || process.env.NANSEN_API_KEY || '';
    if (apiKey) {
      console.log(chalk.gray(`  Channel feed: ${options.channel} (hourly)`));
      startChannelFeed(options.channel, new NansenClient(apiKey), veil, config);
    }
  }

  console.log(chalk.gray('\n  Listening... DM the bot to get started.'));
  console.log(chalk.gray('  Ctrl+C to stop\n'));

  // ── Self-healing heartbeat ────────────────────────────────────────────────
  // Keeps the bot marked "online" on the relay and provides a health check
  setInterval(async () => {
    try {
      await veil.ping();
    } catch (err: unknown) {
      console.log(chalk.yellow(`  [heartbeat] Ping failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }, HEARTBEAT_INTERVAL);

  // ── Message polling loop ──────────────────────────────────────────────────
  const seen = new Set<string>();
  let polling = false;
  let consecutiveErrors = 0;

  const pollDMs = async () => {
    if (polling) return;
    polling = true;
    try {
      const messages = await veil.receive({ unreadOnly: true });
      consecutiveErrors = 0;

      for (const msg of messages) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);

        const fromDid = msg.from;

        // Skip self-messages (from bot's own DID)
        if (fromDid === config.veilDid) {
          await veil.markRead(msg.id).catch(() => {});
          continue;
        }

        const content = (msg.content || '').trim();

        // Redact log if user is mid-onboarding — message is their API key
        const isAwaitingKey = onboarding.get(fromDid) === 'awaiting_key';
        const logContent = isAwaitingKey ? '[key submission — redacted]' : content.slice(0, 60);
        console.log(chalk.gray(`  [${new Date().toLocaleTimeString()}] ${shortAddr(fromDid)}: ${logContent}`));

        const reply = await handleMessage(content, config, veil, fromDid, encSecret);
        if (reply) {
          await veil.send(fromDid, reply).catch((e: Error) => {
            console.log(chalk.yellow(`  [send] Failed to reply to ${shortAddr(fromDid)}: ${e.message}`));
          });
        }
        await veil.markRead(msg.id).catch(() => {});
      }

      if (seen.size > 2000) {
        const arr = [...seen];
        arr.slice(0, 1000).forEach(k => seen.delete(k));
      }
    } catch (err: unknown) {
      consecutiveErrors++;
      const backoff = Math.min(POLL_INTERVAL * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
      console.log(chalk.yellow(`  [poll] Error #${consecutiveErrors}: ${err instanceof Error ? err.message : String(err)} — retry in ${Math.round(backoff / 1000)}s`));
      if (consecutiveErrors >= 3) {
        await new Promise(r => setTimeout(r, backoff));
      }
    } finally {
      polling = false;
    }
  };

  const pollInterval = setInterval(async () => {
    try { await pollDMs(); } catch { /* outer safety net */ }
  }, POLL_INTERVAL);

  process.on('SIGINT', () => {
    clearInterval(pollInterval);
    for (const iv of digestIntervals.values()) clearInterval(iv);
    console.log(chalk.gray('\n  Bot stopped.'));
    process.exit(0);
  });

  try { await pollDMs(); } catch { /* ignore initial poll error */ }

  await new Promise(() => {});
}

async function handleMessage(
  content: string,
  config: OracleConfig,
  veil: VoidlyAgent,
  fromDid: string,
  encSecret: string,
): Promise<string> {
  // Ignore empty messages
  if (!content) return '';

  // ── Onboarding state machine ─────────────────────────────────────────────

  // If user is mid-onboarding and sends a non-command, treat as API key submission
  if (onboarding.get(fromDid) === 'awaiting_key' && !content.startsWith('!')) {
    const key = content.trim();
    if (key.length < 20) {
      return `❌ That's too short to be a Nansen API key (got ${key.length} chars, need ~32).\n\nGet it here: app.nansen.ai/account → API tab\n\nJust paste the key — nothing else.`;
    }

    const status = await validateNansenKey(key);
    if (status === 'invalid') {
      onboarding.set(fromDid, 'awaiting_key');
      return `❌ That key wasn't accepted by Nansen.\n\nDouble-check you copied the full key from:\napp.nansen.ai/account → API tab\n\nIt should be ~32 characters. Paste it again:`;
    }

    // Valid key or error (Nansen unreachable) — store and start digests
    const record: UserRecord = {
      nansenKey: key,
      subscribedAt: new Date().toISOString(),
      defaultChains: config.defaultChains,
    };
    setUser(fromDid, record, encSecret);
    onboarding.delete(fromDid);
    console.log(chalk.green(`  [onboard] ✓ ${shortAddr(fromDid)} subscribed${status === 'error' ? ' (key unverified — Nansen unreachable)' : ''}`));

    startHourlyDigest(fromDid, record, veil);

    if (status === 'error') {
      return `⚠️ Couldn't reach Nansen to verify your key — saved it anyway. If it's wrong, send !stop then re-subscribe.\n\nYou'll get your first digest shortly.`;
    }

    return `✅ You're subscribed!\n\nFirst digest coming right up — then hourly automatically.\n\n!alpha · !alpha 24h · !alpha 7d\n!screen · !token 0x · !flows 0x · !wallet 0x\n!set — customise your digest\n\n!stop to unsubscribe · !help for all commands`;
  }

  // ── Command routing ───────────────────────────────────────────────────────

  const user = getUser(fromDid, encSecret);

  // No Nansen key — trigger onboarding
  if (!user && !content.startsWith('!')) {
    onboarding.set(fromDid, 'awaiting_key');
    return ONBOARDING_PROMPT;
  }

  if (!content.startsWith('!')) {
    // Has a key, not a command — ignore
    return '';
  }

  const parts = content.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // Commands that work without a key
  if (cmd === '!help') return HELP_TEXT;
  if (cmd === '!start' || cmd === '!setup') {
    if (user) {
      return `You're already subscribed. Send !alpha for a digest or !stop to unsubscribe.`;
    }
    onboarding.set(fromDid, 'awaiting_key');
    return ONBOARDING_PROMPT;
  }

  // !stop with no stored key — clean up any pending onboarding state and confirm
  if (cmd === '!stop' && !user) {
    onboarding.delete(fromDid);
    stopHourlyDigest(fromDid);
    return `You're not currently subscribed. Send any message to get started.`;
  }

  // Commands that require a stored key
  if (!user) {
    onboarding.set(fromDid, 'awaiting_key');
    return `To use commands, you need a Nansen API key first.\n\n${ONBOARDING_PROMPT}`;
  }

  const nansen = getNansenClient(fromDid, user.nansenKey);

  try {
    switch (cmd) {
      case '!alpha': {
        const chains = user.defaultChains;
        const validAlphaTfs = ['1h', '24h', '7d'];
        const tfArg = parts[1]?.toLowerCase() || '1h';
        const alphaTf = validAlphaTfs.includes(tfArg) ? tfArg : '1h';
        const screenTf = alphaTf === '7d' ? '7d' : alphaTf === '24h' ? '24h' : '1h';
        const [flows, rawTrades, screener] = await Promise.all([
          nansen.getSmartMoneyFlows(chains, 8),
          nansen.getSmartMoneyDexTrades(chains, 8),
          nansen.screenTokens(chains, screenTf as '1h' | '24h' | '7d', 8),
        ]);
        const trades = rawTrades.map(normalizeSmartTrade);
        const prefs: DigestPrefs = user.prefs ?? DEFAULT_PREFS;
        return buildAlphaDigest(flows, trades, screener, alphaTf, prefs);
      }

      case '!screen': {
        const chainArg = parts[1];
        if (chainArg && !VALID_CHAINS.has(chainArg.toLowerCase())) {
          return `❌ Unknown chain: "${chainArg}"\nValid: ${[...VALID_CHAINS].join(', ')}`;
        }
        const chains = chainArg ? [chainArg.toLowerCase()] : user.defaultChains;
        const validFrames = ['5m', '1h', '6h', '24h', '7d'];
        const tfArg = parts[2] && validFrames.includes(parts[2]) ? parts[2] as '5m' | '1h' | '6h' | '24h' | '7d' : '1h';
        const tokens = await nansen.screenTokens(chains, tfArg, 10);
        const tf = tfArg.toUpperCase();
        const lines = [`🎯 SCREENER  ${tf}`];
        tokens.slice(0, 10).forEach((t, i) => {
          const flow     = t.netflow || 0;
          const abs      = Math.abs(flow);
          const absStr   = abs >= 1e9 ? `$${(abs / 1e9).toFixed(1)}B` : abs >= 1e6 ? `$${(abs / 1e6).toFixed(1)}M` : abs >= 1e3 ? `$${(abs / 1e3).toFixed(0)}K` : `$${abs.toFixed(0)}`;
          const sym      = (t.token_symbol || '?').slice(0, 8).padEnd(8);
          const flowStr  = ((flow >= 0 ? '+' : '-') + absStr).padEnd(10);
          const pct      = t.price_change != null ? ` ${t.price_change >= 0 ? '+' : ''}${t.price_change.toFixed(1)}%` : '';
          const bs       = `${t.nof_buyers || 0}b/${t.nof_sellers || 0}s`;
          const mcap     = t.market_cap_usd ? `  ${formatUsd(t.market_cap_usd)}` : '';
          lines.push(`#${i + 1} ${sym} ${flowStr}${pct}  ${bs}${mcap}`);
        });
        if (!tokens.length) lines.push('  No data');
        lines.push('', '!screen 24h · !token 0x · !flows 0x');
        return lines.join('\n');
      }

      case '!wallet': {
        const addr = parts[1];
        if (!addr || !addr.startsWith('0x') || addr.length !== 42) return '❌ Usage: !wallet <0x_address> [chain]';
        const chainArg = parts[2] ? parts[2].toLowerCase() : 'ethereum';
        if (parts[2] && !VALID_CHAINS.has(chainArg)) {
          return `❌ Unknown chain: "${parts[2]}"\nValid: ${[...VALID_CHAINS].join(', ')}`;
        }
        const chain = chainArg;
        const [balances, labels, rawTxs] = await Promise.all([
          nansen.getWalletBalances(addr, chain),
          nansen.getWalletLabels(addr, chain).catch(() => []),
          nansen.getWalletTransactions(addr, chain, 5).catch(() => []),
        ]);
        const walletTrades = rawTxs.map(normalizeProfilerTx);
        const labelStr = labels.map(l => l.label).join(' · ') || 'No labels';
        const topHoldings = balances
          .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0))
          .slice(0, 5);
        const lines: string[] = [
          `👛 ${shortAddr(addr)}`,
          labelStr,
          '',
          'HOLDINGS',
        ];
        if (topHoldings.length) {
          topHoldings.forEach(b => {
            const sym = (b.token_symbol || '?').slice(0, 8).padEnd(8);
            lines.push(`${sym}  ${formatUsd(b.value_usd || 0)}`);
          });
        } else {
          lines.push('  No holdings found');
        }
        lines.push('', 'RECENT TRADES');
        if (walletTrades.length) {
          walletTrades.slice(0, 5).forEach(t => {
            const action = t.action === 'BUY' ? 'BUY ' : 'SELL';
            const sym    = (t.token_in || '?').slice(0, 6).padEnd(6);
            lines.push(`${action}  ${sym}  ${formatUsd(t.value_usd || 0)}  ${timeAgo(t.timestamp)}`);
          });
        } else {
          lines.push('  No recent trades');
        }
        lines.push('', '!flows 0x · !token 0x');
        return lines.join('\n');
      }

      case '!flows': {
        const tokenAddr = parts[1];
        if (!tokenAddr || !tokenAddr.startsWith('0x') || tokenAddr.length !== 42) return '❌ Usage: !flows <0x_token_address> [chain]';
        const chainArg2 = parts[2] ? parts[2].toLowerCase() : 'ethereum';
        if (parts[2] && !VALID_CHAINS.has(chainArg2)) {
          return `❌ Unknown chain: "${parts[2]}"\nValid: ${[...VALID_CHAINS].join(', ')}`;
        }
        const chain = chainArg2;
        const [flowData, flowTokenInfo] = await Promise.all([
          nansen.getFlowIntelligence(chain, tokenAddr, '1d'),
          nansen.getTokenInfo(chain, tokenAddr, '1d'),
        ]);
        if (!flowData.length) return `❌ No flow data for ${shortAddr(tokenAddr)}`;
        const sym   = flowTokenInfo?.symbol || shortAddr(tokenAddr);
        const mcap  = flowTokenInfo ? `  ${formatUsd(flowTokenInfo.market_cap_usd || 0)} mcap` : '';
        const bsStr = flowTokenInfo
          ? `  ${flowTokenInfo.unique_buyers ?? 0}b/${flowTokenInfo.unique_sellers ?? 0}s 24h`
          : '';
        const lines: string[] = [
          `🌊 ${sym}${mcap}${bsStr}`,
          '',
        ];
        // Compute totals for NET/BUYS/SELLS
        let totalNet = 0, totalBuys = 0, totalSells = 0, totalWallets = 0;
        flowData.forEach(f => {
          totalNet += f.net_flow_usd || 0;
          totalWallets += f.wallet_count || 0;
        });
        const sign = totalNet >= 0 ? '+' : '-';
        lines.push(`NET    ${sign}${formatUsd(Math.abs(totalNet))}  24h`);
        // Show per-segment breakdown
        flowData.forEach(f => {
          const net  = f.net_flow_usd || 0;
          const s    = net >= 0 ? '+' : '-';
          const seg  = f.segment.slice(0, 12).padEnd(12);
          lines.push(`${seg}  ${s}${formatUsd(Math.abs(net))}  (${f.wallet_count}w)`);
        });
        lines.push('', '!token 0x · !wallet 0x');
        return lines.join('\n');
      }

      case '!token': {
        const tokenAddr = parts[1];
        if (!tokenAddr || !tokenAddr.startsWith('0x') || tokenAddr.length !== 42) {
          return '❌ Usage: !token <0x_token_address> [chain]';
        }
        const tokenChain = parts[2] ? parts[2].toLowerCase() : 'ethereum';
        if (parts[2] && !VALID_CHAINS.has(tokenChain)) {
          return `❌ Unknown chain: "${parts[2]}"\nValid: ${[...VALID_CHAINS].join(', ')}`;
        }
        const [tInfo, tFlows, rawTgmTrades] = await Promise.all([
          nansen.getTokenInfo(tokenChain, tokenAddr, '1d'),
          nansen.getFlowIntelligence(tokenChain, tokenAddr, '1d'),
          nansen.getTokenDexTrades(tokenChain, tokenAddr, true, 5).catch((): TgmDexTrade[] => []),
        ]);
        if (!tInfo) {
          return `❌ No data for ${shortAddr(tokenAddr)} on ${tokenChain}`;
        }
        const tgmTrades = rawTgmTrades.map(t => normalizeTgmTrade(t, tokenChain));
        const tokenLines: string[] = [
          `🔍 ${tInfo.symbol}`,
          `Mcap ${formatUsd(tInfo.market_cap_usd || 0)} · Vol ${formatUsd(tInfo.volume_total_usd || 0)}`,
          '',
          'SMART MONEY  24h',
          `Net     ${tInfo.unique_buyers ?? 0}b / ${tInfo.unique_sellers ?? 0}s`,
        ];
        if (tFlows.length) {
          tokenLines.push('', 'SEGMENT FLOWS');
          tFlows.forEach(f => {
            const net  = f.net_flow_usd || 0;
            const s    = net >= 0 ? '+' : '-';
            const seg  = f.segment.slice(0, 10).padEnd(10);
            tokenLines.push(`${seg}  ${s}${formatUsd(Math.abs(net))}  (${f.wallet_count}w)`);
          });
        }
        if (tgmTrades.length) {
          tokenLines.push('', 'TOP TRADES');
          tgmTrades.slice(0, 4).forEach(t => {
            const action = t.action === 'BUY' ? 'BUY ' : 'SELL';
            const label  = (t.trader_label && t.trader_label !== 'Smart Money'
              ? t.trader_label : shortAddr(t.trader_address)).slice(0, 12).padEnd(12);
            tokenLines.push(`${action}  ${label}  ${formatUsd(t.value_usd || 0)}  ${timeAgo(t.timestamp)}`);
          });
        }
        tokenLines.push('', '!flows 0x · !wallet 0x');
        return tokenLines.join('\n');
      }

      case '!set': {
        const prefs: UserPrefs = { ...(user.prefs ?? DEFAULT_PREFS) };
        const section = parts[1]?.toLowerCase();
        const toggle  = parts[2]?.toLowerCase();
        const SECTIONS = ['flows', 'trades', 'screener'] as const;
        type Section = typeof SECTIONS[number];

        if (!section) {
          return [
            '⚙️ DIGEST SETTINGS',
            '',
            `flows    ${prefs.flows    !== false ? '✅ on' : '⬜ off'}`,
            `trades   ${prefs.trades   !== false ? '✅ on' : '⬜ off'}`,
            `screener ${prefs.screener !== false ? '✅ on' : '⬜ off'}`,
            '',
            'Toggle: !set flows off · !set trades off · !set screener off',
          ].join('\n');
        }

        if (!SECTIONS.includes(section as Section)) {
          return `❌ Unknown section: "${section}"\nChoices: flows · trades · screener`;
        }
        if (toggle !== 'on' && toggle !== 'off') {
          return `❌ Usage: !set ${section} on|off`;
        }

        prefs[section as Section] = toggle === 'on';
        const updatedUser: UserRecord = { ...user, prefs };
        setUser(fromDid, updatedUser, encSecret);
        return `✅ ${section} ${toggle === 'on' ? 'enabled' : 'disabled'}\n\nSend !set to see all settings.`;
      }

      case '!join': {
        const channelId = parts[1];
        const walletAddr = parts[2];
        if (!channelId || !walletAddr) return '❌ Usage: !join <channel_id> <wallet_address>';
        if (!walletAddr.startsWith('0x') || walletAddr.length !== 42) return '❌ wallet_address must be 42 chars (0x...)';

        const ch = (config.channels || []).find(c => c.id === channelId);
        if (!ch) return `❌ Channel not found: ${channelId}`;

        if (!ch.gateToken) {
          await veil.inviteToChannel(channelId, fromDid);
          return `✅ Invited to "${ch.name}"\nJoin: https://msg.voidly.ai/join/${channelId}`;
        }

        const allowed = await checkGate(channelId, walletAddr, config);
        if (allowed) {
          await veil.inviteToChannel(channelId, fromDid);
          return `✅ Balance verified. Invited to "${ch.name}"\nJoin: https://msg.voidly.ai/join/${channelId}`;
        }
        return `🔒 Access denied. Need ${ch.gateMinBalance} of token ${ch.gateToken.slice(0, 10)}...`;
      }

      case '!stop': {
        stopHourlyDigest(fromDid);
        nansenClients.delete(fromDid); // evict cached client (keyed by DID, not key)
        removeUser(fromDid);
        onboarding.delete(fromDid);
        console.log(chalk.gray(`  [unsub] ${shortAddr(fromDid)}`));
        return `✅ Unsubscribed. Your key has been deleted.\n\nSend any message to re-subscribe.`;
      }

      default:
        return `❓ Unknown command: ${cmd}\n\n${HELP_TEXT}`;
    }
  } catch (err: unknown) {
    return `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function startChannelFeed(
  channelId: string,
  nansen: NansenClient,
  veil: VoidlyAgent,
  config: OracleConfig,
): void {
  const postDigest = async () => {
    try {
      const [flows, rawTrades, screener] = await Promise.all([
        nansen.getSmartMoneyFlows(config.defaultChains, 8),
        nansen.getSmartMoneyDexTrades(config.defaultChains, 5),
        nansen.screenTokens(config.defaultChains, '1h', 8),
      ]);
      const trades = rawTrades.map(normalizeSmartTrade);
      const digest = buildAlphaDigest(flows, trades, screener);
      await veil.postToChannel(channelId, digest);
      console.log(chalk.gray(`  [feed] Posted ${new Date().toLocaleTimeString()}`));
    } catch (err: unknown) {
      console.log(chalk.yellow(`  [feed] Failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  postDigest();
  setInterval(postDigest, DIGEST_INTERVAL);
}

const ONBOARDING_PROMPT = `To get started, paste your Nansen API key.

Get it here: app.nansen.ai/account → API tab
It looks like: abc123XY... (32 characters)

Just paste the key — nothing else.`;

const HELP_TEXT = `🔱 NANSEN ORACLE — COMMANDS

!alpha [tf]
  Smart money digest: flows, trades, screener.
  tf: 1h (default) · 24h · 7d

!screen [chain] [tf]
  Token screener by smart money inflow.
  Price change, buyers/sellers, mcap.

!token <0x...> [chain]
  Token deep dive: mcap, volume, segment
  flows, top smart trades.

!wallet <0x...> [chain]
  Labels, holdings, recent trades.

!flows <0x...> [chain]
  Flow breakdown by segment for any token.

!set [section] [on|off]
  Customise your !alpha digest.
  Sections: flows · trades · screener
  (no args = show current settings)

!setup / !start
  Connect your Nansen API key.

!stop
  Unsubscribe and delete your key.

!help
  This message.

Hourly digest starts automatically.
msg.voidly.ai`;
