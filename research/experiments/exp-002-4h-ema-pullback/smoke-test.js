#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const {buildFeatures,resolveExit,runExperiment}=require("./core.js");
const target=resolveExit([{o:100,h:111,l:99,c:110,ct:1}],0,1,100,95,110,1,1);
assert.equal(target.reason,"TARGET");
const both=resolveExit([{o:100,h:111,l:94,c:100,ct:1}],0,1,100,95,110,1,1);
assert.equal(both.reason,"STOP_BOTH");
assert.equal(both.stopHit,true);
const fixture=[];
for(let i=0;i<120;i++){const c=100+i*0.35+1.2*Math.sin(i/4);fixture.push({t:i*14400000,o:c-0.1,h:c+0.7,l:c-0.7,c,v:100,ct:(i+1)*14400000-1});}
const cfg={emaFast:20,emaSlow:50,atrPeriod:14};
const f1=buildFeatures(fixture,cfg);
const altered=fixture.map((b,i)=>i<=80?{...b}:{...b,o:b.o*1.3,h:b.h*1.3,l:b.l*1.3,c:b.c*1.3});
const f2=buildFeatures(altered,cfg);
for(let i=0;i<=80;i++)for(const k of ["emaFast","emaSlow","atr","strength","vol"])assert.equal(f1[i][k],f2[i][k],"lookahead prefix invariant "+k+" at "+i);
const rcfg={experiment:"SMOKE",symbols:["SOLUSDT"],emaFast:2,emaSlow:3,atrPeriod:2,warmupBars:10,trainFraction:0.7,validationFraction:0.15,embargoBars:2,stopAtr:1.5,targetR:2,maxHoldBars:2,equity:1000,riskPct:0.01,riskUsd:10,costBpsRoundTrip:15,costSensitivityBps:[12,15,25],validationStopAtrNeighborhood:[1.25,1.5,1.75],minimumOosTrades:100,bootstrapReplicates:100,bootstrapBlockTrades:2,bootstrapSeed:1};
const result=runExperiment({SOLUSDT:fixture,BTCUSDT:fixture},rcfg,{SOLUSDT:[]});
assert.deepEqual(Object.keys(result.symbols),["SOLUSDT"]);
console.log("PASS: deterministic fixture, stop-first intrabar rule, no-lookahead prefix invariance, BTC reference-only filter.");