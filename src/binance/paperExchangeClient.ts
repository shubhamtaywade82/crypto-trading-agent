/**
 * Thin HTTP client for the paper_exchange Rails broker.
 *
 * paper_exchange has no market-data connection of its own for crypto
 * symbols — this agent owns that (see its README's "Crypto market data
 * ownership"). This client is the other half of that contract: it pushes
 * mark prices / funding events the broker needs for margin and liquidation
 * math, and submits orders with the price this agent's own feed observed.
 */

export interface PaperExchangeAccountSnapshot {
  accountId: string;
  currency: string;
  margin: number;
  availableBalance: number;
  lockedMargin: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  positionsCount: number;
}

export interface PaperExchangePosition {
  id: number;
  symbol: string;
  side: 'long' | 'short';
  netQuantity: number;
  averagePrice: number;
  currentPrice: number;
  leverage: number;
  marginType: 'cross' | 'isolated';
  liquidationPrice: number | null;
  unrealizedPnl: number;
}

export interface SubmitOrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  leverage: number;
  marginType?: 'cross' | 'isolated';
  /** Reference price this fill executes near — the broker has no price of its own for crypto. */
  executionPrice: number;
  /** Idempotency key: a retried submission with the same id replays the original order. */
  clientOrderId: string;
}

export interface SubmitOrderResult {
  orderId: number;
  status: string;
}

type Fetch = typeof fetch;

export class PaperExchangeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accountId: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async getAccount(): Promise<PaperExchangeAccountSnapshot> {
    const raw = await this.request<Record<string, unknown>>('GET', '/api/account');
    return {
      accountId: String(raw.account_id),
      currency: String(raw.currency),
      margin: Number(raw.margin),
      availableBalance: Number(raw.available_balance),
      lockedMargin: Number(raw.locked_margin),
      equity: Number(raw.equity),
      unrealizedPnl: Number(raw.unrealized_pnl),
      realizedPnl: Number(raw.realized_pnl),
      positionsCount: Number(raw.positions_count),
    };
  }

  async getPositions(): Promise<PaperExchangePosition[]> {
    const raw = await this.request<Array<Record<string, unknown>>>('GET', '/api/positions');
    return raw.map((p) => ({
      id: Number(p.id),
      symbol: String(p.symbol),
      side: p.side as 'long' | 'short',
      netQuantity: Number(p.net_quantity),
      averagePrice: Number(p.average_price),
      currentPrice: Number(p.current_price),
      leverage: Number(p.leverage),
      marginType: p.margin_type as 'cross' | 'isolated',
      liquidationPrice: p.liquidation_price === null || p.liquidation_price === undefined ? null : Number(p.liquidation_price),
      unrealizedPnl: Number(p.unrealized_pnl),
    }));
  }

  async submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult> {
    const raw = await this.request<Record<string, unknown>>('POST', '/api/orders', {
      order: {
        symbol: params.symbol,
        side: params.side,
        quantity: params.quantity,
        order_type: 'market',
        instrument_type: 'CRYPTO_PERPETUAL',
        leverage: params.leverage,
        margin_type: params.marginType ?? 'cross',
        execution_price: params.executionPrice,
        client_order_id: params.clientOrderId,
      },
    });
    return { orderId: Number(raw.id), status: String(raw.status) };
  }

  async cancelOrder(orderId: number | string): Promise<void> {
    await this.request('DELETE', `/api/orders/${orderId}`);
  }

  /** Bulk mark-price push — drives the broker's liquidation checks. Safe to call repeatedly (idempotent per symbol). */
  async pushMarkPrices(prices: Record<string, number>): Promise<void> {
    await this.request('POST', '/api/mark_prices', { prices });
  }

  /**
   * Reports a funding settlement so the broker posts the fee against open
   * leveraged positions on `symbol`. NOT idempotent — the broker books a new
   * ledger entry on every call, so callers must only invoke this once per
   * actual funding boundary (00:00/08:00/16:00 UTC for Binance USD-M),
   * never on a fixed polling interval.
   */
  async pushFundingEvent(symbol: string, fundingRate: number, markPrice?: number): Promise<void> {
    await this.request('POST', '/api/funding_events', {
      symbol,
      funding_rate: fundingRate,
      mark_price: markPrice,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': this.accountId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`paper_exchange ${method} ${path} -> ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
