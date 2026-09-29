import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 10000);
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || "";
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "";
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const SCAN_CACHE_MS = 4 * 60_000;
const SIGNAL_COOLDOWN_MS = 15 * 60_000;
const BACKGROUND_SCAN_MS = 4 * 60_000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.text({ type: ["text/plain", "application/text"], limit: "100kb" }));

let scanCache = null;
let scanCacheAt = 0;
let scanPromise = null;
let dailyLimitResetAt = 0;
let lastProviderError = "";
let lastSuccessfulScanAt = 0;
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
  const originalMessage = clean(payload.message);
  if (originalMessage && !lines.some(line => line.includes(originalMessage))) lines.push(originalMessage);
  return lines.join("\n");
}

async function sendOneSignal(title, message, data = {}) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
    console.warn("OneSignal skipped: environment keys missing");
    return { skipped: true };
  }
  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { "Content-Type":"application/json", Authorization:`Key ${ONESIGNAL_API_KEY}` },
    body: JSON.stringify({ app_id:ONESIGNAL_APP_ID, target_channel:"push", included_segments:["Subscribed Users"], headings:{ en:title }, contents:{ en:message }, data, name:`BIT ADAMS ${Date.now()}` })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OneSignal error ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function sendTelegram(title, message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram skipped: environment keys missing");
    return { skipped: true };
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `${title}\n\n${message}`,
      disable_web_page_preview: true
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(`Telegram error ${response.status}: ${JSON.stringify(result)}`);
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
  const latest = candles.at(-1) || {};
  return { signal, confidence, price:last, high:latest.high, low:latest.low, ema9:lastE9, ema21:lastE21, rsi:round(r,1), atr:a, momentum:round(momentum,3) };
}

function nextUtcMidnight() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

async function candles(symbol) {
  if (!TWELVE_DATA_API_KEY) throw new Error("TWELVE_DATA_API_KEY missing in Render");
  const pair = symbol === "XAUUSD" ? "XAU/USD" : "BTC/USD";
  const url = new URL("https://api.twelvedata.com/time_series");
  url.search = new URLSearchParams({ symbol:pair, interval:"5min", outputsize:"80", order:"ASC", timezone:"UTC", apikey:TWELVE_DATA_API_KEY });
  const response = await fetch(url, { signal:AbortSignal.timeout(10_000) });
  const data = await response.json();
  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    const message = data.message || `Twelve Data ${response.status}`;
    lastProviderError = message;
    if (/credits for the day|daily limit|quota.*day/i.test(message)) {
      const now = new Date();
      dailyLimitResetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    }
    throw new Error(message);
  }
  return data.values.map(v => ({ datetime:v.datetime, open:Number(v.open), high:Number(v.high), low:Number(v.low), close:Number(v.close) })).filter(v => Number.isFinite(v.close));
}

function aggregateTo15m(candles5m) {
  const groups = new Map();
  const now = Date.now();
  for (const candle of candles5m) {
    const datetime = String(candle.datetime || "").replace(" ", "T");
    const normalized = /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(datetime) ? datetime : `${datetime}Z`;
    const timestamp = Date.parse(normalized);
    if (!Number.isFinite(timestamp)) continue;
    const bucket = Math.floor(timestamp / 900_000) * 900_000;
    if (bucket + 900_000 > now) continue;
    const group = groups.get(bucket);
    if (!group) {
      groups.set(bucket, { timestamp:bucket, datetime:candle.datetime, open:candle.open, high:candle.high, low:candle.low, close:candle.close, times:new Set([timestamp]) });
      continue;
    }
    if (group.times.has(timestamp)) continue;
    group.times.add(timestamp);
    group.high = Math.max(group.high, candle.high);
    group.low = Math.min(group.low, candle.low);
    group.close = candle.close;
  }
  return [...groups.values()]
    .filter(group => group.times.size === 3)
    .sort((a,b) => a.timestamp - b.timestamp)
    .map(({datetime,open,high,low,close}) => ({datetime,open,high,low,close}));
}

function levels(symbol, direction, price, a) {
  const digits = 2; const unit = Math.max(a, price * (symbol === "BTCUSD" ? 0.002 : 0.0008)); const buy = direction === "BUY";
  return { entry:round(price,digits), sl:round(price + (buy ? -1.2 : 1.2)*unit,digits), tp1:round(price + (buy ? 1 : -1)*unit,digits), tp2:round(price + (buy ? 1.8 : -1.8)*unit,digits), tp3:round(price + (buy ? 2.8 : -2.8)*unit,digits) };
}

async function notifyEvent(event, symbol, payload) {
  const title = eventTitle(event,symbol);
  const message = eventMessage(event,symbol,payload);
  const [oneSignal, telegram] = await Promise.allSettled([
    sendOneSignal(title, message, { source:"BIT ADAMS", event, symbol, ...payload }),
    sendTelegram(title, message)
  ]);
  if (oneSignal.status === "rejected") console.error("OneSignal error:", oneSignal.reason?.message);
  if (telegram.status === "rejected") console.error("Telegram error:", telegram.reason?.message);
  return {
    oneSignal: oneSignal.status === "fulfilled" ? oneSignal.value : { error:oneSignal.reason?.message },
    telegram: telegram.status === "fulfilled" ? telegram.value : { error:telegram.reason?.message }
  };
}

async function updateTrade(symbol, analysis) {
  let trade = liveTrades.get(symbol);
  const price = analysis.price;
  const high = Number.isFinite(analysis.m5?.high) ? analysis.m5.high : price;
  const low = Number.isFinite(analysis.m5?.low) ? analysis.m5.low : price;
  if (!trade && ["BUY","SELL"].includes(analysis.signal) && analysis.confirmed) {
    const cooldown = Date.now() - (lastSignalAt.get(symbol) || 0);
    if (cooldown >= SIGNAL_COOLDOWN_MS) {
      trade = { symbol, direction:analysis.signal, timeframe:"M5 + M15", confidence:analysis.confidence, status:"OPEN", createdAt:new Date().toISOString(), ...analysis.levels };
      liveTrades.set(symbol, trade); lastSignalAt.set(symbol, Date.now());
      await notifyEvent(trade.direction, symbol, trade);
    }
  }
  if (!trade) return null;
  const buy = trade.direction === "BUY"; const hit = target => buy ? high >= target : low <= target; const stopped = buy ? low <= trade.sl : high >= trade.sl;
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
  const m5Candles = await candles(symbol);
  const m15Candles = aggregateTo15m(m5Candles);
  if (m15Candles.length < 22) throw new Error("Not enough completed candles to confirm M15 conditions");
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
  return { ok:true, version:"8.7 LIVE", updatedAt:new Date().toISOString(), cacheSeconds:240, assets };
}

async function getScan(force = false) {
  if (dailyLimitResetAt > Date.now()) {
    if (scanCache) return scanCache;
    const error = `Twelve Data daily credits exhausted. Retry after ${new Date(dailyLimitResetAt).toISOString()}.`;
    return { ok:true, version:"8.7 LIVE", updatedAt:new Date().toISOString(), cacheSeconds:SCAN_CACHE_MS/1000, assets:{
      XAUUSD:{symbol:"XAUUSD",name:"GOLD",signal:"WAIT",confidence:0,status:"ERROR",error,timeframes:{}},
      BTCUSD:{symbol:"BTCUSD",name:"BITCOIN",signal:"WAIT",confidence:0,status:"ERROR",error,timeframes:{}}
    }};
  }
  if (!force && scanCache && Date.now()-scanCacheAt < SCAN_CACHE_MS) return scanCache;
  if (scanPromise) return scanPromise;
  scanPromise = performScan().then(data => {
    scanCache=data;
    scanCacheAt=Date.now();
    const errors=Object.values(data.assets || {}).filter(asset => asset.status === "ERROR").map(asset => asset.error).filter(Boolean);
    if (errors.length) lastProviderError=errors[0];
    else { lastProviderError=""; lastSuccessfulScanAt=scanCacheAt; }
    return data;
  }).finally(() => { scanPromise=null; });
  return scanPromise;
}

app.get("/health", (req,res) => {
  const dailyLimit = dailyLimitResetAt > Date.now();
  const fresh = lastSuccessfulScanAt > 0 && Date.now() - lastSuccessfulScanAt < SCAN_CACHE_MS * 2;
  const marketDataStatus = !TWELVE_DATA_API_KEY ? "NOT_CONFIGURED" : dailyLimit ? "DAILY_LIMIT" : fresh ? "CONNECTED" : scanCache ? "UNAVAILABLE" : "CHECKING";
  res.json({ ok:true, service:"BIT ADAMS SERVER", version:"8.9 AUTO-SCAN", status:"UP", twelveDataConfigured:Boolean(TWELVE_DATA_API_KEY), marketDataStatus, marketDataError:lastProviderError || null, marketDataUpdatedAt:lastSuccessfulScanAt ? new Date(lastSuccessfulScanAt).toISOString() : null, oneSignalConfigured:Boolean(ONESIGNAL_APP_ID && ONESIGNAL_API_KEY), telegramConfigured:Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID), time:new Date().toISOString() });
});
app.get("/", (req,res) => res.json({ app:"BIT ADAMS", version:"8.9 AUTO-SCAN", status:"ONLINE", endpoints:{ health:"/health", scan:"/api/scan", market:"/api/market", testTelegram:"/api/test-telegram", tradingview:"/tradingview-webhook" } }));
app.get(["/api/scan","/api/market"], async (req,res) => { try { res.json(await getScan()); } catch(error) { res.status(503).json({ ok:false,error:error.message }); } });
app.get("/api/test-telegram", async (req,res) => {
  try {
    const telegram = await sendTelegram("✅ BIT ADAMS TEST", "Notificările Telegram funcționează.");
    if (telegram.skipped) return res.status(503).json({ok:false,error:"Telegram environment keys missing"});
    res.json({ok:true,telegram});
  } catch(error) { res.status(500).json({ok:false,error:error.message}); }
});

app.post("/api/notify", async (req,res) => {
  try {
    const payload = normalizePayload(req.body);
    const event = detectEvent(payload);
    if (!event) return res.status(400).json({ok:false,error:"Unknown notification event"});
    const trade = payload.trade && typeof payload.trade === "object" ? payload.trade : {};
    const symbol = normalizeSymbol(trade.asset || trade.symbol || payload.symbol || payload.asset);
    const notification = await notifyEvent(event, symbol, {
      ...trade,
      ...payload,
      source:"BIT ADAMS APP",
      timeframe:clean(trade.timeframe || payload.timeframe)
    });
    res.json({ok:true,event,symbol,notification});
  } catch(error) {
    console.error("App notification error:",error);
    res.status(500).json({ok:false,error:error.message});
  }
});

async function tradingViewWebhook(req,res) {
  try {
    const payload=normalizePayload(req.body);
    if (WEBHOOK_SECRET && clean(payload.secret)!==WEBHOOK_SECRET) return res.status(401).json({ok:false,error:"Invalid webhook secret"});
    const event=detectEvent(payload); if(!event) return res.status(400).json({ok:false,error:"Unknown event",received:payload});
    const symbol=normalizeSymbol(payload.symbol || payload.ticker || payload.asset);
    const notification=await notifyEvent(event,symbol,{...payload,source:"TradingView",timeframe:clean(payload.timeframe||payload.tf||payload.interval)});
    res.json({ok:true,event,symbol,notification});
  } catch(error) { console.error("Webhook error:",error); res.status(500).json({ok:false,error:error.message}); }
}

app.post(["/tradingview-webhook","/webhook"],tradingViewWebhook);
app.use((req,res) => res.status(404).json({ok:false,error:"Route not found"}));
app.listen(PORT,"0.0.0.0",() => {
  console.log(`BIT ADAMS 8.9 AUTO-SCAN running on port ${PORT}`);
  getScan(true).catch(error => console.error("Initial scan error:", error.message));
  setInterval(() => {
    getScan(true).catch(error => console.error("Background scan error:", error.message));
  }, BACKGROUND_SCAN_MS);
});
