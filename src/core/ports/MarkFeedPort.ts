export interface MarkQuote {
  readonly symbol: string;
  readonly markPrice: number;
  readonly fundingRate: number;
  /** Epoch ms of the next funding settlement. */
  readonly nextFundingTime: number;
  readonly observedAt: number;
}

/** Where current marks come from (the market-data venue). */
export interface MarkSourcePort {
  getMarks(symbols: readonly string[]): Promise<readonly MarkQuote[]>;
}

/**
 * The paper venue has no price feed of its own: its stops, targets and liquidations only move when marks are pushed
 * to it. This port is that push.
 */
export interface MarkSinkPort {
  pushMarks(marks: Readonly<Record<string, number>>): Promise<void>;
  pushFunding(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void>;
}
