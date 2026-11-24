/**
 * Pure, deterministic functions for asset returns and risk-adjusted ratios.
 */

export function calculateSimpleReturns(prices: readonly number[]): number[] {
  if (prices.length < 2) return [];
  const returns: number[] = new Array(prices.length - 1);
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    // Safeguard against division by zero or negative baseline
    returns[i - 1] = prev > 0 ? (prices[i] - prev) / prev : 0;
  }
  return returns;
}

export function calculateLogReturns(prices: readonly number[]): number[] {
  if (prices.length < 2) return [];
  const returns: number[] = new Array(prices.length - 1);
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    // Safeguard against negative or zero prices where log is undefined
    returns[i - 1] = prev > 0 && curr > 0 ? Math.log(curr / prev) : 0;
  }
  return returns;
}

export function calculateCumulativeReturns(returns: readonly number[]): number[] {
  if (returns.length === 0) return [];
  const cumulative: number[] = new Array(returns.length);
  let compFactor = 1;
  for (let i = 0; i < returns.length; i++) {
    compFactor *= 1 + returns[i];
    cumulative[i] = compFactor - 1;
  }
  return cumulative;
}

export function calculateMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

export function calculateSampleVariance(values: readonly number[], mean?: number): number {
  if (values.length < 2) return 0;
  const avg = mean ?? calculateMean(values);
  const sumSq = values.reduce((acc, v) => acc + (v - avg) ** 2, 0);
  return sumSq / (values.length - 1);
}

export function calculateAnnualizedSharpe(
  returns: readonly number[],
  riskFreeRatePeriod = 0,
  periodsPerYear = 365
): number {
  if (returns.length < 2) return 0;
  const meanReturn = calculateMean(returns);
  const variance = calculateSampleVariance(returns, meanReturn);
  if (variance <= 0) return 0;
  const excessReturn = meanReturn - riskFreeRatePeriod;
  const stdDev = Math.sqrt(variance);
  return (excessReturn / stdDev) * Math.sqrt(periodsPerYear);
}

export function calculateAnnualizedSortino(
  returns: readonly number[],
  targetReturnPeriod = 0,
  periodsPerYear = 365
): number {
  if (returns.length < 2) return 0;
  const meanReturn = calculateMean(returns);
  const excessReturn = meanReturn - targetReturnPeriod;
  // Downside deviation measures dispersion only for returns below target
  const downsideSq = returns.reduce((acc, r) => {
    const diff = r - targetReturnPeriod;
    return diff < 0 ? acc + diff ** 2 : acc;
  }, 0);
  const downsideVariance = downsideSq / returns.length;
  if (downsideVariance <= 0) return excessReturn > 0 ? 100 : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  return (excessReturn / downsideDev) * Math.sqrt(periodsPerYear);
}
