/**
 * RiskPanel — kill-switch state, circuit breaker, peak equity, daily loss,
 * loss streak, win streak, profit factor, expectancy, risk limits, and
 * the live-readiness check list (EVIDENCE / FORWARD / RISK / OPS).
 *
 * The audit calls out that the dashboard should show refusal reasons
 * rather than just a buy/sell label — so the live-readiness checks are
 * rendered with their `detail` text, and FAILs are visually marked.
 */

import { useDashboardStore } from "../store.js";

export default function RiskPanel({ className }: { className: string }) {
  const risk = useDashboardStore((s) => s.risk);
  const liveReadiness = useDashboardStore((s) => s.liveReadiness);
  const refusals = useDashboardStore((s) => s.decisionRefusals);
  const positions = useDashboardStore((s) => s.positions);

  const ks = risk?.killSwitch;
  const perf = (risk?.performance ?? {}) as Record<string, number | undefined>;

  const unprotectedCount = positions.filter((p) => p.serverSl == null).length;

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        Risk &amp; Readiness
        <span className="spacer" />
        {liveReadiness && (
          <span
            className={`text-mono ${liveReadiness.ready ? "text-up" : "text-dn"}`}
            style={{ textTransform: "none", letterSpacing: 0, fontSize: 10 }}
          >
            {liveReadiness.ready ? "READY" : `${liveReadiness.blockers?.length ?? 0} blockers`}
          </span>
        )}
      </div>
      <div className="panel-body">
        {/* Kill-switch card */}
        <div className={`kill-switch-card ${ks?.halted ? "halted" : "live"}`}>
          <div className="label">Kill-switch</div>
          {ks?.halted ? (
            <div>HALTED — {ks.reason || "manual"}</div>
          ) : (
            <div>LIVE — operator can halt via CLI</div>
          )}
          {ks?.at ? (
            <div className="text-dim" style={{ fontSize: 10 }}>
              last change: {new Date(ks.at).toLocaleString()}
            </div>
          ) : null}
        </div>

        {/* Circuit + performance */}
        <div className="kv-list" style={{ marginBottom: 12 }}>
          <span className="k">circuit</span>
          <span className="v">{risk?.circuit ?? "—"}</span>
          <span className="k">peak equity</span>
          <span className="v">{risk?.peak != null ? `$${risk.peak.toFixed(2)}` : "—"}</span>
          <span className="k">peak reset at</span>
          <span className="v">
            {risk?.peakResetAt ? new Date(risk.peakResetAt).toLocaleDateString() : "—"}
          </span>
          <span className="k">daily loss %</span>
          <span className="v">{fmtPct(perf.dailyLossPercent)}</span>
          <span className="k">drawdown %</span>
          <span className="v">{fmtPct(perf.drawdownPercent)}</span>
          <span className="k">loss streak</span>
          <span className="v">{perf.lossStreak ?? "—"}</span>
          <span className="k">win streak</span>
          <span className="v">{perf.winStreak ?? "—"}</span>
          <span className="k">profit factor</span>
          <span className="v">{fmtNum(perf.profitFactor, 2)}</span>
          <span className="k">expectancy</span>
          <span className="v">{fmtNum(perf.expectancy, 4)}</span>
          <span className="k">unprotected</span>
          <span className={`v ${unprotectedCount > 0 ? "text-dn" : ""}`}>{unprotectedCount}</span>
        </div>

        {/* Refusal summary (top 6 reasons) */}
        {refusals && refusals.total > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div className="text-dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
              Refusals ({refusals.total} total)
            </div>
            <div className="kv-list">
              {Object.entries(refusals.counts)
                .filter(([, c]) => c > 0)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([reason, c]) => (
                  <span key={reason} className="k" style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "1fr auto" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{reason}</span>
                    <span className="v">{c}</span>
                  </span>
                ))}
            </div>
          </div>
        )}

        {/* Live readiness checks */}
        {liveReadiness && (
          <div>
            <div className="text-dim" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
              Live readiness checks
            </div>
            {liveReadiness.checks.length === 0 && <div className="empty">No checks computed.</div>}
            {liveReadiness.checks.map((c, i) => (
              <div key={`${c.id}-${i}`} className="readiness-check">
                <span className={`marker ${c.status}`}>{markerFor(c.status)}</span>
                <span>
                  <span className="area">{c.area}</span> · {c.id}
                  <br />
                  <span className="text-muted">{c.detail}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function fmtPct(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtNum(v: number | undefined | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function markerFor(status: string): string {
  switch (status) {
    case "PASS":
      return "✓";
    case "FAIL":
      return "✗";
    case "WARN":
      return "!";
    case "INFO":
      return "i";
    default:
      return "·";
  }
}
