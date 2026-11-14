#!/usr/bin/env node
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {runExperiment}=require("./core.js");
const root=process.cwd(),dir=__dirname;
const cfg=JSON.parse(fs.readFileSync(path.join(dir,"config.json"),"utf8"));
const data={},funding={};
for(const s of cfg.symbols){
 const p=path.resolve(root,cfg.input_paths[s].path);
 data[s]=fs.readFileSync(p,"utf8").trim().split(/\r?\n/).map(line=>{const a=JSON.parse(line);return{t:+a[0],o:+a[1],h:+a[2],l:+a[3],c:+a[4],v:+a[5],ct:+a[6]};});
 const fp=path.resolve(root,cfg.funding_paths[s]);
 funding[s]=JSON.parse(fs.readFileSync(fp,"utf8")).map(x=>({fundingTime:+x.fundingTime,markPrice:+x.markPrice,fundingRate:+x.fundingRate})).sort((a,b)=>a.fundingTime-b.fundingTime);
}
const results=runExperiment(data,cfg,funding);
const n=data[cfg.symbols[0]].length,valEnd=Math.floor(n*(cfg.trainFraction+cfg.validationFraction));
const testStart=valEnd+cfg.embargoBars,testEnd=n-cfg.embargoBars;
for(const s of cfg.symbols){
 const bars=data[s],rows=funding[s],start=bars[testStart].t,end=bars[testEnd-1].ct;
 const first=Math.ceil(start/(8*3600000))*(8*3600000),expected=first<=end?Math.floor((end-first)/(8*3600000))+1:0;
 let maxGap=0;for(let i=1;i<rows.length;i++)maxGap=Math.max(maxGap,rows[i].fundingTime-rows[i-1].fundingTime);
 results.symbols[s].oos.funding_coverage={rows:rows.length,expected_settlements_in_test:expected,first_time_utc:rows[0]?new Date(rows[0].fundingTime).toISOString():null,last_time_utc:rows.at(-1)?new Date(rows.at(-1).fundingTime).toISOString():null,max_gap_hours:maxGap/3600000,complete:rows.length===expected&&maxGap<=8*3600000+1000};
 if(!results.symbols[s].oos.funding_coverage.complete)results.symbols[s].evidence_status="INSUFFICIENT_EVIDENCE";
}
results.reference_symbol={symbol:cfg.reference_symbol,role:"REGIME_AND_CONFIRMATION_REFERENCE_ONLY",strategy_evaluated:false};
const out=path.join(dir,"results.repro.json");
fs.writeFileSync(out,JSON.stringify(results,null,2)+"\n");
console.log(JSON.stringify({output:out,symbols:Object.keys(results.symbols),test_window:results.symbols[cfg.symbols[0]].sample.test,status:Object.fromEntries(cfg.symbols.map(s=>[s,results.symbols[s].evidence_status]))},null,2));