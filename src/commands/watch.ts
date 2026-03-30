import chalk from 'chalk';
import ora from 'ora';
import { NansenClient, normalizeTgmTrade, normalizeProfilerTx, TradeEvent } from '../nansen.js';
import { VeilClient } from '../veil.js';
import { OracleConfig, WatchItem, saveConfig } from '../config.js';
import { formatUsd, shortAddr } from '../display.js';
import { VALID_CHAINS } from './alpha.js';

const DEFAULT_THRESHOLD_USD = 500_000;

export async function runWatch(
  target: string,
  config: OracleConfig,
  options: { chain?: string; threshold?: number; interval?: number; veilDid?: string; type?: string },
): Promise<void> {
  const apiKey = config.nansenApiKey || process.env.NANSEN_API_KEY || '';
  if (!apiKey) {
    console.error(chalk.red('\n  ✗ No Nansen API key. Run: nansen-oracle init --key YOUR_KEY'));
    process.exit(1);
  }

  if (!target.startsWith('0x') || target.length !== 42) {
    console.error(chalk.red(`\n  ✗ Invalid address: "${target}" (must be a 42-char EVM address starting with 0x)\n`));
    process.exit(1);
  }

  // Default to wallet; use --type token for token contract addresses
  const isWallet = options.type !== 'token';
  const chain = (options.chain || 'ethereum').toLowerCase();
  if (!VALID_CHAINS.has(chain)) {
    console.error(chalk.red(`\n  ✗ Unknown chain: "${chain}"`));
    console.error(chalk.gray(`    Valid: ${[...VALID_CHAINS].join(', ')}\n`));
    process.exit(1);
  }

  let threshold = DEFAULT_THRESHOLD_USD;
  if (options.threshold !== undefined) {
    if (options.threshold <= 0) {
      console.warn(chalk.yellow(`  ⚠  --threshold must be > 0. Using default ${formatUsd(DEFAULT_THRESHOLD_USD)}.`));
    } else {
      threshold = options.threshold;
    }
  }

  const rawInterval = options.interval ?? 5;
  if (options.interval !== undefined && options.interval < 1) {
    console.warn(chalk.yellow(`  ⚠  --interval must be at least 1 minute. Using 1 min.`));
  }
  const pollMs = Math.max(1, rawInterval) * 60 * 1000;
  const deliverTo = options.veilDid || config.veilDid;

  const nansen = new NansenClient(apiKey);
  const veil = new VeilClient(config);

  // Add to watchlist
  const exists = config.watchlist.find(w => w.address.toLowerCase() === target.toLowerCase());
  if (!exists) {
    config.watchlist.push({ type: isWallet ? 'wallet' : 'token', address: target, chain, threshold });
    saveConfig(config);
  }

  try { await veil.register(); } catch { /* non-fatal */ }

  console.log(chalk.cyan.bold(`\n  🔱 NANSEN ORACLE — WATCH MODE`));
  console.log(chalk.gray(`  Target:     ${target}`));
  console.log(chalk.gray(`  Type:       ${isWallet ? 'Wallet (use --type token for contracts)' : 'Token'}`));
  console.log(chalk.gray(`  Chain:      ${chain}`));
  console.log(chalk.gray(`  Threshold:  ${formatUsd(threshold)}`));
  console.log(chalk.gray(`  Poll:       every ${Math.max(1, rawInterval)} min`));
  console.log(chalk.gray(`  Alerts →    ${deliverTo}`));
  console.log(chalk.gray(`  Inbox:      https://msg.voidly.ai`));
  console.log(chalk.gray(`\n  Ctrl+C to stop\n`));

  const seenTxs = new Set<string>();
  let firstRun = true;

  const poll = async () => {
    const spinner = ora({ text: chalk.gray(`Checking ${shortAddr(target)}...`), spinner: 'dots' }).start();
    try {
      const events: TradeEvent[] = isWallet
        ? await checkWallet(target, chain, nansen)
        : await checkToken(target, chain, nansen);

      const newEvents = events.filter(e => e.tx_hash && !seenTxs.has(e.tx_hash));
      newEvents.forEach(e => seenTxs.add(e.tx_hash));

      const alerts = newEvents.filter(e => e.value_usd >= threshold);

      spinner.succeed(chalk.gray(
        `  ${new Date().toLocaleTimeString()}  ${newEvents.length} new txns  ${alerts.length} above ${formatUsd(threshold)}`,
      ));

      if (alerts.length > 0 && !firstRun) {
        for (const e of alerts) {
          const actionStr = e.action === 'BUY'
            ? chalk.green.bold(`🟢 BUY  ${e.token_in}`)
            : chalk.red.bold(`🔴 SELL ${e.token_in}`);
          console.log(`  ${actionStr}  ${formatUsd(e.value_usd)}  ${chalk.gray(shortAddr(e.trader_address || target))}`);

          const msg = buildAlertMessage(e, target);
          await veil.sendDM(deliverTo, msg).catch(() => {});
        }
      }

      // Prune seenTxs to avoid memory leak
      if (seenTxs.size > 2000) {
        const arr = [...seenTxs];
        arr.slice(0, 1000).forEach(k => seenTxs.delete(k));
      }

      firstRun = false;
    } catch (err: unknown) {
      spinner.warn(chalk.yellow(`  Poll error: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  await poll();
  const interval = setInterval(poll, pollMs);

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log(chalk.gray('\n  Watch stopped.'));
    process.exit(0);
  });

  await new Promise(() => {});
}

async function checkToken(address: string, chain: string, nansen: NansenClient): Promise<TradeEvent[]> {
  const trades = await nansen.getTokenDexTrades(chain, address, true, 30);
  return trades.map(t => normalizeTgmTrade(t, chain));
}

async function checkWallet(address: string, chain: string, nansen: NansenClient): Promise<TradeEvent[]> {
  const txns = await nansen.getWalletTransactions(address, chain, 20);
  return txns.map(normalizeProfilerTx);
}

function buildAlertMessage(e: TradeEvent, target: string): string {
  const typeStr = e.action === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  return [
    `🚨 SMART MONEY ALERT`,
    `${e.action === 'BUY' ? 'Token' : 'Target'}: ${target.slice(0, 12)}...`,
    `${typeStr}  ${e.token_in}  ${formatUsd(e.value_usd)}`,
    e.trader_label !== 'Wallet' ? `Trader: ${e.trader_label}  (${shortAddr(e.trader_address)})` : '',
    `Tx: ${shortAddr(e.tx_hash)}`,
    '',
    'via Nansen Oracle × Veil  |  msg.voidly.ai',
  ].filter(Boolean).join('\n');
}
