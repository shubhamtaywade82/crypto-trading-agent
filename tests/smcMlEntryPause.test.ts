import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceClient } from '@nemesis-oss/binance-sdk';
import { DEFAULT_SMC_RUNTIME_OPTIONS, SmcMlRuntime } from '../src/strategies/smc-ml/SmcMlRuntime.js';
import type { SmcMlCycle } from '../src/strategies/smc-ml/SmcMlRuntime.js';
import type { SmcExecutionAdvisor } from '../src/strategies/smc-ml/SmcExecutionAdvisor.js';

/** A client that records every venue call; any call not listed in `answers` fails the test. */
function fakeClient(answers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: string[] = [];
  const handler = (path: string) => (...args: unknown[]) => {
    calls.push(path);
    const answer = answers[path];
    if (!answer) throw new Error(`unexpected venue call: ${path}`);
    return Promise.resolve(answer(...args));
  };
  const client = {
    futures: {
      ops: { sizePosition: handler('ops.sizePosition'), placeBracketOrder: handler('ops.placeBracketOrder'), closePosition: handler('ops.closePosition') },
      account: { positionRiskV3: handler('account.positionRiskV3') },
    },
  } as unknown as BinanceClient;
  return { client, calls };
}

function cycle(action: 'OPEN' | 'ADD' | 'EXIT', portfolioState: SmcMlCycle['portfolioState'] = 'NO_POSITION'): SmcMlCycle {
  return {
    analysis: { symbol: 'SOLUSDT', generatedAt: 0 },
    portfolioState,
    positionQty: 0,
    decision: { action, side: 'LONG', entrySource: 'MARKET', reason: 'test' },
    selectedCandidate: { entrySource: 'MARKET', entryPrice: 100, stopLoss: 95, tp2: 110, sourceBreak: { time: 0 } },
  } as unknown as SmcMlCycle;
}

const advisor = {} as SmcExecutionAdvisor;

test('SMC-ML entries are paused by default', () => {
  assert.equal(DEFAULT_SMC_RUNTIME_OPTIONS.entriesEnabled, false);
});

for (const action of ['OPEN', 'ADD'] as const) {
  test(`a paused ${action} is refused before any venue call`, async () => {
    const { client, calls } = fakeClient();
    const runtime = new SmcMlRuntime(client, advisor);

    const result = await runtime.execute(cycle(action, action === 'ADD' ? 'LONG' : 'NO_POSITION')) as { executed: boolean; reason: string };

    assert.equal(result.executed, false);
    assert.match(result.reason, /entries paused/);
    assert.deepEqual(calls, []);
  });
}

test('EXIT still closes an open position while entries are paused', async () => {
  const { client, calls } = fakeClient({
    'account.positionRiskV3': () => [{ positionAmt: 2, entryPrice: 100, positionSide: 'BOTH' }],
    'ops.closePosition': () => ({ closed: true }),
  });
  const runtime = new SmcMlRuntime(client, advisor);

  const result = await runtime.execute(cycle('EXIT', 'LONG')) as { executed: boolean; action: string };

  assert.equal(result.executed, true);
  assert.equal(result.action, 'EXIT');
  assert.deepEqual(calls, ['account.positionRiskV3', 'ops.closePosition']);
});
