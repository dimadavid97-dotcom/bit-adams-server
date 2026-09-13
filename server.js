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

const HISTORY_FILE =
  "./history.json";

const RUNTIME_FILE =
  "./runtime-state.json";

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

const states =
  new Map();

const signals =
  new Map();

const openTrades =
  new Map();

const lastSignalTimes =
  new Map();

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

  return new Date()
    .toISOString();
}


function round(
  value,
  digits = 2
) {

  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
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
      !fs.existsSync(
        HISTORY_FILE
      )
    ) {
      return;
    }

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
   RUNTIME STATE
===================================================== */

function loadRuntimeState() {

  try {

    if (
      !fs.existsSync(
        RUNTIME_FILE
      )
    ) {
      return;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          RUNTIME_FILE,
          "utf8"
        )
      );


    if (
      Array.isArray(
        parsed.openTrades
      )
    ) {

      for (
        const trade
        of parsed.openTrades
      ) {

        if (
          trade?.asset &&
          ASSETS[trade.asset]
        ) {

          openTrades.set(
            trade.asset,
            trade
          );
        }
      }
    }


    if (
      parsed.lastSignalTimes &&
      typeof parsed.lastSignalTimes ===
      "object"
    ) {

      for (
        const [
          asset,
          value
        ]
        of Object.entries(
          parsed.lastSignalTimes
        )
      ) {

        if (
          ASSETS[asset] &&
          Number.isFinite(
            Number(value)
          )
        ) {

          lastSignalTimes.set(
            asset,
            Number(value)
          );
        }
      }
    }


    console.log(
      `Runtime restored | open trades ${openTrades.size}`
    );

  } catch (error) {

    console.log(
      "Runtime load warning:",
      error.message
    );
  }
}


function saveRuntimeState() {

  try {

    const signalTimes = {};

    for (
      const [asset, value]
      of lastSignalTimes.entries()
    ) {

      signalTimes[asset] =
        value;
    }


    fs.writeFileSync(

      RUNTIME_FILE,

      JSON.stringify(
        {

          openTrades:
            Array.from(
              openTrades.values()
            ),

          lastSignalTimes:
            signalTimes,

          savedAt:
            nowIso()

        },
        null,
        2
      ),

      "utf8"
    );

  } catch (error) {

    console.log(
      "Runtime save warning:",
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
   MOMENTUM
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


  const index =
    array.findIndex(
      item =>
        item.start ===
        candle.start
    );


  if (
    index >= 0
  ) {

    array[index] = {
      ...candle
    };

  } else {

    array.push({
      ...candle
    });
  }


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
   M5 -> CLOSED M15
===================================================== */

function aggregateClosedM15(
  m5Candles,
  timestampSec =
    Math.floor(
      Date.now() / 1000
    )
) {

  const currentM15Bucket =
    candleBucket(
      timestampSec,
      900
    );


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


    /*
      Never place current M15
      inside closed M15.
    */

    if (
      bucket >=
      currentM15Bucket
    ) {

      continue;
    }


    if (
      !groups.has(bucket)
    ) {

      groups.set(
        bucket,
        []
      );
    }


    groups
      .get(bucket)
      .push(candle);
  }


  const result = [];


  for (
    const [bucket, group]
    of groups.entries()
  ) {

    const sorted =
      group
        .slice()
        .sort(
          (a, b) =>
            a.start - b.start
        );


    /*
      M15 must contain exactly:
      00
      05
      10

      Three complete M5 candles.
    */

    const requiredStarts = [

      bucket,

      bucket + 300,

      bucket + 600

    ];


    const valid =
      requiredStarts.every(
        start =>
          sorted.some(
            candle =>
              candle.start ===
              start
          )
      );


    if (!valid) {
      continue;
    }


    const complete =
      requiredStarts.map(
        start =>
          sorted.find(
            candle =>
              candle.start ===
              start
          )
      );


    result.push({

      start:
        bucket,

      open:
        complete[0].open,

      high:
        Math.max(
          ...complete.map(
            x => x.high
          )
        ),

      low:
        Math.min(
          ...complete.map(
            x => x.low
          )
        ),

      close:
        complete[
          complete.length - 1
        ].close

    });
  }


  return result
    .sort(
      (a, b) =>
        a.start - b.start
    )
    .slice(
      -MAX_CANDLES
    );
}


/* =====================================================
   CURRENT M15 FROM M5
===================================================== */

function buildCurrentM15(
  closedM5,
  currentM5,
  timestampSec =
    Math.floor(
      Date.now() / 1000
    )
) {

  const bucket =
    candleBucket(
      timestampSec,
      900
    );


  const parts =
    closedM5
      .filter(
        candle =>
          candle.start >= bucket &&
          candle.start <
            bucket + 900
      )
      .map(
        candle => ({
          ...candle
        })
      );


  if (
    currentM5 &&
    currentM5.start >= bucket &&
    currentM5.start <
      bucket + 900
  ) {

    const existing =
      parts.findIndex(
        x =>
          x.start ===
          currentM5.start
      );


    if (
      existing >= 0
    ) {

      parts[existing] = {
        ...currentM5
      };

    } else {

      parts.push({
        ...currentM5
      });
    }
  }


  parts.sort(
    (a, b) =>
      a.start - b.start
  );


  if (
    parts.length === 0
  ) {

    return null;
  }


  return {

    start:
      bucket,

    open:
      parts[0].open,

    high:
      Math.max(
        ...parts.map(
          x => x.high
        )
      ),

    low:
      Math.min(
        ...parts.map(
          x => x.low
        )
      ),

    close:
      parts[
        parts.length - 1
      ].close
  };
}


/* =====================================================
   REST BOOTSTRAP
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
            )
              .replace(
                " ",
                "T"
              ) +
              "Z"
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


  const nowSec =
    Math.floor(
      Date.now() / 1000
    );


  const currentM5Bucket =
    candleBucket(
      nowSec,
      300
    );


  /*
    IMPORTANT FIX:

    All candles BEFORE current
    M5 bucket are closed.

    Current bucket is kept
    separate as currentM5.
  */

  state.closedM5 =
    candles
      .filter(
        candle =>
          candle.start <
          currentM5Bucket
      )
      .slice(
        -MAX_CANDLES
      );


  const current =
    candles.find(
      candle =>
        candle.start ===
        currentM5Bucket
    );


  state.currentM5 =
    current
      ? { ...current }
      : null;


  /*
    Only COMPLETE groups of
    three M5 candles become M15.
  */

  state.closedM15 =
    aggregateClosedM15(
      state.closedM5,
      nowSec
    );


  state.currentM15 =
    buildCurrentM15(
      state.closedM5,
      state.currentM5,
      nowSec
    );


  const latest =
    state.currentM5 ||
    state.closedM5[
      state.closedM5.length - 1
    ];


  if (latest) {

    state.lastPrice =
      formatPrice(
        asset,
        latest.close
      );
  }


  state.bootstrapped =
    true;


  console.log(
    `${asset} BOOTSTRAP OK | CLOSED M5 ${state.closedM5.length} | CLOSED M15 ${state.closedM15.length}`
  );


  refreshSignal(asset);
}


/* =====================================================
   LIVE M5 CANDLE
===================================================== */

function updateLiveM5(
  state,
  price,
  timestampSec
) {

  const bucket =
    candleBucket(
      timestampSec,
      300
    );


  let current =
    state.currentM5;


  if (!current) {

    state.currentM5 = {

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


  /*
    Same M5 candle.
  */

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


  /*
    Ignore older/out-of-order tick.
  */

  if (
    bucket <
    current.start
  ) {

    return false;
  }


  /*
    Previous M5 is now CLOSED.
  */

  addClosedCandle(
    state.closedM5,
    current
  );


  state.currentM5 = {

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


  /*
    FAST MODE:
    current live candle is also used
    for live confirmation.
  */

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

      status:
        "WAIT",

      confidence:
        0,

      score:
        0,

      reason:
        "WARMING_UP",

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


  /* RSI BUY */

  if (
    currentRsi >= 52 &&
    currentRsi <= 72
  ) {

    score += 2;
  }


  /* RSI SELL */

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
   M5 + M15
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


  /*
    FULL BUY CONFIRMATION
  */

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


  /*
    FULL SELL CONFIRMATION
  */

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


  /*
    FAST BUY
  */

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

        m5.confidence *
        0.75 +

        Math.max(
          55,
          m15.confidence
        ) *
        0.25
      );


    reason =
      "FAST M5 BUY + M15 not bearish";
  }


  /*
    FAST SELL
  */

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

        m5.confidence *
        0.75 +

        Math.max(
          55,
          m15.confidence
        ) *
        0.25
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
   ONESIGNAL
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


  saveRuntimeState();


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

  saveRuntimeState();


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
   TP / SL
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


  /* ===================================================
     BUY
  =================================================== */

  if (
    trade.direction === "BUY"
  ) {

    /*
      TP1
    */

    if (
      !trade.tp1Hit &&
      price >=
      Number(trade.tp1)
    ) {

      trade.tp1Hit =
        true;

      trade.breakEven =
        true;

      trade.sl =
        trade.entry;

      trade.status =
        "TP1";


      saveRuntimeState();


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


    /*
      TP2
    */

    if (
      !trade.tp2Hit &&
      price >=
      Number(trade.tp2)
    ) {

      trade.tp2Hit =
        true;

      trade.status =
        "TP2";


      saveRuntimeState();


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


    /*
      TP3
    */

    if (
      !trade.tp3Hit &&
      price >=
      Number(trade.tp3)
    ) {

      trade.tp3Hit =
        true;


      saveRuntimeState();


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


    /*
      SL / BREAK EVEN
    */

    if (
      price <=
      Number(trade.sl)
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


  /* ===================================================
     SELL
  =================================================== */

  if (
    trade.direction === "SELL"
  ) {

    /*
      TP1
    */

    if (
      !trade.tp1Hit &&
      price <=
      Number(trade.tp1)
    ) {

      trade.tp1Hit =
        true;

      trade.breakEven =
        true;

      trade.sl =
        trade.entry;

      trade.status =
        "TP1";


      saveRuntimeState();


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


    /*
      TP2
    */

    if (
      !trade.tp2Hit &&
      price <=
      Number(trade.tp2)
    ) {

      trade.tp2Hit =
        true;

      trade.status =
        "TP2";


      saveRuntimeState();


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


    /*
      TP3
    */

    if (
      !trade.tp3Hit &&
      price <=
      Number(trade.tp3)
    ) {

      trade.tp3Hit =
        true;


      saveRuntimeState();


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


    /*
      SL / BREAK EVEN
    */

    if (
      price >=
      Number(trade.sl)
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


  /*
    Update M5 first.
  */

  const newM5 =
    updateLiveM5(
      state,
      price,
      timestampSec
    );


  /*
    When a new M5 begins,
    rebuild COMPLETE M15 candles.
  */

  if (
    newM5
  ) {

    state.closedM15 =
      aggregateClosedM15(
        state.closedM5,
        timestampSec
      );
  }


  /*
    Current M15 is always built
    from M5 data.
  */

  state.currentM15 =
    buildCurrentM15(
      state.closedM5,
      state.currentM5,
      timestampSec
    );


  /*
    Refresh algorithm.
  */

  const signal =
    refreshSignal(asset);


  /*
    Track existing trade first.
  */

  await trackTrade(
    asset,
    price
  );


  /*
    Then check new trade.
  */

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


  /*
    Prevent two sockets.
  */

  if (
    ws &&
    (
      ws.readyState ===
      WebSocket.OPEN ||
      ws.readyState ===
      WebSocket.CONNECTING
    )
  ) {

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

      ws = null;


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

function calculateStats(
  items
) {

  const wins =
    items.filter(
      x =>
        x.status === "WIN"
    ).length;


  const losses =
    items.filter(
      x =>
        x.status === "LOST"
    ).length;


  const breakEven =
    items.filter(
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

    total:
      items.length
  };
}


function getStats() {

  const global =
    calculateStats(
      history
    );


  const goldHistory =
    history.filter(
      x =>
        x.asset ===
        "XAUUSD"
    );


  const btcHistory =
    history.filter(
      x =>
        x.asset ===
        "BTCUSD"
    );


  return {

    wins:
      global.wins,

    losses:
      global.losses,

    breakEven:
      global.breakEven,

    winRate:
      global.winRate,

    totalHistory:
      history.length,

    openTrades:
      openTrades.size,

    maxOpenTrades:
      MAX_OPEN_TRADES,

    XAUUSD:
      calculateStats(
        goldHistory
      ),

    BTCUSD:
      calculateStats(
        btcHistory
      )
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
        "8.7 LIVE",

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

      version:
        "8.7",

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
   DEBUG
===================================================== */

app.get(
  "/api/debug",
  (req, res) => {

    const result = {};


    for (
      const asset
      of Object.keys(ASSETS)
    ) {

      const state =
        ensureState(asset);


      result[asset] = {

        lastPrice:
          state.lastPrice,

        lastTickAt:
          state.lastTickAt,

        closedM5:
          state.closedM5.length,

        closedM15:
          state.closedM15.length,

        currentM5:
          state.currentM5,

        currentM15:
          state.currentM15,

        signal:
          signals.get(asset)
          || null,

        openTrade:
          openTrades.get(asset)
          || null
      };
    }


    res.json({

      version:
        "8.7",

      websocketConnected:
        wsConnected,

      lastEvent:
        wsLastEvent,

      data:
        result
    });
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

      "Notifications are working.",

      {
        event:
          "TEST"
      }
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

    loadRuntimeState();


    console.log(
      "===================================="
    );

    console.log(
      `BIT ADAMS v8.7 LIVE PORT ${PORT}`
    );

    console.log(
      `MIN CONFIDENCE ${MIN_CONFIDENCE}%`
    );

    console.log(
      "FAST M5 + M15"
    );

    console.log(
      "M15 = 3 COMPLETE M5 CANDLES"
    );

    console.log(
      "TP1 => SL TO ENTRY"
    );

    console.log(
      "REST = BOOTSTRAP ONLY"
    );

    console.log(
      "LIVE = WEBSOCKET"
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
      Only 2 REST requests:

      GOLD M5
      BITCOIN M5
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


  saveHistory();

  saveRuntimeState();


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
