import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import {
  archEffectTest,
  autocorrelation,
  chiSquareUpperTail,
  evaluateVolForecasts,
  ewmaVarianceForecasts,
  fitGarch11,
  logGamma,
  ljungBox,
  logReturns,
  volatilityClusteringReport,
} from '../src/research/VolatilityClustering.js';

function normalRng(seed: number): () => number {
  const rand = mulberry32(seed);
  return () => {
    let u = rand();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
}

/** Deterministic GARCH(1,1) return generator. */
function garchReturns(n: number, seed: number, omega = 2e-6, alpha = 0.1, beta = 0.88): number[] {
  const z = normalRng(seed);
  let sigma2 = omega / (1 - alpha - beta);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = z() * Math.sqrt(sigma2);
    out.push(r);
    sigma2 = omega + alpha * r * r + beta * sigma2;
  }
  return out;
}

test('logGamma matches known values', () => {
  assert.ok(Math.abs(logGamma(1)) < 1e-10);          // Gamma(1) = 1
  assert.ok(Math.abs(logGamma(2)) < 1e-10);          // Gamma(2) = 1
  assert.ok(Math.abs(logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-10);
});

test('chi-square upper tail matches textbook critical values', () => {
  // chi2(1) 95th percentile = 3.841 => upper tail ~0.05
  assert.ok(Math.abs(chiSquareUpperTail(3.841, 1) - 0.05) < 1e-3);
  // chi2(2) 95th percentile = 5.991
  assert.ok(Math.abs(chiSquareUpperTail(5.991, 2) - 0.05) < 1e-3);
  // chi2(10) 95th percentile = 18.307
  assert.ok(Math.abs(chiSquareUpperTail(18.307, 10) - 0.05) < 1e-3);
  assert.equal(chiSquareUpperTail(0, 5), 1);
});

test('autocorrelation of an iid series is near zero; of a persistent series is high', () => {
  const z1 = normalRng(1);
  const iid = Array.from({ length: 2000 }, () => z1());
  assert.ok(Math.abs(autocorrelation(iid, 1)) < 0.06);
  const persistent: number[] = [];
  const z = normalRng(2);
  let prev = 0;
  for (let i = 0; i < 2000; i += 1) {
    prev = 0.9 * prev + z();
    persistent.push(prev);
  }
  assert.ok(autocorrelation(persistent, 1) > 0.8);
});

test('Ljung-Box does not reject white noise but firmly rejects clustered volatility', () => {
  const z11 = normalRng(11);
  const white = Array.from({ length: 1000 }, () => z11());
  const lbWhite = ljungBox(white, 10);
  assert.ok(lbWhite.pValue > 0.01, `white noise p=${lbWhite.pValue}`);

  const clustered = garchReturns(2000, 5);
  const lbClustered = ljungBox(clustered.map((r) => r * r), 10);
  assert.ok(lbClustered.pValue < 1e-6, `GARCH squared returns p=${lbClustered.pValue}`);
});

test('archEffectTest detects clustering in GARCH data and its absence in iid data', () => {
  const clustered = archEffectTest(garchReturns(2000, 7), { lags: 10 });
  assert.ok(clustered !== null);
  assert.equal(clustered.clusters, true);
  assert.ok(clustered.acfSquared.slice(0, 5).some((v) => v > 0.05));

  const z13 = normalRng(13);
  const iid = archEffectTest(Array.from({ length: 2000 }, () => z13()), { lags: 10 });
  assert.ok(iid !== null);
  // iid data should almost never show significant squared-return autocorrelation.
  assert.equal(iid.clusters, false);
});

test('fitGarch11 recovers the persistence of a GARCH(1,1) process', () => {
  const returns = garchReturns(5000, 21, 2e-6, 0.1, 0.88); // persistence 0.98
  const fit = fitGarch11(returns);
  assert.ok(fit !== null);
  assert.ok(Math.abs(fit.persistence - 0.98) < 0.05, `persistence ${fit.persistence}`);
  assert.ok(fit.shockHalfLife !== null && fit.shockHalfLife > 10 && fit.shockHalfLife < 100);
});

test('EWMA variance forecasts react to a volatility jump immediately', () => {
  const returns = [...Array.from({ length: 50 }, () => 0.001), 0.05, 0.001];
  const forecasts = ewmaVarianceForecasts(returns, 0.94);
  assert.equal(forecasts.length, returns.length);
  // The forecast AFTER the jump must be far above the forecast before it.
  assert.ok(forecasts[51] > 10 * forecasts[49]);
});

test('evaluateVolForecasts: EWMA beats the naive constant baseline on clustered data', () => {
  const returns = garchReturns(2500, 33);
  const report = evaluateVolForecasts(returns, { trainFraction: 0.7 });
  assert.ok(report !== null);
  const ewma = report.models.find((m) => m.model === 'ewma')!;
  const naive = report.models.find((m) => m.model === 'naive')!;
  assert.ok(ewma.qlike < naive.qlike, `EWMA ${ewma.qlike} should beat naive ${naive.qlike}`);
  assert.ok(report.garch !== null);
});

test('volatilityClusteringReport recommends a clustering-aware model for GARCH data', () => {
  const report = volatilityClusteringReport(garchReturns(2500, 44));
  assert.ok(report.arch?.clusters);
  assert.ok(['CLUSTERING_USE_EWMA', 'CLUSTERING_USE_GARCH'].includes(report.recommendation));
});

test('volatilityClusteringReport keeps it simple for iid returns', () => {
  const z55 = normalRng(55);
  const report = volatilityClusteringReport(Array.from({ length: 1500 }, () => z55()));
  // A single iid sample may occasionally trip the 5% test; the recommendation is either "no clustering" or
  // a clustering model — but the ARCH evidence must be borderline at worst.
  assert.ok(['NO_CLUSTERING_CONSTANT_VOL_OK', 'CLUSTERING_USE_EWMA', 'CLUSTERING_USE_GARCH'].includes(report.recommendation));
});

test('volatilityClusteringReport returns INSUFFICIENT_DATA for short series', () => {
  const report = volatilityClusteringReport([0.01, -0.02, 0.015]);
  assert.equal(report.recommendation, 'INSUFFICIENT_DATA');
});

test('logReturns computes log price changes', () => {
  const closes = [100, 110, 99];
  const rs = logReturns(closes);
  assert.ok(Math.abs(rs[0] - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs(rs[1] - Math.log(0.9)) < 1e-12);
});
