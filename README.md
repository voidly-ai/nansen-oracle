# nansen-oracle

Smart money signals delivered to your private Veil inbox. Get Nansen alpha before CT does.

```
nansen-oracle alpha
```

```
NANSEN ORACLE  |  SMART MONEY DIGEST  |  Mon, 30 Mar 2026

▸ SMART MONEY FLOWS  (1H)
TOKEN    CHAIN     1H FLOW        24H FLOW       TRADERS  SECTOR
ETH      ethereum  ▲ +$47.2M      ▲ +$312.0M     142      Layer 1
SOL      solana    ▲ +$31.8M      ▲  +$89.4M      89      Layer 1
WIF      solana    ▲  +$8.4M      ▲  +$22.1M      34      Meme
PEPE     ethereum  ▼ -$12.4M      ▼  -$44.2M      67      Meme

▸ HOT TRADES  (Smart Money)
Abraxas Fund    0x7a2f...3f1   BUY  ETH   $8.1M   ethereum
Smart Trader    0xb891...cc2   BUY  WIF   $1.4M   solana
DWF Labs        0x44f1...8a3   SELL PEPE  $3.2M   ethereum

▸ SCREENER  (24H)
#1  GRASS  ethereum  ▲ +$2.1M   47 buyers   $84.0M cap
#2  AIXBT  ethereum  ▲ +$1.8M   31 buyers  $142.0M cap

  Delivered → Veil inbox  ·  msg.voidly.ai
```

---

## Install

```bash
npm install -g nansen-oracle
nansen-oracle init --key YOUR_NANSEN_KEY
nansen-oracle alpha
```

No key yet? Run the demo with sample data:

```bash
nansen-oracle demo
```

Get your Nansen API key at [app.nansen.ai/auth/agent-setup](https://app.nansen.ai/auth/agent-setup).

---

## Commands

| Command | Description |
|---------|-------------|
| `alpha` | Full smart money digest — flows, trades, screener — delivered to Veil inbox |
| `screen` | Token screener by smart money inflow. Filter by chain and timeframe |
| `watch` | Monitor a wallet or token. Alert when smart money crosses threshold |
| `wallet` | Wallet profiler — Nansen labels, top holdings, recent DEX trades |
| `channel` | Create and manage private Veil channels with optional token gating |
| `bot` | Persistent bot on the Veil relay. Users DM it for live alpha |

---

### alpha

Fetches smart money flows, hot DEX trades, and token screener picks in parallel. Prints to terminal and delivers a formatted digest to your Veil inbox.

```bash
nansen-oracle alpha
nansen-oracle alpha --chains solana,base
nansen-oracle alpha --no-deliver   # terminal only, skip Veil
```

---

### screen

Token screener ranked by smart money inflow.

```bash
nansen-oracle screen
nansen-oracle screen --timeframe 1h
nansen-oracle screen --chains ethereum --timeframe 6h --deliver
```

Timeframes: `5m` `1h` `6h` `24h` `7d`

---

### watch

Continuous monitoring for wallets or token contracts. Polls Nansen and fires an alert — printed locally and sent to your Veil inbox — when smart money activity crosses the threshold.

```bash
# Watch a wallet
nansen-oracle watch start 0xWHALE --chain ethereum

# Watch a token contract, custom threshold
nansen-oracle watch start 0xTOKEN --type token --chain ethereum --threshold 500000

# Manage watchlist
nansen-oracle watch list
nansen-oracle watch remove 0xADDR
```

---

### wallet

Fetch a wallet's Nansen labels, top holdings, recent DEX trades, and total portfolio value.

```bash
nansen-oracle wallet 0xWALLET
nansen-oracle wallet 0xWALLET --chain solana
```

---

### channel

Create private Veil channels. Share the join link. Your Oracle bot posts live Nansen signals.

```bash
nansen-oracle channel create "Whale Alerts"
nansen-oracle channel list
nansen-oracle channel post "Whale Alerts" "Smart money just moved $40M into ETH"
```

**Token-gated channels** — require holders of a specific token to join:

```bash
nansen-oracle channel create "Diamond Hands" \
  --gate 0xTOKEN_ADDRESS \
  --min-balance 1000
```

When someone requests access, the Oracle bot checks their wallet balance via the Nansen profiler API and grants or denies entry automatically.

---

### bot

Persistent bot that listens on the Veil relay at your DID. Users DM it directly from [msg.voidly.ai](https://msg.voidly.ai).

```bash
nansen-oracle bot start
nansen-oracle bot start --channel ch_abc123   # also posts hourly digests to a channel
```

Commands users can send:

```
!alpha                          full smart money digest
!screen [chain] [timeframe]     token screener
!wallet 0x...                   wallet profile
!flows 0x...                    flow intelligence by segment
!join <channel_id> <0x...>      token-gate check + channel invite
!help                           command list
```

---

### whoami / reset

```bash
nansen-oracle whoami      # show DID, API key status, channels
nansen-oracle reset       # regenerate Veil identity
nansen-oracle reset --hard  # full reset — clears channels and watchlist
```

---

## Veil delivery

Every command that delivers to Veil sends an E2E encrypted direct message to your own DID. The relay at `api.voidly.ai` routes ciphertext only — it cannot read message content. Your private key never leaves your machine.

The underlying crypto is X25519 key exchange + XSalsa20-Poly1305 (NaCl box, via [tweetnacl](https://github.com/dchest/tweetnacl-js)).

To read your inbox: [msg.voidly.ai](https://msg.voidly.ai) — browser PWA, no install, no phone number.

For programmatic access to the same relay, see [@voidly/agent-sdk](https://www.npmjs.com/package/@voidly/agent-sdk).

---

## Architecture

```
Nansen API                    Veil Relay (api.voidly.ai)
     │                               │
     │  smart money data             │  E2E encrypted DMs
     └──────────────►  nansen-oracle ◄──────── Your Veil inbox
                            │                  (msg.voidly.ai)
                            │
                     Token-gated channels
```

---

## Config

Stored at `~/.nansen-oracle/config.json` with `0o600` permissions. Never committed — see `.gitignore`.

```json
{
  "nansenApiKey": "...",
  "veilDid": "did:voidly:...",
  "defaultChains": ["ethereum", "base", "solana"],
  "channels": [
    {
      "id": "ch_abc123",
      "name": "Whale Alerts",
      "gateToken": "0x...",
      "gateMinBalance": 1000
    }
  ],
  "watchlist": [
    {
      "type": "wallet",
      "address": "0x...",
      "chain": "ethereum",
      "threshold": 500000
    }
  ]
}
```

## Environment

```bash
NANSEN_API_KEY=your_key_here
```

The CLI reads `NANSEN_API_KEY` from the environment or from config. Environment takes precedence.

---

## More

- Landing page: [voidly.ai/nansen](https://voidly.ai/nansen)
- Veil inbox: [msg.voidly.ai](https://msg.voidly.ai)
- Agent SDK: [@voidly/agent-sdk](https://www.npmjs.com/package/@voidly/agent-sdk)
- Issues: [github.com/voidly-ai/nansen-oracle/issues](https://github.com/voidly-ai/nansen-oracle/issues)

MIT — [Voidly](https://voidly.ai)
