/** Shared shapes for the public market-data layer. Missing values are `null`, never zero. */

export type PublicVenue = 'SPOT' | 'USDM';

/** LIVE: a book inside the staleness window. STALE: a book exists but is older than that. MISSING: no valid book yet. */
export type QuoteQuality = 'LIVE' | 'STALE' | 'MISSING';

export interface PublicQuote {
  readonly venue: PublicVenue;
  readonly symbol: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  /** Last trade price from the trade stream, independent of the book's freshness. */
  readonly last: number | null;
  readonly bookAt: number | null;
  readonly tradeAt: number | null;
  readonly quality: QuoteQuality;
}

export interface UsdmFunding {
  /** Most recent funding rates, oldest first, as decimals (0.0001 = 1 bp per interval). */
  readonly rates: readonly number[];
  readonly lastFundingTime: number | null;
  readonly lastRate: number | null;
  /** When this history was last fetched successfully; null when it never was. */
  readonly fetchedAt: number | null;
}

/** What the decision context receives. Informational: nothing in this delivery gates an entry on it. */
export interface PublicDataContext {
  readonly asOf: number;
  readonly spot: Readonly<Record<string, PublicQuote>>;
  readonly usdm: Readonly<Record<string, PublicQuote>>;
  /** (spot mid − USDⓈ-M mid) / USDⓈ-M mid, in basis points. Null unless both books are LIVE. */
  readonly basisBps: Readonly<Record<string, number | null>>;
  readonly funding: Readonly<Record<string, UsdmFunding>>;
}
