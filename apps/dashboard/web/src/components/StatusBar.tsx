/**
 * StatusBar — single-line operational pulse at the bottom (well, top of the
 * workspace) showing: data freshness, kill-switch state, API weight,
 * WS status, last refresh time.
 */

import { useDashboardStore } from "../store.js";

export default function StatusBar() {
  const ws = useDashboardStore((s) => s.ws);
  const lastUpdate = useDashboardStore((s) => s.lastUpdate);
  const risk = useDashboardStore((s) => s.risk);
  const error = useDashboardStore((s) => s.error);
  const health = useDashboardStore((s) => s.health);

  const stale = lastUpdate > 0 && Date.now() - lastUpdate > 5000;
  const ks = risk?.killSwitch;
  const apiWeight = ws.apiWeight;
  const venue = ws.venue as { state?: string; accountId?: string } | null;

  return (
    <div className="status-bar">
      <span className={stale ? "pulse stale" : "pulse"} style={{ background: stale ? "var(--warn)" : undefined }} />
      {stale ? (
        <span className="stale">STALE — last refresh {formatRelative(lastUpdate)}</span>
      ) : lastUpdate > 0 ? (
        <span>updated {formatRelative(lastUpdate)}</span>
      ) : (
        <span className="text-dim"><span className="loading-spinner" />initializing…</span>
      )}
      <span className="text-dim">|</span>
      {ks ? (
        <span className={ks.halted ? "err" : ""}>
          kill-switch {ks.halted ? "HALTED" : "live"}
          {ks.halted && ks.reason ? ` · ${ks.reason}` : ""}
        </span>
      ) : (
        <span className="text-dim">kill-switch —</span>
      )}
      <span className="text-dim">|</span>
      <span>circuit {risk?.circuit ?? "—"}</span>
      <span className="text-dim">|</span>
      <span>api weight {apiWeight ?? "—"}</span>
      <span className="text-dim">|</span>
      <span>venue {venue?.state ?? "—"}</span>
      <span className="text-dim">|</span>
      <span>data {health?.dataDir?.split("/").pop() ?? "—"}</span>
      <span className="spacer" style={{ flex: 1 }} />
      {error && <span className="err">{error}</span>}
    </div>
  );
}

function formatRelative(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}
