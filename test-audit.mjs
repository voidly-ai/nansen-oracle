/**
 * Comprehensive audit test for Nansen Oracle Bot.
 * Tests all edge cases, failure modes, and security scenarios.
 *
 * Usage: node test-audit.mjs
 */

import { VoidlyAgent } from '@voidly/agent-sdk';

const BOT_DID = 'did:voidly:7pd74J7Fp5q328LkS5SL1G';
const RELAY = 'https://api.voidly.ai';

let passed = 0;
let failed = 0;
const issues = [];

function log(msg) { console.log(`  ${msg}`); }
function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; issues.push({ label, reason }); console.log(`  ❌ ${label}: ${reason}`); }
function section(title) { console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`); }

async function waitForReply(agent, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await agent.receive({ unreadOnly: true });
    if (msgs.length > 0) {
      // Mark all read
      for (const m of msgs) {
        try { await agent.markRead?.(m.id); } catch {}
      }
      return msgs[msgs.length - 1].content;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for reply`);
}

async function waitForNoReply(agent, waitMs = 5000) {
  await new Promise(r => setTimeout(r, waitMs));
  const msgs = await agent.receive({ unreadOnly: true });
  return msgs.length === 0;
}

async function newAgent(name) {
  const a = await VoidlyAgent.register({ name }, { baseUrl: RELAY });
  log(`Registered: ${a.did} as ${name}`);
  return a;
}

// ── FLOW 1: New user — hello triggers onboarding ─────────────────────────────
section('FLOW 1: New user triggers onboarding');
let user1;
try {
  user1 = await newAgent('audit-user1');
  await user1.send(BOT_DID, 'hello');
  const reply = await waitForReply(user1);
  log(`Reply: ${reply.slice(0, 120)}...`);
  if (reply.includes('Nansen API key') || reply.includes('app.nansen.ai')) {
    ok('hello → ONBOARDING_PROMPT');
  } else {
    fail('hello → ONBOARDING_PROMPT', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('hello → ONBOARDING_PROMPT', e.message);
}

// ── FLOW 2: !help before onboarding ──────────────────────────────────────────
section('FLOW 2: !help before onboarding');
let user2;
try {
  user2 = await newAgent('audit-user2');
  await user2.send(BOT_DID, '!help');
  const reply = await waitForReply(user2);
  log(`Reply: ${reply.slice(0, 200)}...`);
  if (reply.includes('!alpha') && reply.includes('!stop')) {
    ok('!help before onboarding → HELP_TEXT');
  } else {
    fail('!help before onboarding → HELP_TEXT', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('!help before onboarding → HELP_TEXT', e.message);
}

// ── FLOW 3: !stop before onboarding ──────────────────────────────────────────
section('FLOW 3: !stop before onboarding (no user record)');
let user3;
try {
  user3 = await newAgent('audit-user3');
  await user3.send(BOT_DID, '!stop');
  const reply = await waitForReply(user3);
  log(`Reply: ${reply.slice(0, 200)}`);
  // !stop goes through the switch, user=null → triggers onboarding prompt before reaching switch
  // Actually: user is null, content starts with '!', so it falls to command routing
  // cmd='!stop', user=null → hits "if (!user)" → sets onboarding, returns onboarding prompt
  // OR: if !stop is routed in switch before the null user check, returns Unsubscribed
  // Let's see what actually happens
  if (reply.includes('Unsubscribed') || reply.includes('key') || reply.includes('command')) {
    ok('!stop before onboarding → sensible response');
    log(`  Details: "${reply.slice(0, 80)}"`);
  } else {
    fail('!stop before onboarding → sensible response', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('!stop before onboarding', e.message);
}

// ── FLOW 4: !start as first message ──────────────────────────────────────────
section('FLOW 4: !start as first message');
let user4;
try {
  user4 = await newAgent('audit-user4');
  await user4.send(BOT_DID, '!start');
  const reply = await waitForReply(user4);
  log(`Reply: ${reply.slice(0, 150)}`);
  if (reply.includes('Nansen API key') || reply.includes('app.nansen.ai')) {
    ok('!start → onboarding prompt');
  } else {
    fail('!start → onboarding prompt', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('!start as first message', e.message);
}

// ── FLOW 5: Short key (< 8 chars) ────────────────────────────────────────────
section('FLOW 5: Short key rejection during onboarding');
let user5;
try {
  user5 = await newAgent('audit-user5');
  // Trigger onboarding first
  await user5.send(BOT_DID, 'hello');
  await waitForReply(user5);
  // Send short key
  await user5.send(BOT_DID, 'abc');
  const reply = await waitForReply(user5);
  log(`Reply: ${reply.slice(0, 150)}`);
  if (reply.includes("doesn't look like") || reply.includes('alphanumeric')) {
    ok('short key → rejection message');
  } else {
    fail('short key → rejection message', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('short key rejection', e.message);
}

// ── FLOW 6: Invalid key (looks like key but rejected by Nansen) ───────────────
section('FLOW 6: Invalid Nansen key during onboarding');
let user6;
try {
  user6 = await newAgent('audit-user6');
  await user6.send(BOT_DID, 'hello');
  await waitForReply(user6);
  // Send fake key — Nansen unreachable from our test = 'error', NOT 'invalid'
  // A fake key format should get us either 'invalid' or 'error' response
  await user6.send(BOT_DID, 'notavalidkey123456789abcdef');
  const reply = await waitForReply(user6, 35000); // allow time for Nansen call
  log(`Reply: ${reply.slice(0, 200)}`);
  if (reply.includes('rejected') || reply.includes("Couldn't reach") || reply.includes('Error')) {
    ok('invalid/unreachable key → appropriate response');
    log(`  Path: ${reply.includes('rejected') ? 'invalid (401/403)' : "error (network/other)"}`);
  } else {
    fail('invalid key → appropriate response', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('invalid key handling', e.message);
}

// ── FLOW 7: !HELP uppercase ───────────────────────────────────────────────────
section('FLOW 7: Case sensitivity (!HELP, !Alpha)');
let user7;
try {
  user7 = await newAgent('audit-user7');
  await user7.send(BOT_DID, '!HELP');
  const reply = await waitForReply(user7);
  log(`!HELP reply: ${reply.slice(0, 100)}`);
  if (reply.includes('!alpha') || reply.includes('!stop')) {
    ok('!HELP → HELP_TEXT (case-insensitive)');
  } else {
    fail('!HELP case-insensitive', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('!HELP case-insensitive', e.message);
}

// ── FLOW 8: Unknown command ───────────────────────────────────────────────────
section('FLOW 8: Unknown command');
let user8;
try {
  user8 = await newAgent('audit-user8');
  // First get past onboarding by using !help (doesn't need key)
  await user8.send(BOT_DID, '!unknown');
  const reply = await waitForReply(user8);
  log(`Reply: ${reply.slice(0, 150)}`);
  // !unknown: user=null, content starts with '!' → falls to "if (!user)" → onboarding prompt
  // (because no user and !start/!help/!setup not matched)
  if (reply.includes('Nansen API key') || reply.includes('Unknown command') || reply.includes('key first')) {
    ok('!unknown → onboarding or unknown-command message');
    log(`  Path: ${reply.includes('Unknown command') ? 'unknown-cmd branch' : 'onboarding required'}`);
  } else {
    fail('!unknown command', `Got: ${reply.slice(0, 80)}`);
  }
} catch (e) {
  fail('!unknown command', e.message);
}

// ── FLOW 9: Garbage inputs ────────────────────────────────────────────────────
section('FLOW 9: Garbage inputs');
let user9;
try {
  user9 = await newAgent('audit-user9');
  // First send to trigger onboarding
  await user9.send(BOT_DID, 'hello');
  const onboard = await waitForReply(user9);
  log(`Got onboarding: ${onboard.slice(0,50)}...`);

  // Test emoji input while in 'awaiting_key' state
  await user9.send(BOT_DID, '🔥💎🚀');
  const emojiReply = await waitForReply(user9, 35000);
  log(`Emoji reply: ${emojiReply.slice(0, 100)}`);
  if (emojiReply.includes("doesn't look like") || emojiReply.includes('rejected') || emojiReply.includes("Couldn't reach")) {
    ok('emoji input during onboarding → handled gracefully');
  } else {
    fail('emoji input during onboarding', `Got: ${emojiReply.slice(0, 80)}`);
  }
} catch (e) {
  fail('garbage inputs', e.message);
}

// ── FLOW 10: SQL injection attempt ───────────────────────────────────────────
section('FLOW 10: Injection attempt in command');
let user10;
try {
  user10 = await newAgent('audit-user10');
  // Trigger onboarding then send SQL injection as key attempt
  await user10.send(BOT_DID, 'hello');
  await waitForReply(user10);
  await user10.send(BOT_DID, "'; DROP TABLE users; --");
  const reply = await waitForReply(user10, 35000);
  log(`SQL injection reply: ${reply.slice(0, 150)}`);
  if (reply.length > 0) {
    ok('SQL injection → bot responds without crashing');
  } else {
    fail('SQL injection handling', 'No reply received');
  }
} catch (e) {
  fail('SQL injection handling', e.message);
}

// ── FLOW 11: Concurrent users ─────────────────────────────────────────────────
section('FLOW 11: Concurrent users sending simultaneously');
try {
  const [ua, ub, uc] = await Promise.all([
    newAgent('audit-concurrent-a'),
    newAgent('audit-concurrent-b'),
    newAgent('audit-concurrent-c'),
  ]);
  await Promise.all([
    ua.send(BOT_DID, 'hello'),
    ub.send(BOT_DID, '!help'),
    uc.send(BOT_DID, 'hello'),
  ]);
  const [ra, rb, rc] = await Promise.all([
    waitForReply(ua, 20000),
    waitForReply(ub, 20000),
    waitForReply(uc, 20000),
  ]);
  log(`A got: ${ra.slice(0, 50)}...`);
  log(`B got: ${rb.slice(0, 50)}...`);
  log(`C got: ${rc.slice(0, 50)}...`);
  if (ra.includes('Nansen') && rb.includes('!alpha') && rc.includes('Nansen')) {
    ok('concurrent users → each gets correct response');
  } else {
    fail('concurrent users', `A="${ra.slice(0,40)}" B="${rb.slice(0,40)}" C="${rc.slice(0,40)}"`);
  }
} catch (e) {
  fail('concurrent users', e.message);
}

// ── FLOW 12: !stop during onboarding ─────────────────────────────────────────
section('FLOW 12: !stop during onboarding (cleans up state)');
let user12;
try {
  user12 = await newAgent('audit-user12');
  // Trigger onboarding
  await user12.send(BOT_DID, 'hello');
  await waitForReply(user12);
  // Now send !stop — should clean up onboarding state
  await user12.send(BOT_DID, '!stop');
  const stopReply = await waitForReply(user12);
  log(`!stop reply: ${stopReply.slice(0, 150)}`);

  // After !stop, send hello again — should get onboarding prompt (not stuck)
  await user12.send(BOT_DID, 'hello');
  const helloReply = await waitForReply(user12);
  log(`Post-stop hello: ${helloReply.slice(0, 100)}`);
  if (helloReply.includes('Nansen API key') || helloReply.includes('app.nansen.ai')) {
    ok('!stop during onboarding → cleans state, hello works again');
  } else {
    fail('!stop during onboarding state cleanup', `Post-stop hello got: ${helloReply.slice(0,80)}`);
  }
} catch (e) {
  fail('!stop during onboarding', e.message);
}

// ── FLOW 13: Double !stop ─────────────────────────────────────────────────────
section('FLOW 13: Double !stop (idempotent)');
let user13;
try {
  user13 = await newAgent('audit-user13');
  await user13.send(BOT_DID, '!stop');
  const r1 = await waitForReply(user13);
  log(`First !stop: ${r1.slice(0, 100)}`);
  await user13.send(BOT_DID, '!stop');
  const r2 = await waitForReply(user13);
  log(`Second !stop: ${r2.slice(0, 100)}`);
  // Should not crash — just handle gracefully
  if (r2.length > 0) {
    ok('double !stop → no crash, sensible response');
  } else {
    fail('double !stop', 'No response to second !stop');
  }
} catch (e) {
  fail('double !stop', e.message);
}

// ── FLOW 14: Whitespace-only message ─────────────────────────────────────────
section('FLOW 14: Whitespace/empty-like input');
let user14;
try {
  user14 = await newAgent('audit-user14');
  // "   " — should trigger onboarding (content.trim() = '' + no '!' = onboarding)
  // Actually content.trim() === '' → no length check, treated as non-command
  // user=null, content.trim()=' '.trim()='' doesn't start with '!' → set onboarding
  await user14.send(BOT_DID, '   ');
  const reply = await waitForReply(user14);
  log(`Whitespace reply: ${reply.slice(0, 100)}`);
  if (reply.includes('Nansen') || reply.length > 0) {
    ok('whitespace message → triggers onboarding or empty response');
  } else {
    fail('whitespace message', 'No response');
  }
} catch (e) {
  fail('whitespace message', e.message);
}

// ── Wait for logs then check ──────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 3000));

// ── Summary ───────────────────────────────────────────────────────────────────
section('AUDIT SUMMARY');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (issues.length > 0) {
  console.log('\n  Issues found:');
  issues.forEach(({ label, reason }) => console.log(`    ✗ ${label}: ${reason}`));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
