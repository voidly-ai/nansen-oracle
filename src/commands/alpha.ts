import chalk from 'chalk';
import ora from 'ora';
import { NansenClient, normalizeSmartTrade } from '../nansen.js';
import { VeilClient } from '../veil.js';
import { OracleConfig } from '../config.js';
import {
  header,
  printFlowsTable,
  printTradesTable,
  printScreenerTable,
  buildAlphaDigest,
  printDelivery,
} from '../display.js';

export async function runAlpha(config: OracleConfig, options: { chains?: string; deliver?: boolean }): Promise<void> {
  const apiKey = config.nansenApiKey || process.env.NANSEN_API_KEY || '';
  if (!apiKey) {
    console.error(chalk.red('\n  ✗ No Nansen API key. Run: nansen-oracle init --key YOUR_KEY'));
    process.exit(1);
  }

  const nansen = new NansenClient(apiKey);
  const veil = new VeilClient(config);

  const chains = options.chains
    ? options.chains.split(',').map(s => s.trim())
    : config.defaultChains;

  console.log(header('NANSEN ORACLE  |  SMART MONEY DIGEST'));
  console.log();

  const spinner = ora({ text: chalk.gray('Fetching smart money data from Nansen...'), spinner: 'dots' }).start();

  let flows, rawTrades, screener;
  try {
    [flows, rawTrades, screener] = await Promise.all([
      nansen.getSmartMoneyFlows(chains, 20),
      nansen.getSmartMoneyDexTrades(chains, 20),
      nansen.screenTokens(chains, '24h', 20),
    ]);
    spinner.succeed(chalk.gray(`Fetched: ${flows.length} flows, ${rawTrades.length} trades, ${screener.length} tokens`));
  } catch (err: unknown) {
    spinner.fail(chalk.red(`Nansen API error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const trades = rawTrades.map(normalizeSmartTrade);

  printFlowsTable(flows);
  printTradesTable(trades);
  printScreenerTable(screener, '24h');

  if (options.deliver !== false) {
    const deliverSpinner = ora({ text: chalk.gray('Delivering to Veil inbox...'), spinner: 'dots' }).start();
    try {
      await veil.register();
      const digest = buildAlphaDigest(flows, trades, screener);
      await veil.sendDM(config.veilDid, digest);
      deliverSpinner.succeed(chalk.green('Delivered to Veil inbox'));
      printDelivery(config.veilDid, true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      deliverSpinner.warn(chalk.yellow(`Veil delivery failed: ${msg}`));
      printDelivery(config.veilDid, false);
    }
  }
}
