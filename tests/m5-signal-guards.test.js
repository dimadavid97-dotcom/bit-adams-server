import test from "node:test";
import assert from "node:assert/strict";
import {calculateAdx, trendAgent, entryAgent, momentumAgent, riskAgent, reviewSignal} from "../signal-guards.js";

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

test("strict remains default when no profile is specified",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  assert.deepEqual(reviewSignal(side,m5,m15,candles,levels),
    reviewSignal(side,m5,m15,candles,levels,"STRICT"));
});

test("balanced never overrides M15 directional conflict",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  m15.signal="SELL";
  assert.equal(reviewSignal(side,m5,m15,candles,levels,"BALANCED").approved,false);
});

test("balanced rejects thin candle and missing data",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  const last=candles.at(-1);
  last.open=last.close-0.01;
  last.high=last.close+1;
  last.low=last.open-1;
  assert.equal(reviewSignal(side,m5,m15,candles,levels,"BALANCED").approved,false);
  assert.equal(reviewSignal("BUY",null,null,[],{},"BALANCED").approved,false);
});

test("balanced still requires reward risk and directional trend",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  levels.tp2=levels.entry+.5;
  assert.equal(reviewSignal(side,m5,m15,candles,levels,"BALANCED").approved,false);
  levels.tp2=levels.entry+5.5;
  m15.momentum=-0.3;
  assert.equal(reviewSignal(side,m5,m15,candles,levels,"BALANCED").approved,false);
});

test("balanced four-agent quorum accepts controlled strong breakout",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  const review=reviewSignal(side,m5,m15,candles,levels,"BALANCED");
  assert.equal(review.approved,true,JSON.stringify(review));
  assert.equal(review.totalAgents,4);
  assert.ok(review.votes>=3);
  assert.equal(momentumAgent(side,m5,candles).approved,true);
  assert.equal(riskAgent(side,m5,candles,levels,"BALANCED").approved,true);
});

test("four-agent quorum cannot override bad M15 direction or invalid levels",()=>{
  const {candles,m5,m15,levels,side}=setup(-1);
  m15.signal="BUY";
  assert.equal(reviewSignal(side,m5,m15,candles,levels,"BALANCED").approved,false);
  m15.signal="SELL";
  levels.sl=levels.entry+1; // SL must be above entry on a sell, but too close to meet R:R?
  levels.sl=levels.entry-1; // Clearly invalid: sell SL is below entry.
  const result=reviewSignal(side,m5,m15,candles,levels,"BALANCED");
  assert.equal(result.risk.approved,false);
  assert.equal(result.approved,false);
});

test("four-agent setup rejects fake momentum and incomplete candles",()=>{
  const {candles,m5,m15,levels,side}=setup(1);
  m5.momentum=-0.2;
  assert.equal(momentumAgent(side,m5,candles).approved,false);
  assert.equal(reviewSignal(side,m5,m15,candles,levels,"BALANCED").trend.approved,true);
  const incomplete=candles.slice(0,3);
  assert.equal(momentumAgent(side,m5,incomplete).approved,false);
});
