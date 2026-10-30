import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FleetSupervisor } from '../src/minicpm/FleetSupervisor.js';

const TOKEN_ENV = { PAPER_EXCHANGE_API_KEY: 'test-token', MINICPM_ENTRIES: 'off' } as const;

function expectStateEvents(supervisor: FleetSupervisor, count = 1): Promise<InstanceType<typeof FleetSupervisor> extends never ? never : any[]> {
  return new Promise((resolve) => {
    const seen: any[] = [];
    supervisor.on('state', (s: any) => {
      seen.push(s);
      if (seen.length >= count) resolve(seen);
    });
  });
}

test('without the paper-exchange token the embedded fleet parks itself and never throws', async () => {
  const supervisor = new FleetSupervisor({ env: { FLEET_IN_DEV: 'on' } });
  const states = expectStateEvents(supervisor, 1);
  await supervisor.start();
  const [state] = await states;
  assert.equal(state.enabled, false, 'no token => parked');
  assert.match(state.disabledReason ?? '', /PAPER_EXCHANGE_API_KEY is not set/);
  supervisor.stop();
});

test('FLEET_IN_DEV=off parks the fleet even when the token exists', async () => {
  const supervisor = new FleetSupervisor({ env: { ...TOKEN_ENV, FLEET_IN_DEV: 'off' } });
  const states = expectStateEvents(supervisor, 1);
  await supervisor.start();
  const [state] = await states;
  assert.equal(state.enabled, false);
  assert.match(state.disabledReason ?? '', /FLEET_IN_DEV=off/);
  supervisor.stop();
});

test('a bad model route parks the fleet with the refusal reason (boot fail-closed)', async () => {
  const supervisor = new FleetSupervisor({ env: TOKEN_ENV, model: 'qwen3.5-2b', route: 'DOGE=qwen3:4b' });
  const states = expectStateEvents(supervisor, 1);
  await supervisor.start();
  const [state] = await states;
  assert.equal(state.enabled, false);
  assert.match(state.disabledReason ?? '', /does not trade it/);
  supervisor.stop();
});

test('with the token the supervisor resolves the control-model assignment for every symbol', () => {
  const supervisor = new FleetSupervisor({ env: TOKEN_ENV });
  const state = supervisor.state;
  assert.equal(state.enabled, false, 'not started yet — but config is resolved');
  assert.deepEqual(state.assignment, {
    ETHUSDT: 'openbmb/minicpm5-2b:latest',
    SOLUSDT: 'openbmb/minicpm5-2b:latest',
    XRPUSDT: 'openbmb/minicpm5-2b:latest',
  });
  assert.equal(state.entriesEnabled, false, 'entries stay OFF without MINICPM_ENTRIES=on');
});

test('a per-symbol route overrides only the named symbols in the resolved config', () => {
  const supervisor = new FleetSupervisor({ env: TOKEN_ENV, model: 'qwen3.5-2b', route: 'ETH=lfm2.5-2.6b' });
  const state = supervisor.state;
  assert.equal(state.assignment['ETHUSDT'], 'LiquidAI/lfm2.5-2.6b');
  assert.equal(state.assignment['SOLUSDT'], 'qwen3.5:2b');
  assert.equal(state.assignment['XRPUSDT'], 'qwen3.5:2b');
});

test('MINICPM_ENTRIES=on arms entries in the resolved config (same rule as the standalone fleet)', () => {
  const supervisor = new FleetSupervisor({ env: { ...TOKEN_ENV, MINICPM_ENTRIES: 'on' } });
  assert.equal(supervisor.state.entriesEnabled, true);
});

test('the embedded fleet never touches the main agent alert pipeline (only the low-level Telegram sender)', () => {
  const dir = path.resolve('src/minicpm');
  const offenders: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    const src = readFileSync(path.join(dir, file), 'utf8');
    // Allowed: ../ops/telegram.js (the low-level sender). Forbidden: the main agent's alert
    // pipeline — sendAlert / AlertEvent / NotificationEngine / opsHooks / alert cards. Fleet
    // trade cards must stay a separate, [FLEET]-tagged stream, never a second caller of it.
    if (/from\s+['"].*(ops\/alerts|ops\/cards|ops\/hooks|runtime\/opsHooks|sendAlert)['"]/.test(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'src/minicpm must not import the main agent alert pipeline (alerts/cards/hooks/sendAlert)');

  // The single deliberate import point: FleetTelegram imports the low-level sendTelegram only.
  const fleetTelegram = readFileSync(path.join(dir, 'FleetTelegram.ts'), 'utf8');
  const importMatch = fleetTelegram.match(/import\s+\{([^}]*)\}\s+from\s+['"]\.\.\/ops\/telegram\.js['"]/);
  assert.ok(importMatch, 'FleetTelegram is the one bridge to the Telegram sender');
  assert.match(importMatch[1]!, /sendTelegram/, 'it uses the low-level sender');
  assert.doesNotMatch(importMatch[1]!, /sendAlert/, 'the fleet never sends through sendAlert');
});

test('the fleet screen renders a parked explanation and never throws on partial state', async () => {
  const { renderFleetScreen } = await import('../src/ui/fleetPanels.js');
  const parked = renderFleetScreen({
    state: { enabled: false, disabledReason: 'parked: PAPER_EXCHANGE_API_KEY is not set.', entriesEnabled: false, llmHost: 'http://127.0.0.1:11434', startedAt: 0, assignment: {}, bySymbol: {} },
    time: '12:00:00',
    totalWidth: 110,
    totalHeight: 40,
  });
  assert.ok(parked.length > 3);
  assert.ok(parked.some((l) => l.includes('parked')));
  assert.ok(parked.some((l) => l.includes('PAPER_EXCHANGE_API_KEY')));

  const running = renderFleetScreen({
    state: {
      enabled: true,
      entriesEnabled: false,
      llmHost: 'http://127.0.0.1:11434',
      startedAt: Date.now() - 65_000,
      assignment: { ETHUSDT: 'qwen3.5:2b' },
      bySymbol: {
        ETHUSDT: {
          symbol: 'ETHUSDT', accountId: 'crypto-minicpm-eth', state: 'IN_POSITION',
          activePosition: { unrealizedPnl: 12.5, side: 'long', currentPrice: 2400.1 } as never,
          account: null, stopLoss: 2350, takeProfit: 2460, slDistancePct: -2, tpDistancePct: 2.5,
          breakEvenMoved: false, lastDecision: 'ENTER_LONG @ 2400 | SL: 2350 | TP: 2460 (reclaimed support) [R1: entries off]',
          lastUpdated: Date.now(), modelTag: 'qwen3.5:2b',
        },
      },
    },
    time: '12:01:05',
    totalWidth: 110,
    totalHeight: 40,
  });
  assert.ok(running.some((l) => l.includes('SHADOW ANALYSIS')));
  assert.ok(running.some((l) => l.includes('qwen3.5:2b')));
  assert.ok(running.some((l) => l.includes('ETH')));
  assert.ok(running.some((l) => l.includes('Telegram trade notifications')), 'the view must state the fleet trade-notification contract');
  assert.ok(running.some((l) => l.includes('FLEET_TELEGRAM=off')), 'the view must show the opt-out switch');
});
