/**
 * Quant routes — exposes pure QuantLab analytics for the Market Terminal workbench.
 */

import type { Express } from 'express';
import type { DashboardContext } from '../context.js';
import {
  calculateSimpleReturns,
  calculateLogReturns,
  calculateMean,
  calculateSampleVariance,
  calculateAnnualizedSharpe,
  calculateAnnualizedSortino,
  calculateCumulativeReturns,
} from '../../../../src/quant/returns.js';
import {
  calculateCloseVol,
  calculateParkinsonVol,
  calculateGarmanKlassVol,
  calculateYangZhangVol,
  calculateRollingVol,
  type OHLCBar,
} from '../../../../src/quant/volatility.js';
import { calculateCorrelationMatrix } from '../../../../src/quant/correlation.js';
import { simulateGeometricBrownianMotion } from '../../../../src/quant/monteCarlo.js';

interface SymbolAnalytics {
  readonly symbol: string;
  readonly lastPrice: number;
  readonly returns: {
    readonly meanReturn: number;
    readonly volatilityClose: number;
    readonly volatilityParkinson: number;
    readonly volatilityGarmanKlass: number;
    readonly volatilityYangZhang: number;
    readonly sharpe: number;
    readonly sortino: number;
    readonly cumulativeReturn: number;
  };
  readonly rollingVol: readonly number[];
}

function computeSymbolMetrics(symbol: string, bars: readonly OHLCBar[]): SymbolAnalytics | null {
  if (bars.length < 2) return null;
  const closes = bars.map((b) => b.close);
  const simpleReturns = calculateSimpleReturns(closes);
  const cumReturns = calculateCumulativeReturns(simpleReturns);
  const mean = calculateMean(simpleReturns);
  const lastPrice = closes[closes.length - 1];
  return {
    symbol,
    lastPrice,
    returns: {
      meanReturn: mean,
      volatilityClose: calculateCloseVol(closes),
      volatilityParkinson: calculateParkinsonVol(bars),
      volatilityGarmanKlass: calculateGarmanKlassVol(bars),
      volatilityYangZhang: calculateYangZhangVol(bars),
      sharpe: calculateAnnualizedSharpe(simpleReturns),
      sortino: calculateAnnualizedSortino(simpleReturns),
      cumulativeReturn: cumReturns[cumReturns.length - 1] ?? 0,
    },
    rollingVol: calculateRollingVol(bars, 20, 'parkinson'),
  };
}

function runPrimarySimulation(lastPrice: number, volAnnual: number, simulations: number) {
  return simulateGeometricBrownianMotion({
    initialPrice: lastPrice > 0 ? lastPrice : 100,
    driftAnnual: 0.05,
    volatilityAnnual: volAnnual > 0 ? volAnnual : 0.50,
    timeHorizonYears: 30 / 365,
    steps: 30,
    simulations: Math.min(simulations, 500),
    useAntithetic: true,
    seed: 42,
  });
}

export function registerQuantRoutes(app: Express, ctx: DashboardContext): void {
  app.get('/api/quant/terminal', async (req, res, next) => {
    try {
      const symbolsParam = (req.query.symbols as string) || ctx.symbols.join(',');
      const symbols = symbolsParam.split(',').map((s) => s.trim()).filter(Boolean);
      const simulations = Number(req.query.simulations ?? 100);
      const overview = await ctx.binance.getMarketOverview(symbols);

      const analytics: Record<string, SymbolAnalytics> = {};
      const returnSeriesMap: Record<string, number[]> = {};

      for (const sym of symbols) {
        const rawBars = overview.candles[sym] ?? [];
        const metrics = computeSymbolMetrics(sym, rawBars);
        if (metrics) {
          analytics[sym] = metrics;
          returnSeriesMap[sym] = calculateSimpleReturns(rawBars.map((b) => b.close));
        }
      }

      const correlation = calculateCorrelationMatrix(returnSeriesMap, 'pearson');
      const primarySymbol = symbols[0] ?? 'BTCUSDT';
      const primaryMetrics = analytics[primarySymbol];
      const primaryVol = primaryMetrics?.returns.volatilityParkinson ?? 0.50;
      const primaryPrice = primaryMetrics?.lastPrice ?? 100;
      const simulation = runPrimarySimulation(primaryPrice, primaryVol, simulations);

      res.json({
        symbols,
        primarySymbol,
        analytics,
        correlation,
        simulation,
        timestamp: Date.now(),
      });
    } catch (err) {
      next(err);
    }
  });
}
