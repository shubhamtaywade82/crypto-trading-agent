"""Reproducible ALMA/EMA backtest harness for Binance SOLUSDT USDⓈ-M futures.

This script runs locally against CSVs downloaded from Binance or exported from another
source. It deliberately separates signal definitions from execution and costs.

Expected CSV columns: open_time, open, high, low, close, volume
- open_time may be unix milliseconds or an ISO timestamp.
- 15m CSV must be chronological and contain closed candles only.
- optional 1h CSV is used for the directional filter.

Example:
  python alma_solusdt_backtest.py --m15 solusdt_15m.csv --h1 solusdt_1h.csv

The live Binance plugin responses used in the conversation are not automatically saved
as local files, so this script does not pretend to contain the complete downloaded dataset.
"""
from __future__ import annotations
import argparse
import csv
import math
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

@dataclass
class Candle:
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0

def parse_time(s: str) -> int:
    try:
        n = float(s)
        return int(n if n > 10**12 else n * 1000)
    except ValueError:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)

def load_csv(path: str) -> list[Candle]:
    rows: list[Candle] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        required = {"open_time", "open", "high", "low", "close"}
        if not required.issubset(set(reader.fieldnames or [])):
            raise ValueError(f"{path}: expected columns {sorted(required)}; got {reader.fieldnames}")
        for row in reader:
            c = Candle(parse_time(row["open_time"]), float(row["open"]), float(row["high"]),
                       float(row["low"]), float(row["close"]), float(row.get("volume") or 0))
            if not all(math.isfinite(x) for x in (c.o,c.h,c.l,c.c,c.v)):
                raise ValueError(f"Non-finite OHLCV at {c.t}")
            if c.l > min(c.o,c.c) or c.h < max(c.o,c.c) or c.h < c.l or c.v < 0:
                raise ValueError(f"Invalid OHLCV bar at {c.t}: {c}")
            rows.append(c)
    rows.sort(key=lambda x:x.t)
    if len({c.t for c in rows}) != len(rows):
        raise ValueError(f"Duplicate candle timestamps in {path}")
    return rows

def alma(values: list[float], n: int, offset: float=.85, sigma: float=6.) -> list[Optional[float]]:
    if n <= 0 or sigma <= 0 or not 0 <= offset <= 1:
        raise ValueError("ALMA requires n>0, sigma>0, offset in [0,1]")
    m = offset * (n-1)
    s = n / sigma
    weights = [math.exp(-((i-m)**2)/(2*s*s)) for i in range(n)]
    total = sum(weights)
    weights = [x/total for x in weights]
    out: list[Optional[float]] = [None]*len(values)
    for i in range(n-1, len(values)):
        out[i] = sum(values[i-n+1+j]*weights[j] for j in range(n))
    return out

def ema(values: list[float], n: int) -> list[Optional[float]]:
    out: list[Optional[float]] = [None]*len(values)
    alpha=2/(n+1); val=None
    for i,x in enumerate(values):
        val=x if val is None else alpha*x+(1-alpha)*val
        if i >= n-1: out[i]=val
    return out

def atr(bars: list[Candle], n: int=14) -> list[Optional[float]]:
    tr=[]
    for i,b in enumerate(bars):
        tr.append(b.h-b.l if i == 0 else max(b.h-b.l, abs(b.h-bars[i-1].c), abs(b.l-bars[i-1].c)))
    return ema(tr,n)

def align_closed_higher(m15: list[Candle], h1: list[Candle], h1_ms: int=3_600_000) -> list[int]:
    ans=[]; j=0
    for bar in m15:
        while j+1 < len(h1) and h1[j+1].t+h1_ms <= bar.t:
            j+=1
        ans.append(j if h1 and h1[j].t+h1_ms <= bar.t else -1)
    return ans

def summarize(name, trades, equity_curve, start_equity):
    wins=[t for t in trades if t["net"]>0]
    losses=[t for t in trades if t["net"]<=0]
    gw=sum(t["net"] for t in wins); gl=-sum(t["net"] for t in losses)
    peak=start_equity; dd=0.
    for eq in equity_curve:
        peak=max(peak,eq); dd=max(dd,(peak-eq)/peak)
    final=equity_curve[-1] if equity_curve else start_equity
    return {"strategy":name,"trades":len(trades),"wins":len(wins),"win_rate_pct":round(100*len(wins)/len(trades),2) if trades else 0,
            "starting_equity":start_equity,"ending_equity":round(final,2),"net_pnl":round(final-start_equity,2),
            "net_return_pct":round(100*(final/start_equity-1),2),"profit_factor":round(gw/gl,3) if gl else None,
            "max_drawdown_pct":round(100*dd,2),"avg_net_per_trade":round(sum(t["net"] for t in trades)/len(trades),2) if trades else 0,
            "avg_bars_held":round(sum(t["bars"] for t in trades)/len(trades),1) if trades else 0}

def simulate(m15, h1, mode, start_equity=10_000., fee_bps=5., slippage_bps=2., stop_mult=1.5, rr=1.5):
    close=[x.c for x in m15]
    a9=alma(close,9); a21=alma(close,21); e9=ema(close,9); e21=ema(close,21); a50=alma(close,50); av=atr(m15)
    hclose=[x.c for x in h1] if h1 else []
    h50=alma(hclose,50) if h1 else []
    hm=align_closed_higher(m15,h1) if h1 else [-1]*len(m15)
    cost=2*(fee_bps+slippage_bps)/10_000
    equity=start_equity; curve=[]; trades=[]
    side=0; entry=0.; stop=target=0.; entry_equity=0.; entry_i=0; entry_t=0
    def close_trade(price, idx, reason):
        nonlocal equity, side, entry, stop, target, entry_equity
        gross=entry_equity*side*(price-entry)/entry
        fees=entry_equity*cost
        net=gross-fees
        equity+=net
        trades.append({"side":"LONG" if side==1 else "SHORT", "entry":entry,"exit":price,"net":net,
                       "gross":gross,"fees":fees,"bars":idx-entry_i,"entry_time":entry_t,"exit_time":m15[idx].t,"reason":reason})
        side=0; entry=stop=target=0.; entry_equity=0.
    for i in range(100, len(m15)-1):
        b=m15[i]; nxt=m15[i+1]; sig=0; j=hm[i]
        if mode in ("alma_cross","ema_cross"):
            f,s=(a9,a21) if mode=="alma_cross" else (e9,e21)
            if f[i] is not None and s[i] is not None and f[i-1] is not None and s[i-1] is not None:
                if f[i]>s[i] and f[i-1]<=s[i-1]: sig=1
                elif f[i]<s[i] and f[i-1]>=s[i-1]: sig=-1
        elif mode in ("pullback","pullback_atr","smc_proxy") and j>=1 and h50[j] is not None and h50[j-1] is not None and a9[i] is not None and a21[i] is not None and av[i] is not None:
            bull=h1[j].c>h50[j] and h50[j]>h50[j-1]
            bear=h1[j].c<h50[j] and h50[j]<h50[j-1]
            if mode in ("pullback","pullback_atr"):
                if bull and a9[i]>a21[i] and b.l<=a9[i] and b.c>a9[i] and b.c>b.o: sig=1
                elif bear and a9[i]<a21[i] and b.h>=a9[i] and b.c<a9[i] and b.c<b.o: sig=-1
            else:
                lo=min(x.l for x in m15[i-8:i]); hi=max(x.h for x in m15[i-8:i])
                if bull and a9[i]>a21[i] and b.l<lo and b.c>lo and b.c>b.o: sig=1
                elif bear and a9[i]<a21[i] and b.h>hi and b.c<hi and b.c<b.o: sig=-1
        exit_px=None; reason=None
        if side:
            if mode=="pullback_atr":
                # Conservative same-bar ambiguity: stop takes precedence over target.
                if side==1 and b.l<=stop: exit_px=min(nxt.o,stop); reason="stop"
                elif side==-1 and b.h>=stop: exit_px=max(nxt.o,stop); reason="stop"
                elif side==1 and b.h>=target: exit_px=target; reason="target"
                elif side==-1 and b.l<=target: exit_px=target; reason="target"
            if exit_px is None and sig and sig != side: exit_px=nxt.o; reason="opposite_signal"
            if exit_px is not None: close_trade(exit_px,i,reason)
        # Enter at next bar open only, and don't reverse on the same bar as an exit.
        if side==0 and sig and exit_px is None:
            side=sig; entry=nxt.o*(1+side*slippage_bps/10_000); entry_i=i+1; entry_t=nxt.t; entry_equity=equity
            if mode=="pullback_atr":
                dist=max(stop_mult*av[i], entry*.002); stop=entry-side*dist; target=entry+side*dist*rr
        curve.append(equity)
    if side:
        close_trade(m15[-1].c,len(m15)-1,"end_of_data")
    if curve: curve[-1]=equity
    return summarize(mode,trades,curve,start_equity), trades

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--m15',required=True,help='15-minute OHLCV CSV')
    p.add_argument('--h1',required=True,help='1-hour OHLCV CSV')
    p.add_argument('--out',default='alma_backtest_results',help='output filename prefix')
    p.add_argument('--equity',type=float,default=10000.)
    p.add_argument('--fee-bps',type=float,default=5.)
    p.add_argument('--slippage-bps',type=float,default=2.)
    args=p.parse_args()
    m15=load_csv(args.m15); h1=load_csv(args.h1)
    if len(m15)<200 or len(h1)<60: raise SystemExit('Need at least 200 15m bars and 60 1h bars')
    results=[]; all_trades=[]
    for mode in ('alma_cross','ema_cross','pullback','pullback_atr','smc_proxy'):
        summary,trades=simulate(m15,h1,mode,args.equity,args.fee_bps,args.slippage_bps)
        results.append(summary)
        for t in trades: all_trades.append({'strategy':mode,**t})
    prefix=Path(args.out)
    with open(str(prefix)+'_summary.csv','w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(results[0]));w.writeheader();w.writerows(results)
    with open(str(prefix)+'_trades.csv','w',newline='') as f:
        fields=sorted({k for x in all_trades for k in x})
        w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(all_trades)
    print(f"15m bars={len(m15)} {datetime.fromtimestamp(m15[0].t/1000,timezone.utc).isoformat()}..{datetime.fromtimestamp(m15[-1].t/1000,timezone.utc).isoformat()}")
    print(f"1h bars={len(h1)} {datetime.fromtimestamp(h1[0].t/1000,timezone.utc).isoformat()}..{datetime.fromtimestamp(h1[-1].t/1000,timezone.utc).isoformat()}")
    print(f"Costs assumed: {args.fee_bps:g} bps fee + {args.slippage_bps:g} bps slippage per side; funding excluded; notional=equity (1x)")
    for x in results: print(x)
    print(f"Wrote {prefix}_summary.csv and {prefix}_trades.csv")
if __name__=='__main__': main()