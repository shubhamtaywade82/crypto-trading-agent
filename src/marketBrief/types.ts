export type MarketBias = 'BULLISH' | 'BEARISH' | 'MIXED';

export type BriefAction = 'BUY_LONG' | 'SELL_SHORT' | 'NO_TRADE';

export type DataQualityStatus = 'VALID' | 'DEGRADED' | 'INVALID';

export type BriefTimeframe = '5m' | '15m' | '1h' | '4h';

export interface ConfirmedBar {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface FormingBar {
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly latestPrice: number;
  readonly volume: number;
  readonly updatedAt: number;
}

export interface CandleView {
  readonly timeframe: BriefTimeframe;
  readonly confirmed: ConfirmedBar | null;
  readonly forming: FormingBar | null;
  readonly bias: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN';
}

export interface TakerFlowBucket {
  readonly period: string;
  readonly buyVolume: number | null;
  readonly sellVolume: number | null;
  readonly buySellRatio: number | null;
  readonly timestamp: number;
}

export interface MultiPeriodDerivatives {
  readonly fundingRate: number | null;
  readonly nextFundingAt: number | null;
  readonly openInterest: number | null;
  readonly openInterestChangePct: number | null;
  readonly globalLongShortRatio: number | null;
  readonly topTraderAccountLongShortRatio: number | null;
  readonly topTraderPositionLongShortRatio: number | null;
  readonly spreadBps: number | null;
  readonly takerFlowByPeriod: Readonly<Record<string, TakerFlowBucket>>;
}

export interface DataQualityReport {
  readonly status: DataQualityStatus;
  readonly reasons: readonly string[];
  readonly lastTradeAt: number | null;
  readonly markPriceAt: number | null;
  readonly derivativesAt: number | null;
}

export interface MarketOverview {
  readonly lastPrice: number | null;
  readonly markPrice: number | null;
  readonly indexPrice: number | null;
  readonly change24hPct: number | null;
  readonly high24h: number | null;
  readonly low24h: number | null;
}

export interface MarketBriefDecision {
  readonly bias: MarketBias;
  readonly action: BriefAction;
  readonly reasonCodes: readonly string[];
  readonly confirmedTrigger?: string;
  readonly invalidation?: string;
  readonly scenarioId?: string;
  readonly evaluatedAt: number;
}

export interface DeterministicLevels {
  readonly support: readonly [number, number] | null;
  readonly resistance: readonly [number, number] | null;
  readonly equilibrium?: number | null;
}

export interface ConditionalScenarioSummary {
  readonly bullishCondition: string;
  readonly bearishCondition: string;
}

export interface MarketBrief {
  readonly schemaVersion: 1;
  readonly briefId: string;
  readonly symbol: string;
  readonly generatedAt: number;
  readonly dataQuality: DataQualityReport;
  readonly market: MarketOverview;
  readonly timeframes: Readonly<Record<BriefTimeframe, CandleView>>;
  readonly derivatives: MultiPeriodDerivatives;
  readonly decision: MarketBriefDecision;
  readonly levels: DeterministicLevels;
  readonly scenarios: ConditionalScenarioSummary;
  readonly changesSincePrevious?: readonly string[];
}
