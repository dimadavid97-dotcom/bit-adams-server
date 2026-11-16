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

export function reviewSignal(direction,m5,m15,candles,levels,profile="STRICT") {
  const trend=trendAgent(direction,m5,m15,candles,profile);
  const entry=entryAgent(direction,m5,candles,levels,profile);
  const qualityScore=Math.min(99,Math.round(0.4*(m5?.confidence || 0)+0.35*(m15?.confidence || 0)+0.25*Math.min(100,50+trend.adx)));
  return {approved:trend.approved && entry.approved,qualityScore,trend,entry,
    reason:!trend.approved ? "Trend Agent: "+trend.reason : !entry.approved ? "Entry Agent: "+entry.reason : "STRONG M5 BUY/SELL: both agents approved"};
}
