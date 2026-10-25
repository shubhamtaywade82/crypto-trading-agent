import { z } from 'zod';

const onOff = (fallback: 'on' | 'off') => z.enum(['off', 'on']).default(fallback);
const pct = (fallback: number) => z.coerce.number().gt(0).lt(100).default(fallback);
const positive = (fallback: number) => z.coerce.number().positive().default(fallback);

/**
 * Where option positions live. `auto` (the default) follows the cockpit's MODE, so `npm run dev:paper` trades futures and
 * options together:
 *   MODE=paper                       -> local    (in-process options book)
 *   MODE=paper + PAPER_EXCHANGE_URL  -> paper_exchange, on its own `<PAPER_EXCHANGE_ACCOUNT_ID>-options` wallet
 *   MODE=live                        -> monitor  (signals and alerts; no live options execution exists)
 * CoinDCX and Binance live execution are refused below.
 */
const VENUES = ['local', 'paper_exchange', 'monitor'] as const;
export type OptionsVenueKind = (typeof VENUES)[number];
const ALIASES: Record<string, OptionsVenueKind> = { coindcx_monitor: 'monitor' };

const REFUSED_VENUES: Record<string, string> = {
  coindcx: 'CoinDCX options execution is refused: @nemesis-oss/coindcx-sdk 1.3.0 exposes no options endpoints. Use OPTIONS_VENUE=coindcx_monitor for signals and alerts only',
  coindcx_live: 'CoinDCX options execution is refused: @nemesis-oss/coindcx-sdk 1.3.0 exposes no options endpoints. Use OPTIONS_VENUE=coindcx_monitor for signals and alerts only',
  binance: 'Binance live options execution is not wired: it needs the live guard set (startup reconciliation, trade journal, exchange-side protection) ported first. Use OPTIONS_VENUE=local or paper_exchange',
  binance_live: 'Binance live options execution is not wired: it needs the live guard set (startup reconciliation, trade journal, exchange-side protection) ported first. Use OPTIONS_VENUE=local or paper_exchange',
};

/** The venue `auto` and an explicit OPTIONS_VENUE resolve to under the cockpit's MODE; a string is a refusal reason. */
export function resolveVenue(env: { OPTIONS_VENUE: string; MODE: 'paper' | 'live'; PAPER_EXCHANGE_URL?: string }): OptionsVenueKind | { refused: string } {
  const raw = env.OPTIONS_VENUE.toLowerCase();
  if (REFUSED_VENUES[raw]) return { refused: REFUSED_VENUES[raw] };
  if (raw === 'auto') return env.MODE === 'live' ? 'monitor' : env.PAPER_EXCHANGE_URL ? 'paper_exchange' : 'local';
  const venue = ALIASES[raw] ?? raw;
  if (!(VENUES as readonly string[]).includes(venue)) return { refused: `OPTIONS_VENUE must be one of auto, ${VENUES.join(', ')}` };
  if (env.MODE === 'live' && venue !== 'monitor') {
    return { refused: `MODE=live runs options monitor-only (no live options execution is wired); OPTIONS_VENUE=${raw} would paper-trade options beside live futures. Use OPTIONS_VENUE=auto or monitor` };
  }
  return venue as OptionsVenueKind;
}

export const OptionsEnvSchema = z.object({
  /** Options run beside futures in the cockpit; off disables the options desk entirely. */
  OPTIONS: onOff('on'),
  MODE: z.enum(['paper', 'live']).default('paper'),
  OPTIONS_VENUE: z.string().trim().default('auto'),
  OPTIONS_UNDERLYINGS: z.string().default('BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT'),
  /** Starting USDT balance of the in-process paper venue. */
  OPTIONS_LOCAL_EQUITY: positive(1_000),
  PAPER_EXCHANGE_URL: z.string().trim().optional(),
  PAPER_EXCHANGE_API_KEY: z.string().trim().optional(),
  /** The futures account; the options wallet defaults to `<this>-options`. */
  PAPER_EXCHANGE_ACCOUNT_ID: z.string().trim().optional(),
  /**
   * A dedicated USD/USDT account, like Binance's separate Options wallet. Sharing the futures account is refused: the
   * perpetual broker path would read option positions as perpetuals.
   */
  OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID: z.string().trim().optional(),
  OPTIONS_LOOP_MS: z.coerce.number().int().min(5_000).default(15_000),

  OPTIONS_MIN_DTE_HOURS: positive(24),
  OPTIONS_MAX_DTE_HOURS: positive(240),
  OPTIONS_TARGET_DELTA: z.coerce.number().gt(0).lt(1).default(0.45),
  OPTIONS_MIN_DELTA: z.coerce.number().gt(0).lt(1).default(0.3),
  OPTIONS_MAX_DELTA: z.coerce.number().gt(0).lt(1).default(0.6),
  OPTIONS_MAX_SPREAD_PCT: pct(8),
  /** Implied over realized volatility above which a premium is too expensive to buy. */
  OPTIONS_MAX_IV_RV: positive(1.5),
  /** Largest relative gap between the venue's mark and the Black-Scholes price from its own mark IV. */
  OPTIONS_MODEL_TOLERANCE: z.coerce.number().gt(0).lt(1).default(0.25),
  /** Contract units the economics are verified for; widen only after checking the venue's premium convention. */
  OPTIONS_ALLOWED_UNITS: z.string().default('1'),
  OPTIONS_DEPTH_CANDIDATES: z.coerce.number().int().min(1).max(10).default(3),

  OPTIONS_RISK_PER_TRADE_PCT: pct(1),
  /** Hard cap on one trade's premium: a gap through the stop can lose all of it. */
  OPTIONS_MAX_PREMIUM_PCT: pct(2),
  OPTIONS_MAX_TOTAL_PREMIUM_PCT: pct(6),
  OPTIONS_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).default(2),
  OPTIONS_MAX_DAILY_LOSS_PCT: pct(3),
  OPTIONS_MAX_LOSS_STREAK: z.coerce.number().int().min(1).default(4),

  OPTIONS_STOP_PCT: pct(30),
  OPTIONS_TARGET_PCT: positive(60),
  OPTIONS_TRAIL_ARM_PCT: positive(30),
  OPTIONS_TRAIL_PCT: pct(20),
  OPTIONS_MAX_HOLD_HOURS: positive(24),
  OPTIONS_EXIT_BEFORE_EXPIRY_HOURS: positive(6),
  /** Horizon the expected underlying move is scaled to (1h ATR x sqrt(hours)). */
  OPTIONS_HOLD_HORIZON_HOURS: positive(8),
  OPTIONS_MIN_EDGE_RATIO: positive(1.5),
  OPTIONS_MIN_REWARD_RISK: positive(1.5),
  OPTIONS_MAX_SLIPPAGE_PCT: pct(2),

  OPTIONS_QUOTE_STALE_MS: z.coerce.number().int().positive().default(10_000),
  OPTIONS_INDEX_STALE_MS: z.coerce.number().int().positive().default(10_000),
  OPTIONS_MIN_ADX: z.coerce.number().min(0).default(20),
  OPTIONS_RSI_MAX_LONG: z.coerce.number().gt(50).lt(100).default(70),
  OPTIONS_RSI_MIN_SHORT: z.coerce.number().gt(0).lt(50).default(30),
  OPTIONS_COOLDOWN_MINUTES: z.coerce.number().min(0).default(30),
  OPTIONS_MAX_EXIT_ATTEMPTS_BEFORE_ALERT: z.coerce.number().int().min(1).default(3),

  OPTIONS_FEE_RATE: z.coerce.number().min(0).lt(0.01).default(0.0003),
  OPTIONS_FEE_CAP: z.coerce.number().min(0).max(1).default(0.1),
  OPTIONS_LLM_VETO: onOff('on'),
  /** Blank derives a per-venue path, so switching MODE never reconciles one venue's positions against another's. */
  OPTIONS_STATE_PATH: z.string().trim().default(''),
  OPTIONS_JOURNAL_PATH: z.string().trim().default(''),
}).superRefine((env, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  const venue = resolveVenue(env);
  if (typeof venue !== 'string') issue('OPTIONS_VENUE', venue.refused);
  if (venue === 'paper_exchange') {
    const account = optionsAccountId(env);
    if (!env.PAPER_EXCHANGE_URL || !account) {
      issue('OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID', 'options on paper_exchange need PAPER_EXCHANGE_URL and OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID (or PAPER_EXCHANGE_ACCOUNT_ID, from which `<id>-options` is derived)');
    } else if (account === env.PAPER_EXCHANGE_ACCOUNT_ID) {
      issue('OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID', 'OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID must differ from PAPER_EXCHANGE_ACCOUNT_ID: the futures broker path would read option positions as perpetuals');
    }
  }
  if (!(env.OPTIONS_MIN_DELTA < env.OPTIONS_TARGET_DELTA && env.OPTIONS_TARGET_DELTA < env.OPTIONS_MAX_DELTA)) {
    issue('OPTIONS_TARGET_DELTA', 'OPTIONS_MIN_DELTA < OPTIONS_TARGET_DELTA < OPTIONS_MAX_DELTA must hold');
  }
  if (env.OPTIONS_MIN_DTE_HOURS >= env.OPTIONS_MAX_DTE_HOURS) issue('OPTIONS_MIN_DTE_HOURS', 'OPTIONS_MIN_DTE_HOURS must be below OPTIONS_MAX_DTE_HOURS');
  if (env.OPTIONS_EXIT_BEFORE_EXPIRY_HOURS >= env.OPTIONS_MIN_DTE_HOURS) {
    issue('OPTIONS_EXIT_BEFORE_EXPIRY_HOURS', 'OPTIONS_EXIT_BEFORE_EXPIRY_HOURS must be below OPTIONS_MIN_DTE_HOURS, or every entry would be force-exited at once');
  }
  if (env.OPTIONS_RISK_PER_TRADE_PCT > env.OPTIONS_MAX_PREMIUM_PCT) {
    issue('OPTIONS_RISK_PER_TRADE_PCT', 'OPTIONS_RISK_PER_TRADE_PCT cannot exceed OPTIONS_MAX_PREMIUM_PCT: the premium is the most a long option can lose');
  }
  if (env.OPTIONS_MAX_PREMIUM_PCT > env.OPTIONS_MAX_TOTAL_PREMIUM_PCT) issue('OPTIONS_MAX_PREMIUM_PCT', 'OPTIONS_MAX_PREMIUM_PCT cannot exceed OPTIONS_MAX_TOTAL_PREMIUM_PCT');
  const units = env.OPTIONS_ALLOWED_UNITS.split(',').map((u) => Number(u.trim()));
  if (units.length === 0 || units.some((u) => !(u > 0))) issue('OPTIONS_ALLOWED_UNITS', 'OPTIONS_ALLOWED_UNITS must be a comma-separated list of positive numbers');
  const underlyings = env.OPTIONS_UNDERLYINGS.split(',').map((s) => s.trim()).filter(Boolean);
  if (underlyings.length === 0 || underlyings.some((s) => !/^[A-Z0-9]+USDT$/.test(s))) issue('OPTIONS_UNDERLYINGS', 'OPTIONS_UNDERLYINGS must list USDT underlyings, e.g. BTCUSDT,ETHUSDT');
});

export type OptionsEnv = z.infer<typeof OptionsEnvSchema>;

function optionsAccountId(env: { OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID?: string; PAPER_EXCHANGE_ACCOUNT_ID?: string }): string | undefined {
  return env.OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID || (env.PAPER_EXCHANGE_ACCOUNT_ID ? `${env.PAPER_EXCHANGE_ACCOUNT_ID}-options` : undefined);
}

export interface OptionsConfig {
  enabled: boolean;
  venue: OptionsVenueKind;
  underlyings: string[];
  localEquity: number;
  paperExchange: { url: string; accountId: string; apiKey?: string } | null;
  loopMs: number;
  selection: {
    minDteHours: number;
    maxDteHours: number;
    targetDelta: number;
    minDelta: number;
    maxDelta: number;
    maxSpreadPct: number;
    maxIvRv: number;
    modelTolerance: number;
    allowedUnits: number[];
    depthCandidates: number;
    quoteStaleMs: number;
    indexStaleMs: number;
  };
  economics: { holdHorizonHours: number; minEdgeRatio: number; minRewardRisk: number };
  risk: {
    riskPerTradePct: number;
    maxPremiumPct: number;
    maxTotalPremiumPct: number;
    maxOpenPositions: number;
    maxDailyLossPct: number;
    maxLossStreak: number;
    maxSlippagePct: number;
  };
  exits: {
    stopPct: number;
    targetPct: number;
    trailArmPct: number;
    trailPct: number;
    maxHoldMs: number;
    exitBeforeExpiryMs: number;
    maxExitAttemptsBeforeAlert: number;
  };
  direction: { minAdx: number; rsiMaxLong: number; rsiMinShort: number };
  cooldownMs: number;
  fees: { rate: number; cap: number };
  llmVeto: boolean;
  statePath: string;
  journalPath: string;
}

export function optionsConfigFromEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): OptionsConfig {
  const env = OptionsEnvSchema.parse(source);
  const venue = resolveVenue(env) as OptionsVenueKind;
  const venueTag = venue === 'paper_exchange' ? `paper_exchange-${optionsAccountId(env)!.replace(/[^A-Za-z0-9_-]/g, '_')}` : venue;
  return {
    enabled: env.OPTIONS === 'on',
    venue,
    underlyings: env.OPTIONS_UNDERLYINGS.split(',').map((s) => s.trim()).filter(Boolean),
    localEquity: env.OPTIONS_LOCAL_EQUITY,
    paperExchange: venue === 'paper_exchange'
      ? { url: env.PAPER_EXCHANGE_URL!.replace(/\/+$/, ''), accountId: optionsAccountId(env)!, apiKey: env.PAPER_EXCHANGE_API_KEY }
      : null,
    loopMs: env.OPTIONS_LOOP_MS,
    selection: {
      minDteHours: env.OPTIONS_MIN_DTE_HOURS,
      maxDteHours: env.OPTIONS_MAX_DTE_HOURS,
      targetDelta: env.OPTIONS_TARGET_DELTA,
      minDelta: env.OPTIONS_MIN_DELTA,
      maxDelta: env.OPTIONS_MAX_DELTA,
      maxSpreadPct: env.OPTIONS_MAX_SPREAD_PCT,
      maxIvRv: env.OPTIONS_MAX_IV_RV,
      modelTolerance: env.OPTIONS_MODEL_TOLERANCE,
      allowedUnits: env.OPTIONS_ALLOWED_UNITS.split(',').map((u) => Number(u.trim())),
      depthCandidates: env.OPTIONS_DEPTH_CANDIDATES,
      quoteStaleMs: env.OPTIONS_QUOTE_STALE_MS,
      indexStaleMs: env.OPTIONS_INDEX_STALE_MS,
    },
    economics: {
      holdHorizonHours: env.OPTIONS_HOLD_HORIZON_HOURS,
      minEdgeRatio: env.OPTIONS_MIN_EDGE_RATIO,
      minRewardRisk: env.OPTIONS_MIN_REWARD_RISK,
    },
    risk: {
      riskPerTradePct: env.OPTIONS_RISK_PER_TRADE_PCT,
      maxPremiumPct: env.OPTIONS_MAX_PREMIUM_PCT,
      maxTotalPremiumPct: env.OPTIONS_MAX_TOTAL_PREMIUM_PCT,
      maxOpenPositions: env.OPTIONS_MAX_OPEN_POSITIONS,
      maxDailyLossPct: env.OPTIONS_MAX_DAILY_LOSS_PCT,
      maxLossStreak: env.OPTIONS_MAX_LOSS_STREAK,
      maxSlippagePct: env.OPTIONS_MAX_SLIPPAGE_PCT,
    },
    exits: {
      stopPct: env.OPTIONS_STOP_PCT,
      targetPct: env.OPTIONS_TARGET_PCT,
      trailArmPct: env.OPTIONS_TRAIL_ARM_PCT,
      trailPct: env.OPTIONS_TRAIL_PCT,
      maxHoldMs: env.OPTIONS_MAX_HOLD_HOURS * 3_600_000,
      exitBeforeExpiryMs: env.OPTIONS_EXIT_BEFORE_EXPIRY_HOURS * 3_600_000,
      maxExitAttemptsBeforeAlert: env.OPTIONS_MAX_EXIT_ATTEMPTS_BEFORE_ALERT,
    },
    direction: { minAdx: env.OPTIONS_MIN_ADX, rsiMaxLong: env.OPTIONS_RSI_MAX_LONG, rsiMinShort: env.OPTIONS_RSI_MIN_SHORT },
    cooldownMs: env.OPTIONS_COOLDOWN_MINUTES * 60_000,
    fees: { rate: env.OPTIONS_FEE_RATE, cap: env.OPTIONS_FEE_CAP },
    llmVeto: env.OPTIONS_LLM_VETO === 'on',
    statePath: env.OPTIONS_STATE_PATH || `data/options-state-${venueTag}.json`,
    journalPath: env.OPTIONS_JOURNAL_PATH || `data/options-journal-${venueTag}.jsonl`,
  };
}
