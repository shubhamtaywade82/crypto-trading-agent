function ema(values, period) {
  const alpha = 2 / (period + 1);
  let value = values[0];
  const out = [value];
  for (let i = 1; i < values.length; i++) {
    value = values[i] * alpha + value * (1 - alpha);
    out.push(value);
  }
  return out;
}
function wilderAtr(bars, period = 14) {
  const tr = bars.map((b, i) => {
    const prev = i ? bars[i - 1].close : b.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  if (tr.length < period) return tr.map(() => null);
  const out = Array(tr.length).fill(null);
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = value;
  for (let i = period; i < tr.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}
function indicators(bars) {
  const closes = bars.map(b => b.close);
  const e20 = ema(closes, 20), e50 = ema(closes, 50), atr = wilderAtr(bars, 14);
  const contexts = bars.map((b, i) => {
    const slope = i >= 10 ? e50[i] / e50[i - 10] - 1 : null;
    return { ema20: e20[i], ema50: e50[i], atr14: atr[i], slope10: slope };
  });
  return contexts;
}
function classify(bars, ind, thresholds) {
  return bars.map((b, i) => {
    const x = ind[i];
    if (x.atr14 == null || x.slope10 == null) return "INSUFFICIENT_DATA";
    const trend = b.close > x.ema50 && x.slope10 > 0 ? "BULL" :
      b.close < x.ema50 && x.slope10 < 0 ? "BEAR" : "TRANSITION";
    const atrPct = x.atr14 / b.close;
    const vol = atrPct < thresholds.q33 ? "LOW" : atrPct > thresholds.q67 ? "HIGH" : "NORMAL";
    return trend + "_" + vol;
  });
}
function detectSignals(bars, ind, contexts) {
  const signals = Array(bars.length).fill(null);
  for (let i = 1; i < bars.length - 1; i++) {
    const b = bars[i], p = bars[i - 1], x = ind[i], px = ind[i - 1];
    if (contexts[i] === "BULL_LOW" &&
        b.low <= x.ema20 && b.close > x.ema20 &&
        p.close <= px.ema20 && x.atr14 != null) {
      signals[i] = { direction: 1, atr: x.atr14, context: contexts[i] };
    } else if (contexts[i] === "BEAR_LOW" &&
        b.high >= x.ema20 && b.close < x.ema20 &&
        p.close >= px.ema20 && x.atr14 != null) {
      signals[i] = { direction: -1, atr: x.atr14, context: contexts[i] };
    }
  }
  return signals;
}
function simulate(bars, signals, cfg, startIndex, endIndex) {
  const trades = [];
  let position = null, exposureBars = 0, censored = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    const b = bars[i];
    if (position) {
      const p = position;
      const held = i - p.entryIndex + 1;
      exposureBars++;
      let exitPrice = null, outcome = null;
      if (p.direction === 1) {
        if (b.open <= p.stop) { exitPrice = b.open; outcome = "STOP_GAP"; }
        else if (b.low <= p.stop && b.high >= p.target) { exitPrice = p.stop; outcome = "STOP_BOTH_TOUCHED"; }
        else if (b.low <= p.stop) { exitPrice = p.stop; outcome = "STOP"; }
        else if (b.high >= p.target) { exitPrice = p.target; outcome = "TARGET"; }
      } else {
        if (b.open >= p.stop) { exitPrice = b.open; outcome = "STOP_GAP"; }
        else if (b.high >= p.stop && b.low <= p.target) { exitPrice = p.stop; outcome = "STOP_BOTH_TOUCHED"; }
        else if (b.high >= p.stop) { exitPrice = p.stop; outcome = "STOP"; }
        else if (b.low <= p.target) { exitPrice = p.target; outcome = "TARGET"; }
      }
      if (exitPrice == null && held >= cfg.timeStopBars) {
        exitPrice = b.close; outcome = "TIME_STOP";
      }
      if (exitPrice != null) {
        const grossPct = p.direction * (exitPrice - p.entryPrice) / p.entryPrice;
        const netPct = grossPct - cfg.roundTripCostBps / 10000;
        const riskPct = p.riskDistance / p.entryPrice;
        const netR = netPct / riskPct;
        trades.push({
          signalTime: new Date(bars[p.signalIndex].openTime).toISOString(),
          entryTime: new Date(bars[p.entryIndex].openTime).toISOString(),
          exitTime: new Date(b.openTime).toISOString(),
          direction: p.direction === 1 ? "LONG" : "SHORT",
          context: p.context,
          entryPrice: p.entryPrice,
          stop: p.stop,
          target: p.target,
          exitPrice,
          outcome,
          heldBars: held,
          grossReturnPct: grossPct * 100,
          netReturnPct: netPct * 100,
          netR,
          netQuotePnl: cfg.notionalQuote * netPct
        });
        position = null;
        continue;
      }
      continue;
    }
    const s = signals[i];
    if (!s || i + 1 > endIndex) continue;
    const entryIndex = i + 1;
    const entryPrice = bars[entryIndex].open;
    const riskDistance = cfg.stopAtrMultiple * s.atr;
    const stop = entryPrice - s.direction * riskDistance;
    const target = entryPrice + s.direction * riskDistance * cfg.rewardRisk;
    position = { signalIndex: i, entryIndex, entryPrice, riskDistance, stop, target, direction: s.direction, context: s.context };
  }
  if (position) censored++;
  return { trades, exposureBars, censored };
}
function metrics(result, segmentBars, cfg) {
  const t = result.trades, n = t.length;
  const wins = t.filter(x => x.netQuotePnl > 0), losses = t.filter(x => x.netQuotePnl < 0);
  const sumWin = wins.reduce((s, x) => s + x.netQuotePnl, 0);
  const sumLoss = -losses.reduce((s, x) => s + x.netQuotePnl, 0);
  const rs = t.map(x => x.netR);
  const mean = n ? rs.reduce((a, b) => a + b, 0) / n : null;
  let equity = 0, peak = 0, maxDd = 0;
  for (const r of rs) { equity += r; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  const targetCount = t.filter(x => x.outcome === "TARGET").length;
  const avgWin = wins.length ? wins.reduce((s, x) => s + x.netR, 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((s, x) => s + x.netR, 0) / losses.length : null;
  return {
    eligibleContextBars: segmentBars.eligibleContextBars,
    trades: n,
    winRatePct: n ? wins.length / n * 100 : null,
    targetBeforeStopPct: n ? targetCount / n * 100 : null,
    expectancyNetR: mean,
    expectancyNetQuotePerTrade: n ? t.reduce((s, x) => s + x.netQuotePnl, 0) / n : null,
    totalNetQuotePnl: t.reduce((s, x) => s + x.netQuotePnl, 0),
    profitFactor: sumLoss ? sumWin / sumLoss : (sumWin > 0 ? null : 0),
    maxDrawdownR: maxDd,
    averageWinR: avgWin,
    averageLossR: avgLoss,
    exposurePct: segmentBars.totalBars ? result.exposureBars / segmentBars.totalBars * 100 : 0,
    turnoverQuote: n * cfg.notionalQuote * 2,
    censoredPositions: result.censored
  };
}
function blockBootstrapCI(values, seed = 741103, blockSize = 4, reps = 1000) {
  if (values.length < 8) return null;
  let state = seed >>> 0;
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const means = [];
  for (let r = 0; r < reps; r++) {
    const sample = [];
    while (sample.length < values.length) {
      const start = Math.floor(rand() * values.length);
      for (let j = 0; j < blockSize && sample.length < values.length; j++) sample.push(values[(start + j) % values.length]);
    }
    means.push(sample.reduce((a, b) => a + b, 0) / sample.length);
  }
  means.sort((a, b) => a - b);
  return { lower95: means[Math.floor(reps * 0.025)], upper95: means[Math.floor(reps * 0.975)], blockSize, reps, seed };
}
function runSegment(bars, thresholds, cfg, startMs, endMs, contextFilter) {
  const ind = indicators(bars), contexts = classify(bars, ind, thresholds), signals = detectSignals(bars, ind, contexts);
  const startIndex = bars.findIndex(b => b.openTime >= startMs);
  let endIndex = -1;
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].openTime <= endMs) { endIndex = i; break; }
  if (startIndex < 0 || endIndex <= startIndex) throw new Error("Invalid segment boundaries");
  const eligibleContextBars = contexts.slice(startIndex, endIndex + 1).filter(c => c === contextFilter).length;
  const filteredSignals = signals.map((s, i) => s && s.context === contextFilter ? s : null);
  const result = simulate(bars, filteredSignals, cfg, startIndex, endIndex);
  const m = metrics(result, { eligibleContextBars, totalBars: endIndex - startIndex + 1 }, cfg);
  m.blockBootstrapCI95 = blockBootstrapCI(result.trades.map(x => x.netR), cfg.seed, cfg.bootstrapBlockSize, cfg.bootstrapReps);
  m.segment = { startUtc: new Date(bars[startIndex].openTime).toISOString(), endUtc: new Date(bars[endIndex].closeTime).toISOString(), bars: endIndex - startIndex + 1 };
  m.buyHoldReturnPct = (bars[endIndex].close / bars[startIndex].open - 1) * 100;
  return m;
}
function runFixtureTests() {
  const cfg = { stopAtrMultiple: 1.5, rewardRisk: 2, timeStopBars: 3, roundTripCostBps: 0, notionalQuote: 10000, seed: 1, bootstrapBlockSize: 2, bootstrapReps: 50 };
  const bars = [
    {openTime:0,closeTime:1,open:100,high:101,low:99,close:100},
    {openTime:2,closeTime:3,open:100,high:101,low:99,close:100},
    {openTime:4,closeTime:5,open:100,high:107,low:98,close:103}
  ];
  const signals = [null,{direction:1,atr:2,context:"BULL_LOW"},null];
  const a = simulate(bars, signals, cfg, 0, 2);
  if (a.trades.length !== 1 || a.trades[0].entryPrice !== 100 || a.trades[0].outcome !== "TARGET" || a.trades[0].netR !== 2) throw new Error("fixture next-open/target test failed");
  const tieBars = [bars[0],bars[1],{...bars[2],high:107,low:96}];
  const b = simulate(tieBars, signals, cfg, 0, 2);
  if (b.trades.length !== 1 || b.trades[0].outcome !== "STOP_BOTH_TOUCHED" || b.trades[0].netR !== -1) throw new Error("fixture stop-first collision test failed");
  const changedFuture = [bars[0],bars[1],{...bars[2],high:200}];
  const c = simulate(changedFuture, signals, cfg, 0, 2);
  if (c.trades[0].entryPrice !== a.trades[0].entryPrice) throw new Error("fixture future perturbation changed entry");
  const d = simulate(bars, signals, cfg, 0, 2);
  if (JSON.stringify(a) !== JSON.stringify(d)) throw new Error("fixture determinism test failed");
  return {passed:4,tests:["next_bar_open_entry","stop_first_when_stop_and_target_touched","future_perturbation_does_not_change_entry","deterministic_repeat"]};
}
return {ema,wilderAtr,indicators,classify,detectSignals,simulate,metrics,blockBootstrapCI,runSegment,runFixtureTests};