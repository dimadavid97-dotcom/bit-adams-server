import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID || "";

const ONESIGNAL_API_KEY =
  process.env.ONESIGNAL_API_KEY || "";

const SCAN_SECONDS = Math.max(
  60,
  Number(process.env.SCAN_SECONDS || 60)
);

const MIN_CONFIDENCE =
  Number(process.env.MIN_CONFIDENCE || 78);

const PUSH_COOLDOWN_MIN =
  Number(process.env.PUSH_COOLDOWN_MIN || 15);


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


const lastPush = new Map();


function roundPrice(symbol, value) {

  if (value === null || value === undefined) {
    return null;
  }

  return Number(
    Number(value).toFixed(2)
  );

}


function ema(values, period) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const k = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0)
    / period;

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


function rsi(values, period = 14) {

  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {

      gains += change;

    } else {

      losses +=
        Math.abs(change);

    }

  }

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );

}


function atr(
  candles,
  period = 14
) {

  if (
    !Array.isArray(candles) ||
    candles.length <= period
  ) {

    return null;

  }

  const trs = [];

  for (
    let i = candles.length - period;
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

    trs.push(tr);

  }

  return (
    trs.reduce(
      (a, b) => a + b,
      0
    ) / trs.length
  );

}


async function fetchCandles(
  apiSymbol,
  interval
) {

  if (!TWELVE_DATA_API_KEY) {

    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );

  }


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
    "80"
  );

  url.searchParams.set(
    "apikey",
    TWELVE_DATA_API_KEY
  );


  const response =
    await fetch(url, {

      headers: {
        Accept: "application/json"
      }

    });


  if (!response.ok) {

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );

  }


  const data =
    await response.json();


  if (
    data.status === "error" ||
    !Array.isArray(data.values)
  ) {

    throw new Error(
      data.message ||
      "Twelve Data returned no candles"
    );

  }


  return data.values

    .map(v => ({

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

    }))

    .filter(c =>
      [
        c.open,
        c.high,
        c.low,
        c.close
      ].every(Number.isFinite)
    )

    .reverse();

}


function analyze(
  symbol,
  timeframe,
  candles
) {


  if (
    candles.length < 30
  ) {

    throw new Error(
      "Not enough candles"
    );

  }


  const closes =
    candles.map(
      c => c.close
    );


  const latest =
    candles[
      candles.length - 1
    ];


  const previous =
    candles[
      candles.length - 2
    ];


  const price =
    latest.close;


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


  const momentumBase =
    closes[
      Math.max(
        0,
        closes.length - 4
      )
    ];


  const momentum =
    (
      (
        price -
        momentumBase
      )
      /
      momentumBase
    )
    * 100;


  let direction =
    "WAIT";


  if (
    ema9 > ema21 &&
    rsi14 >= 50 &&
    momentum > 0
  ) {

    direction =
      "BUY";

  }


  if (
    ema9 < ema21 &&
    rsi14 <= 50 &&
    momentum < 0
  ) {

    direction =
      "SELL";

  }


  const trendStrength =
    atr14 > 0

      ? Math.abs(
          ema9 - ema21
        ) / atr14

      : 0;


  let confidence = 0;


  if (
    direction !== "WAIT"
  ) {


    confidence = 58;


    confidence +=
      Math.min(
        18,
        trendStrength * 16
      );


    confidence +=
      Math.min(
        10,
        Math.abs(
          rsi14 - 50
        ) * 0.75
      );


    confidence +=
      Math.min(
        8,
        Math.abs(
          momentum
        ) * 8
      );


    const candleAgrees =

      (
        direction === "BUY" &&
        latest.close >= latest.open &&
        latest.close >= previous.close
      )

      ||

      (
        direction === "SELL" &&
        latest.close <= latest.open &&
        latest.close <= previous.close
      );


    if (candleAgrees) {

      confidence += 4;

    }


    confidence =
      Math.max(
        60,
        Math.min(
          97,
          Math.round(
            confidence
          )
        )
      );

  }


  const risk =
    atr14 ||
    price * 0.002;


  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;


  if (
    direction === "BUY"
  ) {

    sl =
      price -
      risk * 1.15;

    tp1 =
      price +
      risk * 0.80;

    tp2 =
      price +
      risk * 1.40;

    tp3 =
      price +
      risk * 2.00;

  }


  if (
    direction === "SELL"
  ) {

    sl =
      price +
      risk * 1.15;

    tp1 =
      price -
      risk * 0.80;

    tp2 =
      price -
      risk * 1.40;

    tp3 =
      price -
      risk * 2.00;

  }


  return {

    symbol,

    timeframe,

    direction,

    confidence,

    price:
      roundPrice(
        symbol,
        price
      ),

    entry:
      direction === "WAIT"
        ? null
        : roundPrice(
            symbol,
            price
          ),

    sl:
      roundPrice(
        symbol,
        sl
      ),

    tp1:
      roundPrice(
        symbol,
        tp1
      ),

    tp2:
      roundPrice(
        symbol,
        tp2
      ),

    tp3:
      roundPrice(
        symbol,
        tp3
      ),

    ema9:
      roundPrice(
        symbol,
        ema9
      ),

    ema21:
      roundPrice(
        symbol,
        ema21
      ),

    rsi14:
      Number(
        rsi14.toFixed(1)
      ),

    atr14:
      roundPrice(
        symbol,
        atr14
      ),

    momentum:
      Number(
        momentum.toFixed(3)
      ),

    candleTime:
      latest.datetime

  };

}


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
      "OneSignal skipped - keys missing"
    );

    return {
      skipped: true
    };

  }


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
    await response
      .json()
      .catch(() => ({}));


  if (!response.ok) {

    console.error(
      "OneSignal error:",
      body
    );

    return {

      ok: false,

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

    ok: true,

    body

  };

}


async function maybeNotify(
  signal
) {


  if (
    signal.direction === "WAIT" ||
    signal.confidence <
      MIN_CONFIDENCE
  ) {

    return;

  }


  const slot =
    `${signal.symbol}:${signal.timeframe}`;


  const now =
    Date.now();


  const previous =
    lastPush.get(slot);


  const cooldownMs =
    PUSH_COOLDOWN_MIN *
    60 *
    1000;


  if (

    previous &&

    previous.direction ===
      signal.direction &&

    now -
      previous.time <
      cooldownMs

  ) {

    return;

  }


  lastPush.set(

    slot,

    {

      direction:
        signal.direction,

      time:
        now

    }

  );


  const title =
    `BIT ADAMS • ${signal.direction} ${signal.symbol} ${signal.timeframe}`;


  const message =
    `Confidence ${signal.confidence}% • Entry ${signal.entry} • SL ${signal.sl} • TP1 ${signal.tp1} • TP2 ${signal.tp2} • TP3 ${signal.tp3}`;


  await sendPush(

    title,

    message,

    signal

  );

}


async function refreshAll() {


  if (state.running) {

    return state;

  }


  state.running =
    true;


  state.error =
    null;


  try {


    for (
      const [
        symbol,
        asset
      ]
      of Object.entries(
        ASSETS
      )
    ) {


      for (
        const [
          tf,
          interval
        ]
        of Object.entries(
          TIMEFRAMES
        )
      ) {


        try {


          const candles =
            await fetchCandles(
              asset.api,
              interval
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


        } catch (err) {


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

            timeframe:
              tf,

            direction:
              "ERROR",

            error:
              err.message

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


      if (

        m5?.direction &&
        m15?.direction &&

        [
          "BUY",
          "SELL"
        ].includes(
          m5.direction
        ) &&

        m5.direction ===
          m15.direction

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


      if (

        m5?.direction &&

        [
          "BUY",
          "SELL"
        ].includes(
          m5.direction
        )

      ) {

        await maybeNotify(
          m5
        );

      }


      if (

        m15?.direction &&

        [
          "BUY",
          "SELL"
        ].includes(
          m15.direction
        )

      ) {

        await maybeNotify(
          m15
        );

      }

    }


    state.updatedAt =
      new Date()
        .toISOString();


    console.log(
      "BIT ADAMS scan OK",
      state.updatedAt
    );


  } catch (err) {


    state.error =
      err.message;


    console.error(
      "Scan error:",
      err
    );


  } finally {


    state.running =
      false;

  }


  return state;

}


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


  if (
    v === "XAUUSD" ||
    v === "GOLD"
  ) {

    return "XAUUSD";

  }


  if (
    v === "BTCUSD" ||
    v === "BITCOIN" ||
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


  if (
    v === "M5" ||
    v === "5MIN" ||
    v === "5"
  ) {

    return "M5";

  }


  if (
    v === "M15" ||
    v === "15MIN" ||
    v === "15"
  ) {

    return "M15";

  }


  return null;

}


app.get(
  "/",
  (req, res) => {

    res.json({

      ok: true,

      name:
        "BIT ADAMS SERVER",

      assets: [
        "XAUUSD",
        "BTCUSD"
      ],

      timeframes: [
        "M5",
        "M15"
      ],

      updatedAt:
        state.updatedAt

    });

  }
);


app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      server:
        "bit-adams-server",

      twelveDataConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      oneSignalConfigured:
        Boolean(
          ONESIGNAL_APP_ID &&
          ONESIGNAL_API_KEY
        ),

      updatedAt:
        state.updatedAt,

      error:
        state.error

    });

  }
);


app.get(
  "/api/scan",
  async (req, res) => {


    const age =
      state.updatedAt

        ? Date.now() -
          new Date(
            state.updatedAt
          ).getTime()

        : Infinity;


    if (
      age > 45000
    ) {

      await refreshAll();

    }


    res.json(
      state
    );

  }
);


app.get(
  "/api/market",
  async (req, res) => {


    const age =
      state.updatedAt

        ? Date.now() -
          new Date(
            state.updatedAt
          ).getTime()

        : Infinity;


    if (
      age > 45000
    ) {

      await refreshAll();

    }


    res.json(
      state
    );

  }
);


app.get(
  "/api/analyze",
  async (req, res) => {


    const symbol =
      normalizeSymbol(
        req.query.symbol
      );


    const timeframe =
      normalizeTimeframe(
        req.query.timeframe ||
        req.query.tf
      );


    if (
      !symbol ||
      !timeframe
    ) {


      return res
        .status(400)
        .json({

          ok: false,

          error:
            "Use symbol=XAUUSD or BTCUSD and timeframe=M5 or M15"

        });

    }


    const age =
      state.updatedAt

        ? Date.now() -
          new Date(
            state.updatedAt
          ).getTime()

        : Infinity;


    if (
      age > 45000
    ) {

      await refreshAll();

    }


    res.json({

      ok: true,

      ...state.assets[
        symbol
      ][
        timeframe
      ]

    });

  }
);


app.post(
  "/api/test-notification",
  async (req, res) => {


    const result =
      await sendPush(

        "BIT ADAMS TEST",

        "Notifications from the new BIT ADAMS server are working.",

        {
          type: "test"
        }

      );


    res.json(
      result
    );

  }
);


app.listen(

  PORT,

  "0.0.0.0",

  () => {


    console.log(
      `BIT ADAMS SERVER running on port ${PORT}`
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

      SCAN_SECONDS *
      1000

    );

  }

);
