import chalk from 'chalk';
import ora from 'ora';
import { NansenClient } from '../nansen.js';
import { VeilClient } from '../veil.js';
import { OracleConfig } from '../config.js';
import { header, printScreenerTable, printDelivery, formatUsd } from '../display.js';
import { parseChains } from './alpha.js';

export async function runScreen(
  config: OracleConfig,
  options: { chains?: string; timeframe?: '5m' | '1h' | '6h' | '24h' | '7d'; deliver?: boolean },
): Promise<void> {
  const apiKey = config.nansenApiKey || process.env.NANSEN_API_KEY || '';
  if (!apiKey) {
    console.error(chalk.red('\n  ✗ No Nansen API key. Run: nansen-oracle init --key YOUR_KEY'));
    process.exit(1);
  }

  const nansen = new NansenClient(apiKey);

  const VALID_TIMEFRAMES = ['5m', '1h', '6h', '24h', '7d'];
  if (options.timeframe && !VALID_TIMEFRAMES.includes(options.timeframe)) {
    console.error(chalk.red(`\n  ✗ Invalid timeframe: "${options.timeframe}". Valid: ${VALID_TIMEFRAMES.join(', ')}`));
    process.exit(1);
  }

  const chains = parseChains(options.chains, config.defaultChains);
  const timeframe = options.timeframe || '24h';

  console.log(header(`NANSEN ORACLE  |  TOKEN SCREENER  |  ${timeframe.toUpperCase()}`));
  console.log();

  const spinner = ora({ text: chalk.gray('Running token screener...'), spinner: 'dots' }).start();

  try {
    const tokens = await nansen.screenTokens(chains, timeframe, 25);
    spinner.succeed(chalk.gray(`${tokens.length} tokens`));
    printScreenerTable(tokens, timeframe);

    if (options.deliver) {
      const veil = new VeilClient(config);
      try {
        await veil.register();
        const lines = [`🎯 SCREENER RESULTS (${timeframe.toUpperCase()}) — ${new Date().toUTCString()}`, ''];
        tokens.slice(0, 10).forEach((t, i) => {
          const flow = t.netflow || 0;
          const abs = Math.abs(flow);
          const absStr = abs >= 1e9 ? `$${(abs / 1e9).toFixed(1)}B` : abs >= 1e6 ? `$${(abs / 1e6).toFixed(1)}M` : abs >= 1e3 ? `$${(abs / 1e3).toFixed(0)}K` : `$${abs.toFixed(0)}`;
          const sign = flow >= 0 ? '+' : '-';
          lines.push(`#${i + 1} ${(t.token_symbol || '?').padEnd(10)} ${sign}${absStr.padStart(8)}  ${t.nof_buyers || 0} buyers  ${formatUsd(t.market_cap_usd || 0)} cap`);
        });
        lines.push('', 'via Nansen Oracle × Veil  |  msg.voidly.ai');
        await veil.sendDM(config.veilDid, lines.join('\n'));
        printDelivery(config.veilDid, true);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.yellow(`\n  ⚠  Veil delivery failed: ${msg}`));
        printDelivery(config.veilDid, false);
      }
    }
  } catch (err: unknown) {
    spinner.fail(chalk.red(`Screener failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
