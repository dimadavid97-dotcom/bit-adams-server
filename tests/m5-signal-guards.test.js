import test from "node:test";
import assert from "node:assert/strict";
import {calculateAdx, trendAgent, entryAgent, reviewSignal} from "../signal-guards.js";

function series(direction=1,n=80,flat=false) {
  const arr=[];
  let price=100;
  for (let i=0;i<n;i++) {
    const move=flat?0: direction*(1.1 + (i%7===0?-0.14:0.06));
    const open=price, close=open+move;
    const high=Math.max(open,close)+(flat?0.02:0.19);
    const low=Math.min(open,close)-(flat?0.02:0.19);
    arr.push({datetime:new Date(Date.UTC(2026,10,12,8,0)+i*300000).toISOString(),
      open, high, low, close});
    price=close;
  }
  return arr;
}

function setup(direction=1) {
  const buy=direction===1;
  const candles=series(direction);
  const entry=candles.at(-1).close;
  const m5={signal:buy?"BUY":"SELL",confidence:90,price:entry,atr:2,
    ema9:entry-direction*.4,ema21:entry-direction*1.1,rsi:buy?58:42,momentum:direction*.12};
  const m15={...m5,confidence:87,ema9:entry-direction*.8,ema21:entry-direction*1.9,
    momentum:direction*.2};
  const levels={entry,sl:entry-direction*3,tp1:entry+direction*3,tp2:entry+direction*5.5,tp3:entry+direction*8};
  return {candles,m5,m15,levels,side:buy?"BUY":"SELL"};
}

test("rising candles show directional ADX",()=>{
  const a=calculateAdx(series(1));
  assert.ok(a.adx>=20);
  assert.ok(a.plusDI>a.minusDI);
});
test("falling candles show directional ADX",()=>{
  const a=calculateAdx(series(-1));
  assert.ok(a.adx>=20);
  assert.ok(a.minusDI>a.plusDI);
});
test("flat candles do not show strong ADX",()=>{
  const a=calculateAdx(series(1,80,true));
  assert.ok(a.adx<20);
});
test("both reviewers accept strong uptrend in synthetic data",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  const r=reviewSignal(side,m5,m15,candles,levels);
  assert.equal(r.approved,true,JSON.stringify(r));
  assert.ok(r.qualityScore>=0 && r.qualityScore<=99);
});
test("both reviewers accept strong downtrend in synthetic data",()=>{
  const {candles,m5,m15,levels,side}=setup(-1);
  const r=reviewSignal(side,m5,m15,candles,levels);
  assert.equal(r.approved,true,JSON.stringify(r));
});
test("M15 disagreement blocks trade",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  m15.signal="SELL";
  const r=reviewSignal(side,m5,m15,candles,levels);
  assert.equal(r.approved,false);
  assert.match(r.reason,/M15/);
});
test("weak M5 score blocks trade",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  m5.confidence=60;
  assert.equal(trendAgent(side,m5,m15,candles).approved,false);
});
test("thin body confirmation is rejected",()=>{
  const {candles,m5,levels,side}=setup(1);
  const last=candles.at(-1);
  last.open=last.close-0.01;
  last.high=last.close+1;
  last.low=last.open-1;
  assert.equal(entryAgent(side,m5,candles,levels).approved,false);
});
test("unfavourable reward/risk is rejected",()=>{
  const {candles,m5,levels,side}=setup(1);
  levels.tp2=levels.entry+.5;
  assert.equal(entryAgent(side,m5,candles,levels).approved,false);
});
test("missing data is rejected",()=>{
  const r=reviewSignal("BUY",null,null,[],{});
  assert.equal(r.approved,false);
});
