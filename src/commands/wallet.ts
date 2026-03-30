import chalk from 'chalk';
import ora from 'ora';
import { NansenClient, normalizeProfilerTx } from '../nansen.js';
import { OracleConfig } from '../config.js';
import { header, printWalletTable, printTradesTable, section, formatUsd } from '../display.js';

export async function runWallet(
  address: string,
  config: OracleConfig,
  options: { chain?: string },
): Promise<void> {
  const apiKey = config.nansenApiKey || process.env.NANSEN_API_KEY || '';
  if (!apiKey) {
    console.error(chalk.red('\n  ✗ No Nansen API key. Run: nansen-oracle init --key YOUR_KEY'));
    process.exit(1);
  }

  if (!address.startsWith('0x') || address.length !== 42) {
    console.error(chalk.red(`\n  ✗ Invalid address: ${address} (must be 0x... EVM address)`));
    process.exit(1);
  }

  const nansen = new NansenClient(apiKey);
  const chain = options.chain || 'ethereum';

  console.log(header('NANSEN ORACLE  |  WALLET PROFILE'));
  console.log();

  const spinner = ora({ text: chalk.gray('Fetching wallet data...'), spinner: 'dots' }).start();

  try {
    const [balances, labels, txns] = await Promise.all([
      nansen.getWalletBalances(address, chain),
      nansen.getWalletLabels(address, chain).catch(() => []),
      nansen.getWalletTransactions(address, chain, 10).catch(() => []),
    ]);

    spinner.succeed(chalk.gray(`${balances.length} positions, ${labels.length} labels, ${txns.length} recent txns`));

    printWalletTable(address, labels, balances);

    // Convert profiler transactions to normalised TradeEvent for display
    const trades = txns.map(normalizeProfilerTx).filter(t => t.value_usd > 0);
    if (trades.length > 0) {
      printTradesTable(trades, 'Recent Transactions (7D)');
    }

    const totalValue = balances.reduce((sum, b) => sum + (b.value_usd || 0), 0);
    console.log();
    console.log(chalk.gray('  Portfolio value: ') + chalk.green.bold(formatUsd(totalValue)));

    const isSmartMoney = labels.some(l =>
      ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'].includes(l.label),
    );
    if (isSmartMoney) {
      console.log(chalk.cyan.bold('  ⚡ Nansen Smart Money wallet'));
    }
    if (labels.some(l => l.label === 'Fund')) {
      console.log(chalk.yellow.bold('  🏛  Labeled as a Fund'));
    }
    if (labels.some(l => l.label === 'Whale')) {
      console.log(chalk.magenta.bold('  🐋 Labeled as a Whale'));
    }
    console.log();

  } catch (err: unknown) {
    spinner.fail(chalk.red(`Wallet lookup failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
