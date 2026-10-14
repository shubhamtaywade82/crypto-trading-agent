/**
 * App — dashboard root. Polls the read-only HTTP API on the same cadence
 * as the Ink TUI's tick flush (1s) and streams WebSocket ticks for the
 * status bar. Layout is a fixed 3-column workspace inspired by
 * OpenTerminal's Workspace.tsx, but simplified to a deterministic grid
 * for the first milestone (drag/resize + saved layouts are a future
 * iteration).
 */

import { useEffect, useRef } from "react";
import { useDashboardStore } from "./store.js";
import { requestJson, startWebSocket } from "./api.js";
import StatusBar from "./components/StatusBar.js";
import ChartWidget from "./components/ChartWidget.js";
import MarketPanel from "./components/MarketPanel.js";
import DecisionJournalPanel from "./components/DecisionJournalPanel.js";
import RiskPanel from "./components/RiskPanel.js";

const POLL_MS = 1000;

export default function App() {
  const setHealth = useDashboardStore((s) => s.setHealth);
  const setError = useDashboardStore((s) => s.setError);
  const symbols = useDashboardStore((s) => s.health?.symbols ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

  // Start WebSocket once.
  const wsStarted = useRef(false);
  useEffect(() => {
    if (wsStarted.current) return;
    wsStarted.current = true;
    return startWebSocket();
  }, []);

  // Health probe — only once at mount.
  useEffect(() => {
    requestJson("/api/health")
      .then((h) => setHealth(h as never))
      .catch((e) => setError(String(e)));
  }, [setHealth, setError]);

  // Polling loop — refresh every panel's data.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        await Promise.allSettled([
          refreshState(),
          refreshMarket(symbols),
          refreshRisk(),
          refreshDecisions(),
          refreshPositions(),
          refreshResearch(),
          refreshLiveReadiness(),
        ]);
        if (!cancelled) {
          useDashboardStore.getState().setLastUpdate(Date.now());
          useDashboardStore.getState().setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [symbols, setError]);

  return (
    <div className="app">
      <Header />
      <StatusBar />
      <div className="workspace">
        <MarketPanel className="panel-market" />
        <ChartWidget className="panel-chart" />
        <DecisionJournalPanel className="panel-decisions" />
        <RiskPanel className="panel-risk" />
      </div>
    </div>
  );
}

function Header() {
  const health = useDashboardStore((s) => s.health);
  const ws = useDashboardStore((s) => s.ws);
  const mode = health?.mode ?? "unknown";
  const symbols = health?.symbols ?? [];
  const connected = ws.connected;
  return (
    <div className="app-header">
      <h1>cta · cockpit</h1>
      <span className="badge read-only" title="This dashboard is read-only. No orders can be placed from the UI.">
        READ-ONLY
      </span>
      <span className="badge mode" title="Agent mode (paper/live)">{mode.toUpperCase()}</span>
      {symbols.length > 0 && (
        <span className="badge" title="Configured symbols">{symbols.join(" · ")}</span>
      )}
      <span className="spacer" />
      <span className={`ws-state ${connected ? "connected" : "disconnected"}`}>
        <span className="dot" />
        {connected ? "ws live" : "ws offline"}
        {ws.lastAt ? ` · ${new Date(ws.lastAt).toLocaleTimeString()}` : ""}
      </span>
    </div>
  );
}

async function refreshState() {
  try {
    const state = await requestJson<Record<string, unknown>>("/api/state");
    const account = (state.account as never) ?? null;
    useDashboardStore.getState().setAccount(account);
  } catch {
    // non-fatal; other panels still refresh
  }
}

async function refreshMarket(symbols: string[]) {
  if (symbols.length === 0) return;
  try {
    const sym = symbols.join(",");
    const [snapshot, safetyRes] = await Promise.all([
      requestJson<Record<string, any>>(`/api/market/snapshot?symbols=${sym}`),
      requestJson<Record<string, any>>(`/api/market/safety?symbols=${sym}`),
    ]);
    for (const s of symbols) {
      const data = snapshot[s];
      const safety = safetyRes[s];
      const candles1m = data?.candles?.["1m"] ?? data?.candles?.["1h"] ?? [];
      const last = candles1m.at(-1)?.close ?? null;
      const first = candles1m[0]?.open ?? last;
      const changePct = last && first ? ((last - first) / first) * 100 : null;
      const spark = candles1m.slice(-30).map((c: any) => c.close);
      useDashboardStore.getState().setSymbolState(s, {
        symbol: s,
        lastPrice: last,
        changePct,
        sparkline: spark,
        fundingPct: data?.derivatives?.fundingRatePct ?? null,
        spreadBps: data?.derivatives?.spreadBps ?? null,
        safetyLevel: safety?.level ?? null,
        safetyReasons: safety?.reasons ?? [],
        stale: !data || !data.generatedAt || Date.now() - data.generatedAt > 60_000,
      });
    }
    useDashboardStore.getState().setMarketState(snapshot);
  } catch {
    // non-fatal
  }
}

async function refreshRisk() {
  try {
    const risk = await requestJson<any>("/api/risk/snapshot");
    useDashboardStore.getState().setRisk(risk);
  } catch {
    // non-fatal
  }
}

async function refreshDecisions() {
  try {
    const [decisions, refusals] = await Promise.all([
      requestJson<any[]>("/api/decisions?limit=50"),
      requestJson<{ total: number; counts: Record<string, number> }>(
        "/api/decisions/refusals/summary",
      ),
    ]);
    useDashboardStore.getState().setDecisions(decisions);
    useDashboardStore.getState().setDecisionRefusals(refusals);
  } catch {
    // non-fatal
  }
}

async function refreshPositions() {
  try {
    const positions = await requestJson<any[]>("/api/positions");
    useDashboardStore.getState().setPositions(positions);
  } catch {
    // non-fatal — the venue may not be initialised in standalone mode
    useDashboardStore.getState().setPositions([]);
  }
}

async function refreshResearch() {
  try {
    const data = await requestJson<any>("/api/research/dashboard");
    useDashboardStore.getState().setResearch({
      champion: data?.championState?.champions?.[0],
      challengers: data?.championState?.challengers,
      experiments: data?.experiments?.slice(-20),
      metrics: data?.metrics,
    });
  } catch {
    // non-fatal — research files may not exist yet
  }
}

async function refreshLiveReadiness() {
  try {
    const lr = await requestJson<any>("/api/live-readiness");
    useDashboardStore.getState().setLiveReadiness(lr);
  } catch {
    // non-fatal
  }
}
