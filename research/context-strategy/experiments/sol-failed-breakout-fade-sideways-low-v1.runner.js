function run(input) {
  const bars = input.bars;
  const funding = input.funding || [];
  const cfg = input.config || {};
  if (!Array.isArray(bars) || bars.length < 500) throw new Error("Need at least 500 chronological 4h bars");
  const N = bars.length;
  const intervalMs = 14400000;
  const times = bars.map(r => Number(r[0]));
  const close = bars.map(r => Number(r[4]));
  const high = bars.map(r => Number(r[2]));
  const low = bars.map(r => Number(r[3]));
  const open = bars.map(r => Number(r[1]));
  const volume = bars.map(r => Number(r[5]));
  const closeTime = bars.map(r => Number(r[6]));
  const dataIssues = {duplicates:0,gaps:0,misaligned:0,ohlcFailures:0,nonPositiveVolume:0,nonFinite:0};
  for (let i=0;i<N;i++) {
    if (i>0) {
      if (times[i]===times[i-1]) dataIssues.duplicates++;
      if (times[i]-times[i-1]!==intervalMs) dataIssues.gaps++;
    }
    if (times[i] % intervalMs !== 0) dataIssues.misaligned++;
    if (![open[i],high[i],low[i],close[i],volume[i]].every(Number.isFinite)) dataIssues.nonFinite++;
    if (!(low[i] <= open[i] && low[i] <= close[i] && high[i] >= open[i] && high[i] >= close[i])) dataIssues.ohlcFailures++;
    if (!(volume[i] > 0)) dataIssues.nonPositiveVolume++;
  }
  const ema = period => {
    const out = new Array(N).fill(null);
    let sum = 0, value = null;
    const alpha = 2/(period+1);
    for (let i=0;i<N;i++) {
      sum += close[i];
      if (i===period-1) value = sum/period;
      else if (i>=period) value = alpha*close[i] + (1-alpha)*value;
      if (i>=period-1) out[i] = value;
    }
    return out;
  };
  const ema50=ema(50), ema200=ema(200);
  const tr=new Array(N), atr=new Array(N).fill(null), absRet=new Array(N).fill(null);
  for (let i=0;i<N;i++) {
    tr[i]=i===0?high[i]-low[i]:Math.max(high[i]-low[i],Math.abs(high[i]-close[i-1]),Math.abs(low[i]-close[i-1]));
    if (i>0) absRet[i]=Math.abs(close[i]/close[i-1]-1);
    if (i===13) atr[i]=tr.slice(0,14).reduce((a,b)=>a+b,0)/14;
    else if (i>13) atr[i]=(13*atr[i-1]+tr[i])/14;
  }
  const features=new Array(N);
  for (let i=0;i<N;i++) {
    features[i]={
      emaSpread:ema50[i]!==null && ema200[i]!==null ? ema50[i]/ema200[i]-1 : null,
      atrPct:atr[i]!==null ? atr[i]/close[i] : null,
      absReturn:absRet[i],
      context:"UNKNOWN"
    };
  }
  const trainEnd=Math.floor(N*0.60), validationEnd=Math.floor(N*0.80);
  const warmup=199, purge=6;
  const trainValues=features.slice(warmup,trainEnd).filter(f=>f.emaSpread!==null && f.atrPct!==null && f.absReturn!==null);
  const quantile=(values,q)=>{
    if (!values.length) throw new Error("Empty quantile sample");
    const a=values.slice().sort((x,y)=>x-y);
    const pos=(a.length-1)*q, lo=Math.floor(pos), hi=Math.ceil(pos);
    return a[lo]+(a[hi]-a[lo])*(pos-lo);
  };
  const thresholds={
    flatSpreadQ30:quantile(trainValues.map(f=>Math.abs(f.emaSpread)),0.30),
    atrQ33:quantile(trainValues.map(f=>f.atrPct),0.33),
    absReturnQ99:quantile(trainValues.map(f=>f.absReturn),0.99)
  };
  for (let i=warmup;i<N;i++) {
    const f=features[i];
    if (f.emaSpread===null || f.atrPct===null || f.absReturn===null) continue;
    if (f.absReturn>thresholds.absReturnQ99) f.context="SHOCK";
    else {
      const trend=Math.abs(f.emaSpread)<=thresholds.flatSpreadQ30?"SIDEWAYS":(f.emaSpread>0?"UP":"DOWN");
      const vol=f.atrPct<=thresholds.atrQ33?"LOW":"NORMAL";
      f.context=trend+"_"+vol;
    }
  }
  const fundingSorted=funding.slice().sort((a,b)=>Number(a.fundingTime)-Number(b.fundingTime));
  const fundingByTime=new Map();
  let fundingDuplicates=0, fundingBad=0, fundingBlankMark=0;
  for (const f of fundingSorted) {
    const t=Number(f.fundingTime);
    if (fundingByTime.has(t)) fundingDuplicates++;
    const rate=Number(f.fundingRate);
    if (!Number.isFinite(t) || !Number.isFinite(rate)) fundingBad++;
    else fundingByTime.set(t,{rate,markPrice:f.markPrice===undefined||f.markPrice===""?null:Number(f.markPrice)});
    if (f.markPrice===undefined || f.markPrice==="") fundingBlankMark++;
  }
  const fundingTimes=Array.from(fundingByTime.keys()).sort((a,b)=>a-b);
  const fundingIntervalHoursObserved={};
  let fundingIntervalsOver8h=0;
  for (let i=1;i<fundingTimes.length;i++) {
    const h=(fundingTimes[i]-fundingTimes[i-1])/3600000;
    const bucket=String(Math.round(h));
    fundingIntervalHoursObserved[bucket]=(fundingIntervalHoursObserved[bucket]||0)+1;
    if (h>8.05) fundingIntervalsOver8h++;
  }
  const barIndexByTime=new Map(times.map((t,i)=>[t,i]));
  const params={lookbacks:[15,20,25],stopBufferAtr:0.25,targetR:1.5,maxHoldBars:6,qty:1,costRate:0.0015,minValidationTrades:20,bootstrapReps:2000,blockLength:5,seed:20261105};
  function backtest(start,end,lookback,conditional) {
    const trades=[];
    let busyUntil=-1, upperSignals=0, lowerSignals=0, ambiguous=0, overlapSkipped=0;
    const contextBars=conditional?features.slice(start,end).filter(f=>f.context==="SIDEWAYS_LOW").length:0;
    for (let i=Math.max(start,warmup,lookback);i<end-params.maxHoldBars;i++) {
      if (i<busyUntil) { overlapSkipped++; continue; }
      if (conditional && features[i].context!=="SIDEWAYS_LOW") continue;
      const priorHigh=Math.max(...high.slice(i-lookback,i));
      const priorLow=Math.min(...low.slice(i-lookback,i));
      const upper=high[i]>priorHigh && close[i]<priorHigh;
      const lowerBreak=low[i]<priorLow && close[i]>priorLow;
      if (upper && lowerBreak) { ambiguous++; continue; }
      if (!upper && !lowerBreak) continue;
      const side=upper?-1:1;
      if (upper) upperSignals++; else lowerSignals++;
      const entryIdx=i+1;
      const entry=open[entryIdx];
      const a=atr[i];
      if (!(Number.isFinite(a)&&a>0)) continue;
      const stop=side===-1?high[i]+params.stopBufferAtr*a:low[i]-params.stopBufferAtr*a;
      const risk=Math.abs(stop-entry);
      if (!(risk>0) || (side===1 && stop>=entry) || (side===-1 && stop<=entry)) continue;
      const target=entry+side*params.targetR*risk;
      let exitIdx=-1, exitPrice=null, exitReason="TIME";
      const last=Math.min(entryIdx+params.maxHoldBars-1,end-1);
      for (let k=entryIdx;k<=last;k++) {
        const o=open[k],h=high[k],l=low[k];
        const stopHit=side===1?(o<=stop || l<=stop):(o>=stop || h>=stop);
        const targetHit=side===1?(o>=target || h>=target):(o<=target || l<=target);
        if (stopHit) {
          exitIdx=k;
          exitPrice=side===1?(o<=stop?o:stop):(o>=stop?o:stop);
          exitReason="STOP";
          break;
        }
        if (targetHit) {
          exitIdx=k;
          exitPrice=target;
          exitReason="TARGET";
          break;
        }
        if (k===last) {
          exitIdx=k;
          exitPrice=close[k];
          exitReason="TIME";
        }
      }
      if (exitIdx<0) continue;
      const entryTime=times[entryIdx], exitTime=closeTime[exitIdx];
      let fundingCost=0, fundingCount=0, fundingProxyCount=0, fundingUnpriced=0;
      for (const ft of fundingTimes) {
        if (ft<=entryTime || ft>exitTime) continue;
        const f=fundingByTime.get(ft);
        let mark=f.markPrice;
        if (!(Number.isFinite(mark)&&mark>0)) {
          const nearest=Math.round(ft/intervalMs)*intervalMs;
          const bi=barIndexByTime.get(nearest);
          if (bi!==undefined && Math.abs(times[bi]-ft)<=60000) { mark=open[bi]; fundingProxyCount++; }
          else { fundingUnpriced++; continue; }
        }
        fundingCost += side*f.rate*mark*params.qty;
        fundingCount++;
      }
      const gross=side*(exitPrice-entry)*params.qty;
      const executionCost=entry*params.qty*params.costRate;
      const net=gross-executionCost-fundingCost;
      const riskQuote=risk*params.qty;
      trades.push({
        signalIndex:i,entryIndex:entryIdx,exitIndex:exitIdx,side:side===1?"LONG":"SHORT",
        entryTimeUtc:new Date(entryTime).toISOString(),exitTimeUtc:new Date(exitTime).toISOString(),
        entry,exit:exitPrice,stop,target,exitReason,holdingBars:exitIdx-entryIdx+1,
        grossQuotePnl:gross,executionCostQuote:executionCost,fundingCostQuote:fundingCost,
        fundingSettlements:fundingCount,fundingMarkProxySettlements:fundingProxyCount,
        fundingUnpricedSettlements:fundingUnpriced,netQuotePnl:net,netR:net/riskQuote,
        context:features[i].context
      });
      busyUntil=exitIdx;
    }
    const n=trades.length, wins=trades.filter(t=>t.netQuotePnl>0), losses=trades.filter(t=>t.netQuotePnl<0);
    const grossWins=wins.reduce((a,t)=>a+t.netQuotePnl,0), grossLoss=Math.abs(losses.reduce((a,t)=>a+t.netQuotePnl,0));
    let cum=0,peak=0,maxDD=0;
    for (const t of trades) { cum+=t.netR; if(cum>peak)peak=cum; maxDD=Math.max(maxDD,peak-cum); }
    const totalQuote=trades.reduce((a,t)=>a+t.netQuotePnl,0);
    const holding=trades.reduce((a,t)=>a+t.holdingBars,0);
    return {
      eligibleContextObservations:conditional?contextBars:features.slice(start,end).filter(f=>f.emaSpread!==null).length,
      trades:n,signals:upperSignals+lowerSignals,upperFailures:upperSignals,lowerFailures:lowerSignals,
      ambiguousBars:ambiguous,overlapSkipped,
      winRate:n?wins.length/n:null,targetBeforeStopProbability:n?trades.filter(t=>t.exitReason==="TARGET").length/n:null,
      meanNetR:n?trades.reduce((a,t)=>a+t.netR,0)/n:null,totalNetR:trades.reduce((a,t)=>a+t.netR,0),
      meanQuotePnl:n?totalQuote/n:null,totalQuotePnl:totalQuote,
      profitFactor:grossLoss>0?grossWins/grossLoss:(grossWins>0?null:0),
      maxDrawdownR:maxDD,averageWinR:wins.length?wins.reduce((a,t)=>a+t.netR,0)/wins.length:null,
      averageLossR:losses.length?losses.reduce((a,t)=>a+t.netR,0)/losses.length:null,
      exposureBars:holding,exposurePct:(end>start)?holding/(end-start):null,
      averageHoldingBars:n?holding/n:null,turnoverQuote:trades.reduce((a,t)=>a+(t.entry+t.exit),0),
      fundingSettlements:trades.reduce((a,t)=>a+t.fundingSettlements,0),
      fundingMarkProxySettlements:trades.reduce((a,t)=>a+t.fundingMarkProxySettlements,0),
      fundingUnpricedSettlements:trades.reduce((a,t)=>a+t.fundingUnpricedSettlements,0),
      tradesLedger:trades
    };
  }
  function rng(seed){let x=seed>>>0;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};}
  function bootstrap(trades,seed){
    const vals=trades.map(t=>t.netR),n=vals.length;
    if(n<2)return {ci95:[null,null],pValueOneSided:null,reps:0,blockLength:params.blockLength};
    const mean=vals.reduce((a,b)=>a+b,0)/n, centered=vals.map(v=>v-mean),rand=rng(seed),means=[],nullMeans=[];
    for(let r=0;r<params.bootstrapReps;r++){
      let s=0,z=0,count=0;
      while(count<n){
        const start=Math.floor(rand()*n);
        for(let j=0;j<params.blockLength&&count<n;j++,count++){
          const idx=(start+j)%n;s+=vals[idx];z+=centered[idx];
        }
      }
      means.push(s/n);nullMeans.push(z/n);
    }
    means.sort((a,b)=>a-b);
    const lo=means[Math.floor(0.025*(means.length-1))],hi=means[Math.floor(0.975*(means.length-1))];
    const p=(nullMeans.filter(v=>v>=mean).length+1)/(nullMeans.length+1);
    return {ci95:[lo,hi],pValueOneSided:p,reps:params.bootstrapReps,blockLength:params.blockLength};
  }
  function holm(items){
    const sorted=items.slice().sort((a,b)=>a.pValue-b.pValue);
    let prev=0;
    for(let i=0;i<sorted.length;i++){const adj=Math.min(1,(items.length-i)*sorted[i].pValue);prev=Math.max(prev,adj);sorted[i].pValueHolm=prev;}
    return sorted;
  }
  const trainRange={start:warmup,end:trainEnd};
  const valRange={start:trainEnd+purge,end:validationEnd};
  const testRange={start:validationEnd+purge,end:N};
  const validationRaw=params.lookbacks.map((lb)=>({lookback:lb,metrics:backtest(valRange.start,valRange.end,lb,true)}));
  const validationCandidates=validationRaw.map(x=>({lookback:x.lookback,metrics:{...x.metrics,tradesLedger:undefined}}));
  const eligible=validationCandidates.filter(x=>x.metrics.trades>=params.minValidationTrades);
  const selected=eligible.length?eligible.slice().sort((a,b)=>(b.metrics.meanNetR??-Infinity)-(a.metrics.meanNetR??-Infinity))[0].lookback:20;
  const trainPrimary=backtest(trainRange.start,trainRange.end,selected,true);
  const validationPrimary=backtest(valRange.start,valRange.end,selected,true);
  const oosVariants=params.lookbacks.map(lb=>{
    const metrics=backtest(testRange.start,testRange.end,lb,true);
    const boot=bootstrap(metrics.tradesLedger,params.seed+lb);
    return {lookback:lb,metrics:{...metrics,tradesLedger:undefined},bootstrap:boot};
  });
  const pItems=oosVariants.filter(x=>x.bootstrap.pValueOneSided!==null).map(x=>({lookback:x.lookback,pValue:x.bootstrap.pValueOneSided}));
  const adjusted=holm(pItems);
  for(const v of oosVariants){const h=adjusted.find(x=>x.lookback===v.lookback);v.bootstrap.pValueHolm=h?h.pValueHolm:null;}
  const primary=oosVariants.find(x=>x.lookback===selected);
  const unconditional=backtest(testRange.start,testRange.end,selected,false);
  const testStartTime=new Date(times[testRange.start]).toISOString();
  const testEndTime=new Date(times[testRange.end-1]).toISOString();
  const bhStart=open[testRange.start],bhEnd=close[testRange.end-1];
  const contextCounts={};
  for(let i=warmup;i<N;i++)contextCounts[features[i].context]=(contextCounts[features[i].context]||0)+1;
  const output={
    experimentId:input.experimentId,rows:N,dataRange:{startUtc:new Date(times[0]).toISOString(),lastOpenUtc:new Date(times[N-1]).toISOString()},
    dataQuality:dataIssues,fundingQuality:{rows:fundingSorted.length,duplicates:fundingDuplicates,invalid:fundingBad,blankMarkPrice:fundingBlankMark,intervalHoursObserved,fundingIntervalsOver8h,firstFundingUtc:fundingTimes.length?new Date(fundingTimes[0]).toISOString():null,lastFundingUtc:fundingTimes.length?new Date(fundingTimes[fundingTimes.length-1]).toISOString():null},
    split:{train:{startIndex:trainRange.start,endIndexExclusive:trainRange.end,startUtc:new Date(times[trainRange.start]).toISOString(),endUtc:new Date(times[trainRange.end-1]).toISOString()},validation:{startIndex:valRange.start,endIndexExclusive:valRange.end,startUtc:new Date(times[valRange.start]).toISOString(),endUtc:new Date(times[valRange.end-1]).toISOString()},test:{startIndex:testRange.start,endIndexExclusive:testRange.end,startUtc:testStartTime,endUtc:testEndTime},purgeBars:purge},
    thresholds,contextCounts,validationCandidates,selectedLookback:selected,selectionEligibleCandidates:eligible.length,
    trainPrimary:{...trainPrimary,tradesLedger:undefined},validationPrimary:{...validationPrimary,tradesLedger:undefined},
    oosVariants,primaryOos:{...primary,metrics:{...primary.metrics},bootstrap:primary.bootstrap},
    unconditionalTest:{...unconditional,tradesLedger:undefined},
    buyHoldReference:{priceReturnPct:(bhEnd/bhStart-1)*100,startPrice:bhStart,endPrice:bhEnd},
    tradeLedger:backtest(testRange.start,testRange.end,selected,true).tradesLedger,
    parameters:params,
    limitations:["4h-only single-symbol experiment","15bp round-trip execution cost is a fixed proxy, not historical spread/fee calibration","blank funding markPrice uses exact 4h last-price open at the settlement timestamp","one untouched holdout is insufficient for OOS_VALIDATED; require multiple walk-forward windows","no latency or partial-fill model"]
  };
  if(input.returnFeatures) output.features=features.map((f,i)=>({i,emaSpread:f.emaSpread,atrPct:f.atrPct,absReturn:f.absReturn,context:f.context}));
  return output;
}
