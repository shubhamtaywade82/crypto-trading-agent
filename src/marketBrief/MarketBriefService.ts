import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import { buildSetupMap } from '../decision/SetupEngine.js';
import { annotateSetupMap } from '../decision/SetupPipeline.js';
import type { CostRates } from '../risk/rrProfile.js';
import type { MarketState, MarketStateInput } from '../market/types.js';
import {
  BinanceMarketBriefDataProvider,
  type MarketBriefRawData,
} from './MarketBriefDataProvider.js';
import { assessBriefSafety } from './MarketBriefSafety.js';
import { evaluateBriefDecision } from './MarketBriefDecision.js';
import { marketBriefSchema } from './schemas.js';
import type { MarketBrief } from './types.js';

export const DEFAULT_BRIEF_COSTS: CostRates = {
  feeRate: 0.0005, // 5 bps standard taker fee
  slippageRate: 0.0005, // 5 bps conservative baseline slippage
};

// Converts normalized raw exchange data into MarketState input
function buildStateInput(raw: MarketBriefRawData, now: number): MarketStateInput {
  return {
    symbol: raw.symbol,
    mark: raw.overview.markPrice ?? raw.overview.lastPrice ?? 0,
    fundingRate: raw.derivatives.fundingRate ?? 0,
    candles: raw.confirmedSeries['15m'],
    candlesByTimeframe: {
      '15m': raw.confirmedSeries['15m'],
      '1h': raw.confirmedSeries['1h'],
      '4h': raw.confirmedSeries['4h'],
    },
    derivatives: {
      asOf: now,
      openInterest: raw.derivatives.openInterest,
      openInterestChangePct: raw.derivatives.openInterestChangePct,
      globalLongShortRatio: raw.derivatives.globalLongShortRatio,
      topTraderAccountLongShortRatio: raw.derivatives.topTraderAccountLongShortRatio,
      topTraderPositionLongShortRatio: raw.derivatives.topTraderPositionLongShortRatio,
      takerBuySellRatio: raw.derivatives.takerFlowByPeriod['15m']?.buySellRatio ?? null,
      takerVolumeImbalance: null,
      orderBookImbalance: null,
      spreadBps: raw.derivatives.spreadBps,
      basisPct: null,
    },
  };
}

export class MarketBriefService {
  private readonly provider: BinanceMarketBriefDataProvider;
  private readonly stateBuilder: MarketStateBuilder;
  private readonly costs: CostRates;

  constructor(
    provider?: BinanceMarketBriefDataProvider,
    stateBuilder?: MarketStateBuilder,
    costs: CostRates = DEFAULT_BRIEF_COSTS
  ) {
    this.provider = provider ?? new BinanceMarketBriefDataProvider();
    this.stateBuilder = stateBuilder ?? new MarketStateBuilder();
    this.costs = costs;
  }

  async generateBrief(symbol: string, now: number = Date.now()): Promise<MarketBrief> {
    const raw = await this.provider.getSnapshot(symbol, now);
    const safety = assessBriefSafety(raw, now);

    let state: MarketState | null = null;
    let setupMap: ReturnType<typeof annotateSetupMap> | null = null;

    if (safety.status !== 'INVALID') {
      const input = buildStateInput(raw, now);
      state = this.stateBuilder.build(input);
      const rawMap = buildSetupMap(state);
      setupMap = annotateSetupMap(state, rawMap, undefined, this.costs);
    }

    const { decision, levels, scenarios } = evaluateBriefDecision(safety, state, setupMap, now);

    const brief: MarketBrief = {
      schemaVersion: 1,
      briefId: `brief_${symbol}_${now}`,
      symbol,
      generatedAt: now,
      dataQuality: safety,
      market: raw.overview,
      timeframes: raw.candleViews,
      derivatives: raw.derivatives,
      decision,
      levels,
      scenarios,
    };

    return marketBriefSchema.parse(brief) as MarketBrief;
  }
}
