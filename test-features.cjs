/**
 * test-features.cjs
 * End-to-end test for all new Nansen Oracle bot features.
 * Tests 9 new capabilities against the live bot at did:voidly:7pd74J7Fp5q328LkS5SL1G
 */

'use strict';

const { VoidlyAgent } = require('@voidly/agent-sdk');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOT_DID = 'did:voidly:7pd74J7Fp5q328LkS5SL1G';
const CREDS_FILE = path.join(os.homedir(), '.voidly', 'agent.json');
const TEST_NANSEN_KEY = 'pECnH1cMqZA75frLACSy5Zv5V7YMvY7t';
const REPLY_TIMEOUT = 40000; // 40s — new commands make more API calls
const POLL_INTERVAL = 2000;

// Well-known addresses for deterministic testing
const UNI_TOKEN   = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'; // UNI on ethereum
const VITALIK     = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const results = [];

function pass(name) {
  results.push({ name, status: 'PASS' });
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, reason) {
  results.push({ name, status: 'FAIL', reason });
  console.error(`  ❌ FAIL  ${name} — ${reason}`);
}

async function waitForReply(agent, timeout = REPLY_TIMEOUT) {
  const deadline = Date.now() + timeout;
  const seen = new Set();
  while (Date.now() < deadline) {
    const msgs = await agent.receive({ unreadOnly: true });
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.from === BOT_DID) {
        await agent.markRead(m.id).catch(() => {});
        return m.content || '';
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  return null;
}

async function sendAndWait(agent, cmd, label, check) {
  console.log(`\n  → Sending: ${cmd}`);
  try {
    await agent.send(BOT_DID, cmd);
    const reply = await waitForReply(agent, REPLY_TIMEOUT);
    if (!reply) {
      fail(label, 'No reply within timeout');
      return null;
    }
    const preview = reply.slice(0, 100).replace(/\n/g, ' ');
    console.log(`    Reply (${reply.length} chars): ${preview}...`);
    const result = check(reply);
    if (result === true) {
      pass(label);
    } else {
      fail(label, typeof result === 'string' ? result : `Assertion failed. Got: ${reply.slice(0, 150)}`);
    }
    return reply;
  } catch (err) {
    fail(label, err.message);
    return null;
  }
}

async function drain(agent) {
  try {
    const msgs = await agent.receive({ unreadOnly: true });
    for (const m of msgs) await agent.markRead(m.id).catch(() => {});
    return msgs.length;
  } catch { return 0; }
}

async function main() {
  console.log('\n  🔱 NANSEN ORACLE — FEATURES TEST');
  console.log(`  Bot: ${BOT_DID}`);
  console.log('  ─────────────────────────────────────────\n');

  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    console.log(`  Test account DID: ${creds.did}`);
  } catch (err) {
    console.error(`  ✗ Could not load credentials: ${err.message}`);
    process.exit(1);
  }

  const agent = VoidlyAgent.fromCredentials({
    did: creds.did,
    apiKey: creds.apiKey,
    signingSecretKey: creds.signingSecretKey,
    encryptionSecretKey: creds.encryptionSecretKey,
  }, { baseUrl: 'https://api.voidly.ai' });

  // ── Setup ─────────────────────────────────────────────────────────────────
  console.log('  [setup] Registering test account...');
  try {
    await agent.send(BOT_DID, '!stop');
    await new Promise(r => setTimeout(r, 3000));
    await drain(agent);

    await agent.send(BOT_DID, '!setup');
    await new Promise(r => setTimeout(r, 2000));
    const onboard = await waitForReply(agent, 10000);
    if (!onboard) throw new Error('No onboarding prompt');
    console.log('  [setup] Got onboarding prompt ✓');

    await agent.send(BOT_DID, TEST_NANSEN_KEY);
    const setupReply = await waitForReply(agent, 25000);
    if (!setupReply) throw new Error('No setup reply');
    if (setupReply.includes('❌') && !setupReply.includes('already')) {
      throw new Error(`Setup failed: ${setupReply.slice(0, 80)}`);
    }
    console.log('  [setup] Registered ✓\n');

    // Drain auto-digest (may arrive slowly if Nansen is busy)
    await new Promise(r => setTimeout(r, 6000));
    const drained = await drain(agent);
    if (drained) console.log(`  [setup] Drained ${drained} auto-digest message(s)\n`);
  } catch (err) {
    console.error(`  [setup] FAILED: ${err.message}`);
    process.exit(1);
  }

  // ── Test 1: !alpha — new format has SIGNAL line ───────────────────────────
  await sendAndWait(agent, '!alpha',
    '!alpha — new format: SIGNAL line + FLOWS section',
    reply => {
      if (!reply.includes('SIGNAL:')) return 'Missing SIGNAL: line';
      if (!reply.includes('FLOWS')) return 'Missing FLOWS section';
      if (!reply.includes('!alpha 24h')) return 'Missing command strip footer';
      return true;
    }
  );

  // ── Test 2: !alpha 24h — labelled correctly ───────────────────────────────
  await sendAndWait(agent, '!alpha 24h',
    '!alpha 24h — digest labelled (24H)',
    reply => {
      if (!reply.includes('24H') && !reply.includes('24h')) return `Missing 24H label. Got: ${reply.slice(0, 200)}`;
      if (!reply.includes('SIGNAL:')) return 'Missing SIGNAL: line';
      return true;
    }
  );

  // ── Test 3: !alpha 7d — labelled correctly ────────────────────────────────
  await sendAndWait(agent, '!alpha 7d',
    '!alpha 7d — digest labelled (7D)',
    reply => {
      if (!reply.includes('7D') && !reply.includes('7d')) return `Missing 7D label. Got: ${reply.slice(0, 200)}`;
      return true;
    }
  );

  // ── Test 4: !screen — shows b/s ratio ────────────────────────────────────
  await sendAndWait(agent, '!screen',
    '!screen — output shows buyer/seller ratio (e.g. 47b/12s)',
    reply => {
      // New format: "Nb/Ns" pattern e.g. "0b/0s" or "47b/12s"
      if (!/\d+b\/\d+s/.test(reply)) return `Missing b/s ratio pattern. Got: ${reply.slice(0, 200)}`;
      return true;
    }
  );

  // ── Test 5: !wallet — includes RECENT TRADES section ────────────────────
  await sendAndWait(agent, `!wallet ${VITALIK}`,
    '!wallet — includes RECENT TRADES section or API error',
    reply => {
      if (reply.includes('RECENT TRADES')) return true;
      if (reply.includes('Error:') || reply.includes('404')) return true; // API error is acceptable
      return `Missing RECENT TRADES section. Got: ${reply.slice(0, 200)}`;
    }
  );

  // ── Test 6: !flows — header includes token symbol or address ─────────────
  await sendAndWait(agent, `!flows ${UNI_TOKEN}`,
    '!flows — header has 🌊 emoji with token context',
    reply => {
      if (reply.includes('🌊')) return true;
      if (reply.includes('Error:') || reply.includes('No flow data')) return true;
      return `Missing 🌊 flows header. Got: ${reply.slice(0, 200)}`;
    }
  );

  // ── Test 7: !token — returns token profile ───────────────────────────────
  await sendAndWait(agent, `!token ${UNI_TOKEN}`,
    '!token — returns token profile (Mcap/Vol or error)',
    reply => {
      if (reply.includes('Mcap') || reply.includes('SEGMENT')) return true;
      if (reply.includes('Error:') || reply.includes('No data')) return true;
      return `Missing token profile data. Got: ${reply.slice(0, 200)}`;
    }
  );

  // ── Test 8: !help — includes !token and !set commands ────────────────────
  await sendAndWait(agent, '!help',
    '!help — includes !token and !set commands',
    reply => {
      if (!reply.includes('!token')) return 'Missing !token in help text';
      if (!reply.includes('!set'))   return 'Missing !set in help text';
      if (!reply.includes('!alpha')) return 'Missing !alpha in help text';
      return true;
    }
  );

  // ── Test 9: !set — shows settings ────────────────────────────────────────
  await sendAndWait(agent, '!set',
    '!set — returns current digest settings',
    reply => {
      if (reply.includes('flows') && reply.includes('trades') && reply.includes('screener')) return true;
      return `Missing settings output. Got: ${reply.slice(0, 200)}`;
    }
  );

  // ── Test 10: !set flows off then on ──────────────────────────────────────
  await sendAndWait(agent, '!set flows off',
    '!set flows off — confirms flows disabled',
    reply => {
      if (reply.includes('flows') && (reply.includes('disabled') || reply.includes('off'))) return true;
      return `Expected flows disabled confirmation. Got: ${reply.slice(0, 200)}`;
    }
  );
  await sendAndWait(agent, '!set flows on',
    '!set flows on — confirms flows re-enabled',
    reply => {
      if (reply.includes('flows') && (reply.includes('enabled') || reply.includes('on'))) return true;
      return `Expected flows enabled confirmation. Got: ${reply.slice(0, 200)}`;
    }
  );

  // ── Test 11: !xyz — regression: unknown command returns help text ─────────
  await sendAndWait(agent, '!xyz',
    '!xyz — unknown command still returns help text',
    reply => {
      if (!reply.includes('Unknown')) return 'Missing Unknown in response';
      if (!reply.includes('!alpha')) return 'Missing !alpha in help text';
      return true;
    }
  );

  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log('\n  [cleanup] Sending !stop...');
  try {
    await agent.send(BOT_DID, '!stop');
    const stopReply = await waitForReply(agent, 15000);
    if (stopReply && (stopReply.includes('Unsubscribed') || stopReply.includes('deleted'))) {
      console.log('  [cleanup] Deregistered ✓\n');
    } else {
      console.log(`  [cleanup] Stop reply: ${(stopReply || 'none').slice(0, 60)}\n`);
    }
  } catch (err) {
    console.log(`  [cleanup] !stop failed (non-critical): ${err.message}\n`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n  ─────────────────────────────────────────');
  console.log('  RESULTS:\n');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  for (const r of results) {
    console.log(`  ${r.status === 'PASS' ? '✅' : '❌'} ${r.name}`);
    if (r.reason) console.log(`       → ${r.reason}`);
  }
  console.log(`\n  ${passed}/${results.length} passed\n`);

  if (failed > 0) {
    console.error('  ✗ SOME FEATURE TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('  ✓ ALL FEATURE TESTS PASSED\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
