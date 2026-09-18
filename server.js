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

const TEST_KEY =
  process.env.TEST_KEY || "";

const SCAN_SECONDS =
  Math.max(
    60,
    Number(process.env.SCAN_SECONDS || 60)
  );

const STATE_FILE = "./adams-state.json";


// ======================================================
// SETTINGS
// ======================================================

const SYMBOL = "XAU/USD";

const INTERVAL = "15min";

const EMA_FAST = 9;
const EMA_SLOW = 21;
const EMA_TREND = 50;

const RSI_LENGTH = 14;
const ATR_LENGTH = 14;

const SL_ATR = 1.30;

const TP1_ATR = 1.00;
const TP2_ATR = 2.00;
const TP3_ATR = 3.00;


// ======================================================
// STATE
// ======================================================

let state = {

  lastSignalCandle: null,

  trade: null,

  history: []

};


function loadState() {

  try {

    if (
      fs.existsSync(
        STATE_FILE
      )
    ) {

      const data =
        fs.readFileSync(
          STATE_FILE,
          "utf8"
        );

      state =
        JSON.parse(data);

    }

  } catch (error) {

    console.log(
      "STATE LOAD ERROR:",
      error.message
    );

  }

}


function saveState() {

  try {

    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        state,
        null,
        2
      )
    );

  } catch (error) {

    console.log(
      "STATE SAVE ERROR:",
      error.message
    );

  }

}


loadState();


// ======================================================
// HELPERS
// ======================================================

function n(value) {

  return Number(value);

}


function price(value) {

  return Number(value).toFixed(3);

}


function parseTime(datetime) {

  if (!datetime) return 0;

  const iso =
    datetime
      .replace(
        " ",
        "T"
      ) + "Z";

  return new Date(iso).getTime();

}


// ======================================================
// EMA
// ======================================================

function emaSeries(
  values,
  length
) {

  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length <
    length
  ) {

    return result;

  }

  let sum = 0;

  for (
    let i = 0;
    i < length;
    i++
  ) {

    sum += values[i];

  }

  let previous =
    sum / length;

  result[
    length - 1
  ] = previous;

  const multiplier =
    2 / (length + 1);

  for (
    let i = length;
    i < values.length;
    i++
  ) {

    previous =
      (
        values[i] *
        multiplier
      ) +
      (
        previous *
        (
          1 -
          multiplier
        )
      );

    result[i] =
      previous;

  }

  return result;

}


// ======================================================
// RSI
// ======================================================

function rsiSeries(
  values,
  length
) {

  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length <=
    length
  ) {

    return result;

  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (
      change >= 0
    ) {

      gains += change;

    } else {

      losses +=
        Math.abs(change);

    }

  }

  let avgGain =
    gains / length;

  let avgLoss =
    losses / length;

  result[length] =
    avgLoss === 0
      ? 100
      : 100 -
        (
          100 /
          (
            1 +
            (
              avgGain /
              avgLoss
            )
          )
        );

  for (
    let i =
      length + 1;
    i <
      values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    const gain =
      Math.max(
        change,
        0
      );

    const loss =
      Math.max(
        -change,
        0
      );

    avgGain =
      (
        (
          avgGain *
          (
            length - 1
          )
        ) +
        gain
      ) /
      length;

    avgLoss =
      (
        (
          avgLoss *
          (
            length - 1
          )
        ) +
        loss
      ) /
      length;

    result[i] =
      avgLoss === 0
        ? 100
        : 100 -
          (
            100 /
            (
              1 +
              (
                avgGain /
                avgLoss
              )
            )
          );

  }

  return result;

}


// ======================================================
// ATR
// ======================================================

function atrSeries(
  candles,
  length
) {

  const tr = [];

  for (
    let i = 0;
    i <
      candles.length;
    i++
  ) {

    const high =
      n(
        candles[i].high
      );

    const low =
      n(
        candles[i].low
      );

    if (
      i === 0
    ) {

      tr.push(
        high - low
      );

      continue;

    }

    const previousClose =
      n(
        candles[
          i - 1
        ].close
      );

    tr.push(
      Math.max(
        high - low,
        Math.abs(
          high -
          previousClose
        ),
        Math.abs(
          low -
          previousClose
        )
      )
    );

  }

  const result =
    new Array(
      candles.length
    ).fill(null);

  if (
    tr.length <
    length
  ) {

    return result;

  }

  let sum = 0;

  for (
    let i = 0;
    i < length;
    i++
  ) {

    sum += tr[i];

  }

  let previous =
    sum / length;

  result[
    length - 1
  ] = previous;

  for (
    let i = length;
    i <
      tr.length;
    i++
  ) {

    previous =
      (
        (
          previous *
          (
            length - 1
          )
        ) +
        tr[i]
      ) /
      length;

    result[i] =
      previous;

  }

  return result;

}


// ======================================================
// ONESIGNAL PUSH
// ======================================================

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
      "ONESIGNAL KEYS MISSING"
    );

    return;

  }

  try {

    const response =
      await fetch(
        "https://api.onesignal.com/notifications",
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json; charset=utf-8",

            "Authorization":
              `Key ${ONESIGNAL_API_KEY}`

          },

          body:
            JSON.stringify({

              app_id:
                ONESIGNAL_APP_ID,

              target_channel:
                "push",

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

    const body =
      await response.text();

    console.log(
      "ONESIGNAL:",
      response.status,
      body
    );

  } catch (error) {

    console.log(
      "PUSH ERROR:",
      error.message
    );

  }

}


// ======================================================
// TWELVE DATA
// ======================================================

async function getCandles() {

  if (
    !TWELVE_DATA_API_KEY
  ) {

    throw new Error(
      "TWELVE_DATA_API_KEY missing"
    );

  }

  const url =
    new URL(
      "https://api.twelvedata.com/time_series"
    );

  url.searchParams.set(
    "symbol",
    SYMBOL
  );

  url.searchParams.set(
    "interval",
    INTERVAL
  );

  url.searchParams.set(
    "outputsize",
    "200"
  );

  url.searchParams.set(
    "order",
    "asc"
  );

  url.searchParams.set(
    "timezone",
    "UTC"
  );

  url.searchParams.set(
    "apikey",
    TWELVE_DATA_API_KEY
  );

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (
    data.status ===
    "error"
  ) {

    throw new Error(
      data.message ||
      "Twelve Data error"
    );

  }

  if (
    !Array.isArray(
      data.values
    )
  ) {

    throw new Error(
      "No candle data"
    );

  }

  return data.values;

}


// ======================================================
// CLOSE TRADE
// ======================================================

async function closeTrade(
  result,
  message
) {

  const trade =
    state.trade;

  if (!trade) return;

  trade.status =
    result;

  trade.closedAt =
    new Date().toISOString();

  state.history.unshift(
    trade
  );

  state.history =
    state.history.slice(
      0,
      100
    );

  state.trade = null;

  saveState();

  await sendPush(
    `ADAMS GOLD • ${result}`,
    message,
    {
      symbol:
        "XAUUSD",

      timeframe:
        "M15",

      result
    }
  );

}


// ======================================================
// MANAGE OPEN TRADE
// ======================================================

async function manageTrade(
  liveCandle
) {

  const trade =
    state.trade;

  if (!trade) return;

  const high =
    n(
      liveCandle.high
    );

  const low =
    n(
      liveCandle.low
    );


  // ====================================================
  // BUY
  // ====================================================

  if (
    trade.direction ===
    "BUY"
  ) {

    // STOP LOSS / BREAK EVEN

    if (
      low <=
      trade.stop
    ) {

      if (
        trade.tp1Hit
      ) {

        await closeTrade(
          "BREAK EVEN",
          `BUY XAUUSD M15 • Break Even hit at ${price(trade.entry)}`
        );

      } else {

        await closeTrade(
          "STOP LOSS",
          `BUY XAUUSD M15 • Stop Loss hit at ${price(trade.stop)}`
        );

      }

      return;

    }


    // TP1

    if (
      !trade.tp1Hit &&
      high >=
      trade.tp1
    ) {

      trade.tp1Hit =
        true;

      trade.stop =
        trade.entry;

      trade.status =
        "TP1 HIT";

      saveState();

      await sendPush(
        "ADAMS GOLD • TP1 ✅",
        `BUY XAUUSD M15 • TP1 ${price(trade.tp1)} HIT`
      );

      await sendPush(
        "ADAMS GOLD • BREAK EVEN 🛡️",
        `Stop Loss moved to ENTRY ${price(trade.entry)}`
      );

    }


    // TP2

    if (
      state.trade &&
      !trade.tp2Hit &&
      high >=
      trade.tp2
    ) {

      trade.tp2Hit =
        true;

      trade.status =
        "TP2 HIT";

      saveState();

      await sendPush(
        "ADAMS GOLD • TP2 ✅",
        `BUY XAUUSD M15 • TP2 ${price(trade.tp2)} HIT`
      );

    }


    // TP3

    if (
      state.trade &&
      high >=
      trade.tp3
    ) {

      await closeTrade(
        "TP3 WIN",
        `BUY XAUUSD M15 • TP3 ${price(trade.tp3)} HIT • WIN ✅`
      );

      return;

    }

  }


  // ====================================================
  // SELL
  // ====================================================

  if (
    trade.direction ===
    "SELL"
  ) {

    // STOP LOSS / BREAK EVEN

    if (
      high >=
      trade.stop
    ) {

      if (
        trade.tp1Hit
      ) {

        await closeTrade(
          "BREAK EVEN",
          `SELL XAUUSD M15 • Break Even hit at ${price(trade.entry)}`
        );

      } else {

        await closeTrade(
          "STOP LOSS",
          `SELL XAUUSD M15 • Stop Loss hit at ${price(trade.stop)}`
        );

      }

      return;

    }


    // TP1

    if (
      !trade.tp1Hit &&
      low <=
      trade.tp1
    ) {

      trade.tp1Hit =
        true;

      trade.stop =
        trade.entry;

      trade.status =
        "TP1 HIT";

      saveState();

      await sendPush(
        "ADAMS GOLD • TP1 ✅",
        `SELL XAUUSD M15 • TP1 ${price(trade.tp1)} HIT`
      );

      await sendPush(
        "ADAMS GOLD • BREAK EVEN 🛡️",
        `Stop Loss moved to ENTRY ${price(trade.entry)}`
      );

    }


    // TP2

    if (
      state.trade &&
      !trade.tp2Hit &&
      low <=
      trade.tp2
    ) {

      trade.tp2Hit =
        true;

      trade.status =
        "TP2 HIT";

      saveState();

      await sendPush(
        "ADAMS GOLD • TP2 ✅",
        `SELL XAUUSD M15 • TP2 ${price(trade.tp2)} HIT`
      );

    }


    // TP3

    if (
      state.trade &&
      low <=
      trade.tp3
    ) {

      await closeTrade(
        "TP3 WIN",
        `SELL XAUUSD M15 • TP3 ${price(trade.tp3)} HIT • WIN ✅`
      );

      return;

    }

  }

}


// ======================================================
// OPEN BUY
// ======================================================

async function openBuy(
  candle,
  atrValue
) {

  const entry =
    n(
      candle.close
    );

  const trade = {

    direction:
      "BUY",

    symbol:
      "XAUUSD",

    timeframe:
      "M15",

    entry,

    stop:
      entry -
      (
        atrValue *
        SL_ATR
      ),

    originalStop:
      entry -
      (
        atrValue *
        SL_ATR
      ),

    tp1:
      entry +
      (
        atrValue *
        TP1_ATR
      ),

    tp2:
      entry +
      (
        atrValue *
        TP2_ATR
      ),

    tp3:
      entry +
      (
        atrValue *
        TP3_ATR
      ),

    tp1Hit:
      false,

    tp2Hit:
      false,

    status:
      "OPEN",

    signalCandle:
      candle.datetime,

    openedAt:
      new Date()
        .toISOString()

  };

  state.trade =
    trade;

  saveState();

  await sendPush(
    "🟢 ADAMS GOLD • BUY",
    `XAUUSD M15
ENTRY ${price(trade.entry)}
STOP LOSS ${price(trade.stop)}
TP1 ${price(trade.tp1)}
TP2 ${price(trade.tp2)}
TP3 ${price(trade.tp3)}`,
    {
      direction:
        "BUY"
    }
  );

}


// ======================================================
// OPEN SELL
// ======================================================

async function openSell(
  candle,
  atrValue
) {

  const entry =
    n(
      candle.close
    );

  const trade = {

    direction:
      "SELL",

    symbol:
      "XAUUSD",

    timeframe:
      "M15",

    entry,

    stop:
      entry +
      (
        atrValue *
        SL_ATR
      ),

    originalStop:
      entry +
      (
        atrValue *
        SL_ATR
      ),

    tp1:
      entry -
      (
        atrValue *
        TP1_ATR
      ),

    tp2:
      entry -
      (
        atrValue *
        TP2_ATR
      ),

    tp3:
      entry -
      (
        atrValue *
        TP3_ATR
      ),

    tp1Hit:
      false,

    tp2Hit:
      false,

    status:
      "OPEN",

    signalCandle:
      candle.datetime,

    openedAt:
      new Date()
        .toISOString()

  };

  state.trade =
    trade;

  saveState();

  await sendPush(
    "🔴 ADAMS GOLD • SELL",
    `XAUUSD M15
ENTRY ${price(trade.entry)}
STOP LOSS ${price(trade.stop)}
TP1 ${price(trade.tp1)}
TP2 ${price(trade.tp2)}
TP3 ${price(trade.tp3)}`,
    {
      direction:
        "SELL"
    }
  );

}


// ======================================================
// SCANNER
// ======================================================

let scanning =
  false;


async function scanMarket() {

  if (scanning) {

    return;

  }

  scanning =
    true;

  try {

    const allCandles =
      await getCandles();

    if (
      allCandles.length <
      60
    ) {

      throw new Error(
        "Not enough candles"
      );

    }


    // --------------------------------------------------
    // LIVE CANDLE
    // --------------------------------------------------

    const liveCandle =
      allCandles[
        allCandles.length - 1
      ];


    // --------------------------------------------------
    // FIND CLOSED M15 CANDLES
    // --------------------------------------------------

    const now =
      Date.now();

    const closedCandles =
      allCandles.filter(
        candle => {

          const openTime =
            parseTime(
              candle.datetime
            );

          const closeTime =
            openTime +
            (
              15 *
              60 *
              1000
            );

          return (
            closeTime <= now
          );

        }
      );


    if (
      closedCandles.length <
      60
    ) {

      throw new Error(
        "Not enough closed candles"
      );

    }


    // --------------------------------------------------
    // MANAGE CURRENT TRADE
    // --------------------------------------------------

    if (
      state.trade
    ) {

      await manageTrade(
        liveCandle
      );

    }


    // Only one trade at a time

    if (
      state.trade
    ) {

      return;

    }


    // --------------------------------------------------
    // CALCULATIONS
    // --------------------------------------------------

    const closes =
      closedCandles.map(
        candle =>
          n(
            candle.close
          )
      );

    const ema9 =
      emaSeries(
        closes,
        EMA_FAST
      );

    const ema21 =
      emaSeries(
        closes,
        EMA_SLOW
      );

    const ema50 =
      emaSeries(
        closes,
        EMA_TREND
      );

    const rsi =
      rsiSeries(
        closes,
        RSI_LENGTH
      );

    const atr =
      atrSeries(
        closedCandles,
        ATR_LENGTH
      );


    const i =
      closedCandles.length -
      1;

    const previous =
      i - 1;

    const candle =
      closedCandles[i];


    // --------------------------------------------------
    // DO NOT PROCESS SAME CLOSED CANDLE TWICE
    // --------------------------------------------------

    if (
      state.lastSignalCandle ===
      candle.datetime
    ) {

      return;

    }


    state.lastSignalCandle =
      candle.datetime;

    saveState();


    // --------------------------------------------------
    // BUY LOGIC
    // --------------------------------------------------

    const buyCross =

      ema9[previous] <=
        ema21[previous] &&

      ema9[i] >
        ema21[i];


    const buySignal =

      buyCross &&

      closes[i] >
        ema50[i] &&

      rsi[i] >
        50;


    // --------------------------------------------------
    // SELL LOGIC
    // --------------------------------------------------

    const sellCross =

      ema9[previous] >=
        ema21[previous] &&

      ema9[i] <
        ema21[i];


    const sellSignal =

      sellCross &&

      closes[i] <
        ema50[i] &&

      rsi[i] <
        50;


    console.log(
      "M15:",
      candle.datetime,
      "Close:",
      closes[i],
      "RSI:",
      rsi[i]?.toFixed(2),
      "BUY:",
      buySignal,
      "SELL:",
      sellSignal
    );


    // --------------------------------------------------
    // OPEN SIGNAL
    // --------------------------------------------------

    if (
      buySignal
    ) {

      await openBuy(
        candle,
        atr[i]
      );

    }


    if (
      sellSignal
    ) {

      await openSell(
        candle,
        atr[i]
      );

    }

  } catch (error) {

    console.log(
      "SCAN ERROR:",
      error.message
    );

  } finally {

    scanning =
      false;

  }

}


// ======================================================
// API
// ======================================================

app.get(
  "/",
  (
    req,
    res
  ) => {

    res.json({

      app:
        "ADAMS GOLD",

      status:
        "ONLINE",

      symbol:
        "XAUUSD",

      timeframe:
        "M15",

      scanner:
        `${SCAN_SECONDS}s`,

      trade:
        state.trade

    });

  }
);


app.get(
  "/health",
  (
    req,
    res
  ) => {

    res.json({

      ok: true,

      time:
        new Date()
          .toISOString()

    });

  }
);


app.get(
  "/state",
  (
    req,
    res
  ) => {

    res.json(
      state
    );

  }
);


// ======================================================
// TEST NOTIFICATION
// Open:
// https://YOUR-RENDER-URL/test-push?key=YOUR_TEST_KEY
// ======================================================

app.get(
  "/test-push",
  async (
    req,
    res
  ) => {

    if (
      !TEST_KEY ||
      req.query.key !==
        TEST_KEY
    ) {

      return res
        .status(401)
        .json({
          error:
            "Unauthorized"
        });

    }

    await sendPush(
      "✅ ADAMS GOLD",
      "Notifications are working."
    );

    res.json({

      success:
        true,

      message:
        "Test notification sent"

    });

  }
);


// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `ADAMS GOLD running on port ${PORT}`
    );

  }
);


scanMarket();

setInterval(
  scanMarket,
  SCAN_SECONDS *
    1000
);
