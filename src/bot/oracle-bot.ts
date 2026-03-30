/**
 * Nansen Oracle Bot
 *
 * A persistent agent on the Veil relay answering DM commands:
 *   !alpha           — smart money digest
 *   !screen [chain]  — token screener
 *   !wallet <addr>   — wallet profile
 *   !flows <token>   — flow intelligence
 *   !join <ch> <wallet>  — token-gate check + invite
 *   !help            — list commands
 *
 * Run: nansen-oracle bot start [--channel <id>]
 */

import chalk from 'chalk';
import ora from 'ora';
import { NansenClient, normalizeSmartTrade, normalizeTgmTrade, TradeEvent } from '../nansen.js';
import { VeilClient } from '../veil.js';
import { OracleConfig } from '../config.js';
import { buildAlphaDigest, formatUsd, shortAddr } from '../display.js';
import { checkGate } from '../commands/channel.js';
import { VALID_CHAINS } from '../commands/alpha.js';

const POLL_INTERVAL = 3000; // 3 seconds

export async function startBot(config: OracleConfig, options: { channel?: string }): Promise<void> {
  const apiKey = config.nansenApiKey || process.env.NANSEN_API_KEY || '';
  if (!apiKey) {
    console.error(chalk.red('\n  ✗ No Nansen API key. Run: nansen-oracle init --key YOUR_KEY'));
    process.exit(1);
  }

  const nansen = new NansenClient(apiKey);
  const veil = new VeilClient(config);

  console.log(chalk.cyan.bold('\n  🔱 NANSEN ORACLE BOT'));
  console.log(chalk.gray(`  DID:   ${config.veilDid}`));
  console.log(chalk.gray(`  Relay: https://api.voidly.ai`));

  const spinner = ora({ text: chalk.gray('Registering on Veil relay...'), spinner: 'dots' }).start();

  try {
    await veil.register();
    spinner.succeed(chalk.green(`Online — ${config.veilDid}`));
  } catch (err: unknown) {
    spinner.fail(chalk.red(`Connect failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (options.channel) {
    console.log(chalk.gray(`  Channel feed: ${options.channel} (hourly)`));
    startChannelFeed(options.channel, nansen, veil, config);
  }

  console.log(chalk.gray('\n  Listening... Commands: !alpha !screen !wallet !flows !join !help'));
  console.log(chalk.gray('  Ctrl+C to stop\n'));

  const seen = new Set<string>();
  let polling = false;

  const pollDMs = async () => {
    if (polling) return; // prevent overlap if previous poll hasn't finished
    polling = true;
    try {
      const messages = await veil.fetchMessages();
      for (const msg of messages) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);

        const content = (msg.content || '').trim();
        if (!content.startsWith('!')) {
          await veil.markRead(msg.id);
          continue;
        }

        console.log(chalk.gray(`  [${new Date().toLocaleTimeString()}] ${shortAddr(msg.from_did)}: ${content.slice(0, 60)}`));

        const reply = await handleCommand(content, config, nansen, veil, msg.from_did);
        await veil.sendDM(msg.from_did, reply).catch(() => {});
        await veil.markRead(msg.id);
      }

      // Prune seen set
      if (seen.size > 2000) {
        const arr = [...seen];
        arr.slice(0, 1000).forEach(k => seen.delete(k));
      }
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(async () => {
    try { await pollDMs(); } catch { /* ignore */ }
  }, POLL_INTERVAL);

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log(chalk.gray('\n  Bot stopped.'));
    process.exit(0);
  });

  // Run once immediately
  try { await pollDMs(); } catch { /* ignore */ }

  await new Promise(() => {});
}

async function handleCommand(
  content: string,
  config: OracleConfig,
  nansen: NansenClient,
  veil: VeilClient,
  fromDid: string,
): Promise<string> {
  const parts = content.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  try {
    switch (cmd) {
      case '!help':
      case '!start':
        return HELP_TEXT;

      case '!alpha': {
        const chains = config.defaultChains;
        const [flows, rawTrades, screener] = await Promise.all([
          nansen.getSmartMoneyFlows(chains, 8),
          nansen.getSmartMoneyDexTrades(chains, 8),
          nansen.screenTokens(chains, '1h', 8),
        ]);
        const trades = rawTrades.map(normalizeSmartTrade);
        return buildAlphaDigest(flows, trades, screener);
      }

      case '!screen': {
        const chainArg = parts[1];
        if (chainArg && !VALID_CHAINS.has(chainArg.toLowerCase())) {
          return `❌ Unknown chain: "${chainArg}"\nValid: ${[...VALID_CHAINS].join(', ')}`;
        }
        const chains = chainArg ? [chainArg.toLowerCase()] : config.defaultChains;
        const validScreenFrames = ['5m', '1h', '6h', '24h', '7d'];
        const tfArg = parts[2] && validScreenFrames.includes(parts[2]) ? parts[2] as '5m' | '1h' | '6h' | '24h' | '7d' : '1h';
        const tokens = await nansen.screenTokens(chains, tfArg, 10);
        const lines = [`🎯 SCREENER (1H) — ${new Date().toUTCString()}`, ''];
        tokens.slice(0, 10).forEach((t, i) => {
          const flow = t.netflow || 0;
          const abs = Math.abs(flow);
          const absStr = abs >= 1e6 ? `$${(abs / 1e6).toFixed(1)}M` : `$${abs.toFixed(0)}`;
          lines.push(`#${i + 1} ${(t.token_symbol || '?').padEnd(10)} ${flow >= 0 ? '+' : '-'}${absStr}  ${t.nof_buyers || 0} buyers`);
        });
        if (!tokens.length) lines.push('  No data');
        lines.push('', 'via Nansen Oracle × Veil');
        return lines.join('\n');
      }

      case '!wallet': {
        const addr = parts[1];
        if (!addr || !addr.startsWith('0x') || addr.length !== 42) return '❌ Usage: !wallet <0x_address> (42-char EVM address)';
        const chain = parts[2] || 'ethereum';
        const [balances, labels] = await Promise.all([
          nansen.getWalletBalances(addr, chain),
          nansen.getWalletLabels(addr, chain).catch(() => []),
        ]);
        const total = balances.reduce((s, b) => s + (b.value_usd || 0), 0);
        const labelStr = labels.map(l => l.label).join(', ') || 'No labels';
        const top = balances
          .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0))
          .slice(0, 5)
          .map(b => `  ${(b.token_symbol || '?').padEnd(8)} ${formatUsd(b.value_usd || 0)}`)
          .join('\n');
        return [
          '💼 WALLET PROFILE',
          `Address: ${shortAddr(addr)}`,
          `Labels:  ${labelStr}`,
          `Total:   ${formatUsd(total)}`,
          '',
          'Top Holdings:',
          top || '  No data',
          '',
          'via Nansen Oracle × Veil',
        ].join('\n');
      }

      case '!flows': {
        const tokenAddr = parts[1];
        const chain = parts[2] || 'ethereum';
        if (!tokenAddr || !tokenAddr.startsWith('0x') || tokenAddr.length !== 42) return '❌ Usage: !flows <0x_token_address> [chain]';
        const flows = await nansen.getFlowIntelligence(chain, tokenAddr, '1d');
        if (!flows.length) return `❌ No flow data for ${shortAddr(tokenAddr)}`;
        const lines = [`🌊 FLOW INTELLIGENCE — ${shortAddr(tokenAddr)}`, ''];
        flows.forEach(f => {
          const net = f.net_flow_usd || 0;
          const sign = net >= 0 ? '+' : '-';
          lines.push(`${f.segment.padEnd(22)} ${sign}${formatUsd(Math.abs(net))}  (${f.wallet_count} wallets)`);
        });
        lines.push('', 'via Nansen Oracle × Veil');
        return lines.join('\n');
      }

      case '!join': {
        const channelId = parts[1];
        const walletAddr = parts[2];
        if (!channelId || !walletAddr) return '❌ Usage: !join <channel_id> <wallet_address>';
        if (!walletAddr.startsWith('0x') || walletAddr.length !== 42) return '❌ wallet_address must be a 42-char EVM address (0x...)';

        const ch = config.channels.find(c => c.id === channelId);
        if (!ch) return `❌ Channel not found: ${channelId}`;

        if (!ch.gateToken) {
          await veil.inviteToChannel(channelId, fromDid);
          return `✅ Invited to "${ch.name}"\nJoin: ${veil.getJoinLink(channelId)}`;
        }

        const allowed = await checkGate(channelId, walletAddr, config);
        if (allowed) {
          await veil.inviteToChannel(channelId, fromDid);
          return `✅ Balance verified. Invited to "${ch.name}"\nJoin: ${veil.getJoinLink(channelId)}`;
        }
        return `🔒 Access denied. Need ${ch.gateMinBalance} of token ${ch.gateToken.slice(0, 10)}...`;
      }

      default:
        return `❓ Unknown: ${cmd}\n\n${HELP_TEXT}`;
    }
  } catch (err: unknown) {
    return `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function startChannelFeed(
  channelId: string,
  nansen: NansenClient,
  veil: VeilClient,
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
      console.log(chalk.gray(`  [feed] Posted digest ${new Date().toLocaleTimeString()}`));
    } catch (err: unknown) {
      console.log(chalk.yellow(`  [feed] Failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  postDigest();
  setInterval(postDigest, 60 * 60 * 1000); // hourly
}

const HELP_TEXT = `🔱 NANSEN ORACLE — COMMANDS

!alpha                    Smart money digest (flows + trades + screener)
!screen [chain] [tf]      Token screener (1H by default). tf: 5m/1h/6h/24h/7d
!wallet <0x...42chars>    Wallet profile: balances, labels, trades
!flows <0x...42chars>     Flow intelligence by wallet segment
!join <ch_id> <0x...>     Join token-gated channel (wallet balance check)
!help                     Show this

Powered by Nansen × Veil  |  msg.voidly.ai`;
