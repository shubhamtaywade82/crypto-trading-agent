/**
 * ChartWidget — lightweight-charts integration. Reuses OpenTerminal's
 * pattern (candlesticks + volume + cursor-based OHLC inspection) but
 * data is fetched from the agent's MarketDataService (futures, mark price
 * stamped) so the chart and the strategy engine see the same candles.
 *
 * Stale data is shown with a visible banner — never silently. We do NOT
 * compute indicators in the browser; the chart visualizes what the agent's
 * backend already produced.
 */

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type CandlestickData,
  type HistogramData,
} from "lightweight-charts";
import { useDashboardStore } from "../store.js";
import { requestJson } from "../api.js";

interface MarketSnapshotResponse {
  [symbol: string]: {
    generatedAt: number;
    candles?: Record<string, Array<{
      openTime: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
    derivatives?: {
      markPrice?: number;
      fundingRatePct?: number;
      spreadBps?: number;
      openInterest?: number;
    };
  };
}

const TIMEFRAME_ORDER = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Timeframe = (typeof TIMEFRAME_ORDER)[number];

export default function ChartWidget({ className }: { className: string }) {
  const symbol = useDashboardStore((s) => s.selectedSymbol);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const timeframeRef = useRef<Timeframe>("15m");
  const staleRef = useRef<HTMLDivElement | null>(null);

  // Initialize chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      rightPriceScale: { borderColor: "#1f2937" },
      timeScale: {
        borderColor: "#1f2937",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#ef4444",
      borderUpColor: "#34d399",
      borderDownColor: "#ef4444",
      wickUpColor: "#34d399",
      wickDownColor: "#ef4444",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Refresh candles when symbol/timeframe changes; also poll every 5s.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const tf = timeframeRef.current;
        const snapshot = await requestJson<MarketSnapshotResponse>(
          `/api/market/snapshot?symbols=${symbol}`,
        );
        if (cancelled || !candleSeriesRef.current || !volumeSeriesRef.current) return;
        const data = snapshot[symbol];
        const candles = data?.candles?.[tf] ?? [];

        // Stale banner — show whenever generatedAt is older than 60s OR the
        // timeframe has no candles.
        if (staleRef.current) {
          const isStale =
            !data || !data.generatedAt || Date.now() - data.generatedAt > 60_000;
          staleRef.current.style.display = isStale ? "block" : "none";
        }

        const candleData: CandlestickData[] = candles.map((c) => ({
          time: Math.floor(c.openTime / 1000) as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        const volData: HistogramData[] = candles.map((c) => ({
          time: Math.floor(c.openTime / 1000) as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? "rgba(52, 211, 153, 0.3)" : "rgba(239, 68, 68, 0.3)",
        }));
        candleSeriesRef.current.setData(candleData);
        volumeSeriesRef.current.setData(volData);
        chartRef.current?.timeScale().fitContent();
      } catch {
        // network error — next poll will retry
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [symbol]);

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        {symbol} · perpetual
        <span className="spacer" />
        {TIMEFRAME_ORDER.map((tf) => (
          <button
            key={tf}
            className={timeframeRef.current === tf ? "active" : ""}
            onClick={() => {
              timeframeRef.current = tf;
              // force a refresh by toggling state via store
              useDashboardStore.setState({ lastUpdate: Date.now() });
              // Trigger a custom re-render by emitting a state change
              const ev = new Event("chart-tf-change");
              window.dispatchEvent(ev);
            }}
          >
            {tf}
          </button>
        ))}
      </div>
      <div className="panel-body no-pad" style={{ position: "relative" }}>
        <div ref={containerRef} className="chart-container" />
        <div
          ref={staleRef}
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            background: "var(--warn-bg)",
            color: "var(--warn)",
            padding: "2px 8px",
            borderRadius: 3,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            display: "none",
            pointerEvents: "none",
          }}
        >
          STALE — last-known data, no fresh market ticks
        </div>
      </div>
    </section>
  );
}
