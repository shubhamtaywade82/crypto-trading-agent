/** Long-only crypto options: CE = call (bullish), PE = put (bearish). Writing (selling to open) is never modelled. */
export type OptionRight = 'CE' | 'PE';

/** One listed contract, from the venue's exchangeInfo. Prices are in the quote asset (USDT). */
export interface OptionContract {
  /** Binance Options symbology: <BASE>-<YYMMDD>-<STRIKE>-<C|P>, e.g. BTC-261030-81000-C. */
  symbol: string;
  /** Underlying index the contract settles on, e.g. BTCUSDT. */
  underlying: string;
  right: OptionRight;
  strike: number;
  /** Expiry instant (epoch ms); Binance Options expire at 08:00 UTC. */
  expiryMs: number;
  /** Units of the underlying one contract covers. */
  unit: number;
  minQty: number;
  qtyStep: number;
  tickSize: number;
}

export type BookLevel = readonly [price: number, qty: number];

/** Executable book plus the venue's implied volatility for one contract, stamped with when this process received it. */
export interface OptionQuote {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  /** Venue mark premium. */
  mark: number;
  /** Venue mark implied volatility as a decimal (0.55 = 55%); null when the venue sent none. */
  markIv: number | null;
  /** Risk-free rate the venue prices with, as a decimal; 0 when absent. */
  riskFreeRate: number;
  receivedAt: number;
}

export interface IndexQuote {
  underlying: string;
  price: number;
  /** Venue timestamp of the index print. */
  time: number;
  receivedAt: number;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Premium decay per calendar day (negative for a long option). */
  thetaPerDay: number;
  vega: number;
}

/** What the LLM sees when asked to veto an option buy; every number comes from deterministic code. */
export interface OptionVetoSnapshot {
  underlying: string;
  contract: string;
  right: OptionRight;
  spot: number;
  strike: number;
  hoursToExpiry: number;
  premium: number;
  spreadPct: number;
  delta: number;
  thetaPerDay: number;
  impliedVolPct: number;
  realizedVolPct: number;
  ivRvRatio: number;
  breakevenMovePct: number;
  edgeRatio: number;
  regime: string;
  htfTrend: string;
  rsi15m: number | null;
  stopPremium: number;
  targetPremium: number;
  quantity: number;
  maxLossUsdt: number;
}
