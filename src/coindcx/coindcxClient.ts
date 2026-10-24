/**
 * `ExchangeApi` adapter over a real CoinDCX futures account.
 *
 * CoinDCX has one real account per API key — there is no create/reset call
 * like paper_exchange's. `initialEquity` (the account's starting balance,
 * used for equity-based reporting) has no server-side concept either, so it
 * is remembered locally in a tiny baseline file, seeded from the first
 * observed wallet total.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  OrderRejectedError, VenueUnavailableError, type ExchangeApi, type ExchangeRiskEvent,
  type PaperExchangeAccountSnapshot, type PaperExchangePosition, type SubmitOrderParams, type SubmitOrderResult,
} from '../binance/paperExchangeClient.js';
import { ContractSpecCache, floorToLot } from './contractSpec.js';
import { SymbolRouter } from './symbolRouter.js';

interface CoinDcxOrderRaw { id: string | number; client_order_id?: string; status: string; filled_quantity?: number; price?: number }

interface CoinDcxPositionRaw {
  id: string | number; pair: string; side?: 'long' | 'short' | 'buy' | 'sell';
  size?: number; active_pos?: number; entry_price?: number; avg_price?: number;
  mark_price?: number; liquidation_price?: number | null; leverage?: number; margin_type?: 'isolated' | 'cross';
  stop_loss?: number | string | null; take_profit?: number | string | null;
}

export interface CoinDcxOrderClient {
  paperMode?: boolean;
  futures: {
    trading: {
      createOrder(req: {
        side: 'buy' | 'sell'; order_type: 'market_order'; base_currency: string; quote_currency: string;
        target_quantity: number; price: number | undefined; leverage: number | undefined;
        client_order_id: string | undefined; time_in_force: 'ioc'; margin_type: 'isolated' | 'cross' | undefined;
      }): Promise<CoinDcxOrderRaw | CoinDcxOrderRaw[]>;
      listOrders(params: { pair?: string; status?: string; limit?: number }): Promise<CoinDcxOrderRaw[]>;
    };
    account: {
      updateLeverage(params: { pair: string; leverage: number }): Promise<unknown>;
      getPositions(params: { pair?: string; status?: string }): Promise<CoinDcxPositionRaw[]>;
      getWallet(): Promise<{ currency: string; balance: number; locked_balance: number; available_balance: number }[]>;
      setSafetyLimits?(limits: { maxOrderQuantity?: number; maxOrderNotional?: number }): void;
    };
    market: {
      getMarketsDetails(): Promise<{ pair: string; status?: string }[]>;
      getInstrumentDetails(pair: string): Promise<{ lot_size?: number; min_quantity?: number; min_price?: number; max_leverage?: number }>;
    };
  };
  marketData: { getSpotTicker(): Promise<{ pair?: string; last_price?: string | number }[]> };
}

export interface CoinDcxExchangeApiDeps {
  client: CoinDcxOrderClient;
  quotePreference: 'auto' | 'USDT' | 'INR';
  baselinePath: string;
  /** A local label only — CoinDCX has one real account per API key, not multiple. */
  accountId: string;
  maxOrderNotional?: number;
  maxOrderQuantity?: number;
  isLiveExecutionArmed?: boolean;
}

const round8 = (value: number): number => Number(value.toFixed(8));
const sumBy = <T,>(items: T[], pick: (item: T) => number): number => items.reduce((total, item) => total + pick(item), 0);

function toOrderResult(raw: CoinDcxOrderRaw): SubmitOrderResult {
  const filled = typeof raw.filled_quantity === 'number' && raw.filled_quantity > 0 ? raw.filled_quantity : undefined;
  return { orderId: String(raw.id), status: raw.status, ...(filled !== undefined ? { filledQuantity: filled } : {}) };
}

function toPosition(p: CoinDcxPositionRaw, symbol: string): PaperExchangePosition {
  const rawPos = Number(p.active_pos ?? p.size ?? 0);
  const entryPrice = Number(p.avg_price ?? p.entry_price ?? 0);
  return {
    id: Number(p.id) || 1, symbol,
    side: rawPos < 0 || p.side === 'sell' || p.side === 'short' ? 'short' : 'long',
    netQuantity: Math.abs(rawPos), averagePrice: entryPrice,
    currentPrice: Number(p.mark_price ?? entryPrice), leverage: Number(p.leverage ?? 1),
    marginType: p.margin_type === 'cross' ? 'cross' : 'isolated',
    liquidationPrice: p.liquidation_price ? Number(p.liquidation_price) : null,
    unrealizedPnl: 0,
    ...(p.stop_loss ? { stopLoss: Number(p.stop_loss) } : {}),
    ...(p.take_profit ? { takeProfit: Number(p.take_profit) } : {}),
  };
}

/** Local memory of the account's starting balance; CoinDCX has no server-side concept of one. */
class CoinDcxBaseline {
  private cached: number | undefined;
  constructor(private readonly filePath: string, private readonly accountId: string) {}

  getOrSeed(observedEquity: number): number {
    if (this.cached !== undefined) return this.cached;
    const persisted = this.read();
    if (persisted !== undefined) return (this.cached = persisted);
    // A non-positive first observation (e.g. an all-INR wallet with no USDT rows yet) must not be seeded permanently:
    // initialEquity=0 would divide-by-zero every pnl%/drawdown/sharpe stat downstream. Leave uncached so the next
    // getAccount() call retries seeding once a real balance is observed.
    if (!(observedEquity > 0)) return 0;
    this.cached = this.seed(observedEquity);
    return this.cached;
  }

  private read(): number | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as { initialEquity?: unknown };
      return typeof raw.initialEquity === 'number' ? raw.initialEquity : undefined;
    } catch {
      return undefined;
    }
  }

  // Same atomic write pattern as RemoteStore: write to .tmp, then rename, so a crash mid-write cannot corrupt the file.
  private seed(initialEquity: number): number {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ accountId: this.accountId, initialEquity }, null, 2));
    renameSync(tmpPath, this.filePath);
    return initialEquity;
  }
}

export class CoinDcxExchangeApi implements ExchangeApi {
  private readonly router: SymbolRouter;
  private readonly specs: ContractSpecCache;
  private readonly baseline: CoinDcxBaseline;
  private readonly warnedPairs = new Set<string>();

  constructor(private readonly deps: CoinDcxExchangeApiDeps) {
    this.router = new SymbolRouter(deps.client, deps.quotePreference);
    this.specs = new ContractSpecCache(deps.client);
    this.baseline = new CoinDcxBaseline(deps.baselinePath, deps.accountId);
  }

  // getPositions() only maps a pair back to a symbol via router.pairToSymbol, which is empty until resolve() has run
  // for that symbol (only submitOrder() calls resolve()). On a cold restart with open positions already on CoinDCX,
  // every one of them would be unresolved and silently dropped — the caller (Task 5) must call this once at startup,
  // for every configured symbol, before the first sync(). An unresolvable symbol is skipped, not thrown.
  async warmSymbols(symbols: string[]): Promise<void> {
    await Promise.all(symbols.map((symbol) => this.router.resolve(symbol).catch(() => {})));
  }

  async getAccount(): Promise<PaperExchangeAccountSnapshot | null> {
    return this.guarded(async () => {
      const rawWallets = await this.deps.client.futures.account.getWallet();
      const isINR = this.deps.quotePreference === 'INR';
      // No fallback rate: 1 would count rupees as dollars (~85x equity) in sizing and in the persisted baseline
      const fxRate = isINR ? await this.router.getFxRate() : undefined;
      const wallets = rawWallets.map((w: any) => {
        const curr = String(w.currency ?? w.currency_short_name ?? '').toUpperCase();
        const rawLocked = Number(w.locked_balance ?? 0);
        const rawAvail = w.available_balance !== undefined ? Number(w.available_balance) : Number(w.balance ?? 0);
        const rawTotal = w.available_balance !== undefined ? Number(w.balance ?? 0) : rawAvail + rawLocked;
        const rate = curr === 'INR' && fxRate !== undefined ? fxRate : 1;
        return { currency: curr, balance: rawTotal / rate, locked_balance: rawLocked / rate, available_balance: rawAvail / rate };
      });
      const targetWallets = wallets.filter((w) => w.currency === 'USDT' || (isINR && w.currency === 'INR' && w.balance > 0));
      const equity = round8(sumBy(targetWallets, (w) => w.balance));
      const positions = await this.getPositions();
      return {
        accountId: this.deps.accountId, currency: 'USDT', ...(fxRate === undefined ? {} : { fxRate }),
        margin: this.baseline.getOrSeed(equity),
        availableBalance: round8(sumBy(targetWallets, (w) => w.available_balance)),
        lockedMargin: round8(sumBy(targetWallets, (w) => w.locked_balance)),
        equity, unrealizedPnl: 0, realizedPnl: 0, positionsCount: positions.length,
      };
    });
  }

  // A valid CoinDCX API key always has an account; RemoteBroker only calls createAccount() when getAccount() returned
  // null, which never happens here — deliberately NOT routed through guarded(): this is a permanent misconfiguration,
  // not a transient venue outage, and must not be mistaken for one (VenueUnavailableError drives retry/degraded-state logic).
  async createAccount(_margin: number): Promise<void> {
    throw new Error('CoinDCX accounts are not created via the API — configure COINDCX_API_KEY for an existing account');
  }

  async getPositions(): Promise<PaperExchangePosition[]> {
    return this.guarded(async () => {
      const isINR = this.deps.quotePreference === 'INR';
      const raw = await this.deps.client.futures.account.getPositions({
        page: '1', size: '50', ...(isINR ? { margin_currency_short_name: ['INR', 'USDT'] } : {}),
      } as any);
      const positions: PaperExchangePosition[] = [];
      for (const p of (raw as any[])) {
        const rawPos = Number(p.active_pos ?? p.size ?? 0);
        if (!(Math.abs(rawPos) > 0)) continue;
        const symbol = this.router.pairToSymbol(p.pair);
        if (!symbol) {
          this.warnUnresolved(p.pair);
          continue;
        }
        positions.push(toPosition(p, symbol));
      }
      return positions;
    });
  }

  async submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult> {
    return this.guarded(async () => {
      if (!this.deps.client.paperMode && !this.deps.isLiveExecutionArmed) {
        throw new OrderRejectedError(
          '[COINDCX READONLY GUARD] Real order submission blocked: COINDCX_LIVE_EXECUTION_ARMED is off. System is in monitor/read-only mode.',
          403,
          '',
        );
      }
      const resolved = await this.router.resolve(params.symbol);
      const spec = await this.specs.get(resolved.pair);
      const quantity = round8(floorToLot(params.quantity, spec.lotSize));
      // Client-side hard stop before any order-mutating call — including the leverage set below.
      this.enforceMinimum(quantity, params, spec.minQty);
      this.enforceCaps(quantity, params.executionPrice);
      await this.setLeverage(resolved.pair, params.leverage, params.reduceOnly ?? false);
      const price = round8(resolved.quote === 'INR' ? params.executionPrice * resolved.fxRate : params.executionPrice);
      const raw = await this.deps.client.futures.trading.createOrder({
        side: params.side,
        order_type: 'market_order',
        base_currency: resolved.base,
        quote_currency: resolved.quote,
        target_quantity: quantity,
        price,
        leverage: params.leverage,
        client_order_id: params.clientOrderId,
        time_in_force: 'ioc',
        margin_type: params.marginType ?? 'isolated',
      });
      // The REST create endpoint answers with an array of the orders it created
      return toOrderResult(Array.isArray(raw) ? raw[0] : raw);
    });
  }

  async findOrder(clientOrderId: string): Promise<SubmitOrderResult | null> {
    return this.guarded(async () => {
      const recent = await this.deps.client.futures.trading.listOrders({ limit: 100 });
      const found = recent.find((o) => o.client_order_id === clientOrderId) ?? (await this.findOpen(clientOrderId));
      return found ? toOrderResult(found) : null;
    });
  }

  // CoinDCX runs its own risk engine; liquidations are journaled as generic CLOSE until risk events are wired.
  async getRiskEvents(): Promise<ExchangeRiskEvent[]> { return this.guarded(async () => []); }

  // CoinDCX has live prices and funding engine; mark/funding pushes exist only for paper_exchange.
  async pushMarkPrices(_prices: Record<string, number>): Promise<void> { return this.guarded(async () => {}); }
  async pushFundingEvent(_s: string, _r: number, _p: number, _t: number): Promise<void> { return this.guarded(async () => {}); }

  private async findOpen(clientOrderId: string): Promise<CoinDcxOrderRaw | undefined> {
    const open = await this.deps.client.futures.trading.listOrders({ status: 'open', limit: 100 });
    return open.find((o) => o.client_order_id === clientOrderId);
  }

  private async setLeverage(pair: string, leverage: number, reduceOnly: boolean): Promise<void> {
    try {
      await this.deps.client.futures.account.updateLeverage({ pair, leverage });
    } catch (err) {
      // A reduce-only close must never be blocked by a stale-leverage rejection; it only shrinks the existing position.
      if (!reduceOnly) throw err;
    }
  }

  // Binance lot rules sized the order; CoinDCX's own lot can floor it to zero or below the pair's minimum
  private enforceMinimum(quantity: number, params: SubmitOrderParams, minQty: number): void {
    if (quantity > 0 && quantity >= minQty) return;
    throw new OrderRejectedError(`${params.symbol} quantity ${params.quantity} floors to ${quantity}, below the CoinDCX minimum ${minQty}`, 400, '');
  }

  private enforceCaps(quantity: number, executionPrice: number): void {
    const { maxOrderQuantity, maxOrderNotional } = this.deps;
    if (maxOrderQuantity !== undefined && quantity > maxOrderQuantity) {
      throw new OrderRejectedError(`order quantity ${quantity} exceeds maxOrderQuantity ${maxOrderQuantity}`, 400, '');
    }
    const notional = quantity * executionPrice;
    if (maxOrderNotional !== undefined && notional > maxOrderNotional) {
      throw new OrderRejectedError(`order notional ${notional} exceeds maxOrderNotional ${maxOrderNotional}`, 400, '');
    }
  }

  private warnUnresolved(pair: string): void {
    if (this.warnedPairs.has(pair)) return;
    this.warnedPairs.add(pair);
    console.warn(`coindcx: skipping position on unresolved pair ${pair} (outside configured symbols)`);
  }

  // Every public method (except createAccount(), see its own comment) routes through this. Note: CoinDcxOrderClient
  // doesn't distinguish a genuine CoinDCX 4xx (invalid leverage, insufficient margin) from a real network failure —
  // the fake/real client just rejects the promise either way — so both surface as VenueUnavailableError here, even
  // though a 4xx is a permanent rejection RemoteBroker should arguably not retry. Task 5's wiring to the real SDK
  // should revisit this if the SDK exposes typed errors that let it distinguish the two.
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VenueUnavailableError || err instanceof OrderRejectedError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new VenueUnavailableError(`CoinDCX request failed: ${message}`, { cause: err });
    }
  }
}
