/**
 * PositionsPanel — displays live tactical exposures as mission deployments
 * with stop-loss protection shields, leverage, and liquidation safety distance.
 * Completely replaces tabular spreadsheets with modern deployment cards.
 */

import { useDashboardStore, type PositionRow } from "../store.js";

export default function PositionsPanel({ className }: { className: string }) {
  const positions = useDashboardStore((s) => s.positions);
  const account = useDashboardStore((s) => s.account);

  const equity = account?.equity ?? 0;
  const marginUsed = account?.marginUsed ?? 0;
  const freeMargin = Math.max(0, equity - marginUsed);
  const marginPct = equity > 0 ? (marginUsed / equity) * 100 : 0;
  const totalUpnl = positions.reduce((sum, p) => sum + (p.upnl ?? 0), 0);

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <span>Tactical Deployments</span>
        <span className="spacer" />
        <span className={`badge-pnl ${totalUpnl >= 0 ? "up" : "dn"}`}>
          {totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)} uPnL
        </span>
      </div>

      <div className="panel-body no-pad">
        <div className="portfolio-hud-strip">
          <div className="hud-metric">
            <span className="hud-label">Equity</span>
            <span className="hud-value">${equity.toFixed(2)}</span>
          </div>
          <div className="hud-metric">
            <span className="hud-label">Margin Utilized</span>
            <span className="hud-value">${marginUsed.toFixed(2)} ({marginPct.toFixed(1)}%)</span>
          </div>
          <div className="hud-metric">
            <span className="hud-label">Available Reserve</span>
            <span className="hud-value">${freeMargin.toFixed(2)}</span>
          </div>
        </div>

        <div className="deployments-container">
          {positions.length > 0 ? (
            positions.map((p, idx) => (
              <DeploymentCard key={p.symbol + idx} pos={p} />
            ))
          ) : (
            <IdleDeploymentsState freeMargin={freeMargin} />
          )}
        </div>
      </div>
    </section>
  );
}

function DeploymentCard({ pos }: { pos: PositionRow }) {
  const isLong = pos.side.toUpperCase() === "LONG" || pos.side.toUpperCase() === "BUY";
  const upnl = pos.upnl ?? 0;
  const upnlPct = pos.upnlPct ?? 0;
  const isProtected = pos.serverSl != null;

  return (
    <div className={`deployment-card ${isLong ? "long-pos" : "short-pos"}`}>
      <div className="deployment-top">
        <span className="deployment-sym">{pos.symbol}</span>
        {pos.leverage && <span className="deployment-lev">{pos.leverage}x</span>}
        <span className={`deployment-side-tag ${isLong ? "up" : "dn"}`}>
          {pos.side.toUpperCase()}
        </span>
        <span className="spacer" />
        <span className="deployment-strat">{pos.strategy || "DISPATCH"}</span>
      </div>

      <div className="deployment-hero">
        <div className="deployment-pnl-block">
          <div className={`pnl-hero-val ${upnl >= 0 ? "text-up" : "text-dn"}`}>
            {upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}
          </div>
          <div className={`pnl-hero-pct ${upnlPct >= 0 ? "text-up" : "text-dn"}`}>
            {upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%
          </div>
        </div>

        <div className="deployment-px-tracker">
          <div className="px-row">
            <span className="px-k">Entry</span>
            <span className="px-v">${pos.entry.toFixed(2)}</span>
          </div>
          <div className="px-row">
            <span className="px-k">Mark</span>
            <span className="px-v font-bold">${pos.mark?.toFixed(2) ?? "—"}</span>
          </div>
        </div>
      </div>

      <div className="deployment-footer">
        {isProtected ? (
          <div className="shield-badge armed" title="Exchange-side stop loss active">
            <span className="shield-icon">🛡️</span>
            <span>Stop-Loss Armed: ${pos.serverSl?.toFixed(2)}</span>
          </div>
        ) : (
          <div className="shield-badge danger" title="No stop loss registered on exchange!">
            <span className="shield-icon">⚠️</span>
            <span>UNPROTECTED EXPOSURE</span>
          </div>
        )}
        <span className="spacer" />
        {pos.liqDistancePct != null && (
          <span className="liq-buffer-text">
            Liq Buffer: <strong>{pos.liqDistancePct.toFixed(1)}%</strong>
          </span>
        )}
      </div>
    </div>
  );
}

function IdleDeploymentsState({ freeMargin }: { freeMargin: number }) {
  return (
    <div className="idle-deployments-box">
      <div className="idle-shield-orb">🛡️</div>
      <div className="idle-title">Autonomous Observation Mode</div>
      <div className="idle-desc">
        100% of capital (${freeMargin.toFixed(2)}) safely preserved in cash treasury.
      </div>
      <div className="idle-subtext">
        Strategy council is scanning multi-timeframe candle closes for high-conviction entries.
      </div>
    </div>
  );
}
