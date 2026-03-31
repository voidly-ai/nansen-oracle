const BASE = 'https://api.nansen.ai';

// Smart Money DEX Trades format (from /api/v1/smart-money/dex-trades)
export interface SmartDexTrade {
  block_timestamp: string;
  transaction_hash: string;
  trader_address: string;
  trader_address_label: string;
  token_bought_symbol: string;
  token_sold_symbol: string;
  token_bought_amount: number;
  token_sold_amount: number;
  trade_value_usd: number;
  chain: string;
}

// TGM DEX Trades format (from /api/v1/tgm/dex-trades) — different schema!
export interface TgmDexTrade {
  block_timestamp: string;
  transaction_hash: string;
  trader_address: string;
  trader_address_label: string;
  action: 'BUY' | 'SELL';
  token_name: string;
  token_symbol?: string;
  token_amount: number;
  token_address: string;
  traded_token_name: string;
  traded_token_amount: number;
  traded_token_address: string;
  estimated_swap_price_usd: number;
  estimated_value_usd: number;
}

// Profiler transactions format (from /api/v1/profiler/address/transactions)
export interface ProfilerTransaction {
  chain: string;
  method: string;
  tokens_sent: Array<{ symbol: string; amount: number; value_usd: number }>;
  tokens_received: Array<{ symbol: string; amount: number; value_usd: number }>;
  volume_usd: number;
  block_timestamp: string;
  transaction_hash: string;
  source_type: string;
}

// Normalised trade — used by display layer
export interface TradeEvent {
  tx_hash: string;
  trader_address: string;
  trader_label: string;
  action: 'BUY' | 'SELL';
  token_in: string;
  token_out: string;
  value_usd: number;
  chain: string;
  timestamp: string;
}

export function normalizeSmartTrade(t: SmartDexTrade): TradeEvent {
  const isBuy = !!t.token_bought_symbol && !isStable(t.token_bought_symbol);
  return {
    tx_hash: t.transaction_hash,
    trader_address: t.trader_address,
    trader_label: t.trader_address_label || 'Smart Money',
    action: isBuy ? 'BUY' : 'SELL',
    token_in: isBuy ? t.token_bought_symbol : t.token_sold_symbol,
    token_out: isBuy ? t.token_sold_symbol : t.token_bought_symbol,
    value_usd: t.trade_value_usd || 0,
    chain: t.chain || 'ethereum',
    timestamp: t.block_timestamp,
  };
}

export function normalizeTgmTrade(t: TgmDexTrade, chain = ''): TradeEvent {
  return {
    tx_hash: t.transaction_hash,
    trader_address: t.trader_address,
    trader_label: t.trader_address_label || 'Smart Money',
    action: t.action || 'BUY',
    token_in: t.token_name || t.token_symbol || '?',
    token_out: t.traded_token_name || '?',
    value_usd: t.estimated_value_usd || 0,
    chain,
    timestamp: t.block_timestamp,
  };
}

export function normalizeProfilerTx(t: ProfilerTransaction): TradeEvent {
  const received = t.tokens_received?.[0];
  const sent = t.tokens_sent?.[0];
  const isBuy = !!received && !isStable(received.symbol);
  return {
    tx_hash: t.transaction_hash,
    trader_address: '',
    trader_label: 'Wallet',
    action: isBuy ? 'BUY' : 'SELL',
    token_in: isBuy ? (received?.symbol || '?') : (sent?.symbol || '?'),
    token_out: isBuy ? (sent?.symbol || '?') : (received?.symbol || '?'),
    value_usd: t.volume_usd || 0,
    chain: t.chain || 'ethereum',
    timestamp: t.block_timestamp,
  };
}

function isStable(symbol: string): boolean {
  return ['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'FRAX', 'USDP'].includes(symbol?.toUpperCase());
}

export interface SmartMoneyFlow {
  token_symbol: string;
  token_address: string;
  chain: string;
  net_flow_1h_usd: number;
  net_flow_24h_usd: number;
  net_flow_7d_usd: number;
  net_flow_30d_usd: number;
  trader_count: number;
  market_cap_usd: number;
  token_sectors: string[];
  token_age_days: number;
}

export interface ScreenerToken {
  token_symbol: string;
  token_address: string;
  chain: string;
  market_cap_usd: number;
  price_usd: number;
  price_change: number;
  netflow: number;
  nof_buyers: number;
  nof_sellers: number;
  nof_traders: number;
  buy_volume: number;
  sell_volume: number;
  volume: number;
  token_age_days: number;
  liquidity: number;
}

export interface WalletBalance {
  token_symbol: string;
  token_address: string;
  chain: string;
  balance: number;
  value_usd: number;
}

export interface WalletLabel {
  label: string;
  category: string;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  market_cap_usd: number;
  fdv_usd: number;
  volume_total_usd: number;
  buy_volume_usd: number;
  sell_volume_usd: number;
  total_buys: number;
  total_sells: number;
  unique_buyers: number;
  unique_sellers: number;
  liquidity_usd: number;
  total_holders: number;
}

export interface FlowIntelligence {
  segment: string;
  net_flow_usd: number;
  average_flow_usd: number;
  wallet_count: number;
}

export class NansenClient {
  private apiKey: string;
  private lastCall = 0;
  private callsThisMinute = 0;
  private minuteStart = Date.now();

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('NANSEN_API_KEY is required. Run: nansen-oracle init --key YOUR_KEY');
    this.apiKey = apiKey;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    if (now - this.minuteStart > 60000) {
      this.callsThisMinute = 0;
      this.minuteStart = now;
    }
    const timeSinceLast = now - this.lastCall;
    if (timeSinceLast < 55) await sleep(55 - timeSinceLast);
    if (this.callsThisMinute >= 280) {
      const wait = 60000 - (now - this.minuteStart);
      if (wait > 0) await sleep(wait);
      this.callsThisMinute = 0;
      this.minuteStart = Date.now();
    }
    this.lastCall = Date.now();
    this.callsThisMinute++;
  }

  private async post<T>(path: string, body: Record<string, unknown>, retries = 0): Promise<T> {
    await this.throttle();

    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err: unknown) {
      throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 429) {
      if (retries >= 2) throw new Error('Nansen API rate limited. Wait a minute and try again.');
      await sleep(5000 * (retries + 1));
      return this.post<T>(path, body, retries + 1);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error(`Nansen API ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error('Nansen API returned non-JSON response');
    }

    // Nansen wraps list results in { data: [...] }
    if (json && typeof json === 'object' && !Array.isArray(json) && 'data' in (json as Record<string, unknown>)) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  // ── Smart Money ──────────────────────────────────────────────────────────

  async getSmartMoneyFlows(chains: string[] = ['ethereum', 'base', 'solana'], limit = 20): Promise<SmartMoneyFlow[]> {
    const result = await this.post<SmartMoneyFlow[]>('/api/v1/smart-money/netflow', {
      chains,
      filters: {
        include_stablecoins: false,
        include_native_tokens: true,
      },
      pagination: { page: 1, per_page: limit },
      order_by: [{ field: 'net_flow_1h_usd', direction: 'DESC' }],
    });
    return Array.isArray(result) ? result : [];
  }

  async getSmartMoneyDexTrades(chains: string[] = ['ethereum', 'base', 'solana'], limit = 20): Promise<SmartDexTrade[]> {
    const result = await this.post<SmartDexTrade[]>('/api/v1/smart-money/dex-trades', {
      chains,
      filters: {},
      pagination: { page: 1, per_page: limit },
      order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
    });
    return Array.isArray(result) ? result : [];
  }

  // ── Token Screener ───────────────────────────────────────────────────────

  async screenTokens(
    chains: string[] = ['ethereum', 'base', 'solana'],
    timeframe: '5m' | '1h' | '6h' | '24h' | '7d' = '24h',
    limit = 20,
  ): Promise<ScreenerToken[]> {
    // Screener max 5 chains, max 1000 results
    const result = await this.post<ScreenerToken[]>('/api/v1/token-screener', {
      chains: chains.slice(0, 5),
      timeframe,
      filters: {
        include_stablecoins: false,
      },
      pagination: { page: 1, per_page: Math.min(limit, 100) },
      order_by: [{ field: 'netflow', direction: 'DESC' }],
    });
    return Array.isArray(result) ? result : [];
  }

  // ── Token God Mode ───────────────────────────────────────────────────────

  async getTokenInfo(chain: string, tokenAddress: string, timeframe = '1d'): Promise<TokenInfo | null> {
    try {
      return await this.post<TokenInfo>('/api/v1/tgm/token-information', {
        chain,
        token_address: tokenAddress,
        timeframe,
      });
    } catch {
      return null;
    }
  }

  async getFlowIntelligence(chain: string, tokenAddress: string, timeframe = '1d'): Promise<FlowIntelligence[]> {
    try {
      const raw = await this.post<unknown>('/api/v1/tgm/flow-intelligence', {
        chain,
        token_address: tokenAddress,
        timeframe,
      });

      // Response may be { segment: { net_flow_usd, ... } } or { data: { segment: {...} } }
      const data = (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>))
        ? (raw as Record<string, unknown>).data as Record<string, unknown>
        : raw as Record<string, unknown>;

      if (!data || typeof data !== 'object') return [];

      return Object.entries(data)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([segment, v]) => {
          const val = v as Record<string, number>;
          return {
            segment,
            net_flow_usd: val.net_flow_usd || 0,
            average_flow_usd: val.average_flow_usd || 0,
            wallet_count: val.wallet_count || 0,
          };
        });
    } catch {
      return [];
    }
  }

  async getTokenDexTrades(chain: string, tokenAddress: string, onlySmartMoney = true, limit = 20): Promise<TgmDexTrade[]> {
    const result = await this.post<TgmDexTrade[]>('/api/v1/tgm/dex-trades', {
      chain,
      token_address: tokenAddress,
      date: { from: daysAgo(1), to: now() },
      only_smart_money: onlySmartMoney,
      pagination: { page: 1, per_page: limit },
      order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
    });
    return Array.isArray(result) ? result : [];
  }

  // ── Profiler ─────────────────────────────────────────────────────────────

  async getWalletBalances(address: string, chain = 'all'): Promise<WalletBalance[]> {
    const result = await this.post<WalletBalance[]>('/api/v1/profiler/address/balances', {
      address,
      chain,
    });
    return Array.isArray(result) ? result : [];
  }

  async getWalletLabels(address: string, chain = 'ethereum'): Promise<WalletLabel[]> {
    const result = await this.post<WalletLabel[]>('/api/v1/profiler/address/labels', {
      address,
      chain,
      pagination: { page: 1, per_page: 20 },
    });
    return Array.isArray(result) ? result : [];
  }

  async getWalletTransactions(address: string, chain = 'ethereum', limit = 10): Promise<ProfilerTransaction[]> {
    const result = await this.post<ProfilerTransaction[]>('/api/v1/profiler/address/transactions', {
      address,
      chain,
      date: { from: daysAgo(7), to: now() },
      pagination: { page: 1, per_page: limit },
      order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
    });
    return Array.isArray(result) ? result : [];
  }

  // ── Token Gating ─────────────────────────────────────────────────────────

  async checkTokenBalance(walletAddress: string, tokenAddress: string, chain = 'ethereum'): Promise<number> {
    const balances = await this.getWalletBalances(walletAddress, chain);
    const match = balances.find(b =>
      b.token_address?.toLowerCase() === tokenAddress.toLowerCase(),
    );
    return match?.balance ?? 0;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now(): string {
  return new Date().toISOString().split('T')[0];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
