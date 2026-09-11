import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);

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
  Number(process.env.MIN_CONFIDENCE || 78);

const MAX_OPEN_TRADES = 2;


/* =========================
   ASSETS
========================= */

const ASSETS = {

  XAUUSD: {
    api: "XAU/USD",
    label: "GOLD"
  },

  BTCUSD: {
    api: "BTC/USD",
    label: "BITCOIN"
  }

};


const TIMEFRAMES = {

  M5: "5min",

  M15: "15min"

};


/* =========================
   STATE
========================= */

const state = {

  updatedAt: null,

  running: false,

  error: null,

  assets: {

    XAUUSD: {
      M5: null,
      M15: null
    },

    BTCUSD: {
      M5: null,
      M15: null
    }

  }

};


const candleCache = new Map();

const acceptedSignalFingerprints =
  new Map();

let apiRequestTimes = [];

let apiGate =
  Promise.resolve();

let tradeHistory = [];


/* =========================
   HELPERS
========================= */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );

}


function nowIso() {

  return new Date()
    .toISOString();

}


function isOpenStatus(status) {

  return [
    "OPEN",
    "TP1",
    "TP2"
  ].includes(
    String(status || "")
      .toUpperCase()
  );

}


function getOpenTrades() {

  return tradeHistory.filter(
    t =>
      isOpenStatus(t.status)
  );

}


function getOpenTradeForAsset(
  symbol
) {

  return (
    tradeHistory.find(
      t =>
        t.symbol === symbol &&
        isOpenStatus(t.status)
    ) || null
  );

}


function roundPrice(value) {

  if(
    !Number.isFinite(
      Number(value)
    )
  ) {

    return null;

  }

  return Number(
    Number(value)
      .toFixed(2)
  );

}


function priceText(value) {

  if(
    !Number.isFinite(
      Number(value)
    )
  ) {

    return "—";

  }

  return Number(value)
    .toFixed(2);

}


/* =========================
   API CREDIT GUARD
   MAX 8 / MINUTE
========================= */

async function reserveApiCredit() {

  const run =
    apiGate.then(
      async () => {

        while(true) {

          const now =
            Date.now();

          apiRequestTimes =
            apiRequestTimes.filter(
              t =>
                now - t < 60000
            );

          if(
            apiRequestTimes.length < 8
          ) {

            apiRequestTimes.push(
              Date.now()
            );

            return;

          }

          const wait =
            Math.max(
              500,
              60000 -
              (
                now -
                apiRequestTimes[0]
              )
              +
              400
            );

          await sleep(wait);

        }

      }
    );


  apiGate =
    run.catch(
      () => {}
    );

  return run;

}


/* =========================
   INDICATORS
========================= */

function emaSeries(
  values,
  period
) {

  if(
    !values.length
  ) {

    return [];

  }

  const k =
    2 /
    (
      period + 1
    );

  const out =
    [values[0]];

  for(
    let i = 1;
    i < values.length;
    i++
  ) {

    out.push(

      values[i] * k
      +
      out[i - 1] *
      (1 - k)

    );

  }

  return out;

}


function rsi(
  values,
  period = 14
) {

  if(
    !Array.isArray(values)
    ||
    values.length <= period
  ) {

    return 50;

  }

  let gains = 0;

  let losses = 0;

  for(
    let i =
      values.length - period;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if(
      change >= 0
    ) {

      gains +=
        change;

    }
    else {

      losses +=
        Math.abs(change);

    }

  }


  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;


  if(
    avgLoss === 0
  ) {

    return 100;

  }


  const rs =
    avgGain /
    avgLoss;


  return (
    100 -
    100 /
    (
      1 + rs
    )
  );

}


function atr(
  candles,
  period = 14
) {

  if(
    !Array.isArray(candles)
    ||
    candles.length <= period
  ) {

    return 0;

  }


  const trs = [];


  for(
    let i =
      candles.length - period;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];


    trs.push(

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

      )

    );

  }


  return (
    trs.reduce(
      (a, b) =>
        a + b,
      0
    )
    /
    trs.length
  );

}


function slope(
  values,
  lookback = 5
) {

  if(
    !Array.isArray(values)
    ||
    values.length <
    lookback + 1
  ) {

    return 0;

  }


  const a =
    values.at(-1);

  const b =
    values[
      values.length -
      1 -
      lookback
    ];


  return (
    (
      a - b
    )
    /
    Math.max(
      Math.abs(b),
      1
    )
    *
    100
  );

}


function macd(values) {

  if(
    values.length < 35
  ) {

    return {
      line: 0,
      signal: 0,
      hist: 0
    };

  }


  const e12 =
    emaSeries(
      values,
      12
    );

  const e26 =
    emaSeries(
      values,
      26
    );


  const lineSeries =
    values.map(
      (_, i) =>
        e12[i] -
        e26[i]
    );


  const signalSeries =
    emaSeries(
      lineSeries,
      9
    );


  return {

    line:
      lineSeries.at(-1),

    signal:
      signalSeries.at(-1),

    hist:
      lineSeries.at(-1)
      -
      signalSeries.at(-1)

  };

}


/* =========================
   TWELVE DATA
========================= */

async function fetchCandles(
  apiSymbol,
  interval,
  outputsize = 80,
  force = false
) {

  if(
    !TWELVE_DATA_API_KEY
  ) {

    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );

  }


  const cacheKey =
    `${apiSymbol}|${interval}`;


  const cached =
    candleCache.get(
      cacheKey
    );


  if(
    !force
    &&
    cached
    &&
    Date.now() -
    cached.time <
    45000
  ) {

    return (
      cached.candles
        .slice(
          -outputsize
        )
    );

  }


  await reserveApiCredit();


  const url =
    new URL(
      "https://api.twelvedata.com/time_series"
    );


  url.searchParams.set(
    "symbol",
    apiSymbol
  );

  url.searchParams.set(
    "interval",
    interval
  );

  url.searchParams.set(
    "outputsize",
    String(
      Math.max(
        80,
        outputsize
      )
    )
  );

  url.searchParams.set(
    "apikey",
    TWELVE_DATA_API_KEY
  );


  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            "application/json"
        }
      }
    );


  const data =
    await response
      .json()
      .catch(
        () => ({})
      );


  if(
    !response.ok
    ||
    data.status === "error"
    ||
    !Array.isArray(
      data.values
    )
  ) {

    throw new Error(

      data.message
      ||
      data.code
      ||
      `Twelve Data HTTP ${response.status}`

    );

  }


  const candles =
    data.values

      .map(
        v => ({

          datetime:
            v.datetime,

          open:
            Number(v.open),

          high:
            Number(v.high),

          low:
            Number(v.low),

          close:
            Number(v.close)

        })
      )

      .filter(
        c =>
          [
            c.open,
            c.high,
            c.low,
            c.close
          ]
          .every(
            Number.isFinite
          )
      )

      .reverse();


  candleCache.set(
    cacheKey,
    {
      time:
        Date.now(),

      candles
    }
  );


  return (
    candles.slice(
      -outputsize
    )
  );

}


/* =========================
   FAST SIGNAL ENGINE
========================= */

function analyze(
  symbol,
  timeframe,
  candles
) {

  if(
    !Array.isArray(candles)
    ||
    candles.length < 50
  ) {

    throw new Error(
      "Not enough candles"
    );

  }


  const closes =
    candles.map(
      c =>
        c.close
    );


  const latest =
    candles.at(-1);

  const previous =
    candles.at(-2);


  const e9 =
    emaSeries(
      closes,
      9
    );

  const e21 =
    emaSeries(
      closes,
      21
    );

  const e50 =
    emaSeries(
      closes,
      50
    );


  const fast =
    e9.at(-1);

  const slow =
    e21.at(-1);

  const long =
    e50.at(-1);


  const rsi14 =
    rsi(
      closes,
      14
    );


  const atr14 =
    atr(
      candles,
      14
    );


  const momentum =
    slope(
      closes,
      6
    );


  const trendSlope =
    slope(
      e21,
      5
    );


  const M =
    macd(
      closes
    );


  const body =
    Math.abs(
      latest.close -
      latest.open
    );


  const range =
    Math.max(
      latest.high -
      latest.low,
      1e-9
    );


  const bodyRatio =
    body /
    range;


  const atrPct =
    atr14
    /
    Math.max(
      latest.close,
      1
    )
    *
    100;


  let buy = 0;

  let sell = 0;


  if(
    fast > slow
  ) {

    buy += 18;

  }
  else {

    sell += 18;

  }


  if(
    slow > long
  ) {

    buy += 15;

  }
  else {

    sell += 15;

  }


  if(
    latest.close > fast
  ) {

    buy += 9;

  }
  else {

    sell += 9;

  }


  if(
    latest.close > slow
  ) {

    buy += 7;

  }
  else {

    sell += 7;

  }


  if(
    trendSlope > 0.010
  ) {

    buy += 10;

  }
  else if(
    trendSlope < -0.010
  ) {

    sell += 10;

  }


  if(
    rsi14 >= 52
    &&
    rsi14 <= 70
  ) {

    buy += 13;

  }
  else if(
    rsi14 <= 48
    &&
    rsi14 >= 30
  ) {

    sell += 13;

  }
  else if(
    rsi14 > 72
  ) {

    sell += 3;

  }
  else if(
    rsi14 < 28
  ) {

    buy += 3;

  }


  if(
    momentum > 0.015
  ) {

    buy += 10;

  }
  else if(
    momentum < -0.015
  ) {

    sell += 10;

  }


  if(
    M.hist > 0
    &&
    M.line > M.signal
  ) {

    buy += 10;

  }
  else if(
    M.hist < 0
    &&
    M.line < M.signal
  ) {

    sell += 10;

  }


  if(
    latest.close >
    latest.open
  ) {

    buy += 4;

  }


  if(
    latest.close <
    latest.open
  ) {

    sell += 4;

  }


  if(
    latest.close >
    latest.open
    &&
    previous.close >
    previous.open
  ) {

    buy += 4;

  }


  if(
    latest.close <
    latest.open
    &&
    previous.close <
    previous.open
  ) {

    sell += 4;

  }


  if(
    bodyRatio > 0.50
  ) {

    if(
      latest.close >
      latest.open
    ) {

      buy += 5;

    }
    else {

      sell += 5;

    }

  }


  const dominant =
    Math.max(
      buy,
      sell
    );


  const difference =
    Math.abs(
      buy -
      sell
    );


  const buyTrend =

    fast > slow
    &&
    latest.close > slow
    &&
    trendSlope >= 0;


  const sellTrend =

    fast < slow
    &&
    latest.close < slow
    &&
    trendSlope <= 0;


  const volatilityOK =

    atrPct >= (
      symbol === "BTCUSD"
        ? 0.06
        : 0.018
    );


  let side =
    "WAIT";


  if(
    volatilityOK
    &&
    buy >= 60
    &&
    difference >= 10
    &&
    buyTrend
    &&
    rsi14 < 74
    &&
    momentum > -0.015
  ) {

    side =
      "BUY";

  }


  if(
    volatilityOK
    &&
    sell >= 60
    &&
    difference >= 10
    &&
    sellTrend
    &&
    rsi14 > 26
    &&
    momentum < 0.015
  ) {

    side =
      "SELL";

  }


  const confidence =

    side === "WAIT"

      ?

      Math.round(

        Math.min(
          72,
          45 +
          dominant * 0.25
        )

      )

      :

      Math.round(

        Math.max(
          72,

          Math.min(
            96,

            58
            +
            dominant * 0.34
            +
            difference * 0.10
          )

        )

      );


  const entry =
    latest.close;


  const atrFloor =

    entry * (

      symbol === "BTCUSD"

        ? 0.0011

        : 0.0008

    );


  const risk =
    Math.max(
      atr14 * 1.10,
      atrFloor
    );


  let sl = null;

  let tp1 = null;

  let tp2 = null;

  let tp3 = null;


  if(
    side === "BUY"
  ) {

    sl =
      entry -
      risk;

    tp1 =
      entry +
      risk * 0.85;

    tp2 =
      entry +
      risk * 1.45;

    tp3 =
      entry +
      risk * 2.20;

  }


  if(
    side === "SELL"
  ) {

    sl =
      entry +
      risk;

    tp1 =
      entry -
      risk * 0.85;

    tp2 =
      entry -
      risk * 1.45;

    tp3 =
      entry -
      risk * 2.20;

  }


  const quality =

    side === "WAIT"

      ? "WAIT"

      : confidence >= 90

        ? "EXCELLENT"

        : confidence >= 82

          ? "STRONG"

          : "VALID";


  return {

    symbol,

    asset:
      symbol,

    timeframe,

    side,

    signal:
      side,

    direction:
      side,

    confidence,

    quality,

    price:
      roundPrice(
        entry
      ),

    currentPrice:
      roundPrice(
        entry
      ),

    entry:
      side === "WAIT"
        ? null
        : roundPrice(
            entry
          ),

    sl:
      roundPrice(
        sl
      ),

    stopLoss:
      roundPrice(
        sl
      ),

    tp1:
      roundPrice(
        tp1
      ),

    tp2:
      roundPrice(
        tp2
      ),

    tp3:
      roundPrice(
        tp3
      ),

    levels: {

      entry:
        side === "WAIT"
          ? null
          : roundPrice(
              entry
            ),

      sl:
        roundPrice(
          sl
        ),

      stopLoss:
        roundPrice(
          sl
        ),

      tp1:
        roundPrice(
          tp1
        ),

      tp2:
        roundPrice(
          tp2
        ),

      tp3:
        roundPrice(
          tp3
        )

    },

    rsi14:
      Number(
        rsi14.toFixed(1)
      ),

    rsi:
      Number(
        rsi14.toFixed(1)
      ),

    atr14:
      roundPrice(
        atr14
      ),

    momentum:
      Number(
        momentum.toFixed(3)
      ),

    buyScore:
      buy,

    sellScore:
      sell,

    candleTime:
      latest.datetime,

    candles:
      candles.slice(-80)

  };

}


/* =========================
   ONESIGNAL
========================= */

async function sendPush(
  title,
  message,
  data = {}
) {

  if(
    !ONESIGNAL_APP_ID
    ||
    !ONESIGNAL_API_KEY
  ) {

    console.log(
      "OneSignal skipped - keys missing"
    );

    return {
      skipped: true
    };

  }


  try {

    const response =
      await fetch(

        "https://api.onesignal.com/notifications",

        {

          method: "POST",

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

              target_channel:
                "push",

              included_segments:
                [
                  "Subscribed Users"
                ],

              headings: {
                en:
                  title
              },

              contents: {
                en:
                  message
              },

              data

            })

        }

      );


    const body =
      await response
        .json()
        .catch(
          () => ({})
        );


    if(
      !response.ok
    ) {

      console.error(
        "OneSignal error:",
        body
      );


      return {

        ok:
          false,

        status:
          response.status,

        body

      };

    }


    console.log(
      "OneSignal sent:",
      title
    );


    return {

      ok:
        true,

      body

    };

  }
  catch(error) {

    console.error(
      "OneSignal request failed:",
      error.message
    );


    return {

      ok:
        false,

      error:
        error.message

    };

  }

}


/* =========================
   TRADE TRACKER
========================= */

function chooseConfirmedCandidate(
  symbol
) {

  const asset =
    state.assets[
      symbol
    ];


  const m5 =
    asset?.M5;

  const m15 =
    asset?.M15;


  const m5Valid =

    [
      "BUY",
      "SELL"
    ].includes(
      m5?.side
    )

    &&

    Number(
      m5?.confidence || 0
    )
    >=
    MIN_CONFIDENCE;


  const m15Valid =

    [
      "BUY",
      "SELL"
    ].includes(
      m15?.side
    )

    &&

    Number(
      m15?.confidence || 0
    )
    >=
    MIN_CONFIDENCE;


  if(
    m5Valid
    &&
    m15Valid
    &&
    m5.side !== m15.side
  ) {

    return null;

  }


  if(
    m5Valid
    &&
    m15Valid
  ) {

    const best =

      Number(
        m15.confidence
      )

      >

      Number(
        m5.confidence
      )

        ?

        m15

        :

        m5;


    return {

      ...best,

      mtfConfirmed:
        true

    };

  }


  if(
    m15Valid
  ) {

    return {

      ...m15,

      mtfConfirmed:
        false

    };

  }


  if(
    m5Valid
  ) {

    return {

      ...m5,

      mtfConfirmed:
        false

    };

  }


  return null;

}


function signalFingerprint(
  signal
) {

  return [

    signal.symbol,

    signal.timeframe,

    signal.side,

    signal.candleTime

  ].join("|");

}


async function createTradeFromSignal(
  signal
) {

  if(
    !signal
  ) {

    return null;

  }


  if(
    getOpenTrades()
      .length
    >=
    MAX_OPEN_TRADES
  ) {

    return null;

  }


  if(
    getOpenTradeForAsset(
      signal.symbol
    )
  ) {

    return null;

  }


  const fingerprint =
    signalFingerprint(
      signal
    );


  const lastFingerprint =
    acceptedSignalFingerprints.get(
      signal.symbol
    );


  if(
    lastFingerprint ===
    fingerprint
  ) {

    return null;

  }


  acceptedSignalFingerprints.set(
    signal.symbol,
    fingerprint
  );


  const trade = {

    id:
      `${Date.now()}-${signal.symbol}`,

    symbol:
      signal.symbol,

    asset:
      signal.symbol,

    direction:
      signal.side,

    side:
      signal.side,

    timeframe:
      signal.timeframe,

    mtfConfirmed:
      Boolean(
        signal.mtfConfirmed
      ),

    confidence:
      signal.confidence,

    entry:
      signal.entry,

    originalSl:
      signal.sl,

    sl:
      signal.sl,

    tp1:
      signal.tp1,

    tp2:
      signal.tp2,

    tp3:
      signal.tp3,

    status:
      "OPEN",

    tp1Hit:
      false,

    tp2Hit:
      false,

    tp3Hit:
      false,

    breakEvenActive:
      false,

    createdAt:
      nowIso(),

    updatedAt:
      nowIso()

  };


  tradeHistory.unshift(
    trade
  );


  tradeHistory =
    tradeHistory.slice(
      0,
      300
    );


  const mtfText =

    trade.mtfConfirmed

      ?

      " • M5+M15 confirmed"

      :

      "";


  await sendPush(

    `BIT ADAMS • ${trade.direction} ${trade.symbol}`,

    `${trade.timeframe}${mtfText} • Confidence ${trade.confidence}% • Entry ${priceText(trade.entry)} • SL ${priceText(trade.sl)} • TP1 ${priceText(trade.tp1)} • TP2 ${priceText(trade.tp2)} • TP3 ${priceText(trade.tp3)}`,

    {

      type:
        "signal",

      tradeId:
        trade.id,

      symbol:
        trade.symbol,

      timeframe:
        trade.timeframe,

      side:
        trade.direction,

      confidence:
        trade.confidence,

      entry:
        trade.entry,

      sl:
        trade.sl,

      tp1:
        trade.tp1,

      tp2:
        trade.tp2,

      tp3:
        trade.tp3

    }

  );


  return trade;

}


async function updateTrade(
  trade,
  currentPrice
) {

  if(
    !trade
    ||
    !isOpenStatus(
      trade.status
    )
    ||
    !Number.isFinite(
      Number(currentPrice)
    )
  ) {

    return;

  }


  const price =
    Number(
      currentPrice
    );


  const isBuy =
    trade.direction ===
    "BUY";


  const profitHit =
    level =>
      isBuy

        ?

        price >=
        Number(level)

        :

        price <=
        Number(level);


  const stopHit =
    level =>
      isBuy

        ?

        price <=
        Number(level)

        :

        price >=
        Number(level);


  if(
    !trade.tp1Hit
    &&
    stopHit(
      trade.originalSl
    )
  ) {

    trade.status =
      "LOST";

    trade.closePrice =
      roundPrice(
        price
      );

    trade.closedAt =
      nowIso();

    trade.updatedAt =
      nowIso();


    await sendPush(

      `BIT ADAMS • SL ${trade.symbol}`,

      `${trade.direction} ${trade.timeframe} • LOST • Close ${priceText(price)}`,

      {

        type:
          "lost",

        tradeId:
          trade.id,

        symbol:
          trade.symbol

      }

    );


    return;

  }


  if(
    !trade.tp1Hit
    &&
    profitHit(
      trade.tp1
    )
  ) {

    trade.tp1Hit =
      true;

    trade.breakEvenActive =
      true;

    trade.sl =
      trade.entry;

    trade.status =
      "TP1";

    trade.tp1At =
      nowIso();

    trade.updatedAt =
      nowIso();


    await sendPush(

      `BIT ADAMS • TP1 ${trade.symbol}`,

      `TP1 hit ✅ • Move SL to ENTRY ${priceText(trade.entry)} • BREAK-EVEN protection ON`,

      {

        type:
          "tp1",

        tradeId:
          trade.id,

        symbol:
          trade.symbol,

        entry:
          trade.entry

      }

    );

  }


  if(
    trade.tp1Hit
    &&
    !trade.tp2Hit
    &&
    profitHit(
      trade.tp2
    )
  ) {

    trade.tp2Hit =
      true;

    trade.status =
      "TP2";

    trade.tp2At =
      nowIso();

    trade.updatedAt =
      nowIso();


    await sendPush(

      `BIT ADAMS • TP2 ${trade.symbol}`,

      `${trade.direction} ${trade.timeframe} • TP2 hit ✅`,

      {

        type:
          "tp2",

        tradeId:
          trade.id,

        symbol:
          trade.symbol

      }

    );

  }


  if(
    trade.tp1Hit
    &&
    !trade.tp3Hit
    &&
    profitHit(
      trade.tp3
    )
  ) {

    trade.tp3Hit =
      true;

    trade.status =
      "WIN";

    trade.closePrice =
      roundPrice(
        price
      );

    trade.tp3At =
      nowIso();

    trade.closedAt =
      nowIso();

    trade.updatedAt =
      nowIso();


    await sendPush(

      `BIT ADAMS • TP3 / WIN ${trade.symbol}`,

      `${trade.direction} ${trade.timeframe} • TP3 hit 🏆 • WIN`,

      {

        type:
          "win",

        tradeId:
          trade.id,

        symbol:
          trade.symbol

      }

    );


    return;

  }


  if(
    trade.tp1Hit
    &&
    trade.breakEvenActive
    &&
    stopHit(
      trade.entry
    )
  ) {

    trade.status =
      "BREAK-EVEN";

    trade.closePrice =
      roundPrice(
        price
      );

    trade.closedAt =
      nowIso();

    trade.updatedAt =
      nowIso();


    await sendPush(

      `BIT ADAMS • BREAK-EVEN ${trade.symbol}`,

      `${trade.direction} ${trade.timeframe} • Closed at ENTRY ${priceText(trade.entry)}`,

      {

        type:
          "break_even",

        tradeId:
          trade.id,

        symbol:
          trade.symbol

      }

    );

  }

}


async function updateOpenTrades() {

  for(
    const trade
    of
    getOpenTrades()
  ) {

    const live =
      state.assets[
        trade.symbol
      ]?.M5;


    const currentPrice =
      Number(
        live?.price
        ??
        live?.currentPrice
      );


    await updateTrade(
      trade,
      currentPrice
    );

  }

}


async function maybeOpenNewTrades() {

  for(
    const symbol
    of
    Object.keys(
      ASSETS
    )
  ) {

    if(
      getOpenTrades()
        .length
      >=
      MAX_OPEN_TRADES
    ) {

      break;

    }


    if(
      getOpenTradeForAsset(
        symbol
      )
    ) {

      continue;

    }


    const candidate =
      chooseConfirmedCandidate(
        symbol
      );


    if(
      candidate
    ) {

      await createTradeFromSignal(
        candidate
      );

    }

  }

}


/* =========================
   MAIN SCAN
========================= */

async function refreshAll() {

  if(
    state.running
  ) {

    return state;

  }


  state.running =
    true;

  state.error =
    null;


  try {


    for(
      const[
        symbol,
        asset
      ]
      of
      Object.entries(
        ASSETS
      )
    ) {


      for(
        const[
          tf,
          interval
        ]
        of
        Object.entries(
          TIMEFRAMES
        )
      ) {


        try {


          const candles =
            await fetchCandles(

              asset.api,

              interval,

              80,

              true

            );


          state.assets[
            symbol
          ][
            tf
          ] =
            analyze(
              symbol,
              tf,
              candles
            );


        }
        catch(err) {


          console.error(
            `${symbol} ${tf} error:`,
            err.message
          );


          state.assets[
            symbol
          ][
            tf
          ] = {

            symbol,

            asset:
              symbol,

            timeframe:
              tf,

            side:
              "ERROR",

            signal:
              "ERROR",

            direction:
              "ERROR",

            confidence:
              0,

            error:
              err.message,

            candles: []

          };

        }

      }


      const m5 =
        state.assets[
          symbol
        ].M5;


      const m15 =
        state.assets[
          symbol
        ].M15;


      if(
        [
          "BUY",
          "SELL"
        ].includes(
          m5?.side
        )
        &&
        m5.side ===
        m15?.side
      ) {


        m5.confidence =
          Math.min(
            99,
            m5.confidence + 4
          );


        m15.confidence =
          Math.min(
            99,
            m15.confidence + 4
          );

      }

    }


    await updateOpenTrades();


    await maybeOpenNewTrades();


    state.updatedAt =
      nowIso();


    console.log(

      "BIT ADAMS scan OK",

      state.updatedAt,

      "open trades:",

      getOpenTrades()
        .length

    );


  }
  catch(err) {


    state.error =
      err.message;


    console.error(
      "Scan error:",
      err
    );


  }
  finally {


    state.running =
      false;


  }


  return state;

}


/* =========================
   PUBLIC FRONT-END DATA
========================= */

function publicSignal(
  signal
) {

  if(
    !signal
  ) {

    return null;

  }


  return {

    ...signal,

    signal:
      signal.side,

    direction:
      signal.side,

    currentPrice:
      signal.price,

    levels: {

      entry:
        signal.entry,

      sl:
        signal.sl,

      stopLoss:
        signal.sl,

      tp1:
        signal.tp1,

      tp2:
        signal.tp2,

      tp3:
        signal.tp3

    }

  };

}


function publicAsset(
  symbol
) {

  const m5 =
    publicSignal(
      state.assets[
        symbol
      ].M5
    );


  const m15 =
    publicSignal(
      state.assets[
        symbol
      ].M15
    );


  const active =
    getOpenTradeForAsset(
      symbol
    );


  const candidate =
    chooseConfirmedCandidate(
      symbol
    );


  const summary =
    candidate
    ||
    m15
    ||
    m5;


  return {

    symbol,

    asset:
      symbol,

    M5:
      m5,

    M15:
      m15,

    m5,

    m15,

    timeframes: {

      M5:
        m5,

      M15:
        m15

    },

    signal:
      summary?.side
      ||
      summary?.signal
      ||
      "WAIT",

    direction:
      summary?.side
      ||
      summary?.direction
      ||
      "WAIT",

    confidence:
      Number(
        summary?.confidence || 0
      ),

    price:
      Number(
        m5?.price
        ??
        m15?.price
        ??
        0
      )
      ||
      null,

    currentPrice:
      Number(
        m5?.price
        ??
        m15?.price
        ??
        0
      )
      ||
      null,

    levels:

      active

        ?

        {

          entry:
            active.entry,

          sl:
            active.sl,

          stopLoss:
            active.sl,

          tp1:
            active.tp1,

          tp2:
            active.tp2,

          tp3:
            active.tp3,

          status:
            active.status

        }

        :

        {

          entry:
            summary?.entry
            ??
            null,

          sl:
            summary?.sl
            ??
            null,

          stopLoss:
            summary?.sl
            ??
            null,

          tp1:
            summary?.tp1
            ??
            null,

          tp2:
            summary?.tp2
            ??
            null,

          tp3:
            summary?.tp3
            ??
            null,

          status:

            summary?.side
            &&
            summary.side !== "WAIT"

              ?

              "READY"

              :

              "WAIT"

        },

    status:
      active?.status
      ||
      "WAIT"

  };

}


function getPublicState() {

  return {

    ok:
      true,

    updatedAt:
      state.updatedAt,

    running:
      state.running,

    error:
      state.error,

    assets: {

      XAUUSD:
        publicAsset(
          "XAUUSD"
        ),

      BTCUSD:
        publicAsset(
          "BTCUSD"
        )

    },

    openTrades:
      getOpenTrades(),

    history:
      tradeHistory

  };

}


/* =========================
   NORMALIZE
========================= */

function normalizeSymbol(
  value
) {

  const v =
    String(
      value || ""
    )
    .toUpperCase()
    .replace(
      /[^A-Z]/g,
      ""
    );


  if(
    v === "XAUUSD"
    ||
    v === "GOLD"
  ) {

    return "XAUUSD";

  }


  if(
    v === "BTCUSD"
    ||
    v === "BITCOIN"
    ||
    v === "BTC"
  ) {

    return "BTCUSD";

  }


  return null;

}


function normalizeTimeframe(
  value
) {

  const v =
    String(
      value || ""
    )
    .toUpperCase();


  if(
    v === "M5"
    ||
    v === "5MIN"
    ||
    v === "5"
  ) {

    return "M5";

  }


  if(
    v === "M15"
    ||
    v === "15MIN"
    ||
    v === "15"
  ) {

    return "M15";

  }


  return null;

}


async function ensureFresh() {

  const age =

    state.updatedAt

      ?

      Date.now()
      -
      new Date(
        state.updatedAt
      )
      .getTime()

      :

      Infinity;


  if(
    age > 45000
  ) {

    await refreshAll();

  }

}


/* =========================
   ROUTES
========================= */

app.get(
  "/",
  (req,res) => {

    res.json({

      ok:
        true,

      name:
        "BIT ADAMS SERVER V8.4",

      assets: [
        "XAUUSD",
        "BTCUSD"
      ],

      timeframes: [
        "M5",
        "M15"
      ],

      maxOpenTrades:
        MAX_OPEN_TRADES,

      updatedAt:
        state.updatedAt

    });

  }
);


app.get(
  "/health",
  (req,res) => {

    res.json({

      ok:
        true,

      server:
        "bit-adams-server",

      twelveDataConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      oneSignalConfigured:
        Boolean(
          ONESIGNAL_APP_ID
          &&
          ONESIGNAL_API_KEY
        ),

      openTrades:
        getOpenTrades()
        .length,

      totalTrackedTrades:
        tradeHistory.length,

      updatedAt:
        state.updatedAt,

      error:
        state.error

    });

  }
);


app.get(
  "/api/market",
  async(req,res) => {

    await ensureFresh();

    res.json(
      getPublicState()
    );

  }
);


app.get(
  "/api/scan",
  async(req,res) => {

    await ensureFresh();

    res.json(
      getPublicState()
    );

  }
);


app.get(
  "/api/history",
  async(req,res) => {

    await ensureFresh();


    const wins =
      tradeHistory.filter(
        t =>
          t.status === "WIN"
      )
      .length;


    const lost =
      tradeHistory.filter(
        t =>
          t.status === "LOST"
      )
      .length;


    const closed =
      wins +
      lost;


    res.json({

      ok:
        true,

      open:
        getOpenTrades()
        .length,

      total:
        tradeHistory.length,

      wins,

      lost,

      breakEven:
        tradeHistory.filter(
          t =>
            t.status ===
            "BREAK-EVEN"
        )
        .length,

      winRate:

        closed

          ?

          Math.round(
            wins /
            closed *
            100
          )

          :

          0,

      trades:
        tradeHistory

    });

  }
);


app.get(
  "/api/analyze",
  async(req,res) => {

    const symbol =
      normalizeSymbol(
        req.query.symbol
      );


    const timeframe =
      normalizeTimeframe(

        req.query.timeframe
        ||
        req.query.tf

      );


    if(
      !symbol
      ||
      !timeframe
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          error:
            "Use symbol=XAUUSD or BTCUSD and timeframe=M5 or M15"

        });

    }


    await ensureFresh();


    res.json({

      ok:
        true,

      ...publicSignal(
        state.assets[
          symbol
        ][
          timeframe
        ]
      )

    });

  }
);


/* =========================
   CANDLES FOR CHART
========================= */

app.get(
  "/api/candles",
  async(req,res) => {

    const symbol =
      normalizeSymbol(
        req.query.symbol
      );


    const timeframe =
      normalizeTimeframe(

        req.query.timeframe
        ||
        req.query.tf

      );


    if(
      !symbol
      ||
      !timeframe
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          error:
            "Use symbol=XAUUSD or BTCUSD and timeframe=M5 or M15"

        });

    }


    await ensureFresh();


    const signal =
      state.assets[
        symbol
      ][
        timeframe
      ];


    res.json({

      ok:
        true,

      symbol,

      timeframe,

      updatedAt:
        state.updatedAt,

      candles:

        Array.isArray(
          signal?.candles
        )

          ?

          signal.candles

          :

          []

    });

  }
);


/* =========================
   TEST NOTIFICATION
========================= */

app.post(
  "/api/test-notification",
  async(req,res) => {

    const result =
      await sendPush(

        "BIT ADAMS TEST",

        "Notifications from the BIT ADAMS server are working.",

        {
          type:
            "test"
        }

      );


    res.json(
      result
    );

  }
);


/* =========================
   START SERVER
========================= */

app.listen(

  PORT,

  "0.0.0.0",

  () => {


    console.log(
      `BIT ADAMS SERVER V8.4 running on port ${PORT}`
    );


    console.log(
      `Scan every ${SCAN_SECONDS}s`
    );


    refreshAll()
      .catch(
        console.error
      );


    setInterval(

      () => {

        refreshAll()
          .catch(
            console.error
          );

      },

      SCAN_SECONDS
      *
      1000

    );

  }

);
