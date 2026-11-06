import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchBinanceMetrics } from '../src/research/pipeline/binanceDataTools.js';
import { executeResearchScript } from '../src/research/pipeline/scriptExecutorTool.js';

describe('binanceDataTools', () => {
  it('fetches market metrics for a valid symbol', async () => {
    const metrics = await fetchBinanceMetrics('SOLUSDT');
    assert.equal(metrics.symbol, 'SOLUSDT');
    assert.ok(typeof metrics.markPrice === 'number');
    assert.ok(typeof metrics.lastFundingRate === 'number');
    assert.ok(typeof metrics.openInterest === 'number');
    assert.ok(typeof metrics.takerBuySellRatio === 'number');
    assert.ok(metrics.fetchedAtIso);
  });
});

describe('scriptExecutorTool', () => {
  it('executes a TypeScript script and captures stdout', async () => {
    const code = `
      const x = 10;
      const y = 20;
      console.log('Result is ' + (x + y));
    `;
    const res = await executeResearchScript(code);
    assert.equal(res.success, true);
    assert.match(res.output, /Result is 30/);
    assert.ok(res.executionTimeMs > 0);
  });

  it('captures errors gracefully without throwing', async () => {
    const code = `
      throw new Error('intentional quant test failure');
    `;
    const res = await executeResearchScript(code);
    assert.equal(res.success, false);
    assert.match(res.output, /intentional quant test failure/);
  });
});
