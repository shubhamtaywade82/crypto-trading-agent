# @cta/dashboard

Read-only operator cockpit for [`crypto-trading-agent`](../../README.md). A browser-based research and operations view that visualizes the existing trading engine — **never replaces it**.

This package is the implementation of the **OpenTerminal reuse audit** recommendation: adopt OpenTerminal as a *reference* for a new visual cockpit, but keep `crypto-trading-agent` as the sole source of truth for trading decisions and execution.

## What this is — and what it is not

| This dashboard is | This dashboard is NOT |
| --- | --- |
| A read-only visualization of the agent's market state, risk gates, decision journal, research plane, and live readiness | A trading engine — it never places orders, never modifies risk limits, never toggles the kill-switch |
| A consumer of the agent's existing `MarketDataService`, `MarketStateBuilder`, `assessSafety`, `evaluateRisk`, `DecisionJournal`, `loadDashboardData`, `evaluateEvidence`, `evaluateForward`, `evaluateConfig`, `approvable`, `isReady` outputs | A second source of market data. The UI fetches candles from the same `BinanceService` the engine uses — never from spot endpoints or independent providers |
| A panel-based workspace inspired by OpenTerminal's `ChartWidget.tsx`, `CryptoWidget.tsx`, `Workspace.tsx`, `terminal.ts` store | A clone of OpenTerminal's server / providers / cache / indicators. Those are *references*, not transplanted code |
| Stale-data-aware: every market panel shows a `STALE` banner when the last tick is older than 60 seconds; the safety verdict still applies | A way to silently fall back to last-known prices so the dashboard always looks populated. Stale data is visibly marked |
| A separate Vite + React 18 app under `apps/dashboard/`, isolated from the Ink TUI's React 18 deps so each can evolve independently | A replacement for the Ink TUI. The Ink cockpit remains the primary operator interface |

## Architecture

```
Binance USD-M futures feeds (WS + REST)
        │
        ▼
┌───────────────────────────────────────────┐
│ Existing crypto-trading-agent core        │  ← single source of truth
│ MarketStateBuilder · assessSafety ·       │
│ strategies · risk engine · decisions ·    │
│ execution adapters · position manager ·    │
│ backtesting · research · live readiness    │
└───────────────────────────────────────────┘
        │
        ▼ read-only disk reads + BinanceService re-instantiation
┌───────────────────────────────────────────┐
│ apps/dashboard/server  (Express + WS)     │  ← read-only HTTP/WS layer
│ /api/state /api/market/* /api/risk/*      │
│ /api/decisions /api/research/*             │
│ /api/live-readiness /api/account /api/...  │
│ /ws/state                                 │
└───────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────┐
│ apps/dashboard/web  (Vite + React 18)     │
│ Workspace · ChartWidget · MarketPanel ·   │
│ DecisionJournalPanel · RiskPanel ·         │
│ StatusBar                                 │
└───────────────────────────────────────────┘
```

## Quick start

```bash
# From the dashboard package root
cd apps/dashboard
npm install

# Terminal 1 — start the read-only server (port 4101)
CTA_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT npm run dev:server

# Terminal 2 — start the Vite dev server (port 5173, proxies /api → 4101)
npm run dev:web

# Open the cockpit
open http://localhost:5173
```

### Production build

```bash
npm run build         # builds web (dist-web/) + server (dist-server/)
npm start            # serves the built frontend through Express on port 4101
```

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CTA_DATA_DIR` | `<repo>/data` | Where the orchestrator persists `decisions.jsonl`, `kill-switch.json`, `paper-state.json`, `remote-state.json`, `live-state.json`, `position-manager.json`, `risk-hwm.json`, `approvals.json`, `rr-profile.json`, `champion-registry.json`, `experiments.jsonl`, `research-events.jsonl`, `experiment-memory.json`, `events.audit.jsonl`. |
| `CTA_DASHBOARD_PORT` | `4101` | HTTP port for the read-only server. |
| `CTA_SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT` | Comma-separated list of symbols the dashboard will fetch and display. |

## API surface

All endpoints are `GET` (read-only). There are no order-placement endpoints, no kill-switch toggle endpoints, no HWM-reset endpoints, no approvals-mutation endpoints.

### Live state
- `GET /api/state` — best-effort live snapshot: account, positions, kill-switch, venue, WS status, API weight.
- `GET /api/logs?limit=100` — recent audit events from `events.audit.jsonl`.
- `WS /ws/state` — pushes BinanceService feed-health updates once per second.

### Market
- `GET /api/market/snapshot?symbols=` — `MarketDataService.snapshot(symbols)`.
- `GET /api/market/state?symbols=` — `MarketStateBuilder.buildAll(inputs)`.
- `GET /api/market/safety?symbols=` — `assessSafety` verdicts per symbol.
- `GET /api/market/derivatives?symbols=` — `DerivativesSnapshot` per symbol.
- `GET /api/market/feed-health?symbol=` — last tick / mark / exchange status.
- `GET /api/market/ws-status` — BinanceService WebSocket health.

### Risk
- `GET /api/risk/snapshot` — kill-switch + HWM + performance snapshot + circuit + limits.
- `GET /api/risk/kill-switch` — `KillSwitch.state()`.
- `GET /api/risk/limits` — static `RiskLimits` from config.
- `GET /api/risk/approvals` — `loadApprovals(path)` (approved strategy set).
- `GET /api/risk/hwm` — raw `risk-hwm.json`.
- `GET /api/risk/unprotected?pct=2.5` — `findUnprotected(positions, equity, pct)`.
- `GET /api/risk/rr-profile` — `loadRrProfile(path)` per-strategy RR floors.

### Decisions
- `GET /api/decisions?status=&strategy=&symbol=&limit=200&spec=` — filtered `DecisionJournal`.
- `GET /api/decisions/:id` — single `DecisionRecord`.
- `GET /api/decisions/refusals/summary` — counts by `classifyRiskRefusal`.
- `GET /api/decisions/status/summary` — counts by `DecisionStatus`.

### Research
- `GET /api/research/dashboard` — `loadDashboardData(dataDir)` (same shape the Ink research-dashboard TUI consumes).
- `GET /api/research/champion` — `ChampionRegistry.snapshot()`.
- `GET /api/research/experiments?limit=200` — `ExperimentStore.all()`.
- `GET /api/research/events?limit=200` — JSONL tail of `research-events.jsonl`.
- `GET /api/research/metrics` — metrics snapshot rebuilt from events.
- `GET /api/research/experiment-memory` — raw `experiment-memory.json`.

### Live readiness
- `GET /api/live-readiness` — `evaluateEvidence + evaluateForward + evaluateConfig + approvable + isReady` (the exact shape `scripts/live-readiness.ts` produces).

### Account / execution / positions
- `GET /api/account` — live `{ equity, marginUsed, initialEquity }`.
- `GET /api/positions` — `getPositions(false)`.
- `GET /api/trades?limit=100` — recent closed trades (newest first).
- `GET /api/venue` — venue status (`connected | degraded | down`).
- `GET /api/venue/feed-health?symbol=` — per-symbol feed health.
- `GET /api/venue/ws-status` — BinanceService WebSocket health.
- `GET /api/live-book` — `LiveBook.positions(prices)` + `mode`.
- `GET /api/position-manager/states` — `PositionManagerStore` map.
- `GET /api/position-manager/config` — `pmConfigFromEnv()`.

## Critical safety guarantees

1. **One authoritative futures-data pipeline.** The dashboard re-instantiates the agent's `BinanceService` (USD-M perpetual futures). It does NOT use spot endpoints. The chart and the strategy engine see the same candles, the same derivatives snapshots, the same mark prices.
2. **Stale data is visibly marked.** Every market panel checks `data.generatedAt` and shows a `STALE — last-known data` banner when the last tick is older than 60 seconds. The `assessSafety` verdict still applies; stale data does not silently downgrade to `NORMAL`.
3. **The UI cannot bypass risk gates.** No `/api/orders/*` endpoint, no `/api/risk/kill-switch/toggle` endpoint, no `/api/risk/hwm/reset` endpoint. Operators must use the authenticated CLI command path.
4. **No browser-side indicator implementations.** The chart visualizes candles and volume only. SMA / EMA / VWAP / RSI / MACD / Bollinger Bands are computed server-side by the existing engine; the dashboard never produces a second opinion that can disagree with strategy inputs.
5. **MIT license compliance.** OpenTerminal is MIT-licensed; patterns borrowed from `ChartWidget.tsx`, `CryptoWidget.tsx`, `Workspace.tsx`, `terminal.ts` retain their copyright and license notice. See `LICENSE` references in the source files.

## Roadmap

This is the **first milestone** from the audit's implementation plan: a read-only dashboard shell with a futures chart, live market-safety panel, and decision journal, backed by data the agent already collects.

Subsequent milestones (tracked separately):

1. **In-process embedding.** Run the dashboard server inside the orchestrator process so `GET /api/state` returns the orchestrator's last emitted `AppState` directly, and `WS /ws/state` forwards `orchestrator.on('state' | 'log' | 'sync')` events to clients. This eliminates the disk-read fallback for live state.
2. **Position, risk, and decision panels — full coverage.** Add a positions panel with mark-price-synced uP&L, a backtest-vs-paper comparison panel, an out-of-sample comparison panel, and a refusal-reason drill-down that opens the full `DecisionRecord` (signal, evidence, risk verdict, execution quality, outcome).
3. **Research interface.** Visualize backtests, parameter sweeps, paper-trading evidence, and out-of-sample comparisons. Surface `BootstrapSummary` CIs and `ConditionalEdge` matrices so operators can investigate whether any strategy has a validated edge (none does as of 2026-09-30, per the research log).
4. **Draggable / resizable workspace.** Adopt OpenTerminal's `Workspace.tsx` layout primitives (saved layouts, linked symbols, keyboard shortcuts, command palette).
5. **Contract and safety tests.** Add Cypress or Playwright tests that verify: (a) no `/api/orders/*` endpoint exists; (b) stale data is visibly marked on every market panel; (c) missing values are never converted to neutral signals; (d) the UI cannot bypass order and risk gates.

## What we deliberately did NOT copy from OpenTerminal

Per the audit's section 5 ("What to avoid copying unchanged"):

| OpenTerminal feature | Why we did not copy it |
| --- | --- |
| `server/src/providers/binance.ts` (spot endpoints) | The agent trades USD-M perpetual futures. Mixing spot data into a futures decision pipeline without explicit semantics corrupts features. We re-instantiate the agent's own `BinanceService` instead. |
| `server/src/cache.ts` (stale-while-revalidate) | Its `cached()` waits for a new fetch and only returns stale on failure; lacks in-flight coalescing. Our dashboard always stamps `generatedAt` and shows a visible `STALE` banner — no silent fallback. |
| Browser-side indicator computations | A second implementation of indicators can disagree with the backend. The chart visualizes candles and volume only. |
| 1-second REST polling for live prices | Not appropriate for live futures execution. We poll `MarketDataService.snapshot` every 5s for the chart and every 1s for the status bar; live updates flow over WebSocket (`/ws/state`). |
| `web/components/widgets/AIWidget.tsx` (LLM assistant) | The agent's existing LLM/council architecture is the trading-specific reasoning layer. A dashboard assistant may *explain* a recorded decision using the decision journal, but it must never bypass risk checks or place orders. Deferred to a later milestone. |
| Portfolio accounting ledger | The agent's position manager, paper engine, remote broker, and live book already reconcile fills, fees, funding, realized P&L, margin, and exchange positions. We do not add a second ledger. |

## License

Same as the parent project. OpenTerminal patterns are MIT-licensed; their copyright and license notice are retained in source files that borrow from `ChartWidget.tsx`, `CryptoWidget.tsx`, `Workspace.tsx`, and `terminal.ts`.
