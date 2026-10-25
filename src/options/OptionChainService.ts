import type { BinanceClient } from '@nemesis-oss/binance-sdk';
import { contractFromExchangeInfo, type RawOptionSymbol } from './contract.js';
import type { BookLevel, IndexQuote, OptionContract, OptionQuote } from './types.js';

/** The slice of the SDK's `client.options.market` this service reads; narrowed so tests can fake it. */
export interface OptionsMarketSource {
  exchangeInfo(): Promise<{ optionSymbols: ReadonlyArray<RawOptionSymbol> }>;
  index(underlying?: string): Promise<ReadonlyArray<{ underlying: string; indexPrice: number; time: number }>>;
  mark(symbol?: string): Promise<ReadonlyArray<{ symbol: string; markPrice: number } & Record<string, unknown>>>;
  depth(symbol: string, limit?: number): Promise<{ bids: ReadonlyArray<readonly [string, string]>; asks: ReadonlyArray<readonly [string, string]> }>;
}

/** Adapts the binance-sdk Options market resource (eapi) to `OptionsMarketSource`. */
export const sdkOptionsSource = (client: BinanceClient): OptionsMarketSource => client.options.market as unknown as OptionsMarketSource;

export interface MarkSnapshot {
  mark: number;
  markIv: number | null;
  riskFreeRate: number;
}

export interface OptionChainOptions {
  /** How long a loaded contract list is reused. Listings change a few times a day. */
  contractsTtlMs?: number;
  depthLimit?: number;
  now?: () => number;
  onRejectedContract?: (symbol: string, reason: string) => void;
}

const finiteOrNull = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Parses one side of a depth reply, dropping malformed and non-positive levels and enforcing best-first order. */
export function parseLevels(raw: ReadonlyArray<readonly [string, string]>, side: 'bids' | 'asks'): BookLevel[] {
  const levels: BookLevel[] = [];
  for (const [p, q] of raw) {
    const price = Number(p);
    const qty = Number(q);
    if (Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0) levels.push([price, qty]);
  }
  return levels.sort((a, b) => (side === 'bids' ? b[0] - a[0] : a[0] - b[0]));
}

/**
 * Option chain over the binance-sdk Options market endpoints: listed contracts (cached), the underlying index,
 * mark premiums with implied volatility, and executable depth. Every quote is stamped with the time this process
 * received it so callers can refuse stale data; nothing here retries or fabricates a price.
 */
export class OptionChainService {
  private contracts: OptionContract[] = [];
  private contractsLoadedAt = 0;
  private readonly contractsTtlMs: number;
  private readonly depthLimit: number;
  private readonly now: () => number;

  constructor(private readonly source: OptionsMarketSource, private readonly opts: OptionChainOptions = {}) {
    this.contractsTtlMs = opts.contractsTtlMs ?? 10 * 60_000;
    this.depthLimit = opts.depthLimit ?? 20;
    this.now = opts.now ?? Date.now;
  }

  /** Verified, tradable contracts for one underlying; refreshed after `contractsTtlMs`. */
  async contractsFor(underlying: string): Promise<OptionContract[]> {
    if (this.contracts.length === 0 || this.now() - this.contractsLoadedAt >= this.contractsTtlMs) {
      const info = await this.source.exchangeInfo();
      const parsed: OptionContract[] = [];
      for (const raw of info.optionSymbols) {
        const result = contractFromExchangeInfo(raw);
        if (result.ok) parsed.push(result.contract);
        else this.opts.onRejectedContract?.(result.symbol, result.reason);
      }
      this.contracts = parsed;
      this.contractsLoadedAt = this.now();
    }
    return this.contracts.filter((c) => c.underlying === underlying);
  }

  async index(underlying: string): Promise<IndexQuote> {
    const rows = await this.source.index(underlying);
    const row = rows.find((r) => r.underlying === underlying);
    if (!row || !(row.indexPrice > 0)) throw new Error(`no index price for ${underlying}`);
    return { underlying, price: row.indexPrice, time: row.time, receivedAt: this.now() };
  }

  /** Marks for every listed contract in one request, keyed by symbol. Rows without a positive mark are dropped. */
  async marks(): Promise<Map<string, MarkSnapshot>> {
    const rows = await this.source.mark();
    const out = new Map<string, MarkSnapshot>();
    for (const row of rows) {
      if (!(row.markPrice > 0)) continue;
      const iv = finiteOrNull(row.markIV);
      out.set(row.symbol, {
        mark: row.markPrice,
        markIv: iv !== null && iv > 0 ? iv : null,
        riskFreeRate: finiteOrNull(row.riskFreeInterest) ?? 0,
      });
    }
    return out;
  }

  /** Depth plus mark for one contract, received now. Throws when the venue has no mark for it. */
  async quote(symbol: string, mark?: MarkSnapshot): Promise<OptionQuote> {
    const [book, markRow] = await Promise.all([
      this.source.depth(symbol, this.depthLimit),
      mark ? Promise.resolve(mark) : this.markFor(symbol),
    ]);
    return {
      symbol,
      bids: parseLevels(book.bids, 'bids'),
      asks: parseLevels(book.asks, 'asks'),
      mark: markRow.mark,
      markIv: markRow.markIv,
      riskFreeRate: markRow.riskFreeRate,
      receivedAt: this.now(),
    };
  }

  private async markFor(symbol: string): Promise<MarkSnapshot> {
    const rows = await this.source.mark(symbol);
    const row = rows.find((r) => r.symbol === symbol);
    if (!row || !(row.markPrice > 0)) throw new Error(`no mark for ${symbol}`);
    const iv = finiteOrNull(row.markIV);
    return { mark: row.markPrice, markIv: iv !== null && iv > 0 ? iv : null, riskFreeRate: finiteOrNull(row.riskFreeInterest) ?? 0 };
  }
}
