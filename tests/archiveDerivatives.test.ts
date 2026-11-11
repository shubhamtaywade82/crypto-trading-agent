import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFundingCsv, parseMetricsCsv } from '../src/backtesting/archiveDerivatives.js';

test('funding rows parse with the header skipped and blank rates dropped', () => {
  const csv = 'calc_time,funding_interval_hours,last_funding_rate\n1672531200000,8,-0.00092452\n1672560000008,8,\n1672588800000,8,0.0001\n';
  assert.deepEqual(parseFundingCsv(csv), [{ time: 1672531200000, rate: -0.00092452 }, { time: 1672588800000, rate: 0.0001 }]);
});

test('metrics rows map Binance columns to named fields, as UTC, skipping rows with blank fields', () => {
  const csv = [
    'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio',
    '2024-01-15 00:00:00,SOLUSDT,4630135.0,434584640.09,3.24,1.81,3.34,0.85',
    '2024-01-15 00:05:00,SOLUSDT,4643636.0,440295634.61,,1.81,3.31,1.36',
  ].join('\n');
  assert.deepEqual(parseMetricsCsv(csv), [{
    time: Date.UTC(2024, 0, 15), openInterest: 4630135, openInterestValue: 434584640.09,
    topTraderAccountRatio: 3.24, topTraderPositionRatio: 1.81, globalAccountRatio: 3.34, takerBuySellRatio: 0.85,
  }]);
});
