module.exports = function runExperiment(input) {
  const solRows=input.solRows, btcRows=input.btcRows, fundingRows=input.fundingRows;
  const cfg={stopAtr:1.5,targetR:2,timeStopBars:12,costBps:15,seed:20261106,reps:2000,blockWeeks:4};
  const n=solRows.length, warmup=200, embargo=12, weekMs=604800000;
  if(n!==btcRows.length||n<2000) throw new Error("insufficient/misaligned 4h series");
  const sol=solRows.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],ct:+r[6]}));
  const btc=btcRows.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],ct:+r[6]}));
  for(let i=0;i<n;i++) if(sol[i].t!==btc[i].t||sol[i].ct!==btc[i].ct) throw new Error("unaligned BTC/SOL timestamps");
  const funding=fundingRows.map(x=>({t:+x.fundingTime,rate:+x.fundingRate,mark:x.markPrice===""?null:+x.markPrice})).sort((a,b)=>a.t-b.t);
  function ema(rows,p){const a=new Array(rows.length);const k=2/(p+1);let v=rows[0].c;a[0]=v;for(let i=1;i<rows.length;i++){v=rows[i].c*k+v*(1-k);a[i]=v;}return a;}
  function indicators(rows){
    const e20=ema(rows,20),e50=ema(rows,50),e200=ema(rows,200);
    const atr=new Array(rows.length).fill(null),atrPct=new Array(rows.length).fill(null),ret1=new Array(rows.length).fill(null),spread=new Array(rows.length).fill(null);
    let sum=0;
    for(let i=1;i<rows.length;i++){
      const tr=Math.max(rows[i].h-rows[i].l,Math.abs(rows[i].h-rows[i-1].c),Math.abs(rows[i].l-rows[i-1].c));
      if(i<=14){sum+=tr;if(i===14)atr[i]=sum/14;}else atr[i]=atr[i-1]*(13/14)+tr/14;
      if(atr[i]!==null)atrPct[i]=atr[i]/rows[i].c*100;
      ret1[i]=Math.abs(rows[i].c/rows[i-1].c-1)*100;
      spread[i]=(e50[i]/e200[i]-1)*100;
    }
    return {e20,e50,e200,atr,atrPct,ret1,spread};
  }
  const si=indicators(sol),bi=indicators(btc);
  function quantile(values,q){
    const a=values.filter(Number.isFinite).slice().sort((x,y)=>x-y);
    if(!a.length)throw new Error("empty train threshold input");
    const p=(a.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);
    return a[lo]+(a[hi]-a[lo])*(p-lo);
  }
  function fit(trainEnd){
    const ix=[];for(let i=warmup;i<trainEnd;i++)ix.push(i);
    return {
      sol:{flat:quantile(ix.map(i=>Math.abs(si.spread[i])),.20),q33:quantile(ix.map(i=>si.atrPct[i]),.33),q67:quantile(ix.map(i=>si.atrPct[i]),.67),shock:quantile(ix.map(i=>si.ret1[i]),.99)},
      btc:{flat:quantile(ix.map(i=>Math.abs(bi.spread[i])),.20)},
      trainEnd
    };
  }
  function label(i,ind,th){
    if(i<warmup||ind.atrPct[i]===null)return "UNKNOWN";
    if(ind.ret1[i]>th.shock)return "SHOCK";
    let trend="SIDEWAYS";
    if(Math.abs(ind.spread[i])>th.flat)trend=ind.spread[i]>0?"BULL":"BEAR";
    let vol="NORMAL";
    if(ind.atrPct[i]<th.q33)vol="LOW";
    else if(ind.atrPct[i]>th.q67)vol="HIGH";
    return trend+"_"+vol;
  }
  function btcLabel(i,th){
    if(Math.abs(bi.spread[i])<=th.btc.flat)return "SIDEWAYS";
    return bi.spread[i]>0?"BULL":"BEAR";
  }
  function fundingFor(dir,entryTime,exitIndex,exitMode,entry){
    const cutoff=exitMode==="TIME"?sol[exitIndex].ct:sol[exitIndex].t;
    let cost=0,events=0,fallback=0,unpriced=0,lo=0,hi=funding.length;
    while(lo<hi){const m=(lo+hi)>>1;if(funding[m].t<=entryTime)lo=m+1;else hi=m;}
    for(let k=lo;k<funding.length&&funding[k].t<=cutoff;k++){
      const f=funding[k];events++;
      let price=f.mark;
      if(!(Number.isFinite(price)&&price>0)){
        fallback++;
        let l=0,h=sol.length;while(l<h){const m=(l+h)>>1;if(sol[m].t<=f.t)l=m+1;else h=m;}
        const ix=l-1;
        if(ix>=0)price=sol[ix].t===f.t?sol[ix].o:sol[ix].c;
        else price=entry;
      }
      if(!(Number.isFinite(price)&&price>0)){unpriced++;continue;}
      cost+=dir*price*f.rate;
    }
    return {cost,events,fallback,unpriced};
  }
  function simulate(start,end,th,stopAtr,costBps,btcFilter){
    const trades=[];let eligible=0,confirmed=0,signals=0,held=0,turnover=0,fEvents=0,fFallback=0,fUnpriced=0;
    const lastSignal=end-cfg.timeStopBars-1;
    for(let i=Math.max(start,warmup+1);i<=lastSignal;i++){
      const ctx=label(i,si,th);
      let dir=ctx==="BULL_NORMAL"?1:ctx==="BEAR_NORMAL"?-1:0;
      if(dir!==0)eligible++;
      const b=btcLabel(i,th);
      const aligned=!btcFilter||(dir===1?b==="BULL":dir===-1?b==="BEAR":false);
      if(dir!==0&&aligned)confirmed++;
      if(dir===0||!aligned)continue;
      const prev=sol[i-1],cur=sol[i];
      const longSignal=dir===1&&prev.c<=si.e20[i-1]&&cur.c>si.e20[i]&&cur.c>cur.o;
      const shortSignal=dir===-1&&prev.c>=si.e20[i-1]&&cur.c<si.e20[i]&&cur.c<cur.o;
      if(!longSignal&&!shortSignal)continue;
      signals++;
      const entryIndex=i+1,entry=sol[entryIndex].o,risk=si.atr[i]*stopAtr;
      if(!(Number.isFinite(risk)&&risk>0))continue;
      const stop=entry-dir*risk,target=entry+dir*risk*cfg.targetR;
      if((dir===1&&entry<=stop)||(dir===-1&&entry>=stop))continue;
      let exitIndex=-1,exitPrice=null,reason="TIME",exitMode="TIME";
      for(let j=entryIndex;j<entryIndex+cfg.timeStopBars;j++){
        const bar=sol[j];
        if(j>entryIndex){
          if(dir===1&&bar.o<=stop){exitIndex=j;exitPrice=bar.o;reason="STOP_GAP";exitMode="INTRABAR";break;}
          if(dir===-1&&bar.o>=stop){exitIndex=j;exitPrice=bar.o;reason="STOP_GAP";exitMode="INTRABAR";break;}
          if(dir===1&&bar.o>=target){exitIndex=j;exitPrice=target;reason="TARGET_GAP_CONSERVATIVE";exitMode="INTRABAR";break;}
          if(dir===-1&&bar.o<=target){exitIndex=j;exitPrice=target;reason="TARGET_GAP_CONSERVATIVE";exitMode="INTRABAR";break;}
        }
        const stopHit=dir===1?bar.l<=stop:bar.h>=stop;
        const targetHit=dir===1?bar.h>=target:bar.l<=target;
        if(stopHit&&targetHit){exitIndex=j;exitPrice=stop;reason="STOP_BOTH_TOUCHED";exitMode="INTRABAR";break;}
        if(stopHit){exitIndex=j;exitPrice=stop;reason="STOP";exitMode="INTRABAR";break;}
        if(targetHit){exitIndex=j;exitPrice=target;reason="TARGET";exitMode="INTRABAR";break;}
        if(j===entryIndex+cfg.timeStopBars-1){exitIndex=j;exitPrice=bar.c;reason="TIME";exitMode="TIME";}
      }
      if(exitIndex<0||exitPrice===null)continue;
      const fund=fundingFor(dir,sol[entryIndex].t,exitIndex,exitMode,entry);
      const gross=dir*(exitPrice-entry),transactionCost=entry*costBps/10000,net=gross-transactionCost-fund.cost,netR=net/risk;
      const hold=exitIndex-entryIndex+1;
      trades.push({entryTime:sol[entryIndex].t,entryUtc:new Date(sol[entryIndex].t).toISOString(),exitTime:sol[exitIndex].t,exitUtc:new Date(sol[exitIndex].t).toISOString(),direction:dir===1?"LONG":"SHORT",context:ctx,btcTrend:b,entry,exit:exitPrice,stop,target,initialRisk:risk,grossPnl:gross,transactionCost,fundingCost:fund.cost,netPnl:net,netR,reason,holdingBars:hold,fundingEvents:fund.events,fundingFallbackEvents:fund.fallback,fundingUnpricedEvents:fund.unpriced});
      fEvents+=fund.events;fFallback+=fund.fallback;fUnpriced+=fund.unpriced;held+=hold;turnover+=entry+exitPrice;
      i=exitIndex;
    }
    return {trades,eligibleContextBars:eligible,btcConfirmedContextBars:confirmed,signals,heldBars:held,turnover,fundingEvents:fEvents,fundingFallback:fFallback,fundingUnpriced:fUnpriced};
  }
  function bootstrap(trades,alpha){
    if(trades.length<2)return null;
    const map=new Map();
    for(const t of trades){const w=Math.floor(t.entryTime/weekMs);if(!map.has(w))map.set(w,[]);map.get(w).push(t.netR);}
    const min=Math.min(...map.keys()),max=Math.max(...map.keys()),weeks=[];
    for(let w=min;w<=max;w++)weeks.push(map.get(w)||[]);
    let state=cfg.seed>>>0;
    function rand(){state=(1664525*state+1013904223)>>>0;return state/4294967296;}
    const means=[];
    for(let r=0;r<cfg.reps;r++){
      let sum=0,count=0;
      const blocks=Math.ceil(weeks.length/cfg.blockWeeks);
      for(let b=0;b<blocks;b++){
        const s=Math.floor(rand()*weeks.length);
        for(let j=0;j<cfg.blockWeeks;j++){
          const a=weeks[(s+j)%weeks.length];
          for(const v of a){sum+=v;count++;}
        }
      }
      if(count)means.push(sum/count);
    }
    means.sort((a,b)=>a-b);
    function q(p){const x=(means.length-1)*p,l=Math.floor(x),h=Math.ceil(x);return means[l]+(means[h]-means[l])*(x-l);}
    return {method:"circular moving-block bootstrap over contiguous UTC 7-day clusters",reps:means.length,blockLengthWeeks:cfg.blockWeeks,seed:cfg.seed,confidence:1-alpha,ci:[q(alpha/2),q(1-alpha/2)]};
  }
  function metrics(sim,start,end,alpha){
    const t=sim.trades,rs=t.map(x=>x.netR),wins=t.filter(x=>x.netPnl>0),losses=t.filter(x=>x.netPnl<0);
    const sum=a=>a.reduce((s,x)=>s+x,0),mean=a=>a.length?sum(a)/a.length:null;
    const pos=sum(t.map(x=>Math.max(0,x.netPnl))),neg=sum(t.map(x=>Math.min(0,x.netPnl)));
    let eq=0,peak=0,maxDD=0;
    for(const x of t){eq+=x.netR;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);}
    const sorted=[...rs].sort((a,b)=>a-b);
    return {eligibleContextObservations:sim.eligibleContextBars,btcConfirmedContextObservations:sim.btcConfirmedContextBars,signals:sim.signals,trades:t.length,winRateNet:t.length?wins.length/t.length:null,targetBeforeStopProbability:t.length?t.filter(x=>x.reason.startsWith("TARGET")).length/t.length:null,meanNetR:mean(rs),medianNetR:sorted.length?sorted[Math.floor(sorted.length/2)]:null,profitFactor:neg<0?pos/Math.abs(neg):pos>0?null:0,maxDrawdownR:maxDD,averageWinR:mean(wins.map(x=>x.netR)),averageLossR:mean(losses.map(x=>x.netR)),totalQuotePnlPerSol:sum(t.map(x=>x.netPnl)),averageQuotePnlPerTradePerSol:mean(t.map(x=>x.netPnl)),netReturnPct:sum(t.map(x=>x.netPnl))/Math.max(1,sum(t.map(x=>x.entry)))*100,averageHoldHours:mean(t.map(x=>x.holdingBars*4)),exposurePct:sim.heldBars/Math.max(1,end-start)*100,turnoverQuotePerSol:sim.turnover,fundingSettlements:sim.fundingEvents,fundingMarkPriceProxySettlements:sim.fundingFallback,fundingUnpricedSettlements:sim.fundingUnpriced,bootstrap:bootstrap(t,alpha)};
  }
  function contextSummary(start,end,th){
    const counts={},durations={},transitions={};
    let runLabel=null,run=0,prevTrend=null;
    for(let i=start;i<end;i++){
      const c=label(i,si,th);counts[c]=(counts[c]||0)+1;
      if(c!==runLabel){
        if(runLabel){if(!durations[runLabel])durations[runLabel]=[];durations[runLabel].push(run);}
        runLabel=c;run=1;
      }else run++;
      const trend=c.split("_")[0];
      if(prevTrend){if(!transitions[prevTrend])transitions[prevTrend]={};transitions[prevTrend][trend]=(transitions[prevTrend][trend]||0)+1;}
      prevTrend=trend;
    }
    if(runLabel){if(!durations[runLabel])durations[runLabel]=[];durations[runLabel].push(run);}
    const med=a=>{if(!a||!a.length)return null;const x=[...a].sort((p,q)=>p-q);return x[Math.floor(x.length/2)];};
    const medianDurationBars={};for(const k of Object.keys(durations))medianDurationBars[k]=med(durations[k]);
    return {counts,medianDurationBars,transitions};
  }
  function buyHold(start,end,costBps){
    const entry=sol[start].o,exit=sol[end-1].c,entryTime=sol[start].t;
    const fund=fundingFor(1,entryTime,end-1,"TIME",entry),gross=exit-entry,cost=entry*costBps/10000,net=gross-cost-fund.cost;
    return {entryUtc:new Date(entryTime).toISOString(),exitUtc:new Date(sol[end-1].ct).toISOString(),entry,exit,grossPnlPerSol:gross,transactionCostPerSol:cost,fundingCostPerSol:fund.cost,netPnlPerSol:net,netReturnPct:net/entry*100,fundingSettlements:fund.events,fundingFallbackEvents:fund.fallback};
  }
  const folds=[
    {name:"WF1",trainEnd:Math.floor(n*.40),valEnd:Math.floor(n*.50),testEnd:Math.floor(n*.60)},
    {name:"WF2",trainEnd:Math.floor(n*.50),valEnd:Math.floor(n*.60),testEnd:Math.floor(n*.70)},
    {name:"WF3",trainEnd:Math.floor(n*.60),valEnd:Math.floor(n*.70),testEnd:Math.floor(n*.80)}
  ];
  const walkForward=[];
  for(const f of folds){
    const th=fit(f.trainEnd);
    const val=simulate(f.trainEnd+embargo,f.valEnd,th,cfg.stopAtr,cfg.costBps,true);
    const test=simulate(f.valEnd+embargo,f.testEnd,th,cfg.stopAtr,cfg.costBps,true);
    walkForward.push({name:f.name,trainEndUtc:new Date(sol[f.trainEnd-1].ct).toISOString(),validationStartUtc:new Date(sol[f.trainEnd+embargo].t).toISOString(),validationEndUtc:new Date(sol[f.valEnd-1].ct).toISOString(),testStartUtc:new Date(sol[f.valEnd+embargo].t).toISOString(),testEndUtc:new Date(sol[f.testEnd-1].ct).toISOString(),thresholds:th,validation:metrics(val,f.trainEnd+embargo,f.valEnd,.05),test:metrics(test,f.valEnd+embargo,f.testEnd,.05)});
  }
  const trainEnd=Math.floor(n*.60),valEnd=Math.floor(n*.80),testStart=valEnd+embargo,th=fit(trainEnd);
  const validation=simulate(trainEnd+embargo,valEnd,th,cfg.stopAtr,cfg.costBps,true);
  const primary=simulate(testStart,n,th,cfg.stopAtr,cfg.costBps,true);
  const primaryMetrics=metrics(primary,testStart,n,.05/6);
  const byContext={};
  for(const c of ["BULL_NORMAL","BEAR_NORMAL"]){
    const sub={...primary,trades:primary.trades.filter(x=>x.context===c)};
    byContext[c]=metrics(sub,testStart,n,.05/6);
  }
  const neighbors=[1.25,1.5,1.75].map(stopAtr=>({stopAtr,metrics:metrics(simulate(testStart,n,th,stopAtr,15,true),testStart,n,.05/6)}));
  const btcAblation=metrics(simulate(testStart,n,th,1.5,15,false),testStart,n,.05/6);
  const costSensitivity=[10,15,20].map(costBps=>({roundTripBps:costBps,metrics:metrics(simulate(testStart,n,th,1.5,costBps,true),testStart,n,.05/6)}));
  const final={
    train:{startUtc:new Date(sol[warmup].t).toISOString(),endUtc:new Date(sol[trainEnd-1].ct).toISOString(),bars:trainEnd-warmup},
    validation:{startUtc:new Date(sol[trainEnd+embargo].t).toISOString(),endUtc:new Date(sol[valEnd-1].ct).toISOString(),bars:valEnd-trainEnd-embargo,metrics:metrics(validation,trainEnd+embargo,valEnd,.05)},
    untouchedTest:{startUtc:new Date(sol[testStart].t).toISOString(),endUtc:new Date(sol[n-1].ct).toISOString(),bars:n-testStart,metrics:primaryMetrics},
    thresholds:th,
    contextDistribution:contextSummary(testStart,n,th),
    byContext,
    parameterNeighborhood:neighbors,
    btcFilterAblation:btcAblation,
    costSensitivity,
    buyAndHold:buyHold(testStart,n,15)
  };
  const fundingAudit={rows:funding.length,duplicates:funding.length-new Set(funding.map(x=>x.t)).size,invalid:funding.filter(x=>!Number.isFinite(x.t)||!Number.isFinite(x.rate)).length,blankMarkPrice:funding.filter(x=>x.mark===null).length,firstUtc:new Date(funding[0].t).toISOString(),lastUtc:new Date(funding[funding.length-1].t).toISOString(),maxGapHours:Math.max(...funding.slice(1).map((x,i)=>(x.t-funding[i].t)/3600000))};
  return {data:{bars:n,startUtc:new Date(sol[0].t).toISOString(),endUtc:new Date(sol[n-1].ct).toISOString(),fundingAudit},parameters:cfg,walkForward,final};
};
