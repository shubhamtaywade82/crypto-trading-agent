import { z } from 'zod';
import type { RiskLimits } from '../domain/risk.js';

/** The only execution mode this runtime has. There is no second value to switch to. */
export const EXECUTION_MODE = 'PAPER_ONLY' as const;

export class PaperOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaperOnlyViolationError';
  }
}

const list = (raw: string): string[] => raw.split(',').map((item) => item.trim()).filter(Boolean);
const flag = z.enum(['off', 'on']);

const Schema = z.object({
  MODE: z.string().default('paper'),
  PAPER_EXCHANGE_URL: z.string().url(),
  PAPER_EXCHANGE_ACCOUNT_ID: z.string().trim().min(1),
  PAPER_EXCHANGE_API_KEY: z.string().trim().optional(),
  SYMBOLS: z.string().default('BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT'),

  PAPER_CORE_STRATEGIES: z.string().default('momentum-ema-cross,range-breakout,mean-reversion-zscore'),
  /** JSON object: strategy id -> parameter overrides. */
  PAPER_CORE_STRATEGY_PARAMS: z.string().default('{}'),
  /** Defaults are per account (data/accounts/<id>/...), so two accounts never share state. Set these only deliberately. */
  PAPER_CORE_JOURNAL: z.string().optional(),
  PAPER_CORE_STATE: z.string().optional(),
  PAPER_CORE_OWNERSHIP: z.string().optional(),
  /** The simulated account research uses for its replay admin calls. It must never be the trading account. */
  PAPER_CORE_RESEARCH_ACCOUNT_ID: z.string().trim().default('research-admin'),
  PAPER_CORE_LEASE_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
  /** While this file exists every entry is refused. */
  PAPER_CORE_KILL_FILE: z.string().default('data/paper-core.KILL'),
  PAPER_CORE_MARK_PUSH_MS: z.coerce.number().int().min(1000).default(5000),
  PAPER_CORE_BAR_SETTLE_MS: z.coerce.number().int().min(0).default(2000),
  PAPER_CORE_MAX_MARK_AGE_MS: z.coerce.number().int().positive().default(60_000),
  PAPER_CORE_MIN_REWARD_RISK: z.coerce.number().positive().default(1),
  PAPER_CORE_QUANTITY_STEP: z.coerce.number().positive().default(0.001),
  PAPER_CORE_MIN_NOTIONAL: z.coerce.number().positive().default(10),
  PAPER_CORE_RESEARCH_CAPITAL: z.coerce.number().positive().default(10_000),
  PAPER_CORE_RESEARCH_SLIPPAGE_BPS: z.coerce.number().min(0).max(999).default(2),
  PAPER_CORE_ADVISOR: flag.default('off'),
  PAPER_CORE_ADVISOR_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // The same names and defaults the rest of the repository uses for its risk envelope
  RISK_PER_TRADE_PCT: z.coerce.number().positive().max(100).default(1),
  MAX_LEVERAGE: z.coerce.number().int().min(1).max(125).default(10),
  MAX_EXPOSURE_PCT: z.coerce.number().positive().default(80),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().default(5),
  MAX_LOSS_STREAK: z.coerce.number().int().positive().default(4),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().optional(),
  TAKER_FEE_RATE: z.coerce.number().nonnegative().default(0.0004),
  SLIPPAGE_BUFFER_RATE: z.coerce.number().nonnegative().default(0.0002),

  OLLAMA_HOST: z.string().default('https://ollama.com'),
  OLLAMA_MODEL: z.string().default('beam'),
  OLLAMA_API_KEY_1: z.string().optional(),
});

export interface PaperCoreConfig {
  readonly executionMode: typeof EXECUTION_MODE;
  readonly paperExchange: { readonly url: string; readonly accountId: string; readonly apiKey?: string };
  readonly symbols: readonly string[];
  readonly strategyIds: readonly string[];
  readonly strategyParameters: Readonly<Record<string, unknown>>;
  readonly limits: RiskLimits;
  readonly journalPath: string;
  readonly statePath: string;
  readonly ownershipPath: string;
  readonly researchAccountId: string;
  readonly leaseTtlSeconds: number;
  readonly killFile: string;
  readonly markPushMs: number;
  readonly barSettleMs: number;
  readonly research: { readonly initialCapital: number; readonly slippageBps: number };
  readonly advisor: { readonly host: string; readonly model: string; readonly timeoutMs: number; readonly apiKey?: string } | null;
}

/**
 * Validates the environment for the paper-only runtime and refuses to produce a config for anything else.
 * It never reads BINANCE_API_KEY, BINANCE_API_SECRET or any CoinDCX credential: this runtime builds its Binance client
 * without credentials, so the values are irrelevant to it and are not copied anywhere it could reach.
 */
export function validatePaperOnlyConfig(env: Readonly<Record<string, string | undefined>>): PaperCoreConfig {
  const mode = (env.MODE ?? 'paper').trim().toLowerCase();
  if (mode !== 'paper') {
    throw new PaperOnlyViolationError(`MODE=${env.MODE} is refused: the paper core has no live execution path. Unset MODE or set MODE=paper.`);
  }
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`paper core configuration: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
  if (!ACCOUNT_ID.test(e.PAPER_EXCHANGE_ACCOUNT_ID)) {
    throw new Error('paper core configuration: PAPER_EXCHANGE_ACCOUNT_ID may use letters, digits, "_" and "-" only (1 to 64 characters)');
  }
  if (!ACCOUNT_ID.test(e.PAPER_CORE_RESEARCH_ACCOUNT_ID)) {
    throw new Error('paper core configuration: PAPER_CORE_RESEARCH_ACCOUNT_ID may use letters, digits, "_" and "-" only (1 to 64 characters)');
  }
  if (e.PAPER_CORE_RESEARCH_ACCOUNT_ID === e.PAPER_EXCHANGE_ACCOUNT_ID) {
    throw new Error('paper core configuration: PAPER_CORE_RESEARCH_ACCOUNT_ID must not be the trading account; research runs on a simulated account');
  }
  const symbols = list(e.SYMBOLS);
  if (symbols.length === 0) throw new Error('paper core configuration: SYMBOLS is empty');
  const accountDir = `data/accounts/${e.PAPER_EXCHANGE_ACCOUNT_ID}`;
  let strategyParameters: unknown;
  try {
    strategyParameters = JSON.parse(e.PAPER_CORE_STRATEGY_PARAMS);
  } catch {
    throw new Error('paper core configuration: PAPER_CORE_STRATEGY_PARAMS is not valid JSON');
  }
  if (typeof strategyParameters !== 'object' || strategyParameters === null || Array.isArray(strategyParameters)) {
    throw new Error('paper core configuration: PAPER_CORE_STRATEGY_PARAMS must be a JSON object keyed by strategy id');
  }
  return Object.freeze({
    executionMode: EXECUTION_MODE,
    paperExchange: { url: e.PAPER_EXCHANGE_URL.replace(/\/+$/, ''), accountId: e.PAPER_EXCHANGE_ACCOUNT_ID, ...(e.PAPER_EXCHANGE_API_KEY ? { apiKey: e.PAPER_EXCHANGE_API_KEY } : {}) },
    symbols,
    strategyIds: list(e.PAPER_CORE_STRATEGIES),
    strategyParameters: strategyParameters as Record<string, unknown>,
    limits: Object.freeze({
      allowedSymbols: symbols,
      riskPerTradePct: e.RISK_PER_TRADE_PCT,
      maxLeverage: e.MAX_LEVERAGE,
      maxConcurrentPositions: e.MAX_CONCURRENT_POSITIONS ?? symbols.length,
      // MAX_EXPOSURE_PCT caps margin in use, as elsewhere in this repository; at the leverage cap that is this much notional
      maxGrossExposurePct: e.MAX_EXPOSURE_PCT * e.MAX_LEVERAGE,
      maxDailyLossPct: e.MAX_DAILY_LOSS_PCT,
      maxDrawdownPct: e.MAX_DRAWDOWN_PCT,
      maxLossStreak: e.MAX_LOSS_STREAK,
      minRewardRisk: e.PAPER_CORE_MIN_REWARD_RISK,
      maxMarkAgeMs: e.PAPER_CORE_MAX_MARK_AGE_MS,
      costRatePerLeg: e.TAKER_FEE_RATE + e.SLIPPAGE_BUFFER_RATE,
      minNotional: e.PAPER_CORE_MIN_NOTIONAL,
      quantityStep: e.PAPER_CORE_QUANTITY_STEP,
    }),
    journalPath: e.PAPER_CORE_JOURNAL ?? `${accountDir}/events.jsonl`,
    statePath: e.PAPER_CORE_STATE ?? `${accountDir}/state.json`,
    ownershipPath: e.PAPER_CORE_OWNERSHIP ?? `${accountDir}/ownership.jsonl`,
    researchAccountId: e.PAPER_CORE_RESEARCH_ACCOUNT_ID,
    leaseTtlSeconds: e.PAPER_CORE_LEASE_TTL_SECONDS,
    killFile: e.PAPER_CORE_KILL_FILE,
    markPushMs: e.PAPER_CORE_MARK_PUSH_MS,
    barSettleMs: e.PAPER_CORE_BAR_SETTLE_MS,
    research: { initialCapital: e.PAPER_CORE_RESEARCH_CAPITAL, slippageBps: e.PAPER_CORE_RESEARCH_SLIPPAGE_BPS },
    advisor: e.PAPER_CORE_ADVISOR === 'on'
      ? { host: e.OLLAMA_HOST, model: e.OLLAMA_MODEL, timeoutMs: e.PAPER_CORE_ADVISOR_TIMEOUT_MS, ...(e.OLLAMA_API_KEY_1?.trim() ? { apiKey: e.OLLAMA_API_KEY_1.trim() } : {}) }
      : null,
  });
}
