/**
 * Pure, deterministic Geometric Brownian Motion (GBM) Monte Carlo simulator.
 */

import { calculateMean, calculateSampleVariance } from './returns.js';

export interface MonteCarloGbmConfig {
  readonly initialPrice: number;
  readonly driftAnnual: number;
  readonly volatilityAnnual: number;
  readonly timeHorizonYears: number;
  readonly steps: number;
  readonly simulations: number;
  readonly useAntithetic?: boolean;
  readonly seed?: number;
}

export interface MonteCarloGbmResult {
  readonly paths: readonly (readonly number[])[];
  readonly timeGrid: readonly number[];
  readonly quantiles: {
    readonly p05: readonly number[];
    readonly p25: readonly number[];
    readonly p50: readonly number[];
    readonly p75: readonly number[];
    readonly p95: readonly number[];
  };
  readonly terminalStats: {
    readonly mean: number;
    readonly stdDev: number;
    readonly probLoss: number;
  };
}

function createPrng(seed: number): () => number {
  let s = Math.trunc(seed) >>> 0;
  return () => {
    // Mulberry32 32-bit PRNG for deterministic cross-platform execution
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleStandardNormals(count: number, prng: () => number): number[] {
  const normals: number[] = new Array(count);
  for (let i = 0; i < count; i += 2) {
    let u1 = prng();
    while (u1 <= 1e-15) u1 = prng();
    const u2 = prng();
    // Box-Muller polar transformation
    const r = Math.sqrt(-2.0 * Math.log(u1));
    const theta = 2.0 * Math.PI * u2;
    normals[i] = r * Math.cos(theta);
    if (i + 1 < count) normals[i + 1] = r * Math.sin(theta);
  }
  return normals;
}

function simulatePath(
  s0: number,
  steps: number,
  driftStep: number,
  volStep: number,
  shocks: readonly number[]
): number[] {
  const path: number[] = new Array(steps + 1);
  path[0] = s0;
  for (let t = 1; t <= steps; t++) {
    // Discrete log-Euler step: S_{t} = S_{t-1} * exp((mu - 0.5*sigma^2)*dt + sigma*sqrt(dt)*Z)
    path[t] = path[t - 1] * Math.exp(driftStep + volStep * shocks[t - 1]);
  }
  return path;
}

function extractStepQuantiles(paths: readonly (readonly number[])[], steps: number) {
  const p05: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p95: number[] = [];
  for (let step = 0; step <= steps; step++) {
    const values = paths.map((p) => p[step]).sort((a, b) => a - b);
    p05.push(values[Math.floor(values.length * 0.05)]);
    p25.push(values[Math.floor(values.length * 0.25)]);
    p50.push(values[Math.floor(values.length * 0.50)]);
    p75.push(values[Math.floor(values.length * 0.75)]);
    p95.push(values[Math.floor(values.length * 0.95)]);
  }
  return { p05, p25, p50, p75, p95 };
}

export function simulateGeometricBrownianMotion(config: MonteCarloGbmConfig): MonteCarloGbmResult {
  const { initialPrice, driftAnnual, volatilityAnnual, timeHorizonYears, steps, simulations } = config;
  const prng = createPrng(config.seed ?? 1);
  const dt = timeHorizonYears / steps;
  const driftStep = (driftAnnual - 0.5 * (volatilityAnnual ** 2)) * dt;
  const volStep = volatilityAnnual * Math.sqrt(dt);
  const paths: number[][] = [];
  const totalRuns = config.useAntithetic ? Math.ceil(simulations / 2) : simulations;

  for (let run = 0; run < totalRuns; run++) {
    const shocks = sampleStandardNormals(steps, prng);
    paths.push(simulatePath(initialPrice, steps, driftStep, volStep, shocks));
    if (config.useAntithetic && paths.length < simulations) {
      // Twin path with negated Brownian increments for antithetic variance reduction
      const antiShocks = shocks.map((z) => -z);
      paths.push(simulatePath(initialPrice, steps, driftStep, volStep, antiShocks));
    }
  }

  const terminalPrices = paths.map((p) => p[steps]);
  const mean = calculateMean(terminalPrices);
  const stdDev = Math.sqrt(calculateSampleVariance(terminalPrices, mean));
  const probLoss = terminalPrices.filter((p) => p < initialPrice).length / terminalPrices.length;
  const timeGrid = Array.from({ length: steps + 1 }, (_, i) => i * dt);
  const quantiles = extractStepQuantiles(paths, steps);

  return { paths, timeGrid, quantiles, terminalStats: { mean, stdDev, probLoss } };
}
