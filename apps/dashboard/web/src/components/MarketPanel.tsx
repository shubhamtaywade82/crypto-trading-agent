/**
 * MarketPanel — left-column symbol list with last price, change %, safety
 * verdict, and stale flag. Clicking a symbol selects it for the chart.
 *
 * Inspired by OpenTerminal's CryptoWidget.tsx, but the data is sourced from
 * the agent's MarketDataService (futures, not spot) and marked with the
 * MarketSafety verdict.
 */

import { useDashboardStore } from "../store.js";

export default function MarketPanel({ className }: { className: string }) {
  const symbols = useDashboardStore((s) => s.health?.symbols ?? ["BTCUSDT"]);
  const symbolsState = useDashboardStore((s) => s.symbolsState);
  const selectedSymbol = useDashboardStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useDashboardStore((s) => s.setSelectedSymbol);

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        Market · USD-M futures
        <span className="spacer" />
        <span className="text-dim" style={{ textTransform: "none", letterSpacing: 0, fontSize: 10 }}>
          futures · ws-fed
        </span>
      </div>
      <div className="panel-body no-pad">
        <div className="symbol-list">
          {symbols.map((sym) => {
            const s = symbolsState[sym];
            const isStale = s?.stale ?? true;
            const chg = s?.changePct;
            return (
              <div
                key={sym}
                className={`symbol-row ${selectedSymbol === sym ? "active" : ""} ${isStale ? "stale" : ""}`}
                onClick={() => setSelectedSymbol(sym)}
              >
                <span className="sym">{sym}</span>
                <span className="px">{s?.lastPrice ? s.lastPrice.toFixed(2) : "—"}</span>
                <span className={`chg ${chg && chg >= 0 ? "up" : "dn"}`}>
                  {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "—"}
                </span>
                {s?.safetyLevel && (
                  <span className={`safety ${s.safetyLevel}`}>{s.safetyLevel}</span>
                )}
              </div>
            );
          })}
          {symbols.length === 0 && <div className="empty">No symbols configured.</div>}
        </div>
      </div>
    </section>
  );
}
