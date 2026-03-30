import chalk from 'chalk';
import ora from 'ora';
import { VeilClient } from '../veil.js';
import { NansenClient } from '../nansen.js';
import { OracleConfig, saveConfig } from '../config.js';
import { header, section, formatUsd } from '../display.js';

const VALID_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function createChannel(
  name: string,
  config: OracleConfig,
  options: { gate?: string; minBalance?: number; topic?: string },
): Promise<void> {
  // Validate name
  const trimmedName = name.trim();
  if (!trimmedName) {
    console.error(chalk.red('\n  ✗ Channel name cannot be empty\n'));
    process.exit(1);
  }
  if (trimmedName.length > 60) {
    console.error(chalk.red(`\n  ✗ Channel name too long (${trimmedName.length} chars). Maximum is 60.\n`));
    process.exit(1);
  }

  // Validate gate options
  if (options.gate !== undefined) {
    if (!VALID_EVM_ADDRESS.test(options.gate)) {
      console.error(chalk.red(`\n  ✗ Invalid gate token address: "${options.gate}" (must be 0x... 42-char EVM address)\n`));
      process.exit(1);
    }
    const parsedBalance = Number(options.minBalance);
    if (options.minBalance !== undefined && (!Number.isInteger(parsedBalance) || parsedBalance < 0)) {
      console.error(chalk.red(`\n  ✗ --min-balance must be a non-negative integer (got: "${options.minBalance}")\n`));
      process.exit(1);
    }
  }

  const veil = new VeilClient(config);

  console.log(header('NANSEN ORACLE  |  CREATE CHANNEL'));
  console.log();

  const spinner = ora({ text: chalk.gray('Creating channel on Veil...'), spinner: 'dots' }).start();

  try {
    await veil.register();
    const topic = options.topic || `Smart money alerts channel — powered by Nansen Oracle`;
    const channel = await veil.createChannel(trimmedName, topic);

    // Save channel config — store display name, not the slug
    config.channels.push({
      id: channel.id,
      name: channel.displayName || trimmedName,
      gateToken: options.gate,
      gateMinBalance: options.minBalance,
      watchlist: [],
    });
    saveConfig(config);

    spinner.succeed(chalk.green(`Channel created: "${trimmedName}" (slug: ${channel.name})`));

    console.log();
    console.log(chalk.gray('  Channel ID:  ') + chalk.white(channel.id));
    console.log(chalk.gray('  Join link:   ') + chalk.cyan.bold(veil.getJoinLink(channel.id)));

    if (options.gate) {
      console.log();
      console.log(chalk.yellow.bold('  🔒 TOKEN-GATED'));
      console.log(chalk.gray(`  Token:       `) + chalk.white(options.gate));
      console.log(chalk.gray(`  Min balance: `) + chalk.white(String(options.minBalance ?? 0)));
      console.log(chalk.gray(`  Gate check:  `) + chalk.gray('Oracle bot verifies on join (run: nansen-oracle bot start)'));
    }

    console.log();
    console.log(chalk.gray('  Share on Twitter/Telegram:'));
    console.log(chalk.white(`  "${trimmedName}" — private alpha channel with live Nansen smart money alerts`));
    console.log(chalk.white(`  Join: ${veil.getJoinLink(channel.id)}`));
    console.log();
    console.log(chalk.gray('  Next steps:'));
    console.log(chalk.gray('  • Start the oracle bot in this channel: ') + chalk.white(`nansen-oracle bot start --channel ${channel.id}`));
    console.log(chalk.gray('  • Post a message: ') + chalk.white(`nansen-oracle channel post "${channel.id}" "Welcome to ${trimmedName}!"`));

  } catch (err: unknown) {
    spinner.fail(chalk.red(`Failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export async function postToChannel(
  channelIdOrName: string,
  message: string,
  config: OracleConfig,
): Promise<void> {
  const veil = new VeilClient(config);

  // Resolve channel ID from name or ID
  const ch = config.channels.find(c => c.id === channelIdOrName || c.name === channelIdOrName);
  const channelId = ch?.id || channelIdOrName;

  const spinner = ora({ text: chalk.gray('Posting...'), spinner: 'dots' }).start();

  try {
    await veil.register();
    await veil.postToChannel(channelId, message);
    spinner.succeed(chalk.green(`Posted to "${ch?.name || channelId}"`));
  } catch (err: unknown) {
    spinner.fail(chalk.red(`Post failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export async function listChannels(config: OracleConfig): Promise<void> {
  const veil = new VeilClient(config);

  console.log(header('NANSEN ORACLE  |  MY CHANNELS'));
  console.log();

  if (config.channels.length === 0) {
    console.log(chalk.gray('  No channels yet. Create one:'));
    console.log(chalk.white('  nansen-oracle channel create "Whale Alerts"'));
    return;
  }

  for (const ch of config.channels) {
    console.log(chalk.cyan.bold(`  📡 ${ch.name}`));
    console.log(chalk.gray(`     ID:   `) + chalk.white(ch.id));
    console.log(chalk.gray(`     Link: `) + chalk.white(veil.getJoinLink(ch.id)));
    if (ch.gateToken) {
      console.log(chalk.gray(`     Gate: `) + chalk.yellow(`${ch.gateToken.slice(0, 10)}... min ${ch.gateMinBalance}`));
    }
    console.log();
  }
}

export async function checkGate(
  channelId: string,
  walletAddress: string,
  config: OracleConfig,
): Promise<boolean> {
  const ch = config.channels.find(c => c.id === channelId);
  if (!ch || !ch.gateToken) return true; // no gate = open

  const nansen = new NansenClient(config.nansenApiKey || process.env.NANSEN_API_KEY || '');

  const balance = await nansen.checkTokenBalance(walletAddress, ch.gateToken);
  const required = ch.gateMinBalance || 0;

  return balance >= required;
}
