import 'dotenv/config';
import { z } from 'zod';
import type { Mode } from './types.js';

const pathWithDefault = (fallback: string) => z.string().default(fallback).transform((raw) => raw.trim() || fallback);

const timeframeTtl = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const EnvSchema = z.object({
  MODE: z.enum(['paper', 'live']).default('paper'),
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  OLLAMA_HOST: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('gemma4:31b'),
  MIN_LEVERAGE: z.coerce.number().default(5),
  MAX_LEVERAGE: z.coerce.number().default(10),
  MAX_EXPOSURE_PCT: z.coerce.number().default(80),
  RISK_PER_TRADE_PCT: z.coerce.number().default(1),
  MAX_DRAWDOWN_PCT: z.coerce.number().default(5),
  MIN_LIQ_BUFFER_ATR: z.coerce.number().default(2),
  SYMBOLS: z.string().default('BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT'),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),
  MAX_LOSS_STREAK: z.coerce.number().int().positive().default(4),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().optional(),
  MAX_SYMBOL_EXPOSURE_PCT: z.coerce.number().positive().optional(),
  MAX_CORRELATED_EXPOSURE_PCT: z.coerce.number().positive().optional(),
  MIN_RR: z.coerce.number().nonnegative().default(0),
  TAKER_FEE_RATE: z.coerce.number().nonnegative().default(0.0004),
  SLIPPAGE_BUFFER_RATE: z.coerce.number().nonnegative().default(0.0002),
  RISK_ENGINE: z.enum(['off', 'on']).default('off'),

  MARKET_DATA_1M_TTL_MS: timeframeTtl(15_000),
  MARKET_DATA_5M_TTL_MS: timeframeTtl(60_000),
  MARKET_DATA_15M_TTL_MS: timeframeTtl(60_000),
  MARKET_DATA_1H_TTL_MS: timeframeTtl(300_000),
  MARKET_DATA_4H_TTL_MS: timeframeTtl(900_000),
  MARKET_DATA_DERIVATIVES_TTL_MS: timeframeTtl(60_000),
  MARKET_DATA_KLINE_LIMIT: z.coerce.number().int().min(50).max(1000).default(300),
  MARKET_DATA_HISTORY_LIMIT: z.coerce.number().int().min(2).max(500).default(30),
  MARKET_DATA_ORDERBOOK_DEPTH: z.coerce.number().int().min(5).max(100).default(20),
  MARKET_DATA_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  MARKET_DATA_DERIVATIVES_PERIOD: z.enum(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']).default('1h'),

  AUDIT: z.enum(['off', 'on']).default('off'),
  ALERTS: z.enum(['off', 'on']).default('off'),
  EVENTS_PATH: pathWithDefault('data/events.jsonl'),
  NOTIFICATIONS_PATH: pathWithDefault('data/notifications.json'),
  PAPER_EXCHANGE_URL: z.string().optional(),
  PAPER_EXCHANGE_ACCOUNT_ID: z.string().trim().optional(),
  COINDCX_API_KEY: z.string().default(''),
  COINDCX_API_SECRET: z.string().default(''),
  COINDCX_PAPER_MODE: z.enum(['off', 'on']).default('on'),
  COINDCX_QUOTE_PREFERENCE: z.enum(['auto', 'USDT', 'INR']).default('auto'),
  COINDCX_MAX_ORDER_NOTIONAL: z.coerce.number().positive().optional(),
  COINDCX_MAX_ORDER_QUANTITY: z.coerce.number().positive().optional(),
  COINDCX_INITIAL_BALANCE: z.coerce.number().positive().default(1_150),
}).superRefine((env, ctx) => {
  if (env.MODE !== 'paper' || !env.PAPER_EXCHANGE_URL || env.PAPER_EXCHANGE_ACCOUNT_ID) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['PAPER_EXCHANGE_ACCOUNT_ID'],
    message: 'PAPER_EXCHANGE_ACCOUNT_ID must be set explicitly when PAPER_EXCHANGE_URL is set (there is no default account)',
  });
});

export const LOOP_INTERVAL_MS = 8000;

type Env = z.infer<typeof EnvSchema>;

const parseSymbols = (raw: string): string[] => raw.split(',').map(s => s.trim());

export function riskFromEnv(env: Env) {
  return {
    minLeverage: env.MIN_LEVERAGE,
    maxLeverage: env.MAX_LEVERAGE,
    maxExposurePct: env.MAX_EXPOSURE_PCT,
    riskPerTradePct: env.RISK_PER_TRADE_PCT,
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    minLiqBufferAtr: env.MIN_LIQ_BUFFER_ATR,
    maxDailyLossPct: env.MAX_DAILY_LOSS_PCT,
    maxLossStreak: env.MAX_LOSS_STREAK,
    maxConcurrentPositions: env.MAX_CONCURRENT_POSITIONS ?? parseSymbols(env.SYMBOLS).length,
    maxSymbolExposurePct: env.MAX_SYMBOL_EXPOSURE_PCT ?? env.MAX_EXPOSURE_PCT,
    maxCorrelatedExposurePct: env.MAX_CORRELATED_EXPOSURE_PCT ?? env.MAX_EXPOSURE_PCT,
    minRr: env.MIN_RR,
    takerFeeRate: env.TAKER_FEE_RATE,
    slippageBufferRate: env.SLIPPAGE_BUFFER_RATE,
  };
}

const env = EnvSchema.parse(process.env);

export const config = {
  mode: env.MODE as Mode,
  binance: { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET },
  ollama: { host: env.OLLAMA_HOST, model: env.OLLAMA_MODEL },
  risk: riskFromEnv(env),
  riskEngine: env.RISK_ENGINE,
  marketDataV2: {
    enabled: true,
    candleTtlMs: {
      '1m': env.MARKET_DATA_1M_TTL_MS,
      '5m': env.MARKET_DATA_5M_TTL_MS,
      '15m': env.MARKET_DATA_15M_TTL_MS,
      '1h': env.MARKET_DATA_1H_TTL_MS,
      '4h': env.MARKET_DATA_4H_TTL_MS,
    },
    derivativesTtlMs: env.MARKET_DATA_DERIVATIVES_TTL_MS,
    klineLimit: env.MARKET_DATA_KLINE_LIMIT,
    historyLimit: env.MARKET_DATA_HISTORY_LIMIT,
    orderBookDepth: env.MARKET_DATA_ORDERBOOK_DEPTH,
    maxConcurrency: env.MARKET_DATA_MAX_CONCURRENCY,
    derivativesPeriod: env.MARKET_DATA_DERIVATIVES_PERIOD,
    basisEnabled: true,
  },
  audit: env.AUDIT,
  alerts: env.ALERTS,
  eventsPath: env.EVENTS_PATH,
  notificationsPath: env.NOTIFICATIONS_PATH,
  symbols: parseSymbols(env.SYMBOLS),
  paperExchange: env.PAPER_EXCHANGE_URL && env.PAPER_EXCHANGE_ACCOUNT_ID
    ? { url: env.PAPER_EXCHANGE_URL.replace(/\/+$/, ''), accountId: env.PAPER_EXCHANGE_ACCOUNT_ID }
    : null,
  coindcx: env.MODE === 'live' ? {
    apiKey: env.COINDCX_API_KEY,
    apiSecret: env.COINDCX_API_SECRET,
    paperMode: env.COINDCX_PAPER_MODE === 'on',
    quotePreference: env.COINDCX_QUOTE_PREFERENCE,
    maxOrderNotional: env.COINDCX_MAX_ORDER_NOTIONAL,
    maxOrderQuantity: env.COINDCX_MAX_ORDER_QUANTITY,
    initialBalance: env.COINDCX_INITIAL_BALANCE,
  } : null,
} as const;

if (config.mode === 'live' && (!config.binance.apiKey || !config.binance.apiSecret)) {
  throw new Error('LIVE mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
}
if (config.mode === 'live' && (!config.coindcx?.apiKey || !config.coindcx.apiSecret)) {
  throw new Error('LIVE mode requires COINDCX_API_KEY and COINDCX_API_SECRET');
}
