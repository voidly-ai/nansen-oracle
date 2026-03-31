'use strict';
const { VoidlyAgent } = require('@voidly/agent-sdk');
const fs = require('fs'), os = require('os'), path = require('path');
const saved = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.voidly/agent.json'), 'utf8'));
const agent = VoidlyAgent.fromCredentials({ did: saved.did, apiKey: saved.apiKey, signingSecretKey: saved.signingSecretKey, encryptionSecretKey: saved.encryptionSecretKey }, { baseUrl: 'https://api.voidly.ai' });
const BOT = 'did:voidly:7pd74J7Fp5q328LkS5SL1G';

(async () => {
  // Drain inbox first
  const drain = await agent.receive({ unreadOnly: true });
  for (const m of drain) await agent.markRead(m.id).catch(() => {});

  const tests = ['!help', '!screen', '!wallet', '!flows', '!alpha'];
  for (const cmd of tests) {
    await agent.send(BOT, cmd);
    await new Promise(r => setTimeout(r, 8000));
    const msgs = await agent.receive({ unreadOnly: true });
    const reply = msgs.map(m => { agent.markRead(m.id).catch(() => {}); return m.content; }).join('');
    console.log(`\n=== ${cmd} ===`);
    console.log(reply || '(no reply)');
  }
})().catch(console.error);
