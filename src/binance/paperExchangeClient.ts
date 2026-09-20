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

export interface SubmitProtectionOrderParams {
  symbol: string;
  /** Side of the protection order (opposite of the position it protects). */
  side: 'buy' | 'sell';
  quantity: number;
  /** Bounded order: fills if the book is marketable at `price`. */
  price?: number;
  /** Stop-loss order: triggers when the book crosses `triggerPrice`. */
  triggerPrice?: number;
  /** Reference price so the broker seeds its book (it has no price of its own for crypto). */
  executionPrice: number;
  /** Idempotency key. */
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

  /**
   * Submits a SL (stop_loss) or TP (bounded) order to the remote broker so
   * exits fire server-side even when this agent is offline. The broker has no
   * market-data feed of its own for crypto, so `executionPrice` seeds its book
   * with the current mark — the bounded/stop_loss order then triggers against
   * the next mark-price push from this agent's own feed.
   *
   * Issue #1: previously SL/TP were silently dropped in remote-paper mode.
   */
  async submitProtectionOrder(params: SubmitProtectionOrderParams): Promise<SubmitOrderResult> {
    const orderType = params.triggerPrice !== undefined ? 'stop_loss' : 'bounded';
    const raw = await this.request<Record<string, unknown>>('POST', '/api/orders', {
      order: {
        symbol: params.symbol,
        side: params.side,
        quantity: params.quantity,
        order_type: orderType,
        instrument_type: 'CRYPTO_PERPETUAL',
        leverage: 1,
        margin_type: 'cross',
        price: params.price,
        trigger_price: params.triggerPrice,
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
   * leveraged positions on `symbol`. Idempotent when `fundingTime` is
   * supplied — the broker dedupes on (paper_position_id, funding_time).
   * Callers MUST pass `fundingTime` (Binance's funding settlement
   * timestamp) so an HTTP retry doesn't double-charge funding.
   */
  async pushFundingEvent(
    symbol: string,
    fundingRate: number,
    markPrice?: number,
    fundingTime?: string | number,
  ): Promise<void> {
    await this.request('POST', '/api/funding_events', {
      symbol,
      funding_rate: fundingRate,
      mark_price: markPrice,
      funding_time: fundingTime,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Retries: 5xx and network errors get up to 2 retries with exponential
    // backoff (250ms, 750ms). 4xx errors are client-side (bad request,
    // unauthorized, insufficient margin) and never retried — surfacing them
    // immediately is correct. Issue #7: previously any non-2xx threw with no
    // retry, so a transient 502 from the broker lost the order entirely.
    const maxAttempts = 3;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Account-Id': this.accountId },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.ok) {
          if (res.status === 204) return undefined as T;
          return (await res.json()) as T;
        }
        const text = await res.text().catch(() => '');
        // 4xx: client error — surface immediately, no retry.
        if (res.status >= 400 && res.status < 500) {
          throw new PaperExchangeHttpError(res.status, method, path, text);
        }
        // 5xx: server error — retry with backoff.
        lastErr = new PaperExchangeHttpError(res.status, method, path, text);
      } catch (err) {
        if (err instanceof PaperExchangeHttpError) throw err;
        // Network error (DNS, connection refused, etc.) — retry.
        lastErr = err as Error;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(250 * Math.pow(3, attempt));
      }
    }
    throw lastErr ?? new Error(`paper_exchange ${method} ${path} failed after ${maxAttempts} attempts`);
  }
}

export class PaperExchangeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`paper_exchange ${method} ${path} -> ${status}: ${body}`);
    this.name = 'PaperExchangeHttpError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
