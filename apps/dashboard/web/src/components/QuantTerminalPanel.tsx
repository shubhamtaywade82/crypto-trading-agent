/**
 * QuantTerminalPanel — Unified QuantLab workbench: multi-estimator volatility,
 * returns analytics, cross-asset correlation matrix, and Monte Carlo GBM projection.
 */

import { useDashboardStore } from "../store.js";

export default function QuantTerminalPanel({ className }: { className: string }) {
  const quant = useDashboardStore((s) => s.quantTerminal);
  const selectedSymbol = useDashboardStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useDashboardStore((s) => s.setSelectedSymbol);

  if (!quant) {
    return (
      <section className={`panel ${className}`}>
        <div className="panel-header">QuantLab Market Terminal</div>
        <div className="panel-body"><div className="empty">Loading quantitative analytics...</div></div>
      </section>
    );
  }

  const activeSymbol = quant.analytics[selectedSymbol] ? selectedSymbol : quant.primarySymbol;
  const metrics = quant.analytics[activeSymbol];

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        QuantLab · Quantitative Workbench
        <span className="spacer" />
        <span className="text-dim" style={{ textTransform: "none", fontSize: 10 }}>
          GBM Simulator · Multi-Vol · Correlation
        </span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SymbolSelector
          symbols={quant.symbols}
          selected={activeSymbol}
          onSelect={setSelectedSymbol}
        />
        {metrics && <MetricsSummary metrics={metrics} />}
        {quant.correlation && <CorrelationHeatmap correlation={quant.correlation} />}
        {quant.simulation && <MonteCarloView simulation={quant.simulation} symbol={activeSymbol} />}
      </div>
    </section>
  );
}

function SymbolSelector({
  symbols,
  selected,
  onSelect,
}: {
  symbols: string[];
  selected: string;
  onSelect: (s: string) => void;
}) {
  return (
    <div className="symbol-chips">
      {symbols.map((sym) => (
        <button
          key={sym}
          className={`symbol-chip ${selected === sym ? "active" : ""}`}
          onClick={() => onSelect(sym)}
        >
          <span className="chip-name">{sym.replace("USDT", "")}</span>
        </button>
      ))}
    </div>
  );
}

function MetricsSummary({ metrics }: { metrics: any }) {
  const r = metrics.returns;
  return (
    <div className="intel-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
      <div className="intel-card">
        <div className="k">Parkinson Vol</div>
        <div className="v font-bold text-accent">{(r.volatilityParkinson * 100).toFixed(1)}%</div>
      </div>
      <div className="intel-card">
        <div className="k">Yang-Zhang Vol</div>
        <div className="v font-bold text-accent-cyan">{(r.volatilityYangZhang * 100).toFixed(1)}%</div>
      </div>
      <div className="intel-card">
        <div className="k">Sharpe Ratio</div>
        <div className={`v font-bold ${r.sharpe >= 0 ? "text-up" : "text-dn"}`}>
          {r.sharpe.toFixed(2)}
        </div>
      </div>
      <div className="intel-card">
        <div className="k">Sortino Ratio</div>
        <div className={`v font-bold ${r.sortino >= 0 ? "text-up" : "text-dn"}`}>
          {r.sortino.toFixed(2)}
        </div>
      </div>
    </div>
  );
}

function CorrelationHeatmap({
  correlation,
}: {
  correlation: { symbols: string[]; matrix: number[][] };
}) {
  return (
    <div>
      <div className="text-dim" style={{ fontSize: 11, marginBottom: 4, fontWeight: 700 }}>
        Cross-Asset Pearson Correlation Heatmap
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `45px repeat(${correlation.symbols.length}, 1fr)`, gap: 2 }}>
        <div />
        {correlation.symbols.map((s) => (
          <div key={s} className="text-dim" style={{ fontSize: 9, textAlign: "center" }}>
            {s.replace("USDT", "")}
          </div>
        ))}
        {correlation.symbols.map((rowSym, i) => (
          <div key={rowSym} style={{ display: "contents" }}>
            <div className="text-dim" style={{ fontSize: 9, alignSelf: "center" }}>
              {rowSym.replace("USDT", "")}
            </div>
            {correlation.matrix[i].map((val, j) => {
              const bg = val > 0 ? `rgba(16, 185, 129, ${Math.abs(val) * 0.7})` : `rgba(239, 68, 68, ${Math.abs(val) * 0.7})`;
              return (
                <div
                  key={j}
                  style={{
                    background: bg,
                    padding: "3px 0",
                    fontSize: 10,
                    textAlign: "center",
                    fontFamily: "var(--font-mono)",
                    borderRadius: 2,
                  }}
                >
                  {val.toFixed(2)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonteCarloView({ simulation, symbol }: { simulation: any; symbol: string }) {
  const stats = simulation.terminalStats;
  const q = simulation.quantiles;
  const steps = q.p50.length - 1;
  const p05End = q.p05[steps];
  const p50End = q.p50[steps];
  const p95End = q.p95[steps];

  return (
    <div>
      <div className="text-dim" style={{ fontSize: 11, marginBottom: 4, fontWeight: 700 }}>
        30-Day Monte Carlo GBM Projection ({symbol.replace("USDT", "")})
      </div>
      <div className="intel-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="intel-card">
          <div className="k">P05 (Downside)</div>
          <div className="v text-dn font-bold">${p05End?.toFixed(1) ?? "—"}</div>
        </div>
        <div className="intel-card">
          <div className="k">P50 (Median)</div>
          <div className="v text-accent font-bold">${p50End?.toFixed(1) ?? "—"}</div>
        </div>
        <div className="intel-card">
          <div className="k">P95 (Upside)</div>
          <div className="v text-up font-bold">${p95End?.toFixed(1) ?? "—"}</div>
        </div>
      </div>
      <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
        Expected Price: ${stats.mean.toFixed(2)} · Prob of Loss: {(stats.probLoss * 100).toFixed(1)}%
      </div>
    </div>
  );
}
