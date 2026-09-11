import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT =
  Number(process.env.PORT || 10000);

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID || "";

const ONESIGNAL_API_KEY =
  process.env.ONESIGNAL_API_KEY || "";

const SCAN_SECONDS =
  Math.max(
    60,
    Number(process.env.SCAN_SECONDS || 60)
  );

const MIN_CONFIDENCE =
  Number(process.env.MIN_CONFIDENCE || 68);

const MAX_OPEN_TRADES = 2;


/* =========================
   ASSETS
========================= */

const ASSETS = {

  XAUUSD: {
    api: "XAU/USD",
    label: "GOLD",
    digits: 2
  },

  BTCUSD: {
    api: "BTC/USD",
    label: "BITCOIN",
    digits: 2
  }

};


/* =========================
   TIMEFRAMES
========================= */

const TIMEFRAMES = {

  M5: "5min",

  M15: "15min"

};


/* =========================
   MEMORY
========================= */

const signals = new Map();

const openTrades = new Map();

const lastSignalTimes = new Map();

let history = [];

let scanning = false;

let lastScanAt = null;

const HISTORY_FILE =
  "./history.json";


/* =========================
   HELPERS
========================= */

function nowIso() {

  return new Date().toISOString();
}


function round(
  value,
  digits = 2
) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {

    return null;
  }

  return Number(
    Number(value).toFixed(digits)
  );
}


function formatPrice(
  asset,
  value
) {

  return round(
    value,
    ASSETS[asset]?.digits || 2
  );
}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


/* =========================
   HISTORY
========================= */

function loadHistory() {

  try {

    if (
      fs.existsSync(HISTORY_FILE)
    ) {

      const raw =
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        );

      history =
        JSON.parse(raw);

      if (
        !Array.isArray(history)
      ) {

        history = [];
      }
    }

  } catch (error) {

    console.log(
      "History load error:",
      error.message
    );

    history = [];
  }
}


function saveHistory() {

  try {

    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(
        history.slice(0, 500),
        null,
        2
      ),
      "utf8"
    );

  } catch (error) {

    console.log(
      "History save error:",
      error.message
    );
  }
}


/* =========================
   EMA
========================= */

function ema(
  values,
  period
) {

  if (
    !values ||
    values.length < period
  ) {

    return null;
  }

  const k =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}


/* =========================
   RSI 14
========================= */

function rsi(
  values,
  period = 14
) {

  if (
    !values ||
    values.length <
      period + 1
  ) {

    return null;
  }

  const recent =
    values.slice(
      -(period + 1)
    );

  let gains = 0;

  let losses = 0;

  for (
    let i = 1;
    i < recent.length;
    i++
  ) {

    const diff =
      recent[i] -
      recent[i - 1];

    if (
      diff > 0
    ) {

      gains += diff;

    } else {

      losses +=
        Math.abs(diff);
    }
  }

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  if (
    avgLoss === 0
  ) {

    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}


/* =========================
   ATR 14
========================= */

function atr(
  candles,
  period = 14
) {

  if (
    !candles ||
    candles.length <
      period + 1
  ) {

    return null;
  }

  const values = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(

        current.high -
        current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      );

    values.push(tr);
  }

  const recent =
    values.slice(-period);

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) /
    recent.length
  );
}


/* =========================
   MOMENTUM %
========================= */

function momentumPercent(
  values,
  period = 3
) {

  if (
    !values ||
    values.length <= period
  ) {

    return 0;
  }

  const current =
    values[
      values.length - 1
    ];

  const previous =
    values[
      values.length -
      1 -
      period
    ];

  if (!previous) {
    return 0;
  }

  return (
    (
      current -
      previous
    ) /
    previous *
    100
  );
}


/* =========================
   TWELVE DATA
========================= */

async function getCandles(
  asset,
  timeframe
) {

  const symbol =
    ASSETS[asset].api;

  const interval =
    TIMEFRAMES[timeframe];

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    "&outputsize=80" +
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (
    !response.ok ||
    data.status === "error" ||
    !Array.isArray(data.values)
  ) {

    throw new Error(
      data.message ||
      `Twelve Data error ${response.status}`
    );
  }

  return data.values
    .map(item => ({

      datetime:
        item.datetime,

      open:
        Number(item.open),

      high:
        Number(item.high),

      low:
        Number(item.low),

      close:
        Number(item.close)

    }))
    .filter(
      candle =>
        Number.isFinite(
          candle.close
        )
    )
    .reverse();
}


/* =========================
   TF ANALYSIS
========================= */

function analyseTimeframe(
  asset,
  timeframe,
  candles
) {

  if (
    !candles ||
    candles.length < 30
  ) {

    return {

      asset,

      timeframe,

      status: "WAIT",

      score: 0,

      confidence: 0,

      reason:
        "WARMING_UP"

    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const ema9 =
    ema(
      closes,
      9
    );

  const ema21 =
    ema(
      closes,
      21
    );

  const currentRsi =
    rsi(
      closes,
      14
    );

  const currentAtr =
    atr(
      candles,
      14
    );

  const momentum =
    momentumPercent(
      closes,
      3
    );

  let score = 0;


  // EMA TREND

  if (
    ema9 > ema21
  ) {

    score += 3;
  }

  if (
    ema9 < ema21
  ) {

    score -= 3;
  }


  // PRICE VS EMA

  if (
    last.close > ema9
  ) {

    score += 1;
  }

  if (
    last.close < ema9
  ) {

    score -= 1;
  }


  // RSI

  if (
    currentRsi >= 52 &&
    currentRsi <= 72
  ) {

    score += 2;
  }

  if (
    currentRsi <= 48 &&
    currentRsi >= 28
  ) {

    score -= 2;
  }


  // MOMENTUM

  if (
    momentum > 0.02
  ) {

    score += 2;
  }

  if (
    momentum < -0.02
  ) {

    score -= 2;
  }


  // LAST CANDLE

  if (
    last.close > last.open
  ) {

    score += 1;
  }

  if (
    last.close < last.open
  ) {

    score -= 1;
  }


  // CANDLE FOLLOW THROUGH

  if (
    last.close >
    previous.close
  ) {

    score += 1;
  }

  if (
    last.close <
    previous.close
  ) {

    score -= 1;
  }


  let status =
    "WAIT";

  if (
    score >= 4
  ) {

    status = "BUY";
  }

  if (
    score <= -4
  ) {

    status = "SELL";
  }


  const confidence =
    status === "WAIT"

      ? Math.min(
          67,
          48 +
          Math.abs(score) * 3
        )

      : Math.min(
          96,
          55 +
          Math.abs(score) * 5
        );


  return {

    asset,

    timeframe,

    status,

    score,

    confidence,

    price:
      formatPrice(
        asset,
        last.close
      ),

    ema9:
      formatPrice(
        asset,
        ema9
      ),

    ema21:
      formatPrice(
        asset,
        ema21
      ),

    rsi:
      round(
        currentRsi,
        1
      ),

    atr:
      formatPrice(
        asset,
        currentAtr
      ),

    momentum:
      round(
        momentum,
        4
      ),

    candleTime:
      last.datetime,

    updatedAt:
      nowIso()
  };
}


/* =========================
   FINAL M5 + M15 SIGNAL
========================= */

function combineSignals(
  asset,
  m5,
  m15
) {

  let direction =
    "WAIT";

  let confidence = 0;

  let reason =
    "Waiting for confirmation";


  // Strong agreement

  if (
    m5.status === "BUY" &&
    m15.status === "BUY"
  ) {

    direction = "BUY";

    confidence =
      Math.round(
        m5.confidence * 0.6 +
        m15.confidence * 0.4
      );

    reason =
      "M5 + M15 bullish confirmation";
  }


  if (
    m5.status === "SELL" &&
    m15.status === "SELL"
  ) {

    direction = "SELL";

    confidence =
      Math.round(
        m5.confidence * 0.6 +
        m15.confidence * 0.4
      );

    reason =
      "M5 + M15 bearish confirmation";
  }


  /*
    FAST MODE

    M5 may trigger when M15 is WAIT,
    provided M15 is not strongly opposite.
  */

  if (
    direction === "WAIT" &&
    m5.status === "BUY" &&
    m5.confidence >= 70 &&
    m15.score >= -1
  ) {

    direction = "BUY";

    confidence =
      Math.round(
        m5.confidence * 0.75 +
        Math.max(
          55,
          m15.confidence
        ) * 0.25
      );

    reason =
      "FAST M5 bullish + M15 not bearish";
  }


  if (
    direction === "WAIT" &&
    m5.status === "SELL" &&
    m5.confidence >= 70 &&
    m15.score <= 1
  ) {

    direction = "SELL";

    confidence =
      Math.round(
        m5.confidence * 0.75 +
        Math.max(
          55,
          m15.confidence
        ) * 0.25
      );

    reason =
      "FAST M5 bearish + M15 not bullish";
  }


  if (
    confidence <
    MIN_CONFIDENCE
  ) {

    direction =
      "WAIT";

    reason =
      "Confidence below minimum";
  }


  return {

    asset,

    label:
      ASSETS[asset].label,

    symbol:
      ASSETS[asset].api,

    direction,

    confidence,

    reason,

    price:
      m5.price,

    M5:
      m5,

    M15:
      m15,

    updatedAt:
      nowIso()
  };
}


/* =========================
   ONE SIGNAL
========================= */

async function sendPush(
  title,
  message,
  data = {}
) {

  if (
    !ONESIGNAL_APP_ID ||
    !ONESIGNAL_API_KEY
  ) {

    console.log(
      "OneSignal not configured"
    );

    return false;
  }

  try {

    const response =
      await fetch(
        "https://api.onesignal.com/notifications",
        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "Authorization":
              `Key ${ONESIGNAL_API_KEY}`

          },

          body:
            JSON.stringify({

              app_id:
                ONESIGNAL_APP_ID,

              included_segments: [
                "Subscribed Users"
              ],

              headings: {
                en: title
              },

              contents: {
                en: message
              },

              data

            })

        }
      );

    const result =
      await response
        .json()
        .catch(() => ({}));

    if (
      !response.ok
    ) {

      console.log(
        "OneSignal error:",
        result
      );

      return false;
    }

    console.log(
      "PUSH SENT:",
      title
    );

    return true;

  } catch (error) {

    console.log(
      "Push error:",
      error.message
    );

    return false;
  }
}


/* =========================
   TRADE LEVELS
========================= */

function createTradeLevels(
  asset,
  signal
) {

  const entry =
    Number(
      signal.price
    );

  const atrValue =
    Number(
      signal.M5.atr
    );

  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0
  ) {

    return null;
  }

  let sl;

  let tp1;

  let tp2;

  let tp3;


  if (
    signal.direction ===
    "BUY"
  ) {

    sl =
      entry -
      atrValue * 1.15;

    tp1 =
      entry +
      atrValue * 1.0;

    tp2 =
      entry +
      atrValue * 1.8;

    tp3 =
      entry +
      atrValue * 2.6;

  } else {

    sl =
      entry +
      atrValue * 1.15;

    tp1 =
      entry -
      atrValue * 1.0;

    tp2 =
      entry -
      atrValue * 1.8;

    tp3 =
      entry -
      atrValue * 2.6;
  }


  return {

    entry:
      formatPrice(
        asset,
        entry
      ),

    sl:
      formatPrice(
        asset,
        sl
      ),

    tp1:
      formatPrice(
        asset,
        tp1
      ),

    tp2:
      formatPrice(
        asset,
        tp2
      ),

    tp3:
      formatPrice(
        asset,
        tp3
      )
  };
}


/* =========================
   OPEN TRADE
========================= */

async function maybeOpenTrade(
  asset,
  signal
) {

  if (
    signal.direction ===
    "WAIT"
  ) {

    return;
  }


  if (
    openTrades.has(asset)
  ) {

    return;
  }


  if (
    openTrades.size >=
    MAX_OPEN_TRADES
  ) {

    return;
  }


  const lastSignal =
    lastSignalTimes.get(asset) || 0;


  // Prevent duplicate signals for 15 minutes

  if (
    Date.now() -
    lastSignal <
    15 * 60 * 1000
  ) {

    return;
  }


  const levels =
    createTradeLevels(
      asset,
      signal
    );


  if (!levels) {

    return;
  }


  const trade = {

    id:
      `${asset}-${Date.now()}`,

    asset,

    label:
      ASSETS[asset].label,

    direction:
      signal.direction,

    confidence:
      signal.confidence,

    entry:
      levels.entry,

    sl:
      levels.sl,

    originalSl:
      levels.sl,

    tp1:
      levels.tp1,

    tp2:
      levels.tp2,

    tp3:
      levels.tp3,

    tp1Hit:
      false,

    tp2Hit:
      false,

    tp3Hit:
      false,

    breakEven:
      false,

    status:
      "OPEN",

    openedAt:
      nowIso(),

    updatedAt:
      nowIso()

  };


  openTrades.set(
    asset,
    trade
  );


  lastSignalTimes.set(
    asset,
    Date.now()
  );


  await sendPush(

    `${trade.label} ${trade.direction} ✅`,

    `Entry ${trade.entry} | SL ${trade.sl} | TP1 ${trade.tp1} | TP2 ${trade.tp2} | TP3 ${trade.tp3} | Confidence ${trade.confidence}%`,

    {
      event:
        "NEW_SIGNAL",

      asset,

      trade
    }
  );


  console.log(
    "NEW TRADE:",
    trade
  );
}


/* =========================
   CLOSE TRADE
========================= */

async function closeTrade(
  asset,
  trade,
  result,
  price
) {

  trade.status =
    result;

  trade.exit =
    formatPrice(
      asset,
      price
    );

  trade.closedAt =
    nowIso();

  trade.updatedAt =
    nowIso();


  openTrades.delete(asset);


  history.unshift({
    ...trade
  });


  history =
    history.slice(
      0,
      500
    );


  saveHistory();


  await sendPush(

    `${trade.label} ${result}`,

    `${trade.direction} | Entry ${trade.entry} | Exit ${trade.exit}`,

    {
      event:
        result,

      asset,

      trade
    }
  );
}


/* =========================
   TRACK TP / SL
========================= */

async function trackTrade(
  asset,
  currentPrice
) {

  const trade =
    openTrades.get(asset);


  if (!trade) {

    return;
  }


  const price =
    Number(currentPrice);


  if (
    !Number.isFinite(price)
  ) {

    return;
  }


  trade.updatedAt =
    nowIso();


  /* BUY */

  if (
    trade.direction === "BUY"
  ) {

    if (
      !trade.tp1Hit &&
      price >= trade.tp1
    ) {

      trade.tp1Hit = true;

      trade.breakEven = true;

      trade.sl =
        trade.entry;

      trade.status =
        "TP1";

      await sendPush(

        `${trade.label} TP1 ✅`,

        `TP1 hit ${trade.tp1}. Move SL to ENTRY ${trade.entry}.`,

        {
          event:
            "TP1",

          asset,

          trade
        }
      );
    }


    if (
      !trade.tp2Hit &&
      price >= trade.tp2
    ) {

      trade.tp2Hit = true;

      trade.status =
        "TP2";

      await sendPush(

        `${trade.label} TP2 ✅`,

        `TP2 hit ${trade.tp2}`,

        {
          event:
            "TP2",

          asset,

          trade
        }
      );
    }


    if (
      price >= trade.tp3
    ) {

      trade.tp3Hit = true;

      await sendPush(

        `${trade.label} TP3 ✅`,

        `TP3 hit ${trade.tp3}`,

        {
          event:
            "TP3",

          asset,

          trade
        }
      );


      await closeTrade(
        asset,
        trade,
        "WIN",
        price
      );

      return;
    }


    if (
      price <= trade.sl
    ) {

      const result =
        trade.breakEven
          ? "BREAK-EVEN"
          : "LOST";


      await closeTrade(
        asset,
        trade,
        result,
        price
      );

      return;
    }
  }


  /* SELL */

  if (
    trade.direction === "SELL"
  ) {

    if (
      !trade.tp1Hit &&
      price <= trade.tp1
    ) {

      trade.tp1Hit = true;

      trade.breakEven = true;

      trade.sl =
        trade.entry;

      trade.status =
        "TP1";

      await sendPush(

        `${trade.label} TP1 ✅`,

        `TP1 hit ${trade.tp1}. Move SL to ENTRY ${trade.entry}.`,

        {
          event:
            "TP1",

          asset,

          trade
        }
      );
    }


    if (
      !trade.tp2Hit &&
      price <= trade.tp2
    ) {

      trade.tp2Hit = true;

      trade.status =
        "TP2";

      await sendPush(

        `${trade.label} TP2 ✅`,

        `TP2 hit ${trade.tp2}`,

        {
          event:
            "TP2",

          asset,

          trade
        }
      );
    }


    if (
      price <= trade.tp3
    ) {

      trade.tp3Hit = true;

      await sendPush(

        `${trade.label} TP3 ✅`,

        `TP3 hit ${trade.tp3}`,

        {
          event:
            "TP3",

          asset,

          trade
        }
      );


      await closeTrade(
        asset,
        trade,
        "WIN",
        price
      );

      return;
    }


    if (
      price >= trade.sl
    ) {

      const result =
        trade.breakEven
          ? "BREAK-EVEN"
          : "LOST";


      await closeTrade(
        asset,
        trade,
        result,
        price
      );

      return;
    }
  }
}


/* =========================
   SCAN ASSET
========================= */

async function scanAsset(
  asset
) {

  console.log(
    `Scanning ${asset}...`
  );


  const m5Candles =
    await getCandles(
      asset,
      "M5"
    );


  // Small delay to avoid API burst

  await sleep(500);


  const m15Candles =
    await getCandles(
      asset,
      "M15"
    );


  const m5 =
    analyseTimeframe(
      asset,
      "M5",
      m5Candles
    );


  const m15 =
    analyseTimeframe(
      asset,
      "M15",
      m15Candles
    );


  const finalSignal =
    combineSignals(
      asset,
      m5,
      m15
    );


  signals.set(
    asset,
    finalSignal
  );


  await trackTrade(
    asset,
    finalSignal.price
  );


  await maybeOpenTrade(
    asset,
    finalSignal
  );


  console.log(
    asset,
    finalSignal.direction,
    finalSignal.confidence + "%",
    "M5",
    m5.score,
    "M15",
    m15.score
  );
}


/* =========================
   SCAN ALL
========================= */

async function scanAll() {

  if (scanning) {

    return;
  }


  if (
    !TWELVE_DATA_API_KEY
  ) {

    console.log(
      "TWELVE_DATA_API_KEY missing"
    );

    return;
  }


  scanning = true;


  try {

    await scanAsset(
      "XAUUSD"
    );


    await sleep(1000);


    await scanAsset(
      "BTCUSD"
    );


    lastScanAt =
      nowIso();


  } catch (error) {

    console.log(
      "SCAN ERROR:",
      error.message
    );

  } finally {

    scanning = false;
  }
}


/* =========================
   STATS
========================= */

function getStats() {

  const wins =
    history.filter(
      x => x.status === "WIN"
    ).length;


  const losses =
    history.filter(
      x => x.status === "LOST"
    ).length;


  const breakEven =
    history.filter(
      x => x.status ===
        "BREAK-EVEN"
    ).length;


  const completed =
    wins + losses;


  const winRate =
    completed > 0
      ? round(
          wins /
          completed *
          100,
          1
        )
      : 0;


  return {

    wins,

    losses,

    breakEven,

    winRate,

    totalHistory:
      history.length,

    openTrades:
      openTrades.size,

    maxOpenTrades:
      MAX_OPEN_TRADES

  };
}


/* =========================
   HOME
========================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      app:
        "BIT ADAMS SERVER",

      version:
        "8.5 FAST",

      mode:
        "GOLD + BITCOIN / M5 + M15",

      minConfidence:
        MIN_CONFIDENCE,

      scanSeconds:
        SCAN_SECONDS,

      maxOpenTrades:
        MAX_OPEN_TRADES,

      lastScanAt,

      oneSignal:
        ONESIGNAL_APP_ID &&
        ONESIGNAL_API_KEY
          ? "ready"
          : "missing",

      status:
        "online"

    });
  }
);


/* =========================
   HEALTH
========================= */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      scanning,

      lastScanAt,

      timestamp:
        nowIso()

    });
  }
);


/* =========================
   SIGNALS
========================= */

app.get(
  "/api/signals",
  (req, res) => {

    const result = {};


    for (
      const asset
      of Object.keys(ASSETS)
    ) {

      result[asset] =
        signals.get(asset)
        || {

          asset,

          label:
            ASSETS[asset].label,

          direction:
            "WAIT",

          confidence:
            0,

          reason:
            "WARMING_UP",

          M5: {
            status:
              "WAIT"
          },

          M15: {
            status:
              "WAIT"
          }

        };
    }


    res.json({

      ...result,

      openTrades:
        openTrades.size,

      maxOpenTrades:
        MAX_OPEN_TRADES,

      lastScanAt

    });
  }
);


/* =========================
   OPEN TRADES
========================= */

app.get(
  "/api/open-trades",
  (req, res) => {

    res.json(
      Array.from(
        openTrades.values()
      )
    );
  }
);


/* =========================
   HISTORY
========================= */

app.get(
  "/api/history",
  (req, res) => {

    res.json({

      stats:
        getStats(),

      history

    });
  }
);


/* =========================
   STATS
========================= */

app.get(
  "/api/stats",
  (req, res) => {

    res.json(
      getStats()
    );
  }
);


/* =========================
   FORCE SCAN
========================= */

app.get(
  "/api/scan",
  async (req, res) => {

    await scanAll();

    res.json({

      success: true,

      lastScanAt,

      signals:
        Object.fromEntries(
          signals
        )

    });
  }
);


/* =========================
   TEST NOTIFICATION
========================= */

async function testPush(
  req,
  res
) {

  const success =
    await sendPush(

      "BIT ADAMS ✅",

      "Notifications are working."

    );


  res.json({

    success,

    oneSignal:
      ONESIGNAL_APP_ID &&
      ONESIGNAL_API_KEY
        ? "configured"
        : "missing"

  });
}


app.get(
  "/api/test-notification",
  testPush
);


app.post(
  "/api/test-notification",
  testPush
);


/* =========================
   START
========================= */

app.listen(
  PORT,
  () => {

    loadHistory();


    console.log(
      "================================"
    );

    console.log(
      `BIT ADAMS SERVER PORT ${PORT}`
    );

    console.log(
      "FAST M5 + M15"
    );

    console.log(
      `MIN CONFIDENCE ${MIN_CONFIDENCE}%`
    );

    console.log(
      TWELVE_DATA_API_KEY
        ? "TWELVE DATA READY"
        : "TWELVE DATA KEY MISSING"
    );

    console.log(
      ONESIGNAL_APP_ID &&
      ONESIGNAL_API_KEY
        ? "ONESIGNAL READY"
        : "ONESIGNAL MISSING"
    );

    console.log(
      "================================"
    );


    // First scan immediately

    scanAll();


    // Automatic scan

    setInterval(
      scanAll,
      SCAN_SECONDS * 1000
    );

  }
);
