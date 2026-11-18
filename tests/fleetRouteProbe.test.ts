import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventTypeOf, probeRoutes, verdicts, type ProbeResult } from '../src/fleet/routeProbe.js';

function result(over: Partial<ProbeResult>): ProbeResult {
  return { name: 'x', url: 'wss://x', connected: true, messages: 0, eventTypes: [], ...over };
}

test('the probe covers the legacy control first, on lowercase stream names', () => {
  const routes = probeRoutes('ETHUSDT');
  assert.equal(routes[0]!.name, 'legacy @trade (control)');
  assert.equal(routes[0]!.url, 'wss://fstream.binance.com/ws/ethusdt@trade');
  assert.equal(routes[2]!.url, 'wss://fstream.binance.com/market/stream?streams=ethusdt@aggTrade');
  assert.equal(routes[3]!.url, 'wss://fstream.binance.com/market/ws/ethusdt@aggTrade');
  assert.equal(routes[4]!.url, 'wss://fstream.binance.com/market/stream?streams=ethusdt@markPrice@1s');
});

test('an event type is read from raw and combined-stream frames', () => {
  assert.equal(eventTypeOf('{"e":"aggTrade","s":"ETHUSDT"}'), 'aggTrade');
  assert.equal(eventTypeOf('{"stream":"ethusdt@aggTrade","data":{"e":"aggTrade"}}'), 'aggTrade');
  assert.equal(eventTypeOf('{"result":null,"id":1}'), null);
  assert.equal(eventTypeOf('not json'), null);
});

test('a silent control withholds every route verdict', () => {
  const lines = verdicts([
    result({ name: 'legacy @trade (control)' }),
    result({ name: '/market/ws @aggTrade', messages: 50 }),
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /control route .* is silent/);
});

test('each route gets a verdict: streams, or silent with the reason it was silent', () => {
  const lines = verdicts([
    result({ name: 'legacy @trade (control)', messages: 300 }),
    result({ name: '/market/stream @aggTrade', messages: 0 }),
    result({ name: '/market/ws @aggTrade', messages: 0, connected: false, error: 'socket error' }),
    result({ name: '/market/stream @markPrice@1s', messages: 40 }),
  ]);
  assert.deepEqual(lines, [
    '/market/stream @aggTrade: silent (connected)',
    '/market/ws @aggTrade: silent (socket error)',
    '/market/stream @markPrice@1s: streams (40 msgs)',
  ]);
});
