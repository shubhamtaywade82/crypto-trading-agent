import { FleetSupervisor, type FleetState } from '../src/fleet/FleetSupervisor.js';
import { renderDashboard } from '../src/fleet/FleetDashboard.js';
import { installTokenUsageLog } from '../src/ollama/tokenUsage.js';

installTokenUsageLog('fleet');

// The dashboard repaints the whole screen; more than 4 repaints a second tears the console
const RENDER_THROTTLE_MS = 250;

// FLEET_IN_DEV only parks the fleet embedded in `npm run dev`; it must not stop the standalone runner
const fleet = new FleetSupervisor({ env: { ...process.env, FLEET_IN_DEV: 'on' }, label: 'standalone' });

fleet.on('log', ({ msg, level }: { msg: string; level: 'info' | 'warn' | 'error' }) => {
  (level === 'info' ? console.log : level === 'warn' ? console.warn : console.error)(msg);
});

let lastRender = 0;
fleet.on('state', (state: FleetState) => {
  const now = Date.now();
  if (!state.enabled || now - lastRender < RENDER_THROTTLE_MS) return;
  lastRender = now;
  renderDashboard({
    startTime: state.startedAt,
    btcPrice: state.anchor.price,
    btcTrend1h: state.anchor.trend1h,
    btcTrend15m: state.anchor.trend15m,
    btcChange24h: state.anchor.change24h,
    workers: Object.values(state.bySymbol),
    entriesEnabled: state.entriesEnabled,
  });
});

process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

// The lease renewal timers keep the process alive until stop() releases them
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => fleet.stop());

await fleet.start();
// The embedded fleet parks on a bad config; standalone, there is nothing else to run, so refuse to start
if (!fleet.state.enabled) {
  console.error(`[fleet] refusing to start: ${fleet.state.disabledReason ?? 'parked'}`);
  process.exit(1);
}
