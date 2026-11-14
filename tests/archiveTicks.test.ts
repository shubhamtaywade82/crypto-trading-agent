import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LARGE_TRADE_QUOTE, reduceAggTrades, reduceBookDepth } from '../src/backtesting/archiveTicks.js';

const DAY = Date.UTC(2025, 5, 2);

test('should split aggressor buys and sells per minute and flag large trades', () => {
  const csv = [
    'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker',
    `1,100,10,1,1,${DAY + 5_000},false`, // aggressor buy, 1,000 quote
    `2,100,${LARGE_TRADE_QUOTE / 100},2,2,${DAY + 30_000},true`, // aggressor sell, large
    `3,200,1,3,3,${DAY + 61_000},false`, // next minute
    `4,200,1,4,4,${DAY - 1},false`, // previous day: ignored
    '',
  ].join('\n');
  const minutes = reduceAggTrades(csv, DAY);
  assert.deepEqual(minutes[0], [1000, LARGE_TRADE_QUOTE, 2, 0, LARGE_TRADE_QUOTE]);
  assert.deepEqual(minutes[1], [200, 0, 1, 0, 0]);
  assert.equal(minutes.length, 1440);
});

test('should keep the last depth snapshot of each minute on both sides', () => {
  const csv = [
    'timestamp,percentage,depth,notional',
    '2025-06-02 00:00:10,-1,1,100', '2025-06-02 00:00:10,1,1,110', '2025-06-02 00:00:10,-5,1,500', '2025-06-02 00:00:10,5,1,510',
    '2025-06-02 00:00:40,-1,1,120', '2025-06-02 00:00:40,1,1,130', '2025-06-02 00:00:40,-5,1,520', '2025-06-02 00:00:40,5,1,530',
    '2025-06-02 00:00:40,-3,1,999',
  ].join('\n');
  const minutes = reduceBookDepth(csv, DAY);
  assert.deepEqual(minutes[0], [120, 130, 520, 530]);
  assert.deepEqual(minutes[1], [null, null, null, null]);
});
