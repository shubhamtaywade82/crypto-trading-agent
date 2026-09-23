import 'dotenv/config';
import { z } from 'zod';
import type { Mode } from './types.js';

// A blank variable (a placeholder left in .env) must not turn into a file named ''
const pathWithDefault = (fallback: string) => z.string().default(fallback).transform((raw) => raw.trim() || fallback);

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
  // Zero would trip the circuit breaker on the first tick, so the loss limits must be positive.
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),
  MAX_LOSS_STREAK: z.coerce.number().int().positive().default(4),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().optional(),
  MAX_SYMBOL_EXPOSURE_PCT: z.coerce.number().positive().optional(),
  MAX_CORRELATED_EXPOSURE_PCT: z.coerce.number().positive().optional(),
  // 0 disables the reward:risk check (Adaptive strategy's R:R is below 1).
  MIN_RR: z.coerce.number().nonnegative().default(0),
  TAKER_FEE_RATE: z.coerce.number().nonnegative().default(0.0004),
  SLIPPAGE_BUFFER_RATE: z.coerce.number().nonnegative().default(0.0002),
  RISK_ENGINE: z.enum(['off', 'on']).default('off'),
  MARKET_STATE_V1: z.enum(['off', 'on']).default('on'),
  AUDIT: z.enum(['off', 'on']).default('off'),
  ALERTS: z.enum(['off', 'on']).default('off'),
  EVENTS_PATH: pathWithDefault('data/events.jsonl'),
  NOTIFICATIONS_PATH: pathWithDefault('data/notifications.json'),
  // When set, PAPER mode routes account/positions/orders through the
  // paper_exchange Rails broker over HTTP instead of the local in-memory
  // PaperEngine. Unset by default — zero behavior change unless configured.
  PAPER_EXCHANGE_URL: z.string().optional(),
  // No default: a silent shared account id would make two setups trade on each other's account.
  PAPER_EXCHANGE_ACCOUNT_ID: z.string().trim().optional(),
  COINDCX_API_KEY: z.string().default(''),
  COINDCX_API_SECRET: z.string().default(''),
  // Routes through the SDK's own paper engine (no real orders) until explicitly turned off.
  COINDCX_PAPER_MODE: z.enum(['off', 'on']).default('on'),
  COINDCX_QUOTE_PREFERENCE: z.enum(['auto', 'USDT', 'INR']).default('auto'),
  COINDCX_MAX_ORDER_NOTIONAL: z.coerce.number().positive().optional(),
  COINDCX_MAX_ORDER_QUANTITY: z.coerce.number().positive().optional(),
  // Same realistic bankroll as the two paper venues (see src/binance/paperEngine.ts).
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

/** Resolves config.risk, defaulting the unset caps from the existing exposure and symbol settings. */
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
  // 'off' keeps today's RiskAgent behaviour; 'on' routes sizing and vetoes through src/risk.
  riskEngine: env.RISK_ENGINE,
  // Read-only in this phase: builds MarketState and makes it available to strategies without changing execution.
  marketStateV1: env.MARKET_STATE_V1,
  // Both default off: 'on' writes the JSONL audit trail / sends Telegram cards (TELEGRAM_* env vars, see README).
  audit: env.AUDIT,
  alerts: env.ALERTS,
  eventsPath: env.EVENTS_PATH,
  notificationsPath: env.NOTIFICATIONS_PATH,
  symbols: parseSymbols(env.SYMBOLS),
  // Non-null only when PAPER mode should be backed by the remote
  // paper_exchange broker instead of the local PaperEngine.
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
// CoinDCX is the only live execution path (see the 2026-09-22 design doc) — no silent fallback to raw Binance orders.
if (config.mode === 'live' && (!config.coindcx?.apiKey || !config.coindcx.apiSecret)) {
  throw new Error('LIVE mode requires COINDCX_API_KEY and COINDCX_API_SECRET');
}
