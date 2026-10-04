# Nansen Oracle

Source snapshot for a CLI and Veil bot that query Nansen and deliver digests through Veil. The [product page](https://voidly.ai/nansen) describes the intended user flow.

**Release status (4 October 2026):** this repository's `package.json` is version 1.0.0, but the unscoped `nansen-oracle` package named in the earlier README is not available from the public npm registry. Do not rely on the old global-install command or treat the example digest as live market data. The `demo` command uses sample data.

## What the source contains

- CLI commands for digests, screening, wallet lookup, watchlists, channels, and a bot.
- A Veil transport that sends encrypted messages through the relay.
- A bot-side subscriber store. A bot operator may have access to API keys and commands supplied to that bot. Confirm the operator and current service state before sharing a key.

Do not send a Nansen API key to a bot solely because a DID appears in this repository or on a page. Confirm the operator, current service state, and Nansen's key controls first. If you run this source yourself, review its permissions, dependencies, and key storage before using a real key. Do not paste keys into issue reports, screenshots, or example output.

This project does not establish that a signal is timely, predictive, or suitable for trading. Check Nansen's underlying records and timestamps before acting on output.

License: MIT, as declared in `package.json`.
