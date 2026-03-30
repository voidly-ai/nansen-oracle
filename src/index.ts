#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { ensureConfig, loadConfig, saveConfig, generateVeilKeys, OracleConfig } from './config.js';
import { runAlpha } from './commands/alpha.js';
import { runScreen } from './commands/screen.js';
import { runWatch } from './commands/watch.js';
import { runWallet } from './commands/wallet.js';
import { createChannel, postToChannel, listChannels } from './commands/channel.js';
import { runDemo } from './commands/demo.js';
import { startBot } from './bot/oracle-bot.js';

const program = new Command();

program
  .name('nansen-oracle')
  .description(
    chalk.cyan('🔱 Smart money signals delivered to your Veil inbox\n') +
    chalk.gray('   Get Nansen alpha before CT does.\n') +
    chalk.gray('   Docs: https://github.com/voidly-ai/nansen-oracle'),
  )
  .version('1.0.0');

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Set up your Nansen API key and Veil identity')
  .option('--key <key>', 'Nansen API key (or set NANSEN_API_KEY env var)')
  .action(async (options) => {
    const config = await ensureConfig();

    if (options.key) {
      config.nansenApiKey = options.key;
      saveConfig(config);
    } else if (process.env.NANSEN_API_KEY) {
      config.nansenApiKey = process.env.NANSEN_API_KEY;
      saveConfig(config);
    }

    console.log(chalk.green.bold('\n  ✓ Nansen Oracle initialized\n'));
    console.log(chalk.gray('  Your Veil DID:   ') + chalk.cyan(config.veilDid));
    console.log(chalk.gray('  Veil inbox:      ') + chalk.white('https://msg.voidly.ai'));
    console.log(chalk.gray('  Config:          ') + chalk.gray('~/.nansen-oracle/config.json'));
    console.log();
    console.log(chalk.gray('  Try: ') + chalk.white('nansen-oracle alpha'));
    console.log();
  });

// ── alpha ─────────────────────────────────────────────────────────────────────

program
  .command('alpha')
  .description('Smart money digest: top flows, hot trades, screener picks → sent to your Veil inbox')
  .option('--chains <chains>', 'Comma-separated chains (default: ethereum,base,solana)')
  .option('--no-deliver', 'Print only, skip Veil delivery')
  .action(async (options) => {
    const config = await ensureConfig();
    await runAlpha(config, options);
  });

// ── screen ────────────────────────────────────────────────────────────────────

program
  .command('screen')
  .description('Token screener — top tokens by smart money inflow')
  .option('--chains <chains>', 'Chains to scan (default: ethereum,base,solana)')
  .option('--timeframe <t>', 'Timeframe: 5m, 1h, 6h, 24h, 7d (default: 24h)')
  .option('--deliver', 'Also send results to your Veil inbox')
  .action(async (options) => {
    const config = await ensureConfig();
    await runScreen(config, {
      chains: options.chains,
      timeframe: options.timeframe as '5m' | '1h' | '6h' | '24h' | '7d',
      deliver: options.deliver,
    });
  });

// ── watch ─────────────────────────────────────────────────────────────────────

const watchCmd = program
  .command('watch')
  .description('Monitor tokens or wallets — alerts sent to your Veil inbox');

watchCmd
  .command('start <address>')
  .description('Start watching a token or wallet address')
  .option('--chain <chain>', 'Chain to monitor (default: ethereum)')
  .option('--type <type>', 'wallet or token (default: wallet)', 'wallet')
  .option('--threshold <usd>', 'Alert threshold in USD (default: 500000)', parseFloat)
  .option('--interval <minutes>', 'Poll interval in minutes (default: 5)', parseInt)
  .option('--veil-did <did>', 'Deliver alerts to a specific Veil DID')
  .action(async (address, options) => {
    const config = await ensureConfig();
    await runWatch(address, config, options);
  });

watchCmd
  .command('list')
  .description('Show all watched addresses')
  .action(async () => {
    const config = await ensureConfig();
    if (!config.watchlist.length) {
      console.log(chalk.gray('\n  No watches yet. Try: nansen-oracle watch start 0xADDRESS\n'));
      return;
    }
    console.log();
    for (const w of config.watchlist) {
      console.log(
        chalk.cyan(`  ${w.type === 'wallet' ? '💼' : '🪙'} ${w.address}`) +
        chalk.gray(`  [${w.chain}]`) +
        (w.threshold ? chalk.gray(`  min $${(w.threshold / 1000).toFixed(0)}K`) : ''),
      );
    }
    console.log();
  });

watchCmd
  .command('remove <address>')
  .description('Remove an address from watchlist')
  .action(async (address) => {
    const config = await ensureConfig();
    const before = config.watchlist.length;
    config.watchlist = config.watchlist.filter(
      w => w.address.toLowerCase() !== address.toLowerCase(),
    );
    if (config.watchlist.length === before) {
      console.log(chalk.yellow(`\n  Not in watchlist: ${address}\n`));
    } else {
      saveConfig(config);
      console.log(chalk.green(`\n  ✓ Removed: ${address}\n`));
    }
  });

// ── wallet ────────────────────────────────────────────────────────────────────

program
  .command('wallet <address>')
  .description('Wallet profile — balances, Nansen labels, recent DEX trades')
  .option('--chain <chain>', 'Chain (default: ethereum)')
  .action(async (address, options) => {
    const config = await ensureConfig();
    await runWallet(address, config, options);
  });

// ── channel ───────────────────────────────────────────────────────────────────

const channelCmd = program
  .command('channel')
  .description('Manage Veil alpha channels');

channelCmd
  .command('create <name>')
  .description('Create a private Veil channel for sharing alpha')
  .option('--gate <token_address>', 'Token-gate: require holders of this token to join')
  .option('--min-balance <amount>', 'Minimum token balance to join', parseFloat)
  .option('--topic <topic>', 'Channel description')
  .action(async (name, options) => {
    const config = await ensureConfig();
    await createChannel(name, config, options);
  });

channelCmd
  .command('post <channel> <message>')
  .description('Post a message to a channel')
  .action(async (channel, message) => {
    const config = await ensureConfig();
    await postToChannel(channel, message, config);
  });

channelCmd
  .command('list')
  .description('List your channels')
  .action(async () => {
    const config = await ensureConfig();
    await listChannels(config);
  });

channelCmd
  .command('delete <channel>')
  .description('Remove a channel from your local config (does not delete it from relay)')
  .action(async (channelArg) => {
    const config = await ensureConfig();
    const before = config.channels.length;
    config.channels = config.channels.filter(
      c => c.id !== channelArg && c.name !== channelArg,
    );
    if (config.channels.length === before) {
      console.log(chalk.yellow(`\n  Channel not found in config: ${channelArg}\n`));
    } else {
      saveConfig(config);
      console.log(chalk.green(`\n  ✓ Removed from config: ${channelArg}\n`));
    }
  });

// ── bot ───────────────────────────────────────────────────────────────────────

const botCmd = program
  .command('bot')
  .description('Run the Oracle bot (listens for DM commands on Veil relay)');

botCmd
  .command('start')
  .description('Start the Oracle bot — answers !alpha, !screen, !wallet, !join commands')
  .option('--channel <id>', 'Also post hourly digests to this channel')
  .action(async (options) => {
    const config = await ensureConfig();
    await startBot(config, options);
  });

// ── whoami ────────────────────────────────────────────────────────────────────

// ── demo ─────────────────────────────────────────────────────────────────────

program
  .command('demo')
  .description('Show a live preview with sample data — no API key needed')
  .action(async () => {
    await runDemo();
  });

// ── reset ─────────────────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Regenerate your Veil identity (new DID + keys). Keeps your Nansen key and channels.')
  .option('--hard', 'Also clear channels and watchlist')
  .action(async (options) => {
    const config = loadConfig();
    const keys = generateVeilKeys();
    const fresh: OracleConfig = {
      nansenApiKey: config?.nansenApiKey || '',
      veilSigningKey: keys.signingKey,
      veilEncryptionKey: keys.encryptionKey,
      veilDid: keys.did,
      veilAgentKey: undefined,
      channels: options.hard ? [] : (config?.channels || []),
      watchlist: options.hard ? [] : (config?.watchlist || []),
      defaultChains: config?.defaultChains || ['ethereum', 'base', 'solana'],
    };
    saveConfig(fresh);
    console.log(chalk.green.bold('\n  ✓ New Veil identity generated\n'));
    console.log(chalk.gray('  New DID: ') + chalk.cyan(fresh.veilDid));
    if (options.hard) console.log(chalk.gray('  Channels and watchlist cleared'));
    console.log();
  });

// ── whoami ─────────────────────────────────────────────────────────────────────

program
  .command('whoami')
  .description('Show your Veil DID and config status')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.log(chalk.yellow('  Not initialized. Run: nansen-oracle init'));
      return;
    }
    console.log();
    console.log(chalk.gray('  DID:      ') + chalk.cyan(config.veilDid));
    console.log(chalk.gray('  Nansen:   ') + (config.nansenApiKey ? chalk.green('configured') : chalk.red('not set')));
    console.log(chalk.gray('  Channels: ') + chalk.white(String(config.channels.length)));
    console.log(chalk.gray('  Watchlist:') + chalk.white(String(config.watchlist.length)));
    console.log(chalk.gray('  Veil:     ') + chalk.white('https://msg.voidly.ai'));
    console.log();
  });

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
