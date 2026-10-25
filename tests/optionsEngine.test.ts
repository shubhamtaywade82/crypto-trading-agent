import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { VetoVerdict } from '../src/ollama/advisor.js';
import type { OptionsConfig } from '../src/options/config.js';
import { OptionChainService } from '../src/options/OptionChainService.js';
import { OptionsBuyingEngine, type LogLevel } from '../src/options/OptionsBuyingEngine.js';
import { OptionsJournal, OptionsStateStore } from '../src/options/stateStore.js';
import type { OptionVetoSnapshot } from '../src/options/types.js';
import {
  LocalOptionsPaperVenue, MonitorOnlyVenue, type OptionOrderRequest, type OptionOrderResult, type OptionsVenue,
} from '../src/options/venues.js';
import { EXPIRY, FakeContext, FakeOptionsMarket, T0, testConfig } from './support/optionsFixture.js';

const CALL = 'BTC-261030-80000-C';

interface Harness {
  engine: OptionsBuyingEngine;
  market: FakeOptionsMarket;
  ctx: FakeContext;
  venue: OptionsVenue;
  cfg: OptionsConfig;
  logs: Array<[LogLevel, string]>;
  vetoes: OptionVetoSnapshot[];
  clock: { now: number };
  journal(): Array<Record<string, any>>;
  events(): string[];
}

async function harness(opts: {
  env?: Record<string, string>;
  venue?: (cfg: OptionsConfig) => OptionsVenue;
  verdict?: VetoVerdict;
  halted?: boolean;
  cfg?: OptionsConfig;
  clock?: { now: number };
  market?: FakeOptionsMarket;
  start?: boolean;
} = {}): Promise<Harness> {
  const cfg = opts.cfg ?? testConfig(opts.env);
  const clock = opts.clock ?? { now: T0 };
  const market = opts.market ?? new FakeOptionsMarket(() => clock.now);
  const ctx = new FakeContext();
  const venue = opts.venue ? opts.venue(cfg) : new LocalOptionsPaperVenue(100_000, cfg.fees);
  const logs: Array<[LogLevel, string]> = [];
  const vetoes: OptionVetoSnapshot[] = [];
  let id = 0;
  const engine = new OptionsBuyingEngine({
    config: cfg,
    chain: new OptionChainService(market, { now: () => clock.now }),
    context: ctx,
    venue,
    vetoer: { vetoOption: async (s) => { vetoes.push(s); return opts.verdict ?? { verdict: 'PROCEED', reason: 'clean' }; } },
    killSwitch: { isHalted: () => opts.halted ?? false, state: () => ({ reason: 'operator halt' }) },
    store: new OptionsStateStore(cfg.statePath),
    journal: new OptionsJournal(cfg.journalPath),
    log: (level, message) => logs.push([level, message]),
    now: () => clock.now,
    newId: () => `id${++id}`,
  });
  if (opts.start !== false) await engine.start();
  const journal = () => {
    try {
      return readFileSync(cfg.journalPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { engine, market, ctx, venue, cfg, logs, vetoes, clock, journal, events: () => journal().map((e) => e.event) };
}

const stateOf = (h: Harness) => h.engine.status()[0];
const entryOf = (h: Harness) => h.journal().find((e) => e.event === 'ENTRY_FILLED')!;

test('buys a call on an aligned uptrend: sized, protected, journaled and paid for once', async () => {
  const h = await harness();
  const ask = h.market.markOf(CALL) + 15;
  await h.engine.cycle();

  const s = stateOf(h);
  assert.equal(s.state, 'POSITION_OPEN');
  assert.equal(s.position?.symbol, CALL);
  assert.equal(s.position?.qty, 1.01);
  assert.ok(Math.abs(s.position!.entry - ask) < 1e-9);
  assert.ok(Math.abs(s.position!.stop - ask * 0.7) < 1e-9);
  assert.ok(Math.abs(s.position!.target - ask * 1.6) < 1e-9);
  assert.deepEqual(h.events(), ['SIGNAL', 'LLM_VERDICT', 'ENTRY_SUBMITTED', 'ENTRY_FILLED']);
  assert.equal(h.vetoes.length, 1);
  assert.equal(h.vetoes[0].right, 'CE');
  assert.equal(h.vetoes[0].quantity, 1.01);
  assert.deepEqual(await h.venue.positions(), [{ symbol: CALL, qty: 1.01, avgPrice: ask }]);
  const entry = entryOf(h);
  assert.ok(Math.abs(entry.fee - 1.01 * 24) < 1e-9); // 0.03% of the 80,000 index per contract, under the 10% premium cap
  assert.equal(entry.partial, false);
});

test('a premium stop closes the position at the bid, books the loss and cools down before re-arming', async () => {
  const h = await harness();
  await h.engine.cycle();
  const entry = entryOf(h);
  const bid = entry.price * 0.69;
  h.market.books.set(CALL, { bids: [[bid, 10]], asks: [[bid + 30, 10]] });

  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'POSITION_CLOSED');
  const closed = h.journal().find((e) => e.event === 'POSITION_CLOSED')!;
  assert.equal(closed.reason, 'STOP_LOSS');
  const exitFee = h.journal().find((e) => e.event === 'EXIT_FILLED')!.fee;
  assert.ok(Math.abs(closed.pnl - (1.01 * (bid - entry.price) - entry.fee - exitFee)) < 1e-6);
  assert.deepEqual(await h.venue.positions(), []);
  assert.ok(Math.abs((await h.venue.equity()) - (100_000 + closed.pnl)) < 1e-6);

  h.market.books.delete(CALL);
  h.clock.now += 10 * 60_000;
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'POSITION_CLOSED');
  h.clock.now += 21 * 60_000;
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'IDLE');
});

test('buys a put on an aligned downtrend', async () => {
  const h = await harness({ start: false });
  h.ctx.trend = 'BEAR';
  await h.engine.start();
  await h.engine.cycle();
  assert.equal(stateOf(h).position?.symbol, 'BTC-261030-80000-P');
});

test('an LLM veto blocks the entry and the LLM never sets a price', async () => {
  const h = await harness({ verdict: { verdict: 'VETO', reason: 'IV rich into resistance' } });
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'IDLE');
  assert.deepEqual(await h.venue.positions(), []);
  const rejected = h.journal().find((e) => e.event === 'ENTRY_REJECTED')!;
  assert.deepEqual(rejected.reasons, ['LLM veto: IV rich into resistance']);
  assert.ok(!h.events().includes('ENTRY_SUBMITTED'));
});

test('the kill switch and stale market data block entries before any signal', async () => {
  const halted = await harness({ halted: true });
  await halted.engine.cycle();
  assert.match(stateOf(halted).note, /kill switch: operator halt/);
  assert.deepEqual(halted.events(), []);

  const stale = await harness();
  stale.ctx.stale = true;
  await stale.engine.cycle();
  assert.match(stateOf(stale).note, /market data: .*45 min ago/);
  assert.deepEqual(stale.events(), []);
});

test('a stale index print rejects the signal without an order', async () => {
  const h = await harness();
  h.market.indexTime = T0 - 20_000;
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'IDLE');
  assert.match(h.journal().find((e) => e.event === 'ENTRY_REJECTED')!.reasons[0], /index print is 20000ms old/);
});

test('the CoinDCX monitor reports what it would buy and never trades', async () => {
  const h = await harness({ venue: (cfg) => new MonitorOnlyVenue('coindcx-monitor', 100_000) });
  await h.engine.cycle();
  const would = h.journal().find((e) => e.event === 'WOULD_BUY')!;
  assert.equal(would.venue, 'coindcx-monitor');
  assert.equal(would.snapshot.contract, CALL);
  assert.equal(stateOf(h).state, 'IDLE');
  assert.ok(h.logs.some(([, m]) => /\[coindcx-monitor\] WOULD BUY 1.01 BTC-261030-80000-C/.test(m)));
  await h.engine.cycle();
  assert.match(stateOf(h).note, /cooldown 30 min/);
  assert.equal(h.journal().filter((e) => e.event === 'WOULD_BUY').length, 1);
});

test('a book that thins between selection and order gives a partial fill sized to what filled', async () => {
  const h = await harness({ start: false });
  const ask = h.market.markOf(CALL) + 15;
  h.market.nextBooks.set(CALL, [
    { bids: [[ask - 30, 10]], asks: [[ask, 10]] },
    { bids: [[ask - 30, 10]], asks: [[ask, 0.3], [ask * 1.5, 10]] },
  ]);
  await h.engine.start();
  await h.engine.cycle();
  const entry = entryOf(h);
  assert.deepEqual([entry.qty, entry.requested, entry.partial], [0.3, 1.01, true]);
  assert.equal(stateOf(h).position?.qty, 0.3);
});

test('an ask that moves past the plan limit before sending is refused', async () => {
  const h = await harness({ start: false });
  const ask = h.market.markOf(CALL) + 15;
  h.market.nextBooks.set(CALL, [{ bids: [[ask - 30, 10]], asks: [[ask, 10]] }, { bids: [[ask, 10]], asks: [[ask * 1.05, 10]] }]);
  await h.engine.start();
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'IDLE');
  assert.match(h.journal().find((e) => e.event === 'ENTRY_REJECTED')!.reasons[0], /moved past limit/);
});

test('a partial exit stays EXIT_PENDING and the remainder closes next cycle', async () => {
  const h = await harness();
  await h.engine.cycle();
  const entry = entryOf(h);
  const bid = entry.price * 0.6;
  h.market.books.set(CALL, { bids: [[bid, 0.5], [bid * 0.5, 10]], asks: [[entry.price, 10]] });
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'EXIT_PENDING');
  assert.equal(stateOf(h).position?.qty, 0.51);

  h.market.books.set(CALL, { bids: [[bid, 10]], asks: [[entry.price, 10]] });
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'POSITION_CLOSED');
  const fills = h.journal().filter((e) => e.event === 'EXIT_FILLED');
  assert.deepEqual(fills.map((f) => f.qty), [0.5, 0.51]);
  const closed = h.journal().find((e) => e.event === 'POSITION_CLOSED')!;
  assert.equal(closed.qty, 1.01);
  const expected = 1.01 * bid - fills[0].fee - fills[1].fee - (1.01 * entry.price + entry.fee);
  assert.ok(Math.abs(closed.pnl - expected) < 1e-6);
});

/** Executes the order, then loses the reply once: the caller cannot know whether it filled. */
class LostReplyVenue extends LocalOptionsPaperVenue {
  lost = 0;
  buys = 0;
  async buyToOpen(req: OptionOrderRequest): Promise<OptionOrderResult> {
    this.buys += 1;
    const result = await super.buyToOpen(req);
    if (this.lost++ === 0) throw new Error('socket hang up');
    return result;
  }
}

test('an entry whose reply is lost is reconciled by its order id, never resent', async () => {
  const h = await harness({ venue: (cfg) => new LostReplyVenue(100_000, cfg.fees) });
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'ENTRY_PENDING');
  const persisted = JSON.parse(readFileSync(h.cfg.statePath, 'utf-8'));
  assert.equal(persisted.slots.BTCUSDT.pendingEntry.clientOrderId, `opt-${CALL}-id1`);

  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'POSITION_OPEN');
  assert.equal((h.venue as LostReplyVenue).buys, 1);
  assert.deepEqual((await h.venue.positions()).map((p) => p.qty), [1.01]);
  assert.deepEqual(h.events(), ['SIGNAL', 'LLM_VERDICT', 'ENTRY_SUBMITTED', 'ENTRY_UNKNOWN', 'ENTRY_FILLED']);
});

class RejectingVenue extends LocalOptionsPaperVenue {
  async buyToOpen(req: OptionOrderRequest): Promise<OptionOrderResult> {
    return { clientOrderId: req.clientOrderId, status: 'REJECTED', filledQty: 0, avgPrice: 0, fee: 0, reason: 'MARGIN_REJECTED' };
  }
}

test('a venue rejection returns to IDLE with a cooldown', async () => {
  const h = await harness({ venue: (cfg) => new RejectingVenue(100_000, cfg.fees) });
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'IDLE');
  assert.equal(h.journal().find((e) => e.event === 'ENTRY_NOT_FILLED')!.reason, 'MARGIN_REJECTED');
  await h.engine.cycle();
  assert.match(stateOf(h).note, /cooldown/);
});

test('a restart restores the open position and the local venue book, then keeps managing it', async () => {
  const first = await harness();
  await first.engine.cycle();
  const entry = entryOf(first);

  const second = await harness({ cfg: first.cfg, clock: first.clock, market: first.market, venue: (cfg) => new LocalOptionsPaperVenue(1, cfg.fees) });
  assert.equal(stateOf(second).state, 'POSITION_OPEN');
  assert.deepEqual(await second.venue.positions(), await first.venue.positions());
  assert.ok(Math.abs((await second.venue.equity()) - (await first.venue.equity())) < 1e-9);

  second.market.books.set(CALL, { bids: [[entry.price * 1.61, 10]], asks: [[entry.price * 1.65, 10]] });
  await second.engine.cycle();
  assert.equal(second.journal().filter((e) => e.event === 'POSITION_CLOSED')[0].reason, 'TAKE_PROFIT');
});

test('refuses to start on a corrupt state file instead of orphaning what it described', async () => {
  const cfg = testConfig();
  writeFileSync(cfg.statePath, '{ "version": 1, "slots": ');
  await assert.rejects(harness({ cfg }), /not valid JSON/);
});

test('exits before expiry on time alone, and a thesis flip exits early', async () => {
  const expiry = await harness();
  await expiry.engine.cycle();
  expiry.clock.now = EXPIRY - 5 * 3_600_000;
  await expiry.engine.cycle();
  assert.equal(expiry.journal().find((e) => e.event === 'EXIT_TRIGGERED')!.reason, 'PRE_EXPIRY');
  assert.equal(stateOf(expiry).state, 'POSITION_CLOSED');

  const flip = await harness();
  await flip.engine.cycle();
  flip.ctx.trend = 'BEAR';
  await flip.engine.cycle();
  assert.equal(flip.journal().find((e) => e.event === 'EXIT_TRIGGERED')!.reason, 'THESIS_INVALIDATED');
});

test('an exit with no bid is retried every cycle and escalates to an error', async () => {
  const h = await harness();
  await h.engine.cycle();
  h.clock.now = EXPIRY - 5 * 3_600_000;
  h.market.books.set(CALL, { bids: [], asks: [[100, 1]] });
  for (let i = 0; i < 3; i += 1) await h.engine.cycle();
  assert.equal(stateOf(h).state, 'EXIT_PENDING');
  assert.equal(h.journal().filter((e) => e.event === 'EXIT_RETRY').length, 3);
  assert.ok(h.logs.some(([level, m]) => level === 'error' && /not done after 3 attempt\(s\): no bid/.test(m)));
  h.market.books.delete(CALL);
  await h.engine.cycle();
  assert.equal(stateOf(h).state, 'POSITION_CLOSED');
});

test('the daily loss governor halts entries after a losing day', async () => {
  const h = await harness({ env: { OPTIONS_MAX_DAILY_LOSS_PCT: '0.5' } });
  await h.engine.cycle();
  const entry = entryOf(h);
  h.market.books.set(CALL, { bids: [[entry.price * 0.69, 10]], asks: [[entry.price * 0.7, 10]] });
  await h.engine.cycle();
  h.market.books.delete(CALL);
  h.clock.now += 31 * 60_000;
  await h.engine.cycle(); // RESET
  await h.engine.cycle();
  assert.match(stateOf(h).note, /risk halt: daily loss/);
  assert.equal(h.journal().filter((e) => e.event === 'SIGNAL').length, 1);
});

class VanishingVenue extends LocalOptionsPaperVenue {
  vanish = false;
  async positions() {
    return this.vanish ? [] : super.positions();
  }
}

test('a position that disappears from the venue is closed at the worst case', async () => {
  const h = await harness({ venue: (cfg) => new VanishingVenue(100_000, cfg.fees) });
  await h.engine.cycle();
  const entry = entryOf(h);
  (h.venue as VanishingVenue).vanish = true;
  await h.engine.cycle();
  const closed = h.journal().find((e) => e.event === 'POSITION_CLOSED')!;
  assert.equal(closed.reason, 'EXTERNAL_CLOSE');
  assert.equal(closed.pnlAssumed, true);
  assert.ok(Math.abs(closed.pnl + (1.01 * entry.price + entry.fee)) < 1e-6);
  assert.ok(h.logs.some(([level, m]) => level === 'error' && /no longer on local-paper/.test(m)));
});

test('startup adopts an untracked venue position with a stop and target', async () => {
  const cfg = testConfig();
  const clock = { now: T0 };
  const market = new FakeOptionsMarket(() => clock.now);
  const venue = new LocalOptionsPaperVenue(100_000, cfg.fees);
  const contract = { symbol: CALL, underlying: 'BTCUSDT', right: 'CE' as const, strike: 80_000, expiryMs: EXPIRY, unit: 1, minQty: 0.01, qtyStep: 0.01, tickSize: 5 };
  await venue.buyToOpen({ contract, qty: 0.5, limitPrice: 5_000, book: [[2_000, 1]], indexPrice: 80_000, clientOrderId: 'manual-1' });

  const h = await harness({ cfg, clock, market, venue: () => venue });
  const s = stateOf(h);
  assert.equal(s.state, 'POSITION_OPEN');
  assert.deepEqual([s.position?.qty, s.position?.entry, s.position?.stop, s.position?.target], [0.5, 2_000, 1_400, 3_200]);
  assert.ok(h.events().includes('ADOPTED'));
});

test('positions are capped by OPTIONS_MAX_OPEN_POSITIONS across underlyings', async () => {
  const h = await harness({ env: { OPTIONS_UNDERLYINGS: 'BTCUSDT,ETHUSDT', OPTIONS_MAX_OPEN_POSITIONS: '1' } });
  await h.engine.cycle();
  const [btc, eth] = h.engine.status();
  assert.equal(btc.state, 'POSITION_OPEN');
  assert.equal(eth.state, 'IDLE');
  assert.match(eth.note, /1 positions open \(max 1\)/);
});
