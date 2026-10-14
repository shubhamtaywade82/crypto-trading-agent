# Pull Request — feat(web-dashboard): read-only operator cockpit for crypto-trading-agent

Implements the first milestone of the **OpenTerminal reuse audit**: a read-only, browser-based operator cockpit that visualizes the existing trading engine — never replaces it.

## What this PR adds

### `apps/dashboard/` — a separate Vite + React 18 application

A new top-level `apps/` workspace (not transplanted into the existing package) so the Ink TUI's React 18 deps and the dashboard's Vite/React deps evolve independently. The audit explicitly called this out:

> The separation also avoids mixing OpenTerminal's React 19 web dependencies with your current Ink interface, which uses React 18. A separate application lets each retain its own dependency configuration.

### Server (`apps/dashboard/server/`) — read-only Express + WebSocket layer

Re-instantiates the agent's existing `BinanceService`, `MarketStateBuilder`, `MarketDataService`, `KillSwitch`, `EquityHwmStore`, `PerformanceEngine`, `ChampionRegistry`, `ExperimentStore`, `PaperEngine`, `RemoteStore`, `LiveBook`, `PositionManagerStore` so the dashboard never duplicates market-data or risk logic. All routes mirror the patterns already proven by:

- `scripts/inspect-state.ts` — `MarketDataService.snapshot` + `MarketStateBuilder.buildAll`.
- `scripts/live-readiness.ts` — `evaluateEvidence` + `evaluateForward` + `evaluateConfig` + `approvable` + `isReady`.
- `scripts/research-dashboard.ts` — `loadDashboardData(dataDir)`.
- `scripts/analyze-decisions.ts` — `classifyRiskRefusal` aggregation over `loadDecisionFiles`.

### API surface (all `GET`, all read-only)

| Area | Endpoints |
| --- | --- |
| Live state | `GET /api/state`, `GET /api/logs?limit=`, `WS /ws/state` |
| Market | `GET /api/market/{snapshot,state,safety,derivatives,feed-health,ws-status}` |
| Risk | `GET /api/risk/{snapshot,kill-switch,limits,approvals,hwm,unprotected,rr-profile}` |
| Decisions | `GET /api/decisions{,/:id,/refusals/summary,/status/summary}` |
| Research | `GET /api/research/{dashboard,champion,experiments,events,metrics,experiment-memory}` |
| Live readiness | `GET /api/live-readiness` (the full check list) |
| Account/positions | `GET /api/{account,positions,trades,venue,live-book,position-manager/*}` |

There are **no** order-placement endpoints, no kill-switch toggle, no HWM reset, no approvals mutation. Operators must use the authenticated CLI command path for any write action.

### Web (`apps/dashboard/web/`) — React 18 + lightweight-charts cockpit

A 3-panel workspace inspired by OpenTerminal's `ChartWidget.tsx`, `CryptoWidget.tsx`, `Workspace.tsx`, `terminal.ts` (patterns borrowed, not transplanted):

- **MarketPanel** — left column. Per-symbol last price, change %, `MarketSafety` verdict (`NORMAL` / `NO_ENTRY` / `HALT`), and a `STALE` flag when the last tick is older than 60 s.
- **ChartWidget** — center. Candlesticks + volume histograms via `lightweight-charts`. Data fetched from the agent's `MarketDataService` (USD-M perpetual futures — never spot). Stale data shows a visible `STALE — last-known data` banner.
- **DecisionJournalPanel** — right-top. Recent decisions from `data/decisions.jsonl` with filterable status. Refusals summary mirrors `scripts/analyze-decisions.ts`.
- **RiskPanel** — right-bottom. Kill-switch card, circuit breaker, peak equity, daily loss, drawdown, loss/win streaks, profit factor, expectancy, unprotected positions count, top refusal reasons, and the live-readiness check list with `detail` text — refusal reasons are explained, not just labeled.

A `StatusBar` runs across the top showing data freshness, kill-switch state, circuit, API weight, venue state, and the data directory the server is reading.

## Critical safety guarantees (audit section 3)

> **Critical warning: do not use its Binance provider for your trading engine**
>
> OpenTerminal's `server/src/providers/binance.ts` uses spot-market endpoints (`/api/v3/ticker/24hr`, `/api/v3/klines`, `/api/v3/depth`).
> Your agent trades Binance USD-M perpetual futures.
> Mixing spot data into a futures decision pipeline without explicit semantics and synchronization can corrupt the features used for decisions and backtests.

This PR honors that constraint:

1. **One authoritative futures-data pipeline.** The dashboard re-instantiates the agent's `BinanceService` (USD-M perpetual futures). No spot endpoints. The chart and the strategy engine see the same candles, the same derivatives snapshots, the same mark prices.
2. **Stale data is visibly marked.** Every market panel checks `data.generatedAt` and shows a `STALE` banner when the last tick is older than 60 seconds. The `assessSafety` verdict still applies; stale data does not silently downgrade to `NORMAL`.
3. **The UI cannot bypass risk gates.** No `/api/orders/*` endpoint, no `/api/risk/kill-switch/toggle` endpoint, no `/api/risk/hwm/reset` endpoint.
4. **No browser-side indicator implementations** (audit section 5). The chart visualizes candles and volume only. SMA / EMA / VWAP / RSI / MACD / Bollinger Bands are computed server-side by the existing engine.
5. **MIT license compliance.** OpenTerminal patterns are MIT-licensed; copyright and license notice are retained in source files that borrow from `ChartWidget.tsx`, `CryptoWidget.tsx`, `Workspace.tsx`, and `terminal.ts`.

## What this PR deliberately does NOT do

Per the audit's section 5 ("What to avoid copying unchanged"), we did NOT copy:

- OpenTerminal's `server/src/providers/binance.ts` (spot endpoints — would corrupt a futures pipeline).
- OpenTerminal's `server/src/cache.ts` (its `cached()` waits for a new fetch and only returns stale on failure; lacks in-flight coalescing). We always stamp `generatedAt` and show a visible `STALE` banner instead.
- Browser-side indicator computations. The chart visualizes candles + volume only.
- 1-second REST polling for live prices. We poll `MarketDataService.snapshot` every 5 s for the chart and every 1 s for the status bar; live updates flow over WebSocket (`/ws/state`).
- OpenTerminal's optional AI assistant widget. The agent's existing LLM/council architecture is the trading-specific reasoning layer; a dashboard assistant must never bypass risk checks or place orders. Deferred.
- OpenTerminal's portfolio accounting ledger. The agent's position manager, paper engine, remote broker, and live book already reconcile fills, fees, funding, realized P&L, margin, and exchange positions.

## Roadmap (subsequent PRs)

This is the audit's **first milestone**. The remaining milestones from the audit's implementation plan are tracked separately:

1. **In-process embedding.** Run the dashboard server inside the orchestrator process so `GET /api/state` returns the orchestrator's last emitted `AppState` directly, and `WS /ws/state` forwards `orchestrator.on('state' | 'log' | 'sync')` events to clients.
2. **Full position/risk/research panels.** Mark-price-synced uP&L, backtest-vs-paper comparison, out-of-sample comparison, refusal-reason drill-down that opens the full `DecisionRecord`.
3. **Research interface.** Visualize backtests, parameter sweeps, paper-trading evidence, out-of-sample comparisons. Surface `BootstrapSummary` CIs and `ConditionalEdge` matrices so operators can investigate whether any strategy has a validated edge (none does as of 2026-09-30, per the research log).
4. **Draggable / resizable workspace.** Adopt OpenTerminal's `Workspace.tsx` layout primitives (saved layouts, linked symbols, keyboard shortcuts, command palette).
5. **Contract and safety tests.** Cypress or Playwright tests that verify: (a) no `/api/orders/*` endpoint exists; (b) stale data is visibly marked on every market panel; (c) missing values are never converted to neutral signals; (d) the UI cannot bypass order and risk gates.

## How to run

```bash
cd apps/dashboard
npm install
npm run dev:server   # port 4101 — read-only HTTP + WS
npm run dev:web      # port 5173 — Vite dev server, proxies /api → 4101
# open http://localhost:5173
```

For production:

```bash
npm run build   # builds web (dist-web/) + server (dist-server/)
npm start       # serves the built frontend through Express on port 4101
```

Configuration (all optional): `CTA_DATA_DIR` (default `<repo>/data`), `CTA_DASHBOARD_PORT` (default `4101`), `CTA_SYMBOLS` (default `BTCUSDT,ETHUSDT,SOLUSDT`).

## Strategic priority

Per the audit's final verdict:

> The strategic priority remains unchanged: your research log reports that no strategy had a validated trading edge as of September 30, 2026. A better dashboard will make the evidence easier to investigate, but it will not itself create an edge. The research and live-readiness gates must remain authoritative.

This PR adds operator visibility without weakening any of those gates.

---

**Reference**: [ErTasselli/OpenTerminal](https://github.com/ErTasselli/OpenTerminal) · MIT License. Patterns borrowed from `ChartWidget.tsx`, `CryptoWidget.tsx`, `Workspace.tsx`, `terminal.ts`. Their copyright and license notice are retained in the corresponding source files under `apps/dashboard/`.
