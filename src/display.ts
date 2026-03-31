import chalk from 'chalk';
import Table from 'cli-table3';
import type { SmartMoneyFlow, ScreenerToken, WalletBalance, WalletLabel, TradeEvent } from './nansen.js';

const BORDER = chalk.gray('─'.repeat(62));

export function header(title: string): string {
  const ts = new Date().toUTCString().replace('GMT', 'UTC');
  const width = Math.max(title.length + 4, ts.length + 4, 52);
  const titlePad = ' '.repeat(Math.max(0, width - title.length - 2));
  const tsPad = ' '.repeat(Math.max(0, width - ts.length - 2));
  return [
    chalk.gray('╔' + '═'.repeat(width) + '╗'),
    chalk.gray('║ ') + chalk.cyan.bold(title) + chalk.gray(titlePad + ' ║'),
    chalk.gray('║ ') + chalk.gray(ts) + chalk.gray(tsPad + ' ║'),
    chalk.gray('╚' + '═'.repeat(width) + '╝'),
  ].join('\n');
}

export function section(title: string): string {
  return chalk.yellow.bold(`\n▸ ${title.toUpperCase()}`);
}

export function formatFlow(usd: number): string {
  if (!isFinite(usd)) return chalk.gray('—');
  const abs = Math.abs(usd);
  let str: string;
  if (abs >= 999_500_000) str = `$${(abs / 1e9).toFixed(1)}B`;
  else if (abs >= 999_500) str = `$${(abs / 1e6).toFixed(1)}M`;
  else if (abs >= 999.5) str = `$${(abs / 1e3).toFixed(1)}K`;
  else str = `$${abs.toFixed(0)}`;
  return usd >= 0 ? chalk.green(`▲ +${str}`) : chalk.red(`▼ -${str}`);
}

export function formatUsd(usd: number): string {
  if (!isFinite(usd)) return '$—';
  const abs = Math.abs(usd);
  if (abs >= 999_500_000) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 999_500) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 999.5) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}

export function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || '?';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function printFlowsTable(flows: SmartMoneyFlow[]): void {
  if (!flows.length) {
    console.log(section('Smart Money Flows  (1H)'));
    console.log(chalk.gray('  No data returned'));
    return;
  }

  console.log(section('Smart Money Flows  (1H)'));
  console.log(BORDER);

  const table = new Table({
    head: [
      chalk.gray('TOKEN'),
      chalk.gray('CHAIN'),
      chalk.gray('1H FLOW'),
      chalk.gray('24H FLOW'),
      chalk.gray('TRADERS'),
      chalk.gray('SECTOR'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [10, 10, 15, 15, 9, 10],
  });

  for (const f of flows.slice(0, 12)) {
    table.push([
      chalk.white.bold((f.token_symbol || '?').slice(0, 8)),
      chalk.gray((f.chain || '?').slice(0, 8)),
      formatFlow(f.net_flow_1h_usd || 0),
      formatFlow(f.net_flow_24h_usd || 0),
      chalk.white(String(f.trader_count || 0)),
      chalk.gray(((f.token_sectors || [])[0] || '').slice(0, 8)),
    ]);
  }

  console.log(table.toString());
}

export function printTradesTable(trades: TradeEvent[], title = 'Hot Trades  (Smart Money)'): void {
  if (!trades.length) {
    console.log(section(title));
    console.log(chalk.gray('  No trades in this window'));
    return;
  }

  console.log(section(title));
  console.log(BORDER);

  const table = new Table({
    head: [
      chalk.gray('LABEL'),
      chalk.gray('WALLET'),
      chalk.gray('ACTION'),
      chalk.gray('VALUE'),
      chalk.gray('CHAIN'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [18, 14, 16, 12, 10],
  });

  for (const t of trades.slice(0, 8)) {
    const action = t.action === 'BUY'
      ? chalk.green(`BUY  ${(t.token_in || '?').slice(0, 8)}`)
      : chalk.red(`SELL ${(t.token_in || '?').slice(0, 8)}`);

    table.push([
      chalk.cyan((t.trader_label || 'Smart Money').slice(0, 16)),
      chalk.gray(shortAddr(t.trader_address)),
      action,
      chalk.white(formatUsd(t.value_usd || 0)),
      chalk.gray((t.chain || '?').slice(0, 8)),
    ]);
  }

  console.log(table.toString());
}

export function printScreenerTable(tokens: ScreenerToken[], timeframe: string): void {
  if (!tokens.length) {
    console.log(section(`Token Screener  (${timeframe})`));
    console.log(chalk.gray('  No tokens returned'));
    return;
  }

  console.log(section(`Token Screener  (Smart Money, ${timeframe})`));
  console.log(BORDER);

  const table = new Table({
    head: [
      chalk.gray('#'),
      chalk.gray('TOKEN'),
      chalk.gray('CHAIN'),
      chalk.gray('NETFLOW'),
      chalk.gray('BUYERS'),
      chalk.gray('SELLERS'),
      chalk.gray('MCAP'),
      chalk.gray('AGE'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [4, 10, 10, 15, 8, 9, 12, 7],
  });

  tokens.slice(0, 15).forEach((t, i) => {
    table.push([
      chalk.gray(String(i + 1)),
      chalk.white.bold((t.token_symbol || '?').slice(0, 8)),
      chalk.gray((t.chain || '?').slice(0, 8)),
      formatFlow(t.netflow || 0),
      chalk.green(String(t.nof_buyers || 0)),
      chalk.red(String(t.nof_sellers || 0)),
      chalk.white(formatUsd(t.market_cap_usd || 0)),
      chalk.gray(`${Math.round(t.token_age_days || 0)}d`),
    ]);
  });

  console.log(table.toString());
}

export function printWalletTable(
  address: string,
  labels: WalletLabel[],
  balances: WalletBalance[],
): void {
  console.log(section('Wallet Profile'));
  console.log(BORDER);

  const labelStr = labels.length
    ? labels.map(l => chalk.cyan(l.label)).join(', ')
    : chalk.gray('No labels');

  console.log(`  ${chalk.gray('Address')}  ${chalk.white(shortAddr(address))}`);
  console.log(`  ${chalk.gray('Labels')}   ${labelStr}`);
  console.log();

  const significant = balances
    .filter(b => (b.value_usd || 0) > 50)
    .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0))
    .slice(0, 10);

  if (!significant.length) {
    console.log(chalk.gray('  No significant holdings found'));
    return;
  }

  const table = new Table({
    head: [chalk.gray('TOKEN'), chalk.gray('CHAIN'), chalk.gray('BALANCE'), chalk.gray('VALUE')],
    style: { head: [], border: ['gray'] },
    colWidths: [12, 12, 20, 14],
  });

  significant.forEach(b => {
    table.push([
      chalk.white.bold((b.token_symbol || '?').slice(0, 10)),
      chalk.gray((b.chain || '?').slice(0, 10)),
      chalk.white(typeof b.balance === 'number' ? b.balance.toFixed(4) : '?'),
      chalk.green(formatUsd(b.value_usd || 0)),
    ]);
  });

  console.log(table.toString());
}

export function printDelivery(did: string, delivered: boolean): void {
  console.log();
  if (delivered) {
    console.log(chalk.green(`  📬 Delivered → Veil inbox`));
    console.log(chalk.gray(`     View at: https://msg.voidly.ai`));
  } else {
    console.log(chalk.gray(`  📬 Veil inbox: https://msg.voidly.ai`));
  }
}

// ── Helpers for buildAlphaDigest ─────────────────────────────────────────────

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

function fmtFlowSigned(usd: number): string {
  const abs = Math.abs(usd);
  const str = abs >= 1e9 ? `$${(abs / 1e9).toFixed(1)}B`
    : abs >= 1e6 ? `$${(abs / 1e6).toFixed(1)}M`
    : abs >= 1e3 ? `$${(abs / 1e3).toFixed(0)}K`
    : `$${abs.toFixed(0)}`;
  return (usd >= 0 ? '+' : '-') + str;
}

export interface DigestPrefs {
  flows?: boolean;
  trades?: boolean;
  screener?: boolean;
}

export function buildAlphaDigest(
  flows: SmartMoneyFlow[],
  trades: TradeEvent[],
  screener: ScreenerToken[],
  timeframe = '1h',
  prefs?: DigestPrefs,
): string {
  const hhmm = new Date().toUTCString().replace(/.*(\d{2}:\d{2}):\d{2}.*/, '$1');
  const tf = timeframe.toUpperCase();

  const showFlows    = prefs?.flows    !== false;
  const showTrades   = prefs?.trades   !== false;
  const showScreener = prefs?.screener !== false;

  const getFlow = (f: SmartMoneyFlow): number => {
    if (timeframe === '24h') return f.net_flow_24h_usd || 0;
    if (timeframe === '7d')  return f.net_flow_7d_usd  || 0;
    return f.net_flow_1h_usd || 0;
  };

  const flowSlice = (flows || []).slice(0, 8);
  const inCount  = flowSlice.filter(f => getFlow(f) > 0).length;
  const outCount = flowSlice.filter(f => getFlow(f) < 0).length;
  const total    = flowSlice.length || 1;
  const tone = inCount / total > 0.6 ? '↑ accumulation'
    : outCount / total > 0.6 ? '↓ distribution'
    : '→ mixed';

  const lines: string[] = [
    `🔱 SMART MONEY  ${hhmm} UTC`,
    `SIGNAL: ${tone} (${inCount} in / ${outCount} out)`,
  ];

  if (showFlows) {
    lines.push('', `📊 FLOWS  ${tf}`);
    flowSlice.forEach(f => {
      const flow    = getFlow(f);
      const sym     = (f.token_symbol || '?').slice(0, 6).padEnd(6);
      const flowStr = fmtFlowSigned(flow).padEnd(10);
      const traders = f.trader_count || 0;
      lines.push(`${sym}  ${flowStr}  ${traders}t`);
    });
    if (!flowSlice.length) lines.push('  No data');
  }

  if (showTrades) {
    lines.push('', '🔥 TRADES');
    (trades || []).slice(0, 4).forEach(t => {
      const action = t.action === 'BUY' ? 'BUY ' : 'SELL';
      const label  = (t.trader_label && t.trader_label !== 'Smart Money'
        ? t.trader_label
        : shortAddr(t.trader_address)
      ).slice(0, 14).padEnd(14);
      const sym  = (t.token_in || '?').slice(0, 6).padEnd(6);
      const val  = formatUsd(t.value_usd || 0);
      const ago  = timeAgo(t.timestamp);
      lines.push(`${label}  ${action}  ${sym}  ${val}  ${ago}`);
    });
    if (!(trades || []).length) lines.push('  No data');
  }

  if (showScreener) {
    lines.push('', `🎯 SCREENER  ${tf}`);
    (screener || []).slice(0, 3).forEach((t, i) => {
      const sym      = (t.token_symbol || '?').slice(0, 8).padEnd(8);
      const flowStr  = fmtFlowSigned(t.netflow || 0).padEnd(10);
      const priceChg = t.price_change != null
        ? ` ${t.price_change >= 0 ? '+' : ''}${t.price_change.toFixed(1)}%`
        : '';
      const bs = `${t.nof_buyers || 0}b/${t.nof_sellers || 0}s`;
      lines.push(`#${i + 1} ${sym} ${flowStr}${priceChg}  ${bs}`);
    });
    if (!(screener || []).length) lines.push('  No data');
  }

  lines.push('', '!alpha 24h · !screen · !token · !flows');
  return lines.join('\n');
}
