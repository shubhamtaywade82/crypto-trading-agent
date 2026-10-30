/**
 * Monte Carlo risk simulation for a strategy's realized (or hypothetical) trade series.
 *
 * What this answers — and what it deliberately does NOT answer:
 *
 *   It answers: "given the distribution of net-R outcomes this strategy actually produced, what could a live
 *   account experience?" — drawdown distributions, probability of breaching the kill-switch drawdown limit,
 *   probability of ruin, recovery-time distribution, liquidation frequency under a stated leverage assumption,
 *   and the spread of final outcomes. All estimates come with binomial standard errors, because a probability
 *   estimated from 5,000 simulated paths still has sampling noise.
 *
 *   It does NOT answer: "does this strategy have an edge?" Monte Carlo cannot create information that is not
 *   in the trade series. If the historical trades are negative expectancy, the simulation faithfully shows the
 *   consequences of trading a losing strategy. If they are positive, the simulation shows how fragile that
 *   positivity is. Promotion evidence comes from the statistics plane (Bootstrap, PromotionGate); this module
 *   quantifies the CONSEQUENCES of the assumed return distribution.
 *
 * Resampling modes (all seeded and reproducible):
 *
 *   - 'iid':      draw trades independently. Understates risk when trades cluster (they do).
 *   - 'block':    moving-block bootstrap over the chronological trade sequence, preserving serial dependence
 *                 within contiguous blocks (default block size ceil(sqrt(n))).
 *   - 'regime':   regime-stratified block bootstrap — blocks are tagged with the regime they occurred in, a
 *                 regime is drawn according to its historical frequency, then a block from that regime. This
 *                 preserves both within-regime dependence and the historical regime mix, while acknowledging
 *                 that the exact future ORDER of regimes is unknowable.
 *
 * The equity model: each trade risks `riskPerTradePct` of CURRENT equity and realizes its net R, so the equity
 * multiplier per trade is (1 + f * R) — the standard fixed-fractional compounding model. Costs are already
 * inside net R (the ledger books fees, slippage and funding). Leverage enters through a simplified margin
 * model, documented on `MonteCarloConfig.leverage`: a single trade whose loss exceeds the margin fraction
 * (1 / L) of equity is treated as liquidated — the position is closed at margin wipe, the loss is capped at
 * the margin, and the event is counted.
 */

import { mulberry32, quantileSorted } from './Bootstrap.js';

export interface MonteCarloTrade {
  /** Net R of the trade: realized profit as a multiple of the amount risked, after all costs. */
  netR: number;
  /** Chronological order is used by block resampling. */
  t: number;
  /** Regime label for 'regime' resampling; null trades fall into the 'UNKNOWN' stratum. */
  regime?: string | null;
}

export type ResampleMode = 'iid' | 'block' | 'regime';

export interface MonteCarloConfig {
  /** Number of simulated paths. Default 5000. */
  simulations: number;
  /** Trades per simulated path. Default: the observed trade count. */
  horizonTrades?: number;
  /** Fraction of current equity risked per trade, e.g. 0.01 = 1%. Default 0.01. */
  riskPerTradePct?: number;
  /** Starting account equity. Default 10_000. */
  initialEquity?: number;
  /** Resampling mode. Default 'block'. */
  resample?: ResampleMode;
  /** Moving-block size for 'block'/'regime' modes. Default ceil(sqrt(n)). */
  blockSize?: number;
  /** PRNG seed — every report is reproducible from it. Default 1. */
  seed?: number;
  /** Kill-switch drawdown limit in % of peak equity. Breaches are counted. Default 20. */
  maxDrawdownPct?: number;
  /**
   * Ruin threshold: a path is ruined when equity falls to (100 - ruinLossPct)% of initial equity or below.
   * Default 50 (half the account) — full wipeouts are usually unreachable in fixed-fractional sizing before
   * the kill switch fires, so "economic ruin" is the operative limit.
   */
  ruinLossPct?: number;
  /**
   * Assumed account leverage for the simplified liquidation model. Default 1 (no leverage, no liquidations).
   * With leverage L, a single trade losing more than 1/L of equity trips liquidation: the loss is capped at
   * the margin (1/L of equity) and counted. This is a first-order single-trade margin model, not an exchange
   * maintenance-margin simulation.
   */
  leverage?: number;
}

export interface Percentiles {
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  mean: number;
}

export interface MonteCarloReport {
  /** Inputs the report was produced from — echo for reproducibility. */
  config: Required<Omit<MonteCarloConfig, 'blockSize'>> & { blockSize: number };
  nTrades: number;
  horizonTrades: number;
  /** Final equity distribution across simulated paths. */
  finalEquity: Percentiles;
  /** Final return in % of initial equity. */
  finalReturnPct: Percentiles;
  /** P(final equity < initial equity) with its binomial standard error. */
  probFinalBelowInitial: number;
  seFinalBelowInitial: number;
  /** Max-drawdown (%, peak-to-trough) distribution. */
  maxDrawdownPct: Percentiles & { p99: number };
  /** P(max drawdown breaches the configured kill-switch limit). */
  probDrawdownBreach: number;
  seDrawdownBreach: number;
  /** P(equity falls to the ruin threshold at any point). */
  probRuin: number;
  seRuin: number;
  /** P(path contains at least one liquidation event under the leverage model). */
  probLiquidation: number;
  seLiquidation: number;
  /** Total liquidation events across all paths (context for probLiquidation). */
  liquidationEvents: number;
  /**
   * Longest underwater stretch per path: trades from an equity peak until equity first regains that peak
   * (or the horizon ends). Null when no path ever drew down.
   */
  recoveryTrades: { median: number; p95: number } | null;
  /** Non-finite or degenerate inputs encountered, e.g. trades with NaN netR (skipped). */
  warnings: string[];
}

const binomialSe = (p: number, n: number): number => Math.sqrt(Math.max(0, p * (1 - p)) / n);

function percentilesOf(sortedValues: readonly number[]): Percentiles {
  return {
    p05: quantileSorted(sortedValues, 0.05),
    p25: quantileSorted(sortedValues, 0.25),
    median: quantileSorted(sortedValues, 0.5),
    p75: quantileSorted(sortedValues, 0.75),
    p95: quantileSorted(sortedValues, 0.95),
    mean: sortedValues.reduce((a, b) => a + b, 0) / sortedValues.length,
  };
}

interface Block {
  netRs: number[];
  regime: string;
}

/** Contiguous chronological blocks of the trade sequence, each tagged with its modal regime. */
function buildBlocks(trades: readonly MonteCarloTrade[], blockSize: number): Block[] {
  const ordered = [...trades].sort((a, b) => a.t - b.t);
  const blocks: Block[] = [];
  for (let start = 0; start < ordered.length; start += blockSize) {
    const slice = ordered.slice(start, start + blockSize);
    const regimeCounts = new Map<string, number>();
    for (const t of slice) {
      const label = t.regime ?? 'UNKNOWN';
      regimeCounts.set(label, (regimeCounts.get(label) ?? 0) + 1);
    }
    const regime = [...regimeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    blocks.push({ netRs: slice.map((t) => t.netR), regime });
  }
  return blocks;
}

/** Draw one trade index (iid mode). */
function drawIid(n: number, rand: () => number): number {
  return Math.floor(rand() * n);
}

/**
 * Runs the Monte Carlo risk simulation over a trade series.
 *
 * @param trades Observed net-R outcomes (chronological order used by block modes).
 * @param config Simulation parameters; see `MonteCarloConfig` for defaults and semantics.
 */
export function runMonteCarlo(
  trades: readonly MonteCarloTrade[],
  config: MonteCarloConfig,
): MonteCarloReport {
  const warnings: string[] = [];
  const clean = trades.filter((t) => Number.isFinite(t.netR));
  if (trades.length !== clean.length) {
    warnings.push(`${trades.length - clean.length} trades with non-finite netR were skipped`);
  }
  if (clean.length === 0) throw new Error('Monte Carlo needs at least one trade with finite netR');

  const simulations = Math.max(1, Math.floor(config.simulations));
  const horizon = Math.max(1, Math.floor(config.horizonTrades ?? clean.length));
  const riskFraction = config.riskPerTradePct ?? 0.01;
  if (!(riskFraction > 0 && riskFraction <= 1)) throw new Error('riskPerTradePct must be in (0, 1]');
  const initialEquity = config.initialEquity ?? 10_000;
  const mode: ResampleMode = config.resample ?? 'block';
  const blockSize = Math.max(1, Math.floor(config.blockSize ?? Math.ceil(Math.sqrt(clean.length))));
  const seed = config.seed ?? 1;
  const maxDdPct = config.maxDrawdownPct ?? 20;
  const ruinLossPct = config.ruinLossPct ?? 50;
  const leverage = Math.max(1, config.leverage ?? 1);
  const marginFraction = 1 / leverage;

  const rand = mulberry32(seed);
  const ordered = [...clean].sort((a, b) => a.t - b.t);
  const netRs = ordered.map((t) => t.netR);

  // Pre-compute resampling structures per mode.
  const blocks = mode === 'regime' || mode === 'block' ? buildBlocks(ordered, blockSize) : [];
  const regimeNames = [...new Set(blocks.map((b) => b.regime))];
  const regimeBlocks = new Map<string, Block[]>(
    regimeNames.map((name) => [name, blocks.filter((b) => b.regime === name)]),
  );

  /** Draws `horizon` net-R values into `out` according to the configured mode. */
  const drawPath = (out: number[]): void => {
    if (mode === 'iid') {
      for (let i = 0; i < horizon; i += 1) out.push(netRs[drawIid(netRs.length, rand)]);
      return;
    }
    if (mode === 'block') {
      let drawn = 0;
      while (drawn < horizon) {
        const block = blocks[Math.floor(rand() * blocks.length)];
        for (let k = 0; k < block.netRs.length && drawn < horizon; k += 1) {
          out.push(block.netRs[k]);
          drawn += 1;
        }
      }
      return;
    }
    // regime mode: pick a regime by historical block share, then a block within it.
    const totalBlocks = blocks.length;
    let drawn = 0;
    while (drawn < horizon) {
      const pick = Math.floor(rand() * totalBlocks);
      let cum = 0;
      let chosen = regimeNames[0];
      for (const name of regimeNames) {
        cum += regimeBlocks.get(name)!.length;
        if (pick < cum) {
          chosen = name;
          break;
        }
      }
      const pool = regimeBlocks.get(chosen)!;
      const block = pool[Math.floor(rand() * pool.length)];
      for (let k = 0; k < block.netRs.length && drawn < horizon; k += 1) {
        out.push(block.netRs[k]);
        drawn += 1;
      }
    }
  };

  const finalEquities: number[] = [];
  const finalReturns: number[] = [];
  const maxDrawdowns: number[] = [];
  const underwaterStretches: number[] = [];
  let ddBreaches = 0;
  let ruinCount = 0;
  let liquidationPaths = 0;
  let liquidationEvents = 0;

  const ruinFloor = initialEquity * (1 - ruinLossPct / 100);
  const pathBuffer: number[] = [];

  for (let sim = 0; sim < simulations; sim += 1) {
    pathBuffer.length = 0;
    drawPath(pathBuffer);

    let equity = initialEquity;
    let peak = initialEquity;
    let maxDd = 0;
    let ruined = false;
    let breached = false;
    let pathLiquidations = 0;
    let underwaterStart = -1; // index where equity last left its peak
    let longestUnderwater = 0;

    for (let i = 0; i < pathBuffer.length; i += 1) {
      const r = pathBuffer[i];
      let lossFraction = riskFraction * r; // negative when losing

      if (lossFraction < -marginFraction) {
        // Single-trade loss exceeds the margin at the assumed leverage: liquidation caps the loss.
        lossFraction = -marginFraction;
        pathLiquidations += 1;
      }

      equity *= 1 + lossFraction;

      if (equity >= peak) {
        if (underwaterStart >= 0) {
          longestUnderwater = Math.max(longestUnderwater, i - underwaterStart);
          underwaterStart = -1;
        }
        peak = equity;
      } else if (underwaterStart < 0) {
        underwaterStart = i;
      }

      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDd) maxDd = dd;
      if (dd >= maxDdPct / 100) breached = true;
      if (equity <= ruinFloor) {
        ruined = true;
        break; // the account is done; the rest of the path is irrelevant
      }
    }

    if (underwaterStart >= 0) {
      longestUnderwater = Math.max(longestUnderwater, pathBuffer.length - underwaterStart);
    }

    finalEquities.push(equity);
    finalReturns.push((equity / initialEquity - 1) * 100);
    maxDrawdowns.push(maxDd * 100);
    underwaterStretches.push(longestUnderwater);
    if (breached) ddBreaches += 1;
    if (ruined) ruinCount += 1;
    if (pathLiquidations > 0) liquidationPaths += 1;
    liquidationEvents += pathLiquidations;
  }

  const sortedEquity = [...finalEquities].sort((a, b) => a - b);
  const sortedReturns = [...finalReturns].sort((a, b) => a - b);
  const sortedDd = [...maxDrawdowns].sort((a, b) => a - b);
  const sortedUnderwater = [...underwaterStretches].sort((a, b) => a - b);
  const probFinalBelow = finalEquities.filter((e) => e < initialEquity).length / simulations;
  const probDdBreach = ddBreaches / simulations;
  const probRuin = ruinCount / simulations;
  const probLiq = liquidationPaths / simulations;

  return {
    config: {
      simulations,
      horizonTrades: horizon,
      riskPerTradePct: riskFraction,
      initialEquity,
      resample: mode,
      blockSize,
      seed,
      maxDrawdownPct: maxDdPct,
      ruinLossPct,
      leverage,
    },
    nTrades: clean.length,
    horizonTrades: horizon,
    finalEquity: percentilesOf(sortedEquity),
    finalReturnPct: percentilesOf(sortedReturns),
    probFinalBelowInitial: probFinalBelow,
    seFinalBelowInitial: binomialSe(probFinalBelow, simulations),
    maxDrawdownPct: {
      ...percentilesOf(sortedDd),
      p99: quantileSorted(sortedDd, 0.99),
    },
    probDrawdownBreach: probDdBreach,
    seDrawdownBreach: binomialSe(probDdBreach, simulations),
    probRuin,
    seRuin: binomialSe(probRuin, simulations),
    probLiquidation: probLiq,
    seLiquidation: binomialSe(probLiq, simulations),
    liquidationEvents,
    recoveryTrades:
      sortedUnderwater.some((u) => u > 0)
        ? { median: quantileSorted(sortedUnderwater, 0.5), p95: quantileSorted(sortedUnderwater, 0.95) }
        : null,
    warnings,
  };
}
