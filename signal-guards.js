// BIT ADAMS: independent, deterministic entry reviewers.
// A score is setup quality, NOT a probability of profit.
const num = n => Number(n);
const finite = n => Number.isFinite(num(n));
const round = n => Math.round(n * 10) / 10;

export function calculateAdx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2 * period + 1) return {adx:0, plusDI:0, minusDI:0};
  let tr = 0, plus = 0, minus = 0;
  const dx = [];
  let previous = candles[0];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    if (![previous.high,previous.low,previous.close,current.high,current.low,current.close].every(finite)) return {adx:0,plusDI:0,minusDI:0};
    const range = Math.max(current.high-current.low,Math.abs(current.high-previous.close),Math.abs(current.low-previous.close));
    const up = current.high - previous.high;
    const down = previous.low - current.low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      tr += range; plus += pdm; minus += mdm;
    } else {
      tr = tr - tr / period + range;
      plus = plus - plus / period + pdm;
      minus = minus - minus / period + mdm;
    }
    if (i >= period) {
      const p = tr > 0 ? 100 * plus / tr : 0;
      const m = tr > 0 ? 100 * minus / tr : 0;
      dx.push({dx:p+m > 0 ? 100 * Math.abs(p-m)/(p+m) : 0,plusDI:p,minusDI:m});
    }
    previous = current;
  }
  if (dx.length < period) return {adx:0,plusDI:0,minusDI:0};
  let adx = dx.slice(0,period).reduce((total,point) => total+point.dx,0)/period;
  for (let i = period; i < dx.length; i++) adx = (adx*(period-1)+dx[i].dx)/period;
  const current = dx.at(-1);
  return {adx:round(adx),plusDI:round(current.plusDI),minusDI:round(current.minusDI)};
}

export function trendAgent(direction,m5,m15,candles,profile="STRICT") {
  const balanced=profile==="BALANCED";
  const d = direction === "BUY" ? 1 : direction === "SELL" ? -1 : 0;
  if (!d || !m5 || !m15 || !Array.isArray(candles)) return {approved:false,reason:"Missing market data"};
  const indicators = calculateAdx(candles);
  const emaGap = m5.atr > 0 ? Math.abs(m5.ema9-m5.ema21)/m5.atr : 0;
  const conditions = [
    [m5.confidence >= 70,"M5 score below 70"],
    [m15.signal === direction && m15.confidence >= 65,"M15 trend/score does not agree"],
    [d * (m5.ema9-m5.ema21) > 0,"M5 EMA trend disagrees"],
    [d * (m15.ema9-m15.ema21) > 0,"M15 EMA trend disagrees"],
    [d * m15.momentum > 0,"M15 momentum disagrees"],
    [indicators.adx >= (balanced?18:20),"Weak/ranging market (ADX too low)"],
    [d * (indicators.plusDI-indicators.minusDI) > 0,"ADX directional movement disagrees"],
    [emaGap >= (balanced?0.10:0.13),"EMAs too compressed for reliable direction"]
  ];
  const failed = conditions.find(([ok])=>!ok);
  return {approved:!failed,reason:failed ? failed[1] : "M5/M15 trend and ADX agree",adx:indicators.adx,plusDI:indicators.plusDI,minusDI:indicators.minusDI,emaGap:round(emaGap)};
}

export function entryAgent(direction,m5,candles,levels,profile="STRICT") {
  const balanced=profile==="BALANCED";
  if (!["BUY","SELL"].includes(direction) || !m5 || !Array.isArray(candles) || candles.length < 10) return {approved:false,reason:"Missing recent M5 candles"};
  const last = candles.at(-1);
  const sign = direction === "BUY" ? 1 : -1;
  const range = last.high-last.low;
  const bodyRatio = range > 0 ? Math.abs(last.close-last.open)/range : 0;
  const closeLocation = range > 0 ? (last.close-last.low)/range : 0.5;
  const closes = candles.slice(-8).map(c=>c.close);
  let travelled = 0;
  for (let i=1;i<closes.length;i++) travelled += Math.abs(closes[i]-closes[i-1]);
  const efficiency = travelled > 0 ? Math.abs(closes.at(-1)-closes[0])/travelled : 0;
  const risk = Math.abs(levels?.entry-levels?.sl);
  const reward2 = Math.abs(levels?.tp2-levels?.entry);
  const rr2 = risk > 0 ? reward2 / risk : 0;
  const conditions = [
    [range > 0 && m5.atr > 0,"No valid M5 volatility"],
    [sign * (last.close-last.open) > 0,"Last M5 candle contradicts direction"],
    [bodyRatio >= (balanced?0.40:0.45),"M5 confirmation candle has a small body"],
    [direction === "BUY" ? closeLocation >= (balanced?0.63:0.68) : closeLocation <= (balanced?0.37:0.32),"M5 candle closed without directional conviction"],
    [range <= m5.atr * 1.6,"M5 candle is unusually large"],
    [efficiency >= (balanced?0.25:0.28),"Recent M5 price action is choppy"],
    [sign * (closes.at(-1)-closes[0]) > 0,"Recent M5 price action disagrees"],
    [rr2 >= 1.3,"Reward/risk to TP2 is too small"]
  ];
  const failed = conditions.find(([ok])=>!ok);
  return {approved:!failed,reason:failed ? failed[1] : "M5 candle, structure and reward/risk agree",efficiency:round(efficiency),bodyRatio:round(bodyRatio),rr2:round(rr2)};
}

// An independent price-action/momentum reviewer. Uses the same already-fetched
// closed M5 candles; adding agents does not increase Twelve Data API usage.
export function momentumAgent(direction,m5,candles) {
  if (!["BUY","SELL"].includes(direction) || !m5 ||
      !Array.isArray(candles) || candles.length < 10) {
    return {approved:false,reason:"Missing momentum data"};
  }
  const sign=direction==="BUY"?1:-1;
  const last=candles.at(-1);
  const previous=candles.at(-2);
  const fourth=candles.at(-4);
  if (![last.open,last.close,previous.high,previous.low,fourth.close,
        m5.ema9,m5.ema21,m5.rsi,m5.momentum].every(finite)) {
    return {approved:false,reason:"Invalid M5 momentum values"};
  }
  const directionalCandle=sign*(last.close-last.open)>0;
  const emaAligned=sign*(m5.ema9-m5.ema21)>0;
  const recentAdvance=sign*(last.close-fourth.close)>0;
  const rsiAligned=direction==="BUY" ? m5.rsi>=50 && m5.rsi<=70 :
    m5.rsi<=50 && m5.rsi>=30;
  const breakout=direction==="BUY" ? last.close>previous.high :
    last.close<previous.low;
  const impulse=sign*m5.momentum>0;
  const approved=directionalCandle && emaAligned && recentAdvance &&
    rsiAligned && impulse && breakout;
  return {approved,reason:approved?"Momentum and M5 breakout agree":
    "No confirmed directional M5 momentum breakout",breakout,rsiAligned};
}

// Hard veto for both profiles: adding votes cannot override unsafe levels,
// a weak/oversized M5 candle or an already overextended entry.
export function riskAgent(direction,m5,candles,levels,profile="STRICT") {
  const balanced=profile==="BALANCED";
  if (!["BUY","SELL"].includes(direction) || !m5 ||
      !Array.isArray(candles) || !candles.length || !levels) {
    return {approved:false,reason:"Missing risk data"};
  }
  const last=candles.at(-1);
  const nums=[last.open,last.high,last.low,last.close,m5.atr,m5.price,
    m5.ema9,levels.entry,levels.sl,levels.tp1,levels.tp2,levels.tp3];
  if (!nums.every(v=>v!==null && v!==undefined && Number.isFinite(Number(v)))) {
    return {approved:false,reason:"Invalid trade or price levels"};
  }
  const sign=direction==="BUY"?1:-1;
  const range=last.high-last.low;
  const body=sign*(last.close-last.open);
  const bodyRatio=range>0?body/range:0;
  const closeLocation=range>0?(last.close-last.low)/range:0.5;
  const risk=sign*(levels.entry-levels.sl);
  const reward2=sign*(levels.tp2-levels.entry);
  const rr2=risk>0?reward2/risk:0;
  const conditions=[
    [m5.atr>0 && range>0 && bodyRatio>=(balanced?0.32:0.40),
      "Insufficient directional M5 candle body"],
    [direction==="BUY"?closeLocation>=0.53:closeLocation<=0.47,
      "M5 candle close lacks direction"],
    [range<=m5.atr*1.6,"M5 candle exceeds volatility safety limit"],
    [Math.abs(m5.price-m5.ema9)<=m5.atr*(balanced?1.30:1.00),
      "Entry too far from EMA9"],
    [risk>0 && rr2>=1.3,"Invalid stop loss or risk/reward below 1.3"],
    [sign*(levels.tp1-levels.entry)>0 &&
      sign*(levels.tp3-levels.tp2)>0,
      "Target levels disagree with trade direction"]
  ];
  const failure=conditions.find(([ok])=>!ok);
  return {approved:!failure,reason:failure?failure[1]:"M5 volatility, entry distance and levels acceptable",
    rr2:round(rr2),bodyRatio:round(bodyRatio)};
}

// Four independent reviewers. In BALANCED mode the Trend and Risk agents
// have veto rights and either Entry or Momentum must confirm (at least 3/4).
// STRICT mode retains full unanimity. This increases eligible setup types
// without permitting contradictory M15 trends or risky/unconfirmed entries.
export function reviewSignal(direction,m5,m15,candles,levels,profile="STRICT") {
  const trend=trendAgent(direction,m5,m15,candles,profile);
  const entry=entryAgent(direction,m5,candles,levels,profile);
  const momentum=momentumAgent(direction,m5,candles);
  const risk=riskAgent(direction,m5,candles,levels,profile);
  const votes=[trend,entry,momentum,risk].filter(agent=>agent.approved).length;
  const balanced=profile==="BALANCED";
  const approved=trend.approved && risk.approved &&
    (balanced ? (entry.approved || momentum.approved) :
      (entry.approved && momentum.approved));
  const qualityScore=Math.min(99,Math.round(0.4*(m5?.confidence || 0)+
    0.35*(m15?.confidence || 0)+0.25*Math.min(100,50+trend.adx)));
  const reason=!trend.approved?"Trend Agent: "+trend.reason :
    !risk.approved?"Risk Agent: "+risk.reason :
    !approved?"Entry/Momentum Agents: "+entry.reason+"; "+momentum.reason :
    "M5 "+votes+"/4 agents approved (Trend + Risk mandatory)";
  return {approved,qualityScore,votes,totalAgents:4,requiredVotes:balanced?3:4,
    trend,entry,momentum,risk,reason};
}


/**
 * ADAMS COMMANDER: final deterministic supervisory gate. It reuses
 * data already calculated by the four reviewers; no extra API calls.
 * A quality score describes setup quality, NOT the probability of winning.
 */
export function chiefAgent(direction,m5,m15,candles,levels,review) {
  const sign=direction==="BUY"?1:direction==="SELL"?-1:0;
  const last=Array.isArray(candles)?candles.at(-1):null;
  const entry=Number(levels?.entry),sl=Number(levels?.sl),tp2=Number(levels?.tp2);
  const risk=sign*(entry-sl),reward=sign*(tp2-entry);
  const conditions=[
    [Boolean(sign && last && m5 && m15 && levels),"Missing completed M5 market data"],
    [review?.approved===true,"Four-agent panel rejected setup"],
    [review?.trend?.approved===true && review?.risk?.approved===true,
      "Trend or Risk agent rejected setup"],
    [review?.entry?.approved===true,
      "Entry agent did not approve closed M5 candle"],
    [Number(review?.votes)>=3,"Fewer than 3 reviewers approved"],
    [Number.isFinite(Number(review?.qualityScore)) && Number(review.qualityScore)>=72,
      "Setup score below Chief threshold 72"],
    [m5?.signal===direction && m15?.signal===direction,
      "M5/M15 direction mismatch"],
    [Number.isFinite(risk) && Number.isFinite(reward) && risk>0 && reward/risk>=1.3,
      "Invalid stop or TP2 reward/risk"],
    [Boolean(last && Number.isFinite(Number(last.open)) &&
      Number.isFinite(Number(last.close)) &&
      sign*(Number(last.close)-Number(last.open))>0),
      "Closed M5 candle did not confirm direction"]
  ];
  const failure=conditions.find(([passed])=>!passed);
  return {
    approved:!failure,
    decision:failure?"HOLD":"GREEN_LIGHT",
    reason:failure?failure[1]:"Chief green light: Trend + Entry + Risk confirmed",
    votes:Number(review?.votes)||0,
    qualityScore:Number.isFinite(Number(review?.qualityScore))?Number(review.qualityScore):null,
    entryMandatory:true
  };
}
