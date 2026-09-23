import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { OllamaAdvisor, parseVerdict } from '../src/ollama/advisor.js';

test('should return VETO with the model reason', () => {
  assert.deepEqual(parseVerdict('{"verdict":"VETO","reason":"extended entry"}'), { verdict: 'VETO', reason: 'extended entry' });
});

test('should proceed on an explicit PROCEED', () => {
  assert.equal(parseVerdict('{"verdict":"PROCEED","reason":"clean"}').verdict, 'PROCEED');
});

test('should VETO when the reply is not JSON or has an unknown verdict (fail-closed, issue #6)', () => {
  assert.equal(parseVerdict('sure, go ahead').verdict, 'VETO');
  assert.ok(parseVerdict('sure, go ahead').reason.startsWith('advisor'));
  assert.equal(parseVerdict('{"verdict":"MAYBE"}').verdict, 'VETO');
});

const snapshot = { symbol: 'BTCUSDT', side: 'LONG' as const, regime: 'HIGH' as const, distanceFromLineAtr: 1, rsi: 55, fundingRate: 0.0001, entry: 100, stopLoss: 95, takeProfit: 112 };

test('should flag an unknown verdict as a fail-closed VETO (issue #6)', () => {
  const result = parseVerdict('{"verdict":"MAYBE"}');
  assert.equal(result.verdict, 'VETO');
  assert.match(result.reason, /^advisor sent an unknown verdict/);
});

test('should re-ping an offline advisor after the interval and then use the model', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  let online = false;
  const client = {
    list: async () => { if (!online) throw new Error('down'); return {} as never; },
    generate: async () => ({ response: '{"verdict":"VETO","reason":"extended"}' }) as never,
  };
  const advisor = new OllamaAdvisor(client);
  await new Promise((resolve) => setImmediate(resolve)); // constructor ping settles offline
  assert.equal((await advisor.veto(snapshot)).reason, 'advisor offline');
  online = true;
  mock.timers.setTime(61_000);
  assert.equal((await advisor.veto(snapshot)).verdict, 'VETO');
  mock.timers.reset();
});

test('should failover to second client if first client generate throws', async () => {
  let firstCalled = false;
  let secondCalled = false;
  const failingClient = {
    list: async () => ({}) as never,
    generate: async () => { firstCalled = true; throw new Error('429 rate limited'); },
  };
  const workingClient = {
    list: async () => ({}) as never,
    generate: async () => { secondCalled = true; return { response: '{"verdict":"PROCEED","reason":"all good"}' } as never; },
  };

  // Instantiate advisor and inject mock clients into pool
  const advisor = new OllamaAdvisor(failingClient);
  await new Promise((resolve) => setImmediate(resolve));
  (advisor as any).clients = [failingClient, workingClient];
  const verdict = await advisor.veto(snapshot);

  assert.equal(firstCalled, true);
  assert.equal(secondCalled, true);
  assert.equal(verdict.verdict, 'PROCEED');
  assert.equal(verdict.reason, 'all good');
});

