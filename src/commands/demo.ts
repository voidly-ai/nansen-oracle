import chalk from 'chalk';
import {
  header,
  printFlowsTable,
  printTradesTable,
  printScreenerTable,
  buildAlphaDigest,
  printDelivery,
} from '../display.js';
import { normalizeSmartTrade, SmartDexTrade, SmartMoneyFlow, ScreenerToken } from '../nansen.js';

const SAMPLE_FLOWS: SmartMoneyFlow[] = [
  { token_symbol: 'ETH',     token_address: '0xeeee', chain: 'ethereum', net_flow_1h_usd:  47_200_000, net_flow_24h_usd:  312_000_000, net_flow_7d_usd: 1_200_000_000, net_flow_30d_usd: 4_800_000_000, trader_count: 142, market_cap_usd: 400_000_000_000, token_sectors: ['Layer 1'], token_age_days: 3000 },
  { token_symbol: 'SOL',     token_address: '0xssss', chain: 'solana',   net_flow_1h_usd:  31_800_000, net_flow_24h_usd:   89_400_000, net_flow_7d_usd:   320_000_000, net_flow_30d_usd: 1_200_000_000, trader_count:  89, market_cap_usd:  85_000_000_000, token_sectors: ['Layer 1'], token_age_days: 1500 },
  { token_symbol: 'WIF',     token_address: '0xwwww', chain: 'solana',   net_flow_1h_usd:   8_400_000, net_flow_24h_usd:   22_100_000, net_flow_7d_usd:    72_000_000, net_flow_30d_usd:   180_000_000, trader_count:  34, market_cap_usd:     890_000_000, token_sectors: ['Meme'],    token_age_days:   45 },
  { token_symbol: 'PEPE',    token_address: '0xpppp', chain: 'ethereum', net_flow_1h_usd: -12_400_000, net_flow_24h_usd:  -44_200_000, net_flow_7d_usd:   -98_000_000, net_flow_30d_usd:  -210_000_000, trader_count:  67, market_cap_usd:   3_800_000_000, token_sectors: ['Meme'],    token_age_days:  120 },
  { token_symbol: 'AIXBT',   token_address: '0xaaaa', chain: 'ethereum', net_flow_1h_usd:   3_800_000, net_flow_24h_usd:    9_200_000, net_flow_7d_usd:    28_000_000, net_flow_30d_usd:    72_000_000, trader_count:  19, market_cap_usd:     142_000_000, token_sectors: ['AI'],      token_age_days:   88 },
  { token_symbol: 'VIRTUAL', token_address: '0xvvvv', chain: 'base',     net_flow_1h_usd:  -2_100_000, net_flow_24h_usd:    3_400_000, net_flow_7d_usd:    14_000_000, net_flow_30d_usd:    42_000_000, trader_count:  15, market_cap_usd:     320_000_000, token_sectors: ['AI'],      token_age_days:   60 },
  { token_symbol: 'TRUMP',   token_address: '0xtttt', chain: 'solana',   net_flow_1h_usd:   1_900_000, net_flow_24h_usd:   -8_700_000, net_flow_7d_usd:   -32_000_000, net_flow_30d_usd:   -88_000_000, trader_count:  45, market_cap_usd:   1_200_000_000, token_sectors: ['Meme'],    token_age_days:   25 },
  { token_symbol: 'BASE',    token_address: '0xbbbb', chain: 'base',     net_flow_1h_usd:   4_200_000, net_flow_24h_usd:   18_900_000, net_flow_7d_usd:    54_000_000, net_flow_30d_usd:   140_000_000, trader_count:  28, market_cap_usd:     680_000_000, token_sectors: ['Layer 2'], token_age_days:  200 },
];

const SAMPLE_RAW_TRADES: SmartDexTrade[] = [
  { transaction_hash: '0xabc1000000000000000000000000000000000000000000000000000000000001', trader_address: '0x7a2f35cc0000000000000000000000000000003f', trader_address_label: 'Abraxas Fund',     token_bought_symbol: 'ETH',   token_sold_symbol: 'USDC', token_bought_amount: 2000,      token_sold_amount: 8_100_000,  trade_value_usd: 8_100_000, chain: 'ethereum', block_timestamp: '2026-03-30T17:00:00Z' },
  { transaction_hash: '0xabc2000000000000000000000000000000000000000000000000000000000002', trader_address: '0xb891cccc0000000000000000000000000000cc20', trader_address_label: 'Smart Trader',     token_bought_symbol: 'WIF',   token_sold_symbol: 'SOL',  token_bought_amount: 1_000_000, token_sold_amount: 10_000,     trade_value_usd: 1_400_000, chain: 'solana',   block_timestamp: '2026-03-30T17:01:00Z' },
  { transaction_hash: '0xabc3000000000000000000000000000000000000000000000000000000000003', trader_address: '0x44f18a3a0000000000000000000000000000008a', trader_address_label: 'DWF Labs',         token_bought_symbol: 'USDC', token_sold_symbol: 'PEPE', token_bought_amount: 3_200_000, token_sold_amount: 500_000_000, trade_value_usd: 3_200_000, chain: 'ethereum', block_timestamp: '2026-03-30T17:02:00Z' },
  { transaction_hash: '0xabc4000000000000000000000000000000000000000000000000000000000004', trader_address: '0xcdef12340000000000000000000000000000cdef', trader_address_label: 'Wintermute',       token_bought_symbol: 'SOL',   token_sold_symbol: 'USDC', token_bought_amount: 15_000,    token_sold_amount: 2_250_000,  trade_value_usd: 2_250_000, chain: 'solana',   block_timestamp: '2026-03-30T17:03:00Z' },
  { transaction_hash: '0xabc5000000000000000000000000000000000000000000000000000000000005', trader_address: '0x12345670000000000000000000000000000056780', trader_address_label: '30D Smart Trader', token_bought_symbol: 'AIXBT', token_sold_symbol: 'USDT', token_bought_amount: 500_000,   token_sold_amount: 950_000,    trade_value_usd:   950_000, chain: 'ethereum', block_timestamp: '2026-03-30T17:04:00Z' },
];

const SAMPLE_SCREENER: ScreenerToken[] = [
  { token_symbol: 'GRASS',    chain: 'ethereum', netflow:  2_100_000, nof_buyers: 47, nof_sellers: 12, market_cap_usd:  84_000_000, token_age_days: 31, price_usd: 1.24,  price_change: 0.08, nof_traders: 59,  buy_volume:  8_200_000, sell_volume: 6_100_000, volume: 14_300_000, liquidity:  4_200_000, token_address: '0x000001' },
  { token_symbol: 'AIXBT',    chain: 'ethereum', netflow:  1_800_000, nof_buyers: 31, nof_sellers:  8, market_cap_usd: 142_000_000, token_age_days: 45, price_usd: 0.18,  price_change: 0.12, nof_traders: 39,  buy_volume:  6_400_000, sell_volume: 4_600_000, volume: 11_000_000, liquidity:  8_900_000, token_address: '0x000002' },
  { token_symbol: 'VIRTUAL',  chain: 'base',     netflow:  1_500_000, nof_buyers: 28, nof_sellers: 11, market_cap_usd: 320_000_000, token_age_days: 60, price_usd: 3.20,  price_change: 0.05, nof_traders: 39,  buy_volume:  5_800_000, sell_volume: 4_300_000, volume: 10_100_000, liquidity: 12_000_000, token_address: '0x000003' },
  { token_symbol: 'FARTCOIN', chain: 'solana',   netflow:  1_200_000, nof_buyers: 22, nof_sellers:  6, market_cap_usd:  28_000_000, token_age_days: 15, price_usd: 0.028, price_change: 0.23, nof_traders: 28,  buy_volume:  3_400_000, sell_volume: 2_200_000, volume:  5_600_000, liquidity:  1_800_000, token_address: '0x000004' },
  { token_symbol: 'WIF',      chain: 'solana',   netflow:    900_000, nof_buyers: 18, nof_sellers:  9, market_cap_usd: 890_000_000, token_age_days: 45, price_usd: 0.89,  price_change: -0.02, nof_traders: 27, buy_volume:  2_900_000, sell_volume: 2_000_000, volume:  4_900_000, liquidity: 28_000_000, token_address: '0x000005' },
];

export async function runDemo(): Promise<void> {
  console.log(header('NANSEN ORACLE  |  DEMO MODE  |  SAMPLE DATA'));
  console.log(chalk.gray('  ⚡ No API key needed. Get your key at: https://app.nansen.ai/auth/agent-setup\n'));

  const trades = SAMPLE_RAW_TRADES.map(normalizeSmartTrade);

  printFlowsTable(SAMPLE_FLOWS);
  printTradesTable(trades);
  printScreenerTable(SAMPLE_SCREENER, '24h');

  console.log();
  console.log(chalk.gray('  ' + '─'.repeat(58)));
  console.log(chalk.cyan.bold('\n  This is demo data. For live Nansen signals:'));
  console.log(chalk.white('  1. Get API key: https://app.nansen.ai/auth/agent-setup'));
  console.log(chalk.white('  2. Run:         nansen-oracle init --key YOUR_KEY'));
  console.log(chalk.white('  3. Run:         nansen-oracle alpha'));
  console.log();

  // Show what the Veil digest looks like
  console.log(chalk.yellow.bold('  ▸ VEIL INBOX PREVIEW (what gets delivered to msg.voidly.ai)'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  const digest = buildAlphaDigest(SAMPLE_FLOWS, trades, SAMPLE_SCREENER);
  digest.split('\n').forEach(line => console.log(chalk.gray('  ') + line));
  printDelivery('did:voidly:YourDID', false);
}
