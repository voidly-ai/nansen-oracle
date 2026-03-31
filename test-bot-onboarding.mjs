/**
 * E2E test for Nansen Oracle Bot onboarding flow.
 *
 * Simulates a new user DMing the bot, submitting a Nansen key,
 * receiving the welcome message, and running !alpha.
 *
 * Prerequisites:
 *   - Bot must be running: nansen-oracle bot start
 *   - BOT_DID must match config.veilDid
 *   - TESTER_KEY is a separate registered agent key
 *
 * Usage:
 *   BOT_DID=did:voidly:7pd74J7Fp5q328LkS5SL1G \
 *   NANSEN_KEY=your_nansen_key \
 *   node test-bot-onboarding.mjs
 */

import { VoidlyAgent } from '@voidly/agent-sdk';

const BOT_DID = process.env.BOT_DID || 'did:voidly:7pd74J7Fp5q328LkS5SL1G';
const NANSEN_KEY = process.env.NANSEN_KEY;
const RELAY = 'https://api.voidly.ai';

if (!NANSEN_KEY) {
  console.error('Usage: NANSEN_KEY=<key> node test-bot-onboarding.mjs');
  process.exit(1);
}

// Fresh agent — simulates a new user
const tester = new VoidlyAgent({ relay: RELAY });
await tester.register({ name: 'onboarding-tester' });
console.log(`Tester DID: ${tester.did}`);

function waitForReply(agent, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Timeout waiting for reply')), timeoutMs);
    const iv = setInterval(async () => {
      try {
        const msgs = await agent.receive();
        if (msgs.length > 0) {
          clearInterval(iv);
          clearTimeout(deadline);
          resolve(msgs[msgs.length - 1].content);
        }
      } catch { /* retry */ }
    }, 1500);
  });
}

async function run() {
  console.log('\n── STEP 1: Send first message (trigger onboarding) ──');
  await tester.send(BOT_DID, 'hello');
  const prompt = await waitForReply(tester);
  console.log('Bot replied:\n', prompt.slice(0, 200));
  if (!prompt.includes('Nansen API key')) throw new Error('Expected onboarding prompt');
  console.log('✓ Onboarding prompt received');

  console.log('\n── STEP 2: Submit Nansen key ──');
  await tester.send(BOT_DID, NANSEN_KEY);
  const welcome = await waitForReply(tester, 30000); // validation takes a few seconds
  console.log('Bot replied:\n', welcome.slice(0, 400));
  if (!welcome.includes("You're in") && !welcome.includes('Unsubscrib')) {
    throw new Error(`Unexpected response: ${welcome.slice(0, 100)}`);
  }
  console.log('✓ Key accepted, subscribed');

  // First digest should arrive automatically — wait for it
  console.log('\n── STEP 3: Wait for first digest ──');
  const digest = await waitForReply(tester, 60000);
  console.log('Digest preview:\n', digest.slice(0, 300));
  if (!digest.includes('SMART MONEY') && !digest.includes('ALPHA')) {
    throw new Error('Expected alpha digest');
  }
  console.log('✓ Digest received');

  console.log('\n── STEP 4: !alpha command ──');
  await tester.send(BOT_DID, '!alpha');
  const alpha = await waitForReply(tester, 30000);
  console.log('Alpha preview:\n', alpha.slice(0, 300));
  console.log('✓ !alpha works');

  console.log('\n── STEP 5: !stop ──');
  await tester.send(BOT_DID, '!stop');
  const goodbye = await waitForReply(tester);
  console.log('Bot replied:', goodbye.slice(0, 100));
  if (!goodbye.includes('Unsubscribed')) throw new Error('Expected unsubscribe confirmation');
  console.log('✓ Unsubscribed');

  console.log('\n✅ All steps passed');
}

run().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
