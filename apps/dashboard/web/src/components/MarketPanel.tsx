/**
 * MarketPanel — deep observability into Binance USD-M futures state:
 * multi-timeframe regime, market structure (BOS/CHOCH), liquidity sweeps,
 * volatility phase, derivatives funding rate, and safety verdicts.
 */

import { useDashboardStore } from "../store.js";

export default function MarketPanel({ className }: { className: string }) {
  const symbols = useDashboardStore((s) => s.symbols);
  const symbolsState = useDashboardStore((s) => s.symbolsState);
  const selectedSymbol = useDashboardStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useDashboardStore((s) => s.setSelectedSymbol);
  const marketState = useDashboardStore((s) => s.marketState) as Record<string, any> | null;

  const current = symbolsState[selectedSymbol];
  const intel = marketState?.[selectedSymbol];
  const isStale = current?.stale ?? true;
  const chg = current?.changePct;

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        Market Intelligence
        <span className="spacer" />
        <span className="text-dim" style={{ textTransform: "none", letterSpacing: 0, fontSize: 10 }}>
          USD-M perpetual · {selectedSymbol}
        </span>
      </div>
      <div className="panel-body">
        {/* Symbol Selector Bar */}
        <div className="symbol-chips">
          {symbols.map((sym) => {
            const s = symbolsState[sym];
            const symChg = s?.changePct;
            return (
              <button
                key={sym}
                className={`symbol-chip ${selectedSymbol === sym ? "active" : ""}`}
                onClick={() => setSelectedSymbol(sym)}
              >
                <span className="chip-name">{sym.replace("USDT", "")}</span>
                <span className={`chip-chg ${symChg && symChg >= 0 ? "up" : "dn"}`}>
                  {symChg != null ? `${symChg >= 0 ? "+" : ""}${symChg.toFixed(1)}%` : "—"}
                </span>
              </button>
            );
          })}
        </div>

        {/* Selected Symbol Header */}
        <div className="symbol-hero">
          <div>
            <div className="hero-price">
              {current?.lastPrice ? `$${current.lastPrice.toFixed(2)}` : "—"}
            </div>
            <div className={`hero-chg ${chg && chg >= 0 ? "text-up" : "text-dn"}`}>
              {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "—"} 24h
              {isStale && <span className="stale-tag">STALE</span>}
            </div>
          </div>
          <span className="spacer" />
          {current?.safetyLevel && (
            <span className={`safety-badge ${current.safetyLevel}`}>
              {current.safetyLevel}
            </span>
          )}
        </div>

        {/* Intelligence Grid */}
        <IntelMetrics intel={intel} current={current} />

        {/* Safety Warnings if any */}
        {current?.safetyReasons && current.safetyReasons.length > 0 && (
          <div className="safety-warning-box">
            <div className="warning-title">Safety Verdict Reasons:</div>
            {current.safetyReasons.map((r, i) => (
              <div key={i} className="warning-item">• {typeof r === "string" ? r : JSON.stringify(r)}</div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function IntelMetrics({ intel, current }: { intel?: any; current?: any }) {
  const rawReg = intel?.regime;
  const regime =
    (typeof rawReg === "string" ? rawReg : null) ??
    rawReg?.current ??
    rawReg?.regime ??
    "—";

  const rawVol = intel?.volatilityPhase ?? rawReg?.volatility ?? intel?.volatility;
  const phase = (typeof rawVol === "string" ? rawVol : null) ?? "—";

  const rawTrend =
    intel?.htfStructure?.trend ??
    intel?.structure?.trend ??
    rawReg?.trendDirection ??
    intel?.trend;
  const trend = (typeof rawTrend === "string" ? rawTrend : null) ?? "—";

  const isPremium = intel?.pricing?.premium ?? intel?.rangePricing?.premium;
  const isDiscount = intel?.pricing?.discount ?? intel?.rangePricing?.discount;
  const location = isPremium ? "PREMIUM" : isDiscount ? "DISCOUNT" : "EQUILIBRIUM";
  const funding = current?.fundingPct != null ? `${(current.fundingPct * 100).toFixed(4)}%` : "—";
  const spread = current?.spreadBps != null ? `${current.spreadBps.toFixed(1)} bps` : "—";

  return (
    <div className="intel-grid">
      <div className="intel-card">
        <span className="k">Regime</span>
        <span className="v font-bold">{regime}</span>
      </div>
      <div className="intel-card">
        <span className="k">Volatility</span>
        <span className={`v ${phase === "EXPANDING" || phase === "HIGH" ? "text-warn" : ""}`}>{phase}</span>
      </div>
      <div className="intel-card">
        <span className="k">Structure</span>
        <span className={`v ${trend === "BULLISH" ? "text-up" : trend === "BEARISH" ? "text-dn" : ""}`}>
          {trend}
        </span>
      </div>
      <div className="intel-card">
        <span className="k">Range Pricing</span>
        <span className="v">{location}</span>
      </div>
      <div className="intel-card">
        <span className="k">Funding / 8h</span>
        <span className="v">{funding}</span>
      </div>
      <div className="intel-card">
        <span className="k">Spread</span>
        <span className="v">{spread}</span>
      </div>
    </div>
  );
}
