import { z } from 'zod';

export const dataQualityStatusSchema = z.enum(['VALID', 'DEGRADED', 'INVALID']);
export const marketBiasSchema = z.enum(['BULLISH', 'BEARISH', 'MIXED']);
export const briefActionSchema = z.enum(['BUY_LONG', 'SELL_SHORT', 'NO_TRADE']);
export const briefTimeframeSchema = z.enum(['5m', '15m', '1h', '4h']);

export const dataQualityReportSchema = z.object({
  status: dataQualityStatusSchema,
  reasons: z.array(z.string()),
  lastTradeAt: z.number().nullable(),
  markPriceAt: z.number().nullable(),
  derivativesAt: z.number().nullable(),
});

export const marketOverviewSchema = z.object({
  lastPrice: z.number().nullable(),
  markPrice: z.number().nullable(),
  indexPrice: z.number().nullable(),
  change24hPct: z.number().nullable(),
  high24h: z.number().nullable(),
  low24h: z.number().nullable(),
});

export const confirmedBarSchema = z.object({
  openTime: z.number(),
  closeTime: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export const formingBarSchema = z.object({
  openTime: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  latestPrice: z.number(),
  volume: z.number(),
  updatedAt: z.number(),
});

export const candleViewSchema = z.object({
  timeframe: briefTimeframeSchema,
  confirmed: confirmedBarSchema.nullable(),
  forming: formingBarSchema.nullable(),
  bias: z.enum(['BULLISH', 'BEARISH', 'MIXED', 'UNKNOWN']),
});

export const takerFlowBucketSchema = z.object({
  period: z.string(),
  buyVolume: z.number().nullable(),
  sellVolume: z.number().nullable(),
  buySellRatio: z.number().nullable(),
  timestamp: z.number(),
});

export const multiPeriodDerivativesSchema = z.object({
  fundingRate: z.number().nullable(),
  nextFundingAt: z.number().nullable(),
  openInterest: z.number().nullable(),
  openInterestChangePct: z.number().nullable(),
  globalLongShortRatio: z.number().nullable(),
  topTraderAccountLongShortRatio: z.number().nullable(),
  topTraderPositionLongShortRatio: z.number().nullable(),
  spreadBps: z.number().nullable(),
  takerFlowByPeriod: z.record(takerFlowBucketSchema),
});

export const marketBriefDecisionSchema = z.object({
  bias: marketBiasSchema,
  action: briefActionSchema,
  reasonCodes: z.array(z.string()),
  confirmedTrigger: z.string().optional(),
  invalidation: z.string().optional(),
  scenarioId: z.string().optional(),
  evaluatedAt: z.number(),
});

export const deterministicLevelsSchema = z.object({
  support: z.tuple([z.number(), z.number()]).nullable(),
  resistance: z.tuple([z.number(), z.number()]).nullable(),
  equilibrium: z.number().nullable().optional(),
});

export const conditionalScenarioSummarySchema = z.object({
  bullishCondition: z.string(),
  bearishCondition: z.string(),
});

export const marketBriefSchema = z.object({
  schemaVersion: z.literal(1),
  briefId: z.string(),
  symbol: z.string(),
  generatedAt: z.number(),
  dataQuality: dataQualityReportSchema,
  market: marketOverviewSchema,
  timeframes: z.object({
    '5m': candleViewSchema,
    '15m': candleViewSchema,
    '1h': candleViewSchema,
    '4h': candleViewSchema,
  }),
  derivatives: multiPeriodDerivativesSchema,
  decision: marketBriefDecisionSchema,
  levels: deterministicLevelsSchema,
  scenarios: conditionalScenarioSummarySchema,
  changesSincePrevious: z.array(z.string()).optional(),
});

// Schema for constrained Ollama narrative synthesis
export const briefNarrativeSchema = z.object({
  summary: z.string(),
  bullishConditions: z.array(z.string()),
  bearishConditions: z.array(z.string()),
  unresolvedConflicts: z.array(z.string()),
  dataLimitations: z.array(z.string()),
});
