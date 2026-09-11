import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import WebSocket from "ws";

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

const MIN_CONFIDENCE =
  Number(process.env.MIN_CONFIDENCE || 68);

const MAX_OPEN_TRADES = 2;

const MAX_CANDLES = 150;

const HISTORY_FILE = "./history.json";

const SIGNAL_COOLDOWN_MS =
  15 * 60 * 1000;


/* =====================================================
   ASSETS
===================================================== */

const ASSETS = {

  XAUUSD: {
    symbol: "XAU/USD",
    label: "GOLD",
    digits: 2
  },

  BTCUSD: {
    symbol: "BTC/USD",
    label: "BITCOIN",
    digits: 2
  }

};


/* =====================================================
   MEMORY
===================================================== */

const states = new Map();

const signals = new Map();

const openTrades = new Map();

const lastSignalTimes = new Map();

let history = [];

let ws = null;

let wsConnected = false;

let wsLastEvent = null;

let reconnectTimer = null;

let reconnectAttempt = 0;

let shuttingDown = false;


/* =====================================================
   HELPERS
===================================================== */

function nowIso() {

  return new Date().toISOString();
}


function round(
  value,
  digits = 2
) {

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Number(
    n.toFixed(digits)
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


function assetFromSymbol(
  symbol
) {

  const normalized =
    String(symbol || "")
      .toUpperCase();

  for (
    const [asset, config]
    of Object.entries(ASSETS)
  ) {

    if (
      config.symbol.toUpperCase() ===
      normalized
    ) {

      return asset;
    }
  }

  return null;
}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


/* =====================================================
   STATE
===================================================== */

function ensureState(asset) {

  if (
    !states.has(asset)
  ) {

    states.set(
      asset,
      {

        asset,

        lastPrice: null,

        lastTickAt: null,

        currentM5: null,

        currentM15: null,

        closedM5: [],

        closedM15: [],

        bootstrapped: false
      }
    );
  }

  return states.get(asset);
}


/* =====================================================
   HISTORY
===================================================== */

function loadHistory() {

  try {

    if (
      fs.existsSync(
        HISTORY_FILE
      )
    ) {

      const parsed =
        JSON.parse(
          fs.readFileSync(
            HISTORY_FILE,
            "utf8"
          )
        );

      if (
        Array.isArray(parsed)
      ) {

        history =
          parsed.slice(
            0,
            500
          );
      }
    }

  } catch (error) {

    console.log(
      "History load warning:",
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
      "History save warning:",
      error.message
    );
  }
}


/* =====================================================
   EMA
===================================================== */

function ema(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {

    return null;
  }

  const multiplier =
    2 / (period + 1);

  let current =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    current =
      (
        values[i] -
        current
      ) *
      multiplier +
      current;
  }

  return current;
}


/* =====================================================
   RSI 14
===================================================== */

function rsi(
  values,
  period = 14
) {

  if (
    !Array.isArray(values) ||
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


/* =====================================================
   ATR 14
===================================================== */

function atr(
  candles,
  period = 14
) {

  if (
    !Array.isArray(candles) ||
    candles.length <
      period + 1
  ) {

    return null;
  }

  const trValues = [];

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

    trValues.push(tr);
  }

  const recent =
    trValues.slice(
      -period
    );

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) /
    recent.length
  );
}


/* =====================================================
   MOMENTUM %
===================================================== */

function momentumPercent(
  values,
  period = 3
) {

  if (
    !Array.isArray(values) ||
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

  if (
    !Number.isFinite(previous) ||
    previous === 0
  ) {

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


/* =====================================================
   CANDLE BUCKET
===================================================== */

function candleBucket(
  timestampSec,
  intervalSec
) {

  return (
    Math.floor(
      timestampSec /
      intervalSec
    ) *
    intervalSec
  );
}


/* =====================================================
   ADD CLOSED CANDLE
===================================================== */

function addClosedCandle(
  array,
  candle
) {

  if (!candle) {
    return;
  }

  const exists =
    array.find(
      item =>
        item.start ===
        candle.start
    );

  if (exists) {
    return;
  }

  array.push({
    ...candle
  });

  array.sort(
    (a, b) =>
      a.start - b.start
  );

  while (
    array.length >
    MAX_CANDLES
  ) {

    array.shift();
  }
}


/* =====================================================
   REST BOOTSTRAP
   ONLY M5
   1 REQUEST PER ASSET
===================================================== */

async function bootstrapAsset(
  asset
) {

  const state =
    ensureState(asset);

  const symbol =
    ASSETS[asset].symbol;

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    "&interval=5min" +
    "&outputsize=100" +
    `&apikey=${encodeURIComponent(
      TWELVE_DATA_API_KEY
    )}`;


  console.log(
    `Bootstrap ${asset} M5...`
  );


  const response =
    await fetch(url);


  const data =
    await response
      .json()
      .catch(() => ({}));


  if (
    !response.ok ||
    data.status === "error" ||
    !Array.isArray(data.values)
  ) {

    throw new Error(
      data.message ||
      `Bootstrap failed ${asset}`
    );
  }


  const candles =
    data.values
      .map(item => {

        const date =
          new Date(
            String(
              item.datetime
            ).replace(
              " ",
              "T"
            ) + "Z"
          );

        return {

          start:
            Math.floor(
              date.getTime() /
              1000
            ),

          open:
            Number(item.open),

          high:
            Number(item.high),

          low:
            Number(item.low),

          close:
            Number(item.close)
        };
      })
      .filter(
        candle =>
          Number.isFinite(
            candle.start
          ) &&
          Number.isFinite(
            candle.open
          ) &&
          Number.isFinite(
            candle.high
          ) &&
          Number.isFinite(
            candle.low
          ) &&
          Number.isFinite(
            candle.close
          )
      )
      .reverse();


  state.closedM5 =
    candles.slice(
      -MAX_CANDLES
    );


  state.closedM15 =
    aggregateM15(
      state.closedM5
    );


  if (
    candles.length
  ) {

    state.lastPrice =
      formatPrice(
        asset,
        candles[
          candles.length - 1
        ].close
      );
  }


  state.bootstrapped =
    true;


  console.log(
    `${asset} bootstrap OK | M5 ${state.closedM5.length} | M15 ${state.closedM15.length}`
  );


  refreshSignal(asset);
}


/* =====================================================
   M5 -> M15 AGGREGATION
===================================================== */

function aggregateM15(
  m5Candles
) {

  const groups =
    new Map();


  for (
    const candle
    of m5Candles
  ) {

    const bucket =
      candleBucket(
        candle.start,
        900
      );


    if (
      !groups.has(bucket)
    ) {

      groups.set(
        bucket,
        {

          start:
            bucket,

          open:
            candle.open,

          high:
            candle.high,

          low:
            candle.low,

          close:
            candle.close
        }
      );

    } else {

      const current =
        groups.get(bucket);

      current.high =
        Math.max(
          current.high,
          candle.high
        );

      current.low =
        Math.min(
          current.low,
          candle.low
        );

      current.close =
        candle.close;
    }
  }


  return Array
    .from(
      groups.values()
    )
    .sort(
      (a, b) =>
        a.start - b.start
    )
    .slice(
      -MAX_CANDLES
    );
}


/* =====================================================
   LIVE CANDLE UPDATE
===================================================== */

function updateLiveCandle(
  state,
  timeframe,
  intervalSec,
  price,
  timestampSec
) {

  const currentKey =
    timeframe === "M5"
      ? "currentM5"
      : "currentM15";

  const closedKey =
    timeframe === "M5"
      ? "closedM5"
      : "closedM15";

  const bucket =
    candleBucket(
      timestampSec,
      intervalSec
    );

  let current =
    state[currentKey];


  if (!current) {

    state[currentKey] = {

      start:
        bucket,

      open:
        price,

      high:
        price,

      low:
        price,

      close:
        price
    };

    return false;
  }


  if (
    bucket ===
    current.start
  ) {

    current.high =
      Math.max(
        current.high,
        price
      );

    current.low =
      Math.min(
        current.low,
        price
      );

    current.close =
      price;

    return false;
  }


  if (
    bucket <
    current.start
  ) {

    return false;
  }


  addClosedCandle(
    state[closedKey],
    current
  );


  state[currentKey] = {

    start:
      bucket,

    open:
      price,

    high:
      price,

    low:
      price,

    close:
      price
  };


  return true;
}


/* =====================================================
   ANALYSIS
===================================================== */

function analyseTimeframe(
  asset,
  timeframe,
  closedCandles,
  currentCandle
) {

  const candles = [
    ...closedCandles
  ];


  if (
    currentCandle
  ) {

    candles.push({
      ...currentCandle
    });
  }


  if (
    candles.length < 25
  ) {

    return {

      asset,

      timeframe,

      status: "WAIT",

      confidence: 0,

      score: 0,

      reason: "WARMING_UP",

      bars:
        candles.length
    };
  }


  const recent =
    candles.slice(-80);


  const closes =
    recent.map(
      candle =>
        candle.close
    );


  const last =
    recent[
      recent.length - 1
    ];


  const previous =
    recent[
      recent.length - 2
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
      recent,
      14
    );


  const momentum =
    momentumPercent(
      closes,
      3
    );


  let score = 0;


  /* EMA TREND */

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


  /* PRICE VS EMA */

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


  /* RSI */

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


  /* MOMENTUM */

  if (
    momentum > 0.015
  ) {

    score += 2;
  }


  if (
    momentum < -0.015
  ) {

    score -= 2;
  }


  /* CURRENT CANDLE */

  if (
    last.close >
    last.open
  ) {

    score += 1;
  }


  if (
    last.close <
    last.open
  ) {

    score -= 1;
  }


  /* FOLLOW THROUGH */

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

    status =
      "BUY";
  }


  if (
    score <= -4
  ) {

    status =
      "SELL";
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

    bars:
      recent.length,

    updatedAt:
      nowIso()
  };
}


/* =====================================================
   M5 + M15 CONFIRMATION
===================================================== */

function combineSignals(
  asset,
  m5,
  m15
) {

  let direction =
    "WAIT";

  let confidence =
    0;

  let reason =
    "Waiting for confirmation";


  /* M5 + M15 AGREE */

  if (
    m5.status === "BUY" &&
    m15.status === "BUY"
  ) {

    direction =
      "BUY";

    confidence =
      Math.round(
        m5.confidence * 0.6 +
        m15.confidence * 0.4
      );

    reason =
      "M5 + M15 BUY confirmation";
  }


  if (
    m5.status === "SELL" &&
    m15.status === "SELL"
  ) {

    direction =
      "SELL";

    confidence =
      Math.round(
        m5.confidence * 0.6 +
        m15.confidence * 0.4
      );

    reason =
      "M5 + M15 SELL confirmation";
  }


  /* FAST BUY */

  if (
    direction === "WAIT" &&
    m5.status === "BUY" &&
    m5.confidence >= 70 &&
    m15.score >= -1
  ) {

    direction =
      "BUY";

    confidence =
      Math.round(
        m5.confidence * 0.75 +
        Math.max(
          55,
          m15.confidence
        ) * 0.25
      );

    reason =
      "FAST M5 BUY + M15 not bearish";
  }


  /* FAST SELL */

  if (
    direction === "WAIT" &&
    m5.status === "SELL" &&
    m5.confidence >= 70 &&
    m15.score <= 1
  ) {

    direction =
      "SELL";

    confidence =
      Math.round(
        m5.confidence * 0.75 +
        Math.max(
          55,
          m15.confidence
        ) * 0.25
      );

    reason =
      "FAST M5 SELL + M15 not bullish";
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
      ASSETS[asset].symbol,

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


/* =====================================================
   REFRESH SIGNAL
===================================================== */

function refreshSignal(
  asset
) {

  const state =
    ensureState(asset);


  const m5 =
    analyseTimeframe(

      asset,

      "M5",

      state.closedM5,

      state.currentM5
    );


  const m15 =
    analyseTimeframe(

      asset,

      "M15",

      state.closedM15,

      state.currentM15
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


  return finalSignal;
}


/* =====================================================
   ONE SIGNAL
===================================================== */

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


/* =====================================================
   TRADE LEVELS
===================================================== */

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
      signal.M5?.atr
    );


  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0
  ) {

    return null;
  }


  if (
    signal.direction === "BUY"
  ) {

    return {

      entry:
        formatPrice(
          asset,
          entry
        ),

      sl:
        formatPrice(
          asset,
          entry -
          atrValue * 1.15
        ),

      tp1:
        formatPrice(
          asset,
          entry +
          atrValue
        ),

      tp2:
        formatPrice(
          asset,
          entry +
          atrValue * 1.8
        ),

      tp3:
        formatPrice(
          asset,
          entry +
          atrValue * 2.6
        )
    };
  }


  if (
    signal.direction === "SELL"
  ) {

    return {

      entry:
        formatPrice(
          asset,
          entry
        ),

      sl:
        formatPrice(
          asset,
          entry +
          atrValue * 1.15
        ),

      tp1:
        formatPrice(
          asset,
          entry -
          atrValue
        ),

      tp2:
        formatPrice(
          asset,
          entry -
          atrValue * 1.8
        ),

      tp3:
        formatPrice(
          asset,
          entry -
          atrValue * 2.6
        )
    };
  }


  return null;
}


/* =====================================================
   OPEN TRADE
===================================================== */

async function maybeOpenTrade(
  asset,
  signal
) {

  if (
    !signal ||
    signal.direction === "WAIT"
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


  const lastTime =
    lastSignalTimes.get(asset)
    || 0;


  if (
    Date.now() -
    lastTime <
    SIGNAL_COOLDOWN_MS
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
    "NEW TRADE",
    asset,
    trade.direction,
    trade.entry
  );
}


/* =====================================================
   CLOSE TRADE
===================================================== */

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


  console.log(
    "TRADE CLOSED",
    asset,
    result
  );
}


/* =====================================================
   TP / SL LIVE TRACKING
===================================================== */

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

      trade.tp1Hit =
        true;

      trade.breakEven =
        true;

      trade.sl =
        trade.entry;

      trade.status =
        "TP1";


      await sendPush(

        `${trade.label} TP1 ✅`,

        `TP1 ${trade.tp1} hit. Move SL to ENTRY ${trade.entry}.`,

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

      trade.tp2Hit =
        true;

      trade.status =
        "TP2";


      await sendPush(

        `${trade.label} TP2 ✅`,

        `TP2 ${trade.tp2} hit.`,

        {

          event:
            "TP2",

          asset,

          trade
        }
      );
    }


    if (
      !trade.tp3Hit &&
      price >= trade.tp3
    ) {

      trade.tp3Hit =
        true;


      await sendPush(

        `${trade.label} TP3 ✅`,

        `TP3 ${trade.tp3} hit.`,

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

      trade.tp1Hit =
        true;

      trade.breakEven =
        true;

      trade.sl =
        trade.entry;

      trade.status =
        "TP1";


      await sendPush(

        `${trade.label} TP1 ✅`,

        `TP1 ${trade.tp1} hit. Move SL to ENTRY ${trade.entry}.`,

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

      trade.tp2Hit =
        true;

      trade.status =
        "TP2";


      await sendPush(

        `${trade.label} TP2 ✅`,

        `TP2 ${trade.tp2} hit.`,

        {

          event:
            "TP2",

          asset,

          trade
        }
      );
    }


    if (
      !trade.tp3Hit &&
      price <= trade.tp3
    ) {

      trade.tp3Hit =
        true;


      await sendPush(

        `${trade.label} TP3 ✅`,

        `TP3 ${trade.tp3} hit.`,

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
    }
  }
}


/* =====================================================
   PRICE EVENT
===================================================== */

async function handlePrice(
  message
) {

  const asset =
    assetFromSymbol(
      message.symbol
    );


  if (!asset) {
    return;
  }


  const price =
    Number(
      message.price
    );


  const timestampSec =
    Number(
      message.timestamp
    );


  if (
    !Number.isFinite(price) ||
    !Number.isFinite(timestampSec)
  ) {

    return;
  }


  const state =
    ensureState(asset);


  state.lastPrice =
    formatPrice(
      asset,
      price
    );


  state.lastTickAt =
    new Date(
      timestampSec *
      1000
    ).toISOString();


  wsLastEvent =
    nowIso();


  updateLiveCandle(

    state,

    "M5",

    300,

    price,

    timestampSec
  );


  updateLiveCandle(

    state,

    "M15",

    900,

    price,

    timestampSec
  );


  const signal =
    refreshSignal(asset);


  await trackTrade(
    asset,
    price
  );


  await maybeOpenTrade(
    asset,
    signal
  );
}


/* =====================================================
   WEBSOCKET
===================================================== */

function scheduleReconnect() {

  if (
    shuttingDown ||
    reconnectTimer
  ) {

    return;
  }


  reconnectAttempt += 1;


  const waitMs =
    Math.min(

      30000,

      1000 *
      2 **
      Math.min(
        reconnectAttempt - 1,
        5
      )
    );


  console.log(
    "Reconnect in",
    Math.round(
      waitMs / 1000
    ),
    "sec"
  );


  reconnectTimer =
    setTimeout(
      () => {

        reconnectTimer =
          null;

        connectWebSocket();

      },
      waitMs
    );
}


function connectWebSocket() {

  if (
    !TWELVE_DATA_API_KEY
  ) {

    console.log(
      "TWELVE DATA KEY MISSING"
    );

    return;
  }


  const url =
    `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(
      TWELVE_DATA_API_KEY
    )}`;


  console.log(
    "Connecting Twelve Data WebSocket..."
  );


  ws =
    new WebSocket(url);


  ws.on(
    "open",
    () => {

      wsConnected =
        true;

      reconnectAttempt =
        0;


      console.log(
        "TWELVE DATA WEBSOCKET CONNECTED"
      );


      ws.send(
        JSON.stringify({

          action:
            "subscribe",

          params: {

            symbols:
              Object
                .values(ASSETS)
                .map(
                  x => x.symbol
                )
                .join(",")
          }
        })
      );
    }
  );


  ws.on(
    "message",
    raw => {

      let message;


      try {

        message =
          JSON.parse(
            raw.toString()
          );

      } catch {

        return;
      }


      if (
        message.event ===
        "price"
      ) {

        handlePrice(
          message
        ).catch(
          error => {

            console.log(
              "PRICE ERROR:",
              error.message
            );
          }
        );

        return;
      }


      console.log(
        "WS:",
        JSON.stringify(
          message
        )
      );
    }
  );


  ws.on(
    "error",
    error => {

      console.log(
        "WEBSOCKET ERROR:",
        error.message
      );
    }
  );


  ws.on(
    "close",
    () => {

      wsConnected =
        false;


      console.log(
        "WEBSOCKET CLOSED"
      );


      scheduleReconnect();
    }
  );
}


/* =====================================================
   STATS
===================================================== */

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
      x =>
        x.status ===
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


/* =====================================================
   HOME
===================================================== */

app.get(
  "/",
  (req, res) => {

    res.json({

      app:
        "BIT ADAMS SERVER",

      version:
        "8.6 LIVE",

      mode:
        "FAST M5 + M15 WEBSOCKET",

      minConfidence:
        MIN_CONFIDENCE,

      websocketConnected:
        wsConnected,

      lastEvent:
        wsLastEvent,

      openTrades:
        openTrades.size,

      status:
        "online"
    });
  }
);


/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      websocketConnected:
        wsConnected,

      lastEvent:
        wsLastEvent,

      timestamp:
        nowIso()
    });
  }
);


/* =====================================================
   SIGNALS
===================================================== */

app.get(
  "/api/signals",
  (req, res) => {

    const result = {};


    for (
      const asset
      of Object.keys(ASSETS)
    ) {

      const state =
        ensureState(asset);


      result[asset] =
        signals.get(asset)
        || {

          asset,

          label:
            ASSETS[asset].label,

          symbol:
            ASSETS[asset].symbol,

          direction:
            "WAIT",

          confidence:
            0,

          reason:
            "WARMING_UP",

          price:
            state.lastPrice,

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

      websocketConnected:
        wsConnected,

      lastEvent:
        wsLastEvent
    });
  }
);


/* =====================================================
   PRICES
===================================================== */

app.get(
  "/api/prices",
  (req, res) => {

    const result = {};


    for (
      const asset
      of Object.keys(ASSETS)
    ) {

      const state =
        ensureState(asset);


      result[asset] = {

        price:
          state.lastPrice,

        lastTickAt:
          state.lastTickAt
      };
    }


    res.json(result);
  }
);


/* =====================================================
   OPEN TRADES
===================================================== */

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


/* =====================================================
   HISTORY
===================================================== */

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


/* =====================================================
   STATS
===================================================== */

app.get(
  "/api/stats",
  (req, res) => {

    res.json(
      getStats()
    );
  }
);


/* =====================================================
   TEST NOTIFICATION
===================================================== */

async function testNotification(
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
  testNotification
);


app.post(
  "/api/test-notification",
  testNotification
);


/* =====================================================
   START SERVER
===================================================== */

app.listen(
  PORT,
  async () => {

    loadHistory();


    console.log(
      "===================================="
    );

    console.log(
      `BIT ADAMS v8.6 LIVE PORT ${PORT}`
    );

    console.log(
      `MIN CONFIDENCE ${MIN_CONFIDENCE}%`
    );

    console.log(
      "REST: BOOTSTRAP ONLY"
    );

    console.log(
      "LIVE: WEBSOCKET"
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
      "===================================="
    );


    /*
      Only TWO REST requests at startup:
      1 GOLD
      1 BITCOIN

      If today's Twelve Data credits are already exhausted,
      bootstrap may fail, but WebSocket will still connect.
    */

    try {

      await bootstrapAsset(
        "XAUUSD"
      );

    } catch (error) {

      console.log(
        "GOLD BOOTSTRAP WARNING:",
        error.message
      );
    }


    await sleep(1200);


    try {

      await bootstrapAsset(
        "BTCUSD"
      );

    } catch (error) {

      console.log(
        "BITCOIN BOOTSTRAP WARNING:",
        error.message
      );
    }


    connectWebSocket();
  }
);


/* =====================================================
   SAFE SHUTDOWN
===================================================== */

function shutdown() {

  shuttingDown =
    true;


  if (
    reconnectTimer
  ) {

    clearTimeout(
      reconnectTimer
    );
  }


  try {

    if (
      ws?.readyState ===
      WebSocket.OPEN
    ) {

      ws.close(
        1000,
        "server shutdown"
      );
    }

  } catch {}


  process.exit(0);
}


process.on(
  "SIGTERM",
  shutdown
);


process.on(
  "SIGINT",
  shutdown
);
