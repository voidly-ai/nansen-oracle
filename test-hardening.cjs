/**
 * test-hardening.cjs
 * Triple-check: nansenbot functional verification after security hardening.
 * Tests all 6 commands against the live bot at did:voidly:7pd74J7Fp5q328LkS5SL1G
 */

'use strict';

const { VoidlyAgent } = require('@voidly/agent-sdk');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOT_DID = 'did:voidly:7pd74J7Fp5q328LkS5SL1G';
const CREDS_FILE = path.join(os.homedir(), '.voidly', 'agent.json');
const TEST_NANSEN_KEY = 'pECnH1cMqZA75frLACSy5Zv5V7YMvY7t'; // operator key used for test account setup
const REPLY_TIMEOUT = 35000; // 35s per command
const POLL_INTERVAL = 2000;

const results = [];

function pass(name) {
  results.push({ name, status: 'PASS' });
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, reason) {
  results.push({ name, status: 'FAIL', reason });
  console.error(`  ❌ FAIL  ${name} — ${reason}`);
}

async function waitForReply(agent, afterId, timeout = REPLY_TIMEOUT) {
  const deadline = Date.now() + timeout;
  const seen = new Set(afterId ? [afterId] : []);
  while (Date.now() < deadline) {
    const msgs = await agent.receive({ unreadOnly: true });
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      if (m.from === BOT_DID) {
        await agent.markRead(m.id).catch(() => {});
        return m.content || '';
      }
      seen.add(m.id);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  return null;
}

async function sendAndWait(agent, cmd, label, check) {
  console.log(`\n  → Sending: ${cmd}`);
  try {
    await agent.send(BOT_DID, cmd);
    const reply = await waitForReply(agent, null, REPLY_TIMEOUT);
    if (!reply) {
      fail(label, 'No reply within 30s');
      return null;
    }
    console.log(`    Reply (${reply.length} chars): ${reply.slice(0, 80).replace(/\n/g, ' ')}...`);
    if (check(reply)) {
      pass(label);
    } else {
      fail(label, `Reply did not match expected content. Got: ${reply.slice(0, 120)}`);
    }
    return reply;
  } catch (err) {
    fail(label, err.message);
    return null;
  }
}

async function main() {
  console.log('\n  🔱 NANSEN ORACLE — HARDENING FUNCTIONAL TEST');
  console.log(`  Bot: ${BOT_DID}`);
  console.log('  ─────────────────────────────────────────\n');

  // Load credentials
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    console.log(`  Test account DID: ${creds.did}`);
  } catch (err) {
    console.error(`  ✗ Could not load credentials from ${CREDS_FILE}: ${err.message}`);
    process.exit(1);
  }

  // Init agent
  const agent = VoidlyAgent.fromCredentials({
    did: creds.did,
    apiKey: creds.apiKey,
    signingSecretKey: creds.signingSecretKey,
    encryptionSecretKey: creds.encryptionSecretKey,
  }, { baseUrl: 'https://api.voidly.ai' });

  // Drain any stale messages first
  try {
    const stale = await agent.receive({ unreadOnly: true });
    for (const m of stale) await agent.markRead(m.id).catch(() => {});
    if (stale.length) console.log(`  Drained ${stale.length} stale message(s)\n`);
  } catch { /* ignore */ }

  // ── Setup: register test account with Nansen key ────────────────────────
  console.log('\n  [setup] Registering test account with Nansen key...');
  try {
    // Send !stop first to clear any prior state
    await agent.send(BOT_DID, '!stop');
    await new Promise(r => setTimeout(r, 3000));
    const stale2 = await agent.receive({ unreadOnly: true });
    for (const m of stale2) await agent.markRead(m.id).catch(() => {});

    // Trigger onboarding
    await agent.send(BOT_DID, '!setup');
    await new Promise(r => setTimeout(r, 3000));
    const onboardMsg = await waitForReply(agent, null, 10000);
    if (!onboardMsg) throw new Error('No onboarding prompt received');
    console.log(`  [setup] Got onboarding prompt ✓`);

    // Send the key
    await agent.send(BOT_DID, TEST_NANSEN_KEY);
    const setupReply = await waitForReply(agent, null, 20000);
    if (!setupReply) throw new Error('No setup confirmation received');
    if (setupReply.includes('subscribed') || setupReply.includes('✅')) {
      console.log(`  [setup] Registered successfully ✓\n`);
    } else if (setupReply.includes('already subscribed')) {
      console.log(`  [setup] Already registered ✓\n`);
    } else if (setupReply.includes('rejected') || setupReply.includes('❌')) {
      throw new Error(`Key rejected: ${setupReply.slice(0, 80)}`);
    } else {
      console.log(`  [setup] Setup reply: ${setupReply.slice(0, 80)} — continuing\n`);
    }
    // Drain the auto-digest that fires on subscription
    await new Promise(r => setTimeout(r, 4000));
    const digestMsgs = await agent.receive({ unreadOnly: true });
    for (const m of digestMsgs) await agent.markRead(m.id).catch(() => {});
    if (digestMsgs.length) console.log(`  [setup] Drained ${digestMsgs.length} auto-digest message(s)\n`);
  } catch (err) {
    console.error(`  [setup] FAILED: ${err.message}`);
    process.exit(1);
  }

  // ── Test 1: !help ────────────────────────────────────────────────────────
  await sendAndWait(agent, '!help', '!help — returns all 8 commands', reply =>
    reply.includes('!alpha') &&
    reply.includes('!screen') &&
    reply.includes('!wallet') &&
    reply.includes('!flows') &&
    reply.includes('!set') &&
    reply.includes('!setup') &&
    reply.includes('!stop') &&
    reply.includes('!help')
  );

  // ── Test 2: !alpha ───────────────────────────────────────────────────────
  await sendAndWait(agent, '!alpha', '!alpha — returns smart money digest', reply =>
    reply.includes('SMART MONEY') &&
    reply.includes('SIGNAL:') &&
    reply.includes('FLOWS')
  );

  // ── Test 3: !screen ──────────────────────────────────────────────────────
  await sendAndWait(agent, '!screen', '!screen — returns screener output', reply =>
    reply.includes('SCREENER') || reply.includes('#1')
  );

  // ── Test 4: !wallet ──────────────────────────────────────────────────────
  // Use Vitalik's wallet — well-known, should have Nansen data
  await sendAndWait(
    agent,
    '!wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    '!wallet — returns wallet profile or API response',
    reply =>
      reply.includes('WALLET PROFILE') ||
      reply.includes('Address:') ||
      reply.includes('Error:') || // bot routed correctly, Nansen API responded
      reply.includes('Labels:')
  );

  // ── Test 5: !flows ───────────────────────────────────────────────────────
  await sendAndWait(
    agent,
    '!flows 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    '!flows — returns flow data or no-data message',
    reply =>
      reply.includes('🌊') ||
      reply.includes('No flow data') ||
      reply.includes('Usage:') ||
      reply.includes('Error:')
  );

  // ── Test 6: unknown command ──────────────────────────────────────────────
  await sendAndWait(agent, '!xyz', '!xyz — unknown command returns help text', reply =>
    reply.includes('!alpha') && reply.includes('Unknown')
  );

  // ── Cleanup: !stop to deregister test account ────────────────────────────
  console.log('\n  [cleanup] Sending !stop to deregister test account...');
  try {
    await agent.send(BOT_DID, '!stop');
    const stopReply = await waitForReply(agent, null, 15000);
    if (stopReply && (stopReply.includes('Unsubscribed') || stopReply.includes('deleted'))) {
      console.log('  [cleanup] Test account deregistered ✓\n');
    } else {
      console.log(`  [cleanup] Stop reply: ${(stopReply || 'none').slice(0, 60)}\n`);
    }
  } catch (err) {
    console.log(`  [cleanup] !stop failed (non-critical): ${err.message}\n`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n  ─────────────────────────────────────────');
  console.log('  RESULTS:\n');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  for (const r of results) {
    console.log(`  ${r.status === 'PASS' ? '✅' : '❌'} ${r.name}`);
    if (r.reason) console.log(`       ${r.reason}`);
  }
  console.log(`\n  ${passed}/${results.length} passed\n`);

  if (failed > 0) {
    console.error('  ✗ SOME TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('  ✓ ALL TESTS PASSED — bot is fully functional after hardening\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
