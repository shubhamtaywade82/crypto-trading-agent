import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionsConfigFromEnv } from '../src/options/config.js';
import { OptionChainService } from '../src/options/OptionChainService.js';
import { OptionsBuyingEngine, type LogLevel } from '../src/options/OptionsBuyingEngine.js';
import { OptionsDesk, type OptionsDeskView } from '../src/options/OptionsDesk.js';
import { OptionsJournal, OptionsStateStore } from '../src/options/stateStore.js';
import { LocalOptionsPaperVenue } from '../src/options/venues.js';
import { renderOptionsBlock } from '../src/ui/accountPanels.js';
import { MIN_COLS, MIN_ROWS, renderCockpit, type CockpitProps } from '../src/ui/panels.js';
import { FakeContext, FakeOptionsMarket, T0, testConfig } from './support/optionsFixture.js';

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
const baseProps = (overrides: Partial<CockpitProps>): CockpitProps => ({
  mode: 'paper', time: '12:00:00', equity: 100_000, upnl: 0, marginUsed: 0, positions: [], selPos: 0,
  agents: [], logs: [], spotPrices: {}, isSyncing: false, totalWidth: 160, totalHeight: 58,
  initialEquity: 100_000, totalPnl: 0, totalPnlPct: 0, successRate: null, sharpe: null, maxDd: 0, var95: null,
  liqEvents: 0, sessionDecisions: 0, sessionExecuted: 0, sessionMonitored: 0, apiWeight: 0, wsStatus: 'down',
  exposurePct: 0, minLiqDistancePct: null, corrBtcEth: null, funding: {}, strategyMetrics: null, venue: { name: 'local paper engine', state: 'local' }, ...overrides,
} as CockpitProps);

// ---- venue follows the cockpit MODE ------------------------------------------------------------------------------

test('auto venue: dev:paper trades options locally, paper_exchange gets its own -options wallet, live is monitor-only', () => {
  assert.equal(optionsConfigFromEnv({ MODE: 'paper' }).venue, 'local');
  assert.equal(optionsConfigFromEnv({}).statePath, 'data/options-state-local.json');

  const pe = optionsConfigFromEnv({ MODE: 'paper', PAPER_EXCHANGE_URL: 'http://pe:3000', PAPER_EXCHANGE_ACCOUNT_ID: 'crypto-paper' });
  assert.equal(pe.venue, 'paper_exchange');
  assert.equal(pe.paperExchange?.accountId, 'crypto-paper-options');
  assert.equal(pe.statePath, 'data/options-state-paper_exchange-crypto-paper-options.json');

  const live = optionsConfigFromEnv({ MODE: 'live' });
  assert.equal(live.venue, 'monitor');
  assert.equal(optionsConfigFromEnv({ MODE: 'live', OPTIONS_VENUE: 'coindcx_monitor' }).venue, 'monitor');
  assert.equal(optionsConfigFromEnv({ OPTIONS: 'off' }).enabled, false);
});

test('refuses paper options beside live futures, and a shared futures/options paper_exchange wallet', () => {
  assert.throws(() => optionsConfigFromEnv({ MODE: 'live', OPTIONS_VENUE: 'local' }), /MODE=live runs options monitor-only/);
  assert.throws(
    () => optionsConfigFromEnv({ PAPER_EXCHANGE_URL: 'http://pe', PAPER_EXCHANGE_ACCOUNT_ID: 'acc', OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID: 'acc' }),
    /must differ from PAPER_EXCHANGE_ACCOUNT_ID/,
  );
  assert.throws(() => optionsConfigFromEnv({ PAPER_EXCHANGE_URL: 'http://pe' }), /need PAPER_EXCHANGE_URL and OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID/);
});

// ---- desk lifecycle ----------------------------------------------------------------------------------------------

function deskWith(build: () => Promise<{ engine: OptionsBuyingEngine; venue: LocalOptionsPaperVenue }>) {
  const logs: Array<[LogLevel, string]> = [];
  const desk = new OptionsDesk({
    config: testConfig(),
    killSwitch: { isHalted: () => false, state: () => ({ reason: '' }) },
    vetoer: null,
    log: (level, message) => logs.push([level, message]),
    build,
  });
  return { desk, logs };
}

test('a desk whose start fails keeps retrying, logs the failure once, and never throws into the caller', async () => {
  const cfg = testConfig();
  const clock = { now: T0 };
  let attempts = 0;
  const { desk, logs } = deskWith(async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error('Request failed with status code 451');
    const venue = new LocalOptionsPaperVenue(100_000, cfg.fees);
    const engine = new OptionsBuyingEngine({
      config: cfg, chain: new OptionChainService(new FakeOptionsMarket(() => clock.now), { now: () => clock.now }), context: new FakeContext(),
      venue, vetoer: null, killSwitch: { isHalted: () => false, state: () => ({ reason: '' }) },
      store: new OptionsStateStore(cfg.statePath), journal: new OptionsJournal(cfg.journalPath), log: () => {}, now: () => clock.now,
    });
    return { engine, venue };
  });

  assert.equal(desk.view().state, 'starting');
  await desk.tick();
  await desk.tick();
  assert.equal(desk.view().state, 'down');
  assert.match(desk.view().rows[0].note, /451/);
  assert.equal(logs.filter(([level]) => level === 'error').length, 1);

  await desk.tick();
  const view = desk.view();
  assert.equal(view.state, 'running');
  assert.equal(view.rows[0].state, 'POSITION_OPEN');
  assert.ok(view.equity !== null && view.equity < 100_000);
  assert.equal(attempts, 3);
});

// ---- cockpit -----------------------------------------------------------------------------------------------------

const deskView: OptionsDeskView = {
  venue: 'local-paper', executing: true, state: 'running', equity: 998.76, halt: null, lastError: null,
  rows: [
    { underlying: 'BTCUSDT', state: 'POSITION_OPEN', note: 'long', position: { symbol: 'BTC-261030-80000-C', qty: 1.01, entry: 1908.07, stop: 1335.65, target: 3052.91 } },
    { underlying: 'ETHUSDT', state: 'IDLE', note: 'no entry: no aligned trend', position: null },
  ],
};

test('the positions column shows the options book under futures without changing the cockpit size', () => {
  const block = renderOptionsBlock({ options: deskView }, 60).map((l) => stripAnsi(l));
  assert.match(block[1], /OPTIONS local-paper\s*$/);
  assert.match(block[2], /^ +eq \$998\.76/);
  assert.match(block[3], /BTC +CE 80000 1\.01 @1908\.07 SL 1335\.65 TP 3052\.91/);
  assert.match(block[4], /ETH +idle +no entry: no aligned trend/);
  assert.deepEqual(renderOptionsBlock({}, 60), []);

  for (const [w, h] of [[MIN_COLS, MIN_ROWS], [200, 58]] as const) {
    const without = renderCockpit(baseProps({ totalWidth: w, totalHeight: h }));
    const withDesk = renderCockpit(baseProps({ totalWidth: w, totalHeight: h, options: { ...deskView, executing: false, venue: 'options-monitor', halt: 'daily loss' } }));
    assert.equal(withDesk.length, without.length);
    const text = withDesk.map((l) => stripAnsi(l)).join('\n');
    assert.match(text, /OPTIONS options-monitor monitor/);
    assert.match(text, /HALT daily loss/);
  }
});
