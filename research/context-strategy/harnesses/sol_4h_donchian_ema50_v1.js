
function buildFeatures(bars,lookback){
 const n=bars.length,ema=new Array(n).fill(null),atr=new Array(n).fill(null),priorHigh=new Array(n).fill(null),priorLow=new Array(n).fill(null),context=new Array(n).fill("INSUFFICIENT_DATA");
 const alpha=2/(50+1);if(n){ema[0]=bars[0].c;for(let i=1;i<n;i++)ema[i]=bars[i].c*alpha+ema[i-1]*(1-alpha);}
 const tr=new Array(n).fill(null);for(let i=0;i<n;i++){const prev=i?bars[i-1].c:bars[i].c;tr[i]=Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-prev),Math.abs(bars[i].l-prev));}
 if(n>=14){let s=0;for(let i=0;i<14;i++)s+=tr[i];atr[13]=s/14;for(let i=14;i<n;i++)atr[i]=(atr[i-1]*13+tr[i])/14;}
 for(let i=lookback;i<n;i++){let hi=-Infinity,lo=Infinity;for(let j=i-lookback;j<i;j++){if(bars[j].h>hi)hi=bars[j].h;if(bars[j].l<lo)lo=bars[j].l;}priorHigh[i]=hi;priorLow[i]=lo;}
 for(let i=60;i<n;i++){if(atr[i]===null||!Number.isFinite(atr[i])||atr[i]<=0)continue;if(bars[i].c>ema[i]&&ema[i]>ema[i-10])context[i]="BULL";else if(bars[i].c<ema[i]&&ema[i]<ema[i-10])context[i]="BEAR";else context[i]="TRANSITION";}
 return {ema,atr,priorHigh,priorLow,context};
}
function buildSignals(bars,params){
 const f=buildFeatures(bars,params.lookback),out=new Array(bars.length).fill(null);
 for(let i=60;i<bars.length-1;i++){let dir=0;if(bars[i].c>f.priorHigh[i])dir=1;else if(bars[i].c<f.priorLow[i])dir=-1;if(!dir)continue;const ctx=f.context[i];if(params.trendFilter&&((dir===1&&ctx!=="BULL")||(dir===-1&&ctx!=="BEAR")))continue;out[i]={signalIndex:i,entryIndex:i+1,direction:dir,context:ctx,atr:f.atr[i]};}
 return {features:f,signals:out};
}
function lowerBound(arr,t){let l=0,r=arr.length;while(l<r){let m=(l+r)>>1;if(arr[m].t<t)l=m+1;else r=m;}return l;}
function upperBound(arr,t){let l=0,r=arr.length;while(l<r){let m=(l+r)>>1;if(arr[m].t<=t)l=m+1;else r=m;}return l;}
function prevCloseBefore(bars,t){let l=0,r=bars.length;while(l<r){let m=(l+r)>>1;if(bars[m].ct<t)l=m+1;else r=m;}return l>0?bars[l-1].c:null;}
function runSegment(bars,funding,params,startTs,endTs){
 const built=buildSignals(bars,params),f=built.features,signals=built.signals,startIdx=lowerBound(bars,startTs),endIdx=upperBound(bars,endTs)-1,totalBars=Math.max(0,endIdx-startIdx+1);
 const initial=params.initialCapital||10000;let equity=initial,peak=initial,maxDD=0,lastExit=startIdx-1,trades=[];
 const contextCounts={BULL:0,BEAR:0,TRANSITION:0,INSUFFICIENT_DATA:0},signalCounts={BULL:0,BEAR:0,TRANSITION:0,INSUFFICIENT_DATA:0};
 for(let i=startIdx;i<=endIdx;i++){const c=f.context[i]||"INSUFFICIENT_DATA";contextCounts[c]=(contextCounts[c]||0)+1;}
 for(let i=Math.max(60,startIdx-1);i<endIdx;i++){
  const s=signals[i];if(!s)continue;const entryIdx=i+1,entryTime=bars[entryIdx].t;
  if(entryTime<startTs||entryTime>endTs||entryIdx<=lastExit)continue;
  signalCounts[s.context]=(signalCounts[s.context]||0)+1;
  if(entryIdx+params.maxHoldBars-1>endIdx)continue;
  const entryRaw=bars[entryIdx].o,stopDist=s.atr*params.stopAtr;if(!Number.isFinite(stopDist)||stopDist<=0||!Number.isFinite(entryRaw)||entryRaw<=0)continue;
  const qty=Math.min(equity*params.riskPct/stopDist,equity*params.maxLeverage/entryRaw);if(!Number.isFinite(qty)||qty<=0)continue;
  const adverse=params.halfSpread+params.slippage,entryFill=entryRaw*(1+s.direction*adverse),stop=entryFill-s.direction*stopDist,target=entryFill+s.direction*stopDist*params.targetR;
  const maxJ=Math.min(entryIdx+params.maxHoldBars-1,endIdx);let exitIdx=maxJ,exitRaw=bars[maxJ].c,exitReason="TIME_STOP";
  for(let j=entryIdx;j<=maxJ;j++){const b=bars[j],stopHit=s.direction===1?b.l<=stop:b.h>=stop,targetHit=s.direction===1?b.h>=target:b.l<=target;if(stopHit&&targetHit){exitIdx=j;exitRaw=stop;exitReason="STOP_BOTH_TOUCHED_STOP_FIRST";break;}if(stopHit){exitIdx=j;exitRaw=stop;exitReason="STOP";break;}if(targetHit){exitIdx=j;exitRaw=target;exitReason="TARGET";break;}}
  const exitFill=exitRaw*(1-s.direction*adverse),entryNotional=qty*entryFill,exitNotional=qty*exitFill,fee=params.feeRate*(entryNotional+exitNotional),executionCost=qty*(Math.abs(entryFill-entryRaw)+Math.abs(exitFill-exitRaw)),pricePnl=s.direction*qty*(exitFill-entryFill);
  const exitBarOpen=bars[exitIdx].t;let fundingCashflow=0,fundingEvents=0,fallbackEvents=0;let fr=lowerBound(funding,entryTime);
  while(fr<funding.length&&funding[fr].t<=exitBarOpen){const z=funding[fr],p=Number.isFinite(z.mp)&&z.mp>0?z.mp:(prevCloseBefore(bars,z.t)||entryRaw);if(!Number.isFinite(z.mp)||z.mp<=0)fallbackEvents++;fundingCashflow+=-s.direction*qty*p*z.r;fundingEvents++;fr++;}
  const netPnl=pricePnl-fee+fundingCashflow,riskQuote=qty*stopDist,netR=netPnl/riskQuote,equityBefore=equity;equity=Math.max(0,equity+netPnl);if(equity>peak)peak=equity;const dd=peak>0?(peak-equity)/peak:0;if(dd>maxDD)maxDD=dd;
  trades.push({direction:s.direction,context:s.context,signalTime:bars[i].t,entryTime,exitBarOpen,exitCloseTime:bars[exitIdx].ct,entryRaw,entryFill,exitRaw,exitFill,qty,stopDistance:stopDist,riskQuote,pricePnl,fees:fee,executionCost,fundingCashflow,fundingEvents,fallbackEvents,netPnl,netR,holdBars:exitIdx-entryIdx+1,exitReason,equityBefore,equityAfter:equity});
  lastExit=exitIdx;
 }
 return {trades,signals,contextCounts,signalCounts,totalBars,initialEquity:initial,endingEquity:equity,maxDrawdownPct:maxDD*100,startIdx,endIdx};
}
function bootstrapCI(values,blockSize,reps,alpha,seed){const n=values.length;if(n<2)return null;let x=seed>>>0;const rand=()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};const means=[];for(let b=0;b<reps;b++){let sum=0,count=0;while(count<n){const st=Math.floor(rand()*n);for(let k=0;k<blockSize&&count<n;k++){sum+=values[(st+k)%n];count++;}}means.push(sum/n);}means.sort((a,b)=>a-b);return [means[Math.floor((alpha/2)*(reps-1))],means[Math.floor((1-alpha/2)*(reps-1))]];}
function wilson(k,n,z){if(!n)return null;const p=k/n,d=1+z*z/n,ctr=(p+z*z/(2*n))/d,rad=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [Math.max(0,ctr-rad),Math.min(1,ctr+rad)];}
function summarize(trades,totalBars,alpha,seed){const n=trades.length;if(!n)return {trades:0,winRatePct:null,targetBeforeStopPct:null,meanNetR:null,profitFactor:null,netPnlUSDT:0,maxDrawdownR:null,blockBootstrapCI_R:null};const wins=trades.filter(t=>t.netPnl>0),losses=trades.filter(t=>t.netPnl<0),targets=trades.filter(t=>t.exitReason==="TARGET"),pos=wins.reduce((a,t)=>a+t.netPnl,0),neg=losses.reduce((a,t)=>a+t.netPnl,0),net=trades.reduce((a,t)=>a+t.netPnl,0),rs=trades.map(t=>t.netR),mean=rs.reduce((a,b)=>a+b,0)/n;let cum=0,peak=0,maxDD=0;for(const r of rs){cum+=r;if(cum>peak)peak=cum;if(peak-cum>maxDD)maxDD=peak-cum;}return {trades:n,winRatePct:wins.length/n*100,winRateCI95:wilson(wins.length,n,1.96).map(x=>x*100),targetBeforeStopPct:targets.length/n*100,targetBeforeStopCI95:wilson(targets.length,n,1.96).map(x=>x*100),meanNetR:mean,medianNetR:[...rs].sort((a,b)=>a-b)[Math.floor(n/2)],profitFactor:neg<0?pos/Math.abs(neg):null,netPnlUSDT:net,netReturnOnInitialPct:net/10000*100,averageWinR:wins.length?wins.reduce((a,t)=>a+t.netR,0)/wins.length:null,averageLossR:losses.length?losses.reduce((a,t)=>a+t.netR,0)/losses.length:null,averageHoldBars:trades.reduce((a,t)=>a+t.holdBars,0)/n,exposurePct:totalBars?trades.reduce((a,t)=>a+t.holdBars,0)/totalBars*100:null,turnoverXInitial:trades.reduce((a,t)=>a+t.qty*(t.entryFill+t.exitFill),0)/10000,feesUSDT:trades.reduce((a,t)=>a+t.fees,0),executionCostsUSDT:trades.reduce((a,t)=>a+t.executionCost,0),fundingCashflowUSDT:trades.reduce((a,t)=>a+t.fundingCashflow,0),fundingEvents:trades.reduce((a,t)=>a+t.fundingEvents,0),fallbackMarkEvents:trades.reduce((a,t)=>a+t.fallbackEvents,0),maxDrawdownR:maxDD,blockBootstrapCI_R:bootstrapCI(rs,5,2000,alpha,seed)};}
function contextStats(contexts,startIdx,endIdx){const counts={BULL:0,BEAR:0,TRANSITION:0,INSUFFICIENT_DATA:0},durations={BULL:[],BEAR:[],TRANSITION:[],INSUFFICIENT_DATA:[]},transitions={BULL:{BULL:0,BEAR:0,TRANSITION:0},BEAR:{BULL:0,BEAR:0,TRANSITION:0},TRANSITION:{BULL:0,BEAR:0,TRANSITION:0}};let prev=null,run=0;for(let i=startIdx;i<=endIdx;i++){const c=contexts[i]||"INSUFFICIENT_DATA";counts[c]=(counts[c]||0)+1;if(prev===null){prev=c;run=1;}else if(c===prev)run++;else{durations[prev].push(run);if(transitions[prev]&&transitions[prev][c]!==undefined)transitions[prev][c]++;prev=c;run=1;}}if(prev!==null)durations[prev].push(run);const avg={};for(const c of Object.keys(durations))avg[c]=durations[c].length?durations[c].reduce((a,b)=>a+b,0)/durations[c].length:null;return {counts,run_count:Object.fromEntries(Object.entries(durations).map(([k,v])=>[k,v.length])),average_duration_bars:avg,transitions};}
return {buildFeatures,buildSignals,runSegment,bootstrapCI,summarize,contextStats,lowerBound,upperBound};
