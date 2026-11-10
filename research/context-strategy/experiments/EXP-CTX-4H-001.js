function analyzeCanonical4h(data) {
  const symbols = Object.keys(data).sort();
  const stepMs = 4 * 60 * 60 * 1000;
  const trainEnd = 8076, validationEnd = 10768, totalRows = 13461, warmup = 100;
  const quality = {};
  const allTimes = {};
  const features = {};
  function emaSeries(values, period) {
    const k = 2 / (period + 1), out = new Array(values.length);
    let e = values[0];
    for (let i = 0; i < values.length; i++) { e = i === 0 ? values[0] : values[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function quantile(values, p) {
    const a = values.slice().sort((x,y)=>x-y), pos=(a.length-1)*p, lo=Math.floor(pos), hi=Math.ceil(pos);
    return a[lo] + (a[hi]-a[lo])*(pos-lo);
  }
  function validateBars(symbol, bars) {
    const times=bars.map(x=>x.openTime), seen=new Set();
    let duplicates=0,gaps=0,ohlcFailures=0,nonPositiveVolume=0,nonFinite=0,nonMonotonic=0;
    for(let i=0;i<bars.length;i++){
      const x=bars[i];
      if(seen.has(x.openTime))duplicates++; seen.add(x.openTime);
      if(i>0){if(x.openTime<=bars[i-1].openTime)nonMonotonic++;if(x.openTime-bars[i-1].openTime!==stepMs)gaps++;}
      if(![x.openTime,x.open,x.high,x.low,x.close,x.volume,x.closeTime].every(Number.isFinite))nonFinite++;
      if(!(x.low<=Math.min(x.open,x.close)&&x.high>=Math.max(x.open,x.close)))ohlcFailures++;
      if(!(x.volume>0))nonPositiveVolume++;
    }
    quality[symbol]={rows:bars.length,firstOpenUtc:new Date(times[0]).toISOString(),lastOpenUtc:new Date(times.at(-1)).toISOString(),duplicates,gaps,ohlcFailures,nonPositiveVolume,nonFinite,nonMonotonic};
    allTimes[symbol]=times;
  }
  for(const s of symbols){
    const bars=data[s]; validateBars(s,bars);
    const closes=bars.map(x=>x.close), e20=emaSeries(closes,20), e50=emaSeries(closes,50);
    const tr=new Array(bars.length);
    for(let i=0;i<bars.length;i++){
      const x=bars[i],prev=i?bars[i-1].close:x.close;
      tr[i]=Math.max(x.high-x.low,Math.abs(x.high-prev),Math.abs(x.low-prev));
    }
    const f=new Array(bars.length);
    let rolling=0;
    for(let i=0;i<bars.length;i++){
      rolling+=tr[i]; if(i>=14)rolling-=tr[i-14];
      const atr=i>=13?rolling/14:null;
      f[i]=i>=warmup?{spreadPct:(e20[i]-e50[i])/closes[i]*100,momentum20Pct:(closes[i]/closes[i-20]-1)*100,volatilityPct:atr/closes[i]*100}:null;
    }
    features[s]=f;
  }
  const reference=allTimes[symbols[0]];
  const alignment=symbols.every(s=>allTimes[s].length===reference.length&&allTimes[s].every((t,i)=>t===reference[i]));
  const pooled=[];
  for(const s of symbols)for(let i=warmup;i<trainEnd;i++)if(features[s][i])pooled.push(features[s][i]);
  const thresholds={
    spreadAbsQ33:quantile(pooled.map(x=>Math.abs(x.spreadPct)),0.33),
    volatilityQ33:quantile(pooled.map(x=>x.volatilityPct),0.33),
    volatilityQ67:quantile(pooled.map(x=>x.volatilityPct),0.67),
    volatilityQ99:quantile(pooled.map(x=>x.volatilityPct),0.99),
    trainingFeatureRows:pooled.length
  };
  function label(f){
    if(!f)return "UNKNOWN";
    if(f.volatilityPct>thresholds.volatilityQ99)return "SHOCK";
    const vol=f.volatilityPct<thresholds.volatilityQ33?"LOW":f.volatilityPct<thresholds.volatilityQ67?"NORMAL":"HIGH";
    let trend;
    if(Math.abs(f.spreadPct)<thresholds.spreadAbsQ33)trend="SIDEWAYS";
    else if(f.spreadPct>0&&f.momentum20Pct>0)trend="UP";
    else if(f.spreadPct<0&&f.momentum20Pct<0)trend="DOWN";
    else trend="TRANSITION";
    return trend+"_"+vol;
  }
  const labels={}; for(const s of symbols)labels[s]=features[s].map(label);
  const segments={TRAIN:[0,trainEnd],VALIDATION:[trainEnd,validationEnd],TEST:[validationEnd,totalRows]};
  const contextNames=["UP_LOW","UP_NORMAL","UP_HIGH","DOWN_LOW","DOWN_NORMAL","DOWN_HIGH","SIDEWAYS_LOW","SIDEWAYS_NORMAL","SIDEWAYS_HIGH","TRANSITION_LOW","TRANSITION_NORMAL","TRANSITION_HIGH","SHOCK","UNKNOWN"];
  function statsFor(seq,start,end){
    const xs=seq.slice(start,end).filter(x=>x!=="UNKNOWN");
    const counts={};for(const x of contextNames)counts[x]=0;for(const x of xs)counts[x]=(counts[x]||0)+1;
    const total=xs.length,frequencyPct={};for(const x of contextNames)frequencyPct[x]=total?counts[x]/total*100:0;
    const runs=[];let cur=null,len=0;
    for(const x of seq.slice(start,end)){if(x==="UNKNOWN")continue;if(x===cur)len++;else{if(cur!==null)runs.push({context:cur,length:len});cur=x;len=1;}}
    if(cur!==null)runs.push({context:cur,length:len});
    const durations={};for(const x of contextNames){const rs=runs.filter(r=>r.context===x).map(r=>r.length).sort((a,b)=>a-b);if(rs.length)durations[x]={runs:rs.length,meanBars:rs.reduce((a,b)=>a+b,0)/rs.length,medianBars:rs[Math.floor((rs.length-1)/2)],meanHours:rs.reduce((a,b)=>a+b,0)/rs.length*4};}
    const trans={};for(let i=start+1;i<end;i++){const a=seq[i-1],b=seq[i];if(a==="UNKNOWN"||b==="UNKNOWN")continue;const k=a+"->"+b;trans[k]=(trans[k]||0)+1;}
    const byFrom={};for(const[k,v]of Object.entries(trans)){const from=k.split("->")[0];byFrom[from]=(byFrom[from]||0)+v;}
    const top=Object.entries(trans).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>({transition:k,count:v,probability:byFrom[k.split("->")[0]]?v/byFrom[k.split("->")[0]]:0}));
    return {bars:total,counts,frequencyPct,durations,transitionCount:Object.values(trans).reduce((a,b)=>a+b,0),topTransitions:top};
  }
  function pearson(a,b){const n=a.length,ma=a.reduce((x,y)=>x+y,0)/n,mb=b.reduce((x,y)=>x+y,0)/n;let num=0,da=0,db=0;for(let i=0;i<n;i++){const x=a[i]-ma,y=b[i]-mb;num+=x*y;da+=x*x;db+=y*y;}return da&&db?num/Math.sqrt(da*db):null;}
  function jsd(a,b){const sa=a.reduce((x,y)=>x+y,0),sb=b.reduce((x,y)=>x+y,0);let out=0;for(let i=0;i<a.length;i++){const p=sa?a[i]/sa:0,q=sb?b[i]/sb:0,m=(p+q)/2;if(p>0)out+=0.5*p*Math.log2(p/m);if(q>0)out+=0.5*q*Math.log2(q/m);}return out;}
  const perSymbol={},combined={};
  for(const [seg,[start,end]] of Object.entries(segments)){
    const counts={};for(const x of contextNames)counts[x]=0;
    const durations={};let transitionTotal=0,topTransitions={};
    for(const s of symbols){
      const st=statsFor(labels[s],Math.max(start,warmup),end);
      perSymbol[s]=perSymbol[s]||{};perSymbol[s][seg]=st;
      for(const x of contextNames)counts[x]+=st.counts[x]||0;
      for(const [x,d] of Object.entries(st.durations)){durations[x]=durations[x]||{runs:0,totalBars:0};durations[x].runs+=d.runs;durations[x].totalBars+=d.meanBars*d.runs;}
      transitionTotal+=st.transitionCount;
      for(const t of st.topTransitions){topTransitions[t.transition]=(topTransitions[t.transition]||0)+t.count;}
    }
    const total=Object.values(counts).reduce((a,b)=>a+b,0),frequencyPct={};for(const x of contextNames)frequencyPct[x]=total?counts[x]/total*100:0;
    combined[seg]={bars:total,counts,frequencyPct,durations:Object.fromEntries(Object.entries(durations).map(([k,v])=>[k,{runs:v.runs,meanBars:v.totalBars/v.runs,meanHours:v.totalBars/v.runs*4}])),transitionCount:transitionTotal,topTransitions:Object.entries(topTransitions).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([transition,count])=>({transition,count}))};
  }
  const names=contextNames.filter(x=>["TRAIN","VALIDATION","TEST"].some(seg=>combined[seg].counts[x]>0));
  const vectors=Object.fromEntries(["TRAIN","VALIDATION","TEST"].map(seg=>[seg,names.map(x=>combined[seg].counts[x])]));
  const stability={trainValidationPearson:pearson(vectors.TRAIN,vectors.VALIDATION),trainTestPearson:pearson(vectors.TRAIN,vectors.TEST),trainValidationJSD:jsd(vectors.TRAIN,vectors.VALIDATION),trainTestJSD:jsd(vectors.TRAIN,vectors.TEST),sparseTestContexts:names.filter(x=>combined.TEST.frequencyPct[x]<1).map(x=>({context:x,frequencyPct:combined.TEST.frequencyPct[x]}))};
  stability.gates={frequencyPass:stability.sparseTestContexts.length===0,correlationPass:stability.trainTestPearson!==null&&stability.trainTestPearson>=0.70,jsdPass:stability.trainTestJSD<=0.15};
  stability.overallPass=stability.gates.frequencyPass&&stability.gates.correlationPass&&stability.gates.jsdPass;
  return {experimentId:"EXP-CTX-4H-001",status:"COMPLETED_CONTEXT_DISCOVERY_NOT_STRATEGY_OOS",symbols,timeframe:"4h",rowsPerSymbol:totalRows,split:segments,warmupBars:warmup,thresholds,quality:{perSymbol:quality,crossSymbolAligned:alignment},combined,perSymbol,stability,interpretation:"Descriptive context taxonomy stability only. No strategy, trade, target probability, expectancy or OOS trading claim."};
}