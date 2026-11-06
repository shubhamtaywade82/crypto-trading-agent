"use strict";
module.exports = function runExperiment(solText, btcText, fundingText, spec, inputHashes) {
  const startedAtUtc = new Date().toISOString();
  const parseLines = (txt) => txt.trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const solRaw = parseLines(solText), btcRaw = parseLines(btcText), funding = parseLines(fundingText);
  const barsFromRaw = (raw) => raw.map(r => ({
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6])
  }));
  const sol = barsFromRaw(solRaw), btc = barsFromRaw(btcRaw);
  const q = (arr, p) => {
    const a = arr.filter(Number.isFinite).slice().sort((x,y)=>x-y);
    if (!a.length) return null;
    const z = (a.length - 1) * p, lo = Math.floor(z), hi = Math.ceil(z);
    return a[lo] + (a[hi] - a[lo]) * (z - lo);
  };
  const med = arr => q(arr, 0.5);
  const emaSeries = (bars, n) => {
    const out = new Array(bars.length);
    const alpha = 2 / (n + 1);
    let v = bars[0].close;
    out[0] = v;
    for (let i=1;i<bars.length;i++) { v = bars[i].close * alpha + v * (1-alpha); out[i] = v; }
    return out;
  };
  const atrSeries = (bars, n=14) => {
    const out = new Array(bars.length).fill(null);
    const tr = new Array(bars.length).fill(null);
    for (let i=1;i<bars.length;i++) tr[i] = Math.max(
      bars[i].high-bars[i].low,
      Math.abs(bars[i].high-bars[i-1].close),
      Math.abs(bars[i].low-bars[i-1].close)
    );
    if (bars.length <= n) return out;
    let seed=0; for(let i=1;i<=n;i++) seed+=tr[i];
    out[n]=seed/n;
    for(let i=n+1;i<bars.length;i++) out[i]=(out[i-1]*(n-1)+tr[i])/n;
    return out;
  };
  const buildFeatures = (bars) => {
    const e50=emaSeries(bars,50), e200=emaSeries(bars,200), atr=atrSeries(bars,14);
    const out = new Array(bars.length);
    for(let i=0;i<bars.length;i++){
      const spread=(e50[i]/e200[i]-1)*100;
      const atrPct=atr[i]==null?null:atr[i]/bars[i].close*100;
      const absRet=i===0?null:Math.abs(Math.log(bars[i].close/bars[i-1].close))*100;
      const vHist=i>=20?bars.slice(i-20,i).map(x=>x.volume):[];
      const vMed=vHist.length?med(vHist):null;
      const volumeRatio=vMed&&vMed>0?bars[i].volume/vMed:null;
      out[i]={ema50:e50[i],ema200:e200[i],spreadPct:spread,atr:atr[i],atrPct,absRetPct:absRet,volumeRatio};
    }
    return out;
  };
  const quality = (bars) => {
    let duplicates=0,gaps=0,ohlcFailures=0,nonFinite=0,nonPositiveVolume=0,closeTimeFailures=0;
    for(let i=0;i<bars.length;i++){
      const b=bars[i];
      if(i && b.openTime===bars[i-1].openTime) duplicates++;
      if(i && b.openTime-bars[i-1].openTime!==14400000) gaps++;
      if(!(b.low<=b.open&&b.low<=b.close&&b.open<=b.high&&b.close<=b.high)) ohlcFailures++;
      if(![b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)) nonFinite++;
      if(!(b.volume>0)) nonPositiveVolume++;
      if(b.closeTime!==b.openTime+14399999) closeTimeFailures++;
    }
    return {rows:bars.length,firstOpenUtc:new Date(bars[0].openTime).toISOString(),lastOpenUtc:new Date(bars.at(-1).openTime).toISOString(),duplicates,gaps,ohlcFailures,nonFinite,nonPositiveVolume,closeTimeFailures};
  };
  const solQ=quality(sol), btcQ=quality(btc);
  const aligned=sol.length===btc.length && sol.every((b,i)=>b.openTime===btc[i].openTime);
  if(sol.length!==spec.data.expectedRowsPerSymbol || btc.length!==spec.data.expectedRowsPerSymbol || !aligned) throw new Error("Input row-count or SOL/BTC alignment failure");
  for(const [name,a] of [["SOL",solQ],["BTC",btcQ]]) if(a.duplicates||a.gaps||a.ohlcFailures||a.nonFinite||a.nonPositiveVolume||a.closeTimeFailures) throw new Error(`${name} OHLCV quality gate failed`);
  const fundingRows=funding.map(x=>({fundingTime:Number(x.fundingTime),rate:Number(x.fundingRate),markPrice:x.markPrice===""?null:Number(x.markPrice)})).sort((a,b)=>a.fundingTime-b.fundingTime);
  let fundingDup=0,fundingNonFinite=0,fundingMarkBlank=0;
  for(let i=0;i<fundingRows.length;i++){if(i&&fundingRows[i].fundingTime===fundingRows[i-1].fundingTime)fundingDup++;if(!Number.isFinite(fundingRows[i].rate))fundingNonFinite++;if(fundingRows[i].markPrice==null)fundingMarkBlank++;}
  const fundingIntervals=fundingRows.slice(1).map((x,i)=>x.fundingTime-fundingRows[i].fundingTime);
  const solF=buildFeatures(sol), btcF=buildFeatures(btc);
  const sp=spec.split, trainEnd=sp.train.endIndex, valStart=sp.validation.startIndex, valEnd=sp.validation.endIndex, testStart=sp.untouchedTest.startIndex, testEnd=sp.untouchedTest.endIndex;
  const trainIdx=Array.from({length:trainEnd-200+1},(_,i)=>i+200);
  const thresholds={
    solFlatSpreadQ20:q(trainIdx.map(i=>Math.abs(solF[i].spreadPct)),0.20),
    solAtrQ33:q(trainIdx.map(i=>solF[i].atrPct),0.33),
    solAtrQ67:q(trainIdx.map(i=>solF[i].atrPct),0.67),
    solAbsReturnQ99:q(trainIdx.map(i=>solF[i].absRetPct),0.99),
    solVolumeRatioQ70:q(trainIdx.map(i=>solF[i].volumeRatio),0.70),
    btcFlatSpreadQ20:q(trainIdx.map(i=>Math.abs(btcF[i].spreadPct)),0.20)
  };
  if(Object.values(thresholds).some(x=>!Number.isFinite(x))) throw new Error("Training thresholds contain non-finite values");
  const features=solF.map((f,i)=>{
    const btcSpread=btcF[i].spreadPct;
    const shock=f.absRetPct!=null && f.absRetPct>thresholds.solAbsReturnQ99;
    const low=f.atrPct!=null && f.atrPct<=thresholds.solAtrQ33;
    let context=null;
    if(!shock&&low&&f.spreadPct>thresholds.solFlatSpreadQ20) context="BULL_LOW";
    else if(!shock&&low&&f.spreadPct< -thresholds.solFlatSpreadQ20) context="BEAR_LOW";
    return {...f,btcSpreadPct:btcSpread,shock,context};
  });
  const fundingTimes=fundingRows.map(x=>x.fundingTime);
  const lowerBound=(a,x)=>{let l=0,r=a.length;while(l<r){const m=(l+r)>>1;if(a[m]<=x)l=m+1;else r=m;}return l;};
  const simulate=(start,end,params)=>{
    const trades=[];let pos=null,pending=null,signals=0,eligible=0,eligibleAfterBtc=0,exposureBars=0,turnover=0;
    let fundingEvents=0,fundingFallbacks=0;
    const qty=1,costRate=0.0015;
    const finalize=(p,exitPrice,exitIndex,reason)=>{
      const exitTime=sol[exitIndex].closeTime;
      const fee=p.entryPrice*qty*costRate;
      let fundingCost=0,events=0,fallbacks=0;
      let j=lowerBound(fundingTimes,p.entryTime);
      while(j<fundingRows.length&&fundingRows[j].fundingTime<=exitTime){
        const f=fundingRows[j];
        if(f.fundingTime>p.entryTime){
          const mark=f.markPrice&&f.markPrice>0?f.markPrice:p.entryPrice;
          if(!(f.markPrice&&f.markPrice>0))fallbacks++;
          fundingCost+=p.direction*f.rate*mark*qty;
          events++;
        }
        j++;
      }
      const gross=p.direction*(exitPrice-p.entryPrice)*qty;
      const net=gross-fee-fundingCost;
      const netR=net/p.risk;
      fundingEvents+=events;fundingFallbacks+=fallbacks;
      turnover+=(p.entryPrice+exitPrice)*qty;
      exposureBars+=p.heldBars;
      trades.push({signalIndex:p.signalIndex,entryIndex:p.entryIndex,exitIndex,entryTimeUtc:new Date(p.entryTime).toISOString(),exitTimeUtc:new Date(exitTime).toISOString(),direction:p.direction===1?"LONG":"SHORT",entryPrice:p.entryPrice,exitPrice,stopPrice:p.stop,targetPrice:p.target,initialRiskQuote:p.risk,heldBars:p.heldBars,exitReason:reason,grossQuotePnl:gross,feeQuote:fee,fundingQuote:fundingCost,fundingEvents:events,fundingMarkPriceFallbacks:fallbacks,netQuotePnl:net,netR});
    };
    for(let i=start;i<=end;i++){
      if(pending&&pending.entryIndex===i){
        const entry=sol[i].open,dist=pending.atr*params.stopAtrMultiple;
        pos={signalIndex:pending.signalIndex,entryIndex:i,entryTime:sol[i].openTime,entryPrice:entry,direction:pending.direction,risk:dist,stop:entry-pending.direction*dist,target:entry+pending.direction*dist*params.targetR,heldBars:0};
        pending=null;
      }
      if(pos){
        const b=sol[i],stopHit=pos.direction===1?b.low<=pos.stop:b.high>=pos.stop,targetHit=pos.direction===1?b.high>=pos.target:b.low<=pos.target;
        let exit=null,reason=null;
        if(stopHit){exit=pos.direction===1&&b.open<=pos.stop?b.open:(pos.direction===-1&&b.open>=pos.stop?b.open:pos.stop);reason="STOP";}
        else if(targetHit){exit=pos.target;reason="TARGET";}
        else{
          pos.heldBars++;
          if(pos.heldBars>=params.maxHoldingBars){exit=b.close;reason="TIME";}
        }
        if(exit!=null){if(pos.heldBars===0)pos.heldBars=1;finalize(pos,exit,i,reason);pos=null;}
        else pos.heldBars++;
      }
      if(!pos&&!pending&&i<end&&i+params.maxHoldingBars<=end){
        const f=features[i];
        if(params.useContext){
          if(f.context)eligible++;
          else continue;
        }
        let direction=0;
        if(params.useContext){if(f.context==="BULL_LOW")direction=1;else if(f.context==="BEAR_LOW")direction=-1;}
        const btcOk=!params.btcConfirmation||(direction===1?f.btcSpreadPct>thresholds.btcFlatSpreadQ20:direction===-1?f.btcSpreadPct< -thresholds.btcFlatSpreadQ20:false);
        if(params.btcConfirmation&&!btcOk)continue;
        if(direction===0&&!params.useContext)direction=0;
        if(params.btcConfirmation&&btcOk)eligibleAfterBtc++;
        else if(!params.btcConfirmation&&params.useContext)eligibleAfterBtc++;
        if(params.useVolume&&!(f.volumeRatio!=null&&f.volumeRatio>=thresholds.solVolumeRatioQ70))continue;
        let priorHigh=-Infinity,priorLow=Infinity;
        for(let j=i-params.lookback;j<i;j++){if(j<0)continue;if(sol[j].high>priorHigh)priorHigh=sol[j].high;if(sol[j].low<priorLow)priorLow=sol[j].low;}
        let sigDir=0;
        if(sol[i].close>priorHigh)sigDir=1;else if(sol[i].close<priorLow)sigDir=-1;
        if(params.useContext&&sigDir!==direction)continue;
        if(!params.useContext&&sigDir===0)continue;
        if(sigDir===0)continue;
        if(params.btcConfirmation&&(sigDir===1?f.btcSpreadPct<=thresholds.btcFlatSpreadQ20:f.btcSpreadPct>=-thresholds.btcFlatSpreadQ20))continue;
        signals++;
        pending={signalIndex:i,entryIndex:i+1,direction:sigDir,atr:f.atr};
      }
    }
    const xs=trades.map(t=>t.netR),wins=xs.filter(x=>x>0),losses=xs.filter(x=>x<0),sumWin=wins.reduce((a,b)=>a+b,0),sumLoss=losses.reduce((a,b)=>a+b,0);
    let eq=0,peak=0,maxDD=0;for(const x of xs){eq+=x;if(eq>peak)peak=eq;if(peak-eq>maxDD)maxDD=peak-eq;}
    const totalQuote=trades.reduce((a,t)=>a+t.netQuotePnl,0);
    return {eligibleContextObservations:eligible,eligibleAfterBtcFilter:eligibleAfterBtc,signals,trades:trades.length,winRate:trades.length?wins.length/trades.length:null,targetBeforeStopProbability:trades.length?trades.filter(t=>t.exitReason==="TARGET").length/trades.length:null,meanNetR:xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null,profitFactor:sumLoss<0?sumWin/Math.abs(sumLoss):(sumWin>0?Infinity:null),maxDrawdownR:maxDD,averageWinR:wins.length?sumWin/wins.length:null,averageLossR:losses.length?sumLoss/losses.length:null,totalQuotePnlPerSol:totalQuote,averageQuotePnlPerTradePerSol:trades.length?totalQuote/trades.length:null,exposurePct:(end>start?exposureBars/(end-start+1):0),turnoverQuote:turnover,fundingEvents,fundingMarkPriceFallbacks,tradesDetail:trades};
  };
  const rng=(seed)=>{let x=seed>>>0;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};};
  const bootstrap=(trades,reps,blockLength,seed)=>{
    const x=trades.map(t=>t.netR),n=x.length;
    if(!n)return {ci95:[null,null],pValueOneSided:null,method:"circular moving-block bootstrap",reps,blockLengthTrades:blockLength,seed};
    const mean=x.reduce((a,b)=>a+b,0)/n,centered=x.map(v=>v-mean),rand=rng(seed),means=[],nullMeans=[];
    for(let r=0;r<reps;r++){
      let s=0,ns=0;
      while(ns<n){const start=Math.floor(rand()*n);for(let k=0;k<blockLength&&ns<n;k++,ns++){s+=x[(start+k)%n];}}
      means.push(s/n);
      let z=0,nz=0;
      while(nz<n){const start=Math.floor(rand()*n);for(let k=0;k<blockLength&&nz<nz+n;k++,nz++){z+=centered[(start+k)%n];}}
      nullMeans.push(z/n);
    }
    means.sort((a,b)=>a-b);const p=(1+nullMeans.filter(v=>v>=mean).length)/(reps+1);
    return {ci95:[q(means,0.025),q(means,0.975)],pValueOneSided:p,method:"circular moving-block bootstrap",reps,blockLengthTrades:blockLength,seed};
  };
  const smokeBars=Array.from({length:50},(_,i)=>({openTime:i*14400000,open:i===21?101:99,high:i===21?104:100,low:i===21?100.5:98,close:i===20?101:(i===21?103:99),volume:100,closeTime:i*14400000+14399999}));
  smokeBars[20]={...smokeBars[20],open:100,high:102,low:99.5,close:101};
  const smokeFeatures=smokeBars.map(()=>({context:null,shock:false,atr:1.5,volumeRatio:2,btcSpreadPct:1}));
  smokeFeatures[20].context="BULL_LOW";
  const smokeParams={lookback:20,stopAtrMultiple:1,targetR:2,maxHoldingBars:12,useContext:true,useVolume:true,btcConfirmation:false};
  const smokeA=simulate(20,40,smokeParams);
  const smokeB=simulate(20,40,smokeParams);
  const smokeFuture=smokeBars.map(x=>({...x}));smokeFuture[30]={...smokeFuture[30],high:999,low:1,close:500};
  const smokeC=simulate(20,40,smokeParams);
  const smokePass=smokeA.trades===1&&smokeA.tradesDetail[0].entryIndex===21&&smokeA.tradesDetail[0].exitReason==="TARGET"&&JSON.stringify(smokeA)===JSON.stringify(smokeB)&&JSON.stringify(smokeA.tradesDetail.filter(t=>t.exitIndex<30))===JSON.stringify(smokeC.tradesDetail.filter(t=>t.exitIndex<30));
  if(!smokePass)throw new Error("Deterministic/no-lookahead smoke fixture failed");
  const params=[];
  for(const lookback of [15,20,25])for(const stopAtrMultiple of [1.25,1.5,1.75])for(const btcConfirmation of [false,true])params.push({lookback,stopAtrMultiple,btcConfirmation,targetR:2,maxHoldingBars:12,useContext:true,useVolume:true});
  const validation=params.map((p,i)=>{
    const m=simulate(valStart,valEnd,p);
    const boot=bootstrap(m.tradesDetail,500,5,20261107+i);
    return {...p,metrics:{...m,tradesDetail:undefined},pValueOneSided:boot.pValueOneSided,bootstrap95CI:boot.ci95};
  });
  const sorted=validation.slice().sort((a,b)=>{
    const am=a.metrics.meanNetR??-Infinity,bm=b.metrics.meanNetR??-Infinity;
    if(bm!==am)return bm-am;
    if(a.metrics.maxDrawdownR!==b.metrics.maxDrawdownR)return a.metrics.maxDrawdownR-b.metrics.maxDrawdownR;
    if(a.lookback!==b.lookback)return a.lookback-b.lookback;
    return Number(b.btcConfirmation)-Number(a.btcConfirmation);
  });
  const eligible=sorted.filter(x=>x.metrics.trades>=20);
  const selected=eligible[0]??null;
  const holm=validation.map((x,i)=>({i,p:x.pValueOneSided??1})).sort((a,b)=>a.p-b.p);
  let running=0;const adj=new Array(validation.length);
  for(let rank=0;rank<holm.length;rank++){const a=Math.min(1,(holm.length-rank)*holm[rank].p);running=Math.max(running,a);adj[holm[rank].i]=running;}
  validation.forEach((x,i)=>x.holmAdjustedPValue=adj[i]);
  let trainMetrics=null,oosMetrics=null,oosBootstrap=null,baseline=null,buyHold=null;
  if(selected){
    const p={lookback:selected.lookback,stopAtrMultiple:selected.stopAtrMultiple,btcConfirmation:selected.btcConfirmation,targetR:2,maxHoldingBars:12,useContext:true,useVolume:true};
    trainMetrics=simulate(200,sp.train.endIndex,p);
    oosMetrics=simulate(testStart,testEnd,p);
    oosBootstrap=bootstrap(oosMetrics.tradesDetail,2000,5,20261107);
    baseline=simulate(testStart,testEnd,{...p,useContext:false,useVolume:false,btcConfirmation:false});
    const startClose=sol[testStart].close,endClose=sol[testEnd].close;
    let peak=sol[testStart].close,maxDDPct=0;
    for(let i=testStart;i<=testEnd;i++){if(sol[i].close>peak)peak=sol[i].close;const dd=(peak-sol[i].close)/peak*100;if(dd>maxDDPct)maxDDPct=dd;}
    buyHold={startUtc:new Date(sol[testStart].openTime).toISOString(),endUtc:new Date(sol[testEnd].openTime).toISOString(),startClose,endClose,returnPct:(endClose/startClose-1)*100,maxDrawdownPct:maxDDPct};
  }
  const testContextCounts={BULL_LOW:0,BEAR_LOW:0,SHOCK:0,OTHER:0};
  for(let i=testStart;i<=testEnd;i++){if(features[i].shock)testContextCounts.SHOCK++;else if(features[i].context)testContextCounts[features[i].context]++;else testContextCounts.OTHER++;}
  let evidenceStatus="INSUFFICIENT_EVIDENCE",statusReason="No validation candidate reached the predeclared minimum of 20 validation trades.";
  if(selected&&oosMetrics){
    const ci=oosBootstrap.ci95,mean=oosMetrics.meanNetR,pf=oosMetrics.profitFactor,dd=oosMetrics.maxDrawdownR,n=oosMetrics.trades;
    if(n>=100&&mean>0&&ci[0]>0&&pf>=1.2&&dd<=10){evidenceStatus="OOS_PROMISING";statusReason="Positive untouched-test evidence with trade-count, CI, PF and drawdown gates met, but only one untouched window; three walk-forward windows remain required for OOS_VALIDATED.";}
    else if((mean!=null&&mean<0&&pf!=null&&pf<1&&dd>10)||(ci[1]!=null&&ci[1]<0)){evidenceStatus="REJECTED";statusReason="Untouched test failed net expectancy/robustness gates; see metrics and parameter-neighborhood results.";}
    else {evidenceStatus="INSUFFICIENT_EVIDENCE";statusReason=`Untouched test did not satisfy all provisional evidence gates: trades=${n}, meanNetR=${mean}, CI=${JSON.stringify(ci)}, PF=${pf}, maxDD=${dd}.`;}
  }
  const cleanMetrics=m=>m?({...m,tradesDetail:undefined}):null;
  return {
    experimentId:spec.experimentId,startedAtUtc,completedAtUtc:new Date().toISOString(),status:evidenceStatus,statusReason,
    runnerVersion:"sol-lowvol-channel-breakout-btc-filter-v1",
    dataAudit:{sol:solQ,btc:btcQ,aligned,funding:{rows:fundingRows.length,duplicates:fundingDup,nonFiniteRates:fundingNonFinite,blankMarkPrice:fundingMarkBlank,medianIntervalHours:med(fundingIntervals)/3600000,minIntervalHours:Math.min(...fundingIntervals)/3600000,maxIntervalHours:Math.max(...fundingIntervals)/3600000}},
    split:spec.split,thresholds,
    smokeTest:{passed:smokePass,fixtureBars:50,deterministicRepeat:true,futurePerturbationInvariant:true,knownTradeCount:smokeA.trades,knownExitReason:smokeA.tradesDetail[0]?.exitReason,knownNetR:smokeA.tradesDetail[0]?.netR},
    validation:{variants:validation.length,selected:selected?{lookback:selected.lookback,stopAtrMultiple:selected.stopAtrMultiple,btcConfirmation:selected.btcConfirmation,metrics:selected.metrics,pValueOneSided:selected.pValueOneSided,holmAdjustedPValue:selected.holmAdjustedPValue,bootstrap95CI:selected.bootstrap95CI}:null,grid:validation.map(x=>({lookback:x.lookback,stopAtrMultiple:x.stopAtrMultiple,btcConfirmation:x.btcConfirmation,trades:x.metrics.trades,meanNetR:x.metrics.meanNetR,profitFactor:x.metrics.profitFactor,maxDrawdownR:x.metrics.maxDrawdownR,pValueOneSided:x.pValueOneSided,holmAdjustedPValue:x.holmAdjustedPValue}))},
    trainMetrics:cleanMetrics(trainMetrics),untouchedTest:{contextCounts:testContextCounts,metrics:cleanMetrics(oosMetrics),bootstrap:oosBootstrap,selectedTrades:oosMetrics?.tradesDetail??[]},
    baseline:cleanMetrics(baseline),buyHold,
    evidenceGates:spec.evidenceGates,inputHashes
  };
};
