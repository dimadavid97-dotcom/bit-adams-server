import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 10000);
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || "";
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "";
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const SCAN_CACHE_MS = 60_000;
const SIGNAL_COOLDOWN_MS = 15 * 60_000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.text({ type: ["text/plain", "application/text"], limit: "100kb" }));

let scanCache = null;
let scanCacheAt = 0;
let scanPromise = null;
const liveTrades = new Map();
const lastSignalAt = new Map();

const clean = value => value == null ? "" : String(value).trim();
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

function normalizePayload(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(String(body).trim()); }
  catch { return { message: String(body).trim() }; }
}

function normalizeSymbol(value) {
  const symbol = clean(value).toUpperCase().replace(/OANDA:|FOREXCOM:|BINANCE:|TVC:|\//g, "");
  if (symbol.includes("XAUUSD") || symbol === "GOLD") return "XAUUSD";
  if (symbol.includes("BTCUSD") || symbol.includes("BTCUSDT") || symbol === "BITCOIN") return "BTCUSD";
  return symbol || "MARKET";
}

const symbolLabel = symbol => symbol === "XAUUSD" ? "GOLD" : symbol === "BTCUSD" ? "BITCOIN" : symbol;

function detectEvent(payload) {
  const raw = clean(payload.event || payload.action || payload.signal || payload.type || payload.side || payload.status || payload.message).toUpperCase();
  if (/BREAK[ -]?EVEN|\bBE\b/.test(raw)) return "BREAK_EVEN";
  if (/STOP[ -]?LOSS|\bSL\b/.test(raw)) return "SL";
  if (raw.includes("TP3")) return "TP3";
  if (raw.includes("TP2")) return "TP2";
  if (raw.includes("TP1")) return "TP1";
  if (/WIN|PROFIT/.test(raw)) return "WIN";
  if (/BUY|LONG/.test(raw)) return "BUY";
  if (/SELL|SHORT/.test(raw)) return "SELL";
  return "";
}

function eventTitle(event, symbol) {
  const name = symbolLabel(symbol);
  return ({ BUY:`🟢 BUY ${name}`, SELL:`🔴 SELL ${name}`, TP1:`✅ TP1 HIT • ${name}`, TP2:`✅ TP2 HIT • ${name}`, TP3:`🏆 TP3 / WIN • ${name}`, WIN:`🏆 WIN • ${name}`, SL:`⛔ STOP LOSS • ${name}`, BREAK_EVEN:`🟡 BREAK-EVEN • ${name}` })[event] || `BIT ADAMS • ${name}`;
}

function eventMessage(event, symbol, payload = {}) {
  const tf = clean(payload.timeframe || payload.tf || payload.interval);
  const lines = [`${symbolLabel(symbol)}${tf ? ` • ${tf}` : ""}`];
  const labels = { BUY:"🟢 SIGNAL: BUY", SELL:"🔴 SIGNAL: SELL", TP1:"✅ TAKE PROFIT 1 HIT\nMOVE SL TO ENTRY", TP2:"✅ TAKE PROFIT 2 HIT", TP3:"🏆 TAKE PROFIT 3 HIT\nTRADE WIN", WIN:"🏆 TRADE WIN", SL:"⛔ STOP LOSS HIT", BREAK_EVEN:"🟡 BREAK-EVEN\nTRADE CLOSED AT ENTRY" };
  if (labels[event]) lines.push(labels[event]);
  for (const [label, value] of [["ENTRY",payload.entry ?? payload.entryPrice],["SL",payload.sl ?? payload.stopLoss],["TP1",payload.tp1],["TP2",payload.tp2],["TP3",payload.tp3],["PRICE",payload.price ?? payload.close]]) if (clean(value)) lines.push(`${label}: ${clean(value)}`);
  return lines.join("\n");
}

async function sendOneSignal(title, message, data = {}) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
    console.warn("OneSignal skipped: environment keys missing");
    return { skipped: true };
  }
  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Key ${ONESIGNAL_API_KEY}` },
    body: JSON.stringify({ app_id:ONESIGNAL_APP_ID, target_channel:"push", included_segments:["Subscribed Users"], headings:{ en:title }, contents:{ en:message }, data, name:`BIT ADAMS ${Date.now()}` })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OneSignal error ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1); const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (!losses) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const ranges = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) ranges.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close)));
  return ranges.reduce((a,b) => a+b, 0) / Math.max(1, ranges.length);
}

function analyse(candles) {
  const closes = candles.map(x => x.close);
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const last = closes.at(-1), prev = closes.at(-4) ?? closes[0];
  const lastE9 = e9.at(-1), lastE21 = e21.at(-1);
  const r = rsi(closes), a = atr(candles), momentum = prev ? ((last - prev) / prev) * 100 : 0;
  let bull = 0, bear = 0;
  if (lastE9 > lastE21) bull += 32; else bear += 32;
  if (last > lastE9) bull += 18; else bear += 18;
  if (r >= 52) bull += 25; else if (r <= 48) bear += 25; else { bull += 10; bear += 10; }
  if (momentum > 0) bull += 25; else if (momentum < 0) bear += 25;
  const confidence = Math.round(Math.max(bull, bear));
  const signal = confidence >= 55 ? (bull > bear ? "BUY" : "SELL") : "WAIT";
  return { signal, confidence, price:last, ema9:lastE9, ema21:lastE21, rsi:round(r,1), atr:a, momentum:round(momentum,3) };
}

async function candles(symbol, interval) {
  if (!TWELVE_DATA_API_KEY) throw new Error("TWELVE_DATA_API_KEY missing in Render");
  const pair = symbol === "XAUUSD" ? "XAU/USD" : "BTC/USD";
  const url = new URL("https://api.twelvedata.com/time_series");
  url.search = new URLSearchParams({ symbol:pair, interval, outputsize:"80", order:"ASC", apikey:TWELVE_DATA_API_KEY });
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) throw new Error(data.message || `Twelve Data ${response.status}`);
  return data.values.map(v => ({ datetime:v.datetime, open:Number(v.open), high:Number(v.high), low:Number(v.low), close:Number(v.close) })).filter(v => Number.isFinite(v.close));
}

function levels(symbol, direction, price, a) {
  const digits = 2; const unit = Math.max(a, price * (symbol === "BTCUSD" ? 0.002 : 0.0008)); const buy = direction === "BUY";
  return { entry:round(price,digits), sl:round(price + (buy ? -1.2 : 1.2)*unit,digits), tp1:round(price + (buy ? 1 : -1)*unit,digits), tp2:round(price + (buy ? 1.8 : -1.8)*unit,digits), tp3:round(price + (buy ? 2.8 : -2.8)*unit,digits) };
}

async function notifyEvent(event, symbol, payload) {
  try { return await sendOneSignal(eventTitle(event,symbol), eventMessage(event,symbol,payload), { source:"BIT ADAMS", event, symbol, ...payload }); }
  catch (error) { console.error("Notification error:", error.message); return { error:error.message }; }
}

async function updateTrade(symbol, analysis) {
  let trade = liveTrades.get(symbol);
  const price = analysis.price;
  if (!trade && ["BUY","SELL"].includes(analysis.signal) && analysis.confirmed) {
    const cooldown = Date.now() - (lastSignalAt.get(symbol) || 0);
    if (cooldown >= SIGNAL_COOLDOWN_MS) {
      trade = { symbol, direction:analysis.signal, timeframe:"M5 + M15", confidence:analysis.confidence, status:"OPEN", createdAt:new Date().toISOString(), ...analysis.levels };
      liveTrades.set(symbol, trade); lastSignalAt.set(symbol, Date.now());
      await notifyEvent(trade.direction, symbol, trade);
    }
  }
  if (!trade) return null;
  const buy = trade.direction === "BUY"; const hit = target => buy ? price >= target : price <= target; const stopped = buy ? price <= trade.sl : price >= trade.sl;
  let event = "";
  if (trade.status === "OPEN" && hit(trade.tp1)) { trade.status="TP1"; trade.sl=trade.entry; event="TP1"; }
  else if (trade.status === "TP1" && hit(trade.tp2)) { trade.status="TP2"; event="TP2"; }
  else if (["OPEN","TP1","TP2"].includes(trade.status) && hit(trade.tp3)) { trade.status="WIN"; event="TP3"; }
  else if (["OPEN","TP1","TP2"].includes(trade.status) && stopped) { trade.status = trade.status === "OPEN" ? "LOST" : "BREAK-EVEN"; event = trade.status === "LOST" ? "SL" : "BREAK_EVEN"; }
  if (event) await notifyEvent(event, symbol, { ...trade, price });
  if (["WIN","LOST","BREAK-EVEN"].includes(trade.status)) { trade.closedAt=new Date().toISOString(); liveTrades.delete(symbol); }
  return trade;
}

async function analyseAsset(symbol) {
  const [m5Candles,m15Candles] = await Promise.all([candles(symbol,"5min"),candles(symbol,"15min")]);
  const m5 = analyse(m5Candles), m15 = analyse(m15Candles);
  const same = m5.signal !== "WAIT" && m5.signal === m15.signal;
  const notOpposite = m5.signal !== "WAIT" && (m15.signal === "WAIT" || m5.signal === m15.signal);
  const signal = same || (notOpposite && m5.confidence >= 75) ? m5.signal : "WAIT";
  const confidence = signal === "WAIT" ? Math.round((m5.confidence + m15.confidence)/2) : Math.min(95, Math.round(m5.confidence*0.6 + m15.confidence*0.4));
  const result = { symbol, name:symbolLabel(symbol), price:m5.price, signal, confidence, status:signal === "WAIT" ? "WAIT" : "CONFIRMED", confirmed:signal !== "WAIT", m5:{...m5}, m15:{...m15}, timeframes:{ M5:m5, M15:m15 } };
  result.levels = signal === "WAIT" ? {} : levels(symbol,signal,m5.price,m5.atr);
  result.trade = await updateTrade(symbol,result);
  return result;
}

async function performScan() {
  const settled = await Promise.allSettled([analyseAsset("XAUUSD"),analyseAsset("BTCUSD")]);
  const assets = {};
  for (let i=0;i<settled.length;i++) {
    const symbol = i === 0 ? "XAUUSD" : "BTCUSD";
    assets[symbol] = settled[i].status === "fulfilled" ? settled[i].value : { symbol, name:symbolLabel(symbol), signal:"WAIT", confidence:0, status:"ERROR", error:settled[i].reason?.message || "Data unavailable", timeframes:{} };
  }
  return { ok:true, version:"8.7 LIVE", updatedAt:new Date().toISOString(), cacheSeconds:60, assets };
}

async function getScan(force = false) {
  if (!force && scanCache && Date.now()-scanCacheAt < SCAN_CACHE_MS) return scanCache;
  if (scanPromise) return scanPromise;
  scanPromise = performScan().then(data => { scanCache=data; scanCacheAt=Date.now(); return data; }).finally(() => { scanPromise=null; });
  return scanPromise;
}

app.get("/health", (req,res) => res.json({ ok:true, service:"BIT ADAMS SERVER", version:"8.7 LIVE", status:"UP", twelveDataConfigured:Boolean(TWELVE_DATA_API_KEY), oneSignalConfigured:Boolean(ONESIGNAL_APP_ID && ONESIGNAL_API_KEY), time:new Date().toISOString() }));
app.get("/", (req,res) => res.json({ app:"BIT ADAMS", version:"8.7 LIVE", status:"ONLINE", endpoints:{ health:"/health", scan:"/api/scan", market:"/api/market", tradingview:"/tradingview-webhook" } }));
app.get(["/api/scan","/api/market"], async (req,res) => { try { res.json(await getScan(req.query.refresh === "1")); } catch(error) { res.status(503).json({ ok:false,error:error.message }); } });

async function tradingViewWebhook(req,res) {
  try {
    const payload=normalizePayload(req.body);
    if (WEBHOOK_SECRET && clean(payload.secret)!==WEBHOOK_SECRET) return res.status(401).json({ok:false,error:"Invalid webhook secret"});
    const event=detectEvent(payload); if(!event) return res.status(400).json({ok:false,error:"Unknown event",received:payload});
    const symbol=normalizeSymbol(payload.symbol || payload.ticker || payload.asset);
    const notification=await sendOneSignal(eventTitle(event,symbol),eventMessage(event,symbol,payload),{source:"TradingView",event,symbol,timeframe:clean(payload.timeframe||payload.tf||payload.interval)});
    res.json({ok:true,event,symbol,notification});
  } catch(error) { console.error("Webhook error:",error); res.status(500).json({ok:false,error:error.message}); }
}

app.post(["/tradingview-webhook","/webhook"],tradingViewWebhook);
app.use((req,res) => res.status(404).json({ok:false,error:"Route not found"}));
app.listen(PORT,"0.0.0.0",() => console.log(`BIT ADAMS 8.7 running on port ${PORT}`));
