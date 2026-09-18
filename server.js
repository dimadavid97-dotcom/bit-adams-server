import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

/* =====================================================
   SETTINGS
===================================================== */

const PORT = Number(process.env.PORT || 10000);

const ONESIGNAL_APP_ID =
  process.env.ONESIGNAL_APP_ID || "";

const ONESIGNAL_API_KEY =
  process.env.ONESIGNAL_API_KEY || "";

// OPTIONAL
// Dacă mai târziu pui WEBHOOK_SECRET în Render,
// TradingView trebuie să trimită același secret.
const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || "";


/* =====================================================
   MIDDLEWARE
===================================================== */

app.use(cors());

app.use(
  express.json({
    limit: "100kb"
  })
);

app.use(
  express.text({
    type: [
      "text/plain",
      "application/text"
    ],
    limit: "100kb"
  })
);


/* =====================================================
   HELPERS
===================================================== */

function clean(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}


function normalizePayload(body) {

  if (!body) {
    return {};
  }

  if (typeof body === "object") {
    return body;
  }

  if (typeof body === "string") {

    const text = body.trim();

    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      return {
        message: text
      };
    }

  }

  return {};
}


function detectEvent(payload) {

  const raw =
    clean(
      payload.event ||
      payload.action ||
      payload.signal ||
      payload.type ||
      payload.side ||
      payload.status ||
      payload.message
    ).toUpperCase();

  if (
    raw.includes("BREAK EVEN") ||
    raw.includes("BREAK-EVEN") ||
    raw.includes("BREAKEVEN") ||
    raw === "BE"
  ) {
    return "BREAK_EVEN";
  }

  if (
    raw.includes("STOP LOSS") ||
    raw.includes("STOP-LOSS") ||
    raw.includes("STOPLOSS") ||
    raw === "SL" ||
    raw.includes(" SL ")
  ) {
    return "SL";
  }

  if (raw.includes("TP3")) {
    return "TP3";
  }

  if (raw.includes("TP2")) {
    return "TP2";
  }

  if (raw.includes("TP1")) {
    return "TP1";
  }

  if (
    raw.includes("WIN") ||
    raw.includes("PROFIT")
  ) {
    return "WIN";
  }

  if (
    raw.includes("BUY") ||
    raw.includes("LONG")
  ) {
    return "BUY";
  }

  if (
    raw.includes("SELL") ||
    raw.includes("SHORT")
  ) {
    return "SELL";
  }

  return "";
}


function normalizeSymbol(value) {

  const s =
    clean(value)
      .toUpperCase()
      .replace("OANDA:", "")
      .replace("FOREXCOM:", "")
      .replace("BINANCE:", "")
      .replace("TVC:", "")
      .replace("/", "");

  if (
    s.includes("XAUUSD") ||
    s === "GOLD"
  ) {
    return "XAUUSD";
  }

  if (
    s.includes("BTCUSD") ||
    s.includes("BTCUSDT") ||
    s === "BITCOIN"
  ) {
    return "BTCUSD";
  }

  return s || "MARKET";
}


function symbolLabel(symbol) {

  if (symbol === "XAUUSD") {
    return "GOLD";
  }

  if (symbol === "BTCUSD") {
    return "BITCOIN";
  }

  return symbol;
}


function getTitle(event, symbol) {

  const name = symbolLabel(symbol);

  switch (event) {

    case "BUY":
      return `🟢 BUY ${name}`;

    case "SELL":
      return `🔴 SELL ${name}`;

    case "TP1":
      return `✅ TP1 HIT • ${name}`;

    case "TP2":
      return `✅ TP2 HIT • ${name}`;

    case "TP3":
      return `🏆 TP3 / WIN • ${name}`;

    case "WIN":
      return `🏆 WIN • ${name}`;

    case "SL":
      return `⛔ STOP LOSS • ${name}`;

    case "BREAK_EVEN":
      return `🟡 BREAK-EVEN • ${name}`;

    default:
      return `BIT ADAMS • ${name}`;
  }

}


function addLine(lines, label, value) {

  const v = clean(value);

  if (v) {
    lines.push(`${label}: ${v}`);
  }

}


function buildMessage(
  event,
  symbol,
  payload
) {

  const lines = [];

  const name =
    symbolLabel(symbol);

  const timeframe =
    clean(
      payload.timeframe ||
      payload.tf ||
      payload.interval
    );

  lines.push(
    `${name}${timeframe ? " • " + timeframe : ""}`
  );

  if (event === "BUY") {
    lines.push("🟢 SIGNAL: BUY");
  }

  if (event === "SELL") {
    lines.push("🔴 SIGNAL: SELL");
  }

  if (event === "TP1") {
    lines.push("✅ TAKE PROFIT 1 HIT");
  }

  if (event === "TP2") {
    lines.push("✅ TAKE PROFIT 2 HIT");
  }

  if (event === "TP3") {
    lines.push("🏆 TAKE PROFIT 3 HIT");
    lines.push("TRADE WIN");
  }

  if (event === "WIN") {
    lines.push("🏆 TRADE WIN");
  }

  if (event === "SL") {
    lines.push("⛔ STOP LOSS HIT");
  }

  if (event === "BREAK_EVEN") {
    lines.push("🟡 BREAK-EVEN");
    lines.push("SL moved to ENTRY");
  }


  addLine(
    lines,
    "ENTRY",
    payload.entry ||
    payload.entryPrice
  );

  addLine(
    lines,
    "SL",
    payload.sl ||
    payload.stoploss ||
    payload.stopLoss
  );

  addLine(
    lines,
    "TP1",
    payload.tp1
  );

  addLine(
    lines,
    "TP2",
    payload.tp2
  );

  addLine(
    lines,
    "TP3",
    payload.tp3
  );

  addLine(
    lines,
    "PRICE",
    payload.price ||
    payload.close
  );


  return lines.join("\n");
}


/* =====================================================
   ONESIGNAL
===================================================== */

async function sendOneSignal(
  title,
  message,
  data = {}
) {

  if (!ONESIGNAL_APP_ID) {

    throw new Error(
      "ONESIGNAL_APP_ID missing"
    );

  }

  if (!ONESIGNAL_API_KEY) {

    throw new Error(
      "ONESIGNAL_API_KEY missing"
    );

  }


  const body = {

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

    data: data,

    name:
      `BIT ADAMS ${Date.now()}`

  };


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
          JSON.stringify(body)
      }
    );


  const text =
    await response.text();


  let result;

  try {
    result = JSON.parse(text);
  } catch {
    result = {
      raw: text
    };
  }


  if (!response.ok) {

    console.error(
      "ONESIGNAL ERROR:",
      response.status,
      result
    );

    throw new Error(
      `OneSignal error ${response.status}`
    );

  }


  console.log(
    "ONESIGNAL SENT:",
    result
  );


  return result;
}


/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {

    res.status(200).json({

      ok: true,

      service:
        "BIT ADAMS SERVER",

      status:
        "UP",

      time:
        new Date().toISOString()

    });

  }
);


/* =====================================================
   HOME
===================================================== */

app.get(
  "/",
  (req, res) => {

    res.json({

      app:
        "BIT ADAMS",

      status:
        "ONLINE",

      endpoints: {

        health:
          "/health",

        tradingview:
          "/tradingview-webhook"

      }

    });

  }
);


/* =====================================================
   TRADINGVIEW WEBHOOK
===================================================== */

async function tradingViewWebhook(
  req,
  res
) {

  try {

    const payload =
      normalizePayload(
        req.body
      );


    console.log(
      "TRADINGVIEW RECEIVED:",
      payload
    );


    /* OPTIONAL SECURITY */

    if (WEBHOOK_SECRET) {

      const receivedSecret =
        clean(
          payload.secret
        );

      if (
        receivedSecret !==
        WEBHOOK_SECRET
      ) {

        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Invalid webhook secret"
          });

      }

    }


    const event =
      detectEvent(
        payload
      );


    if (!event) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            "Unknown event",

          received:
            payload

        });

    }


    const symbol =
      normalizeSymbol(
        payload.symbol ||
        payload.ticker ||
        payload.asset ||
        ""
      );


    const title =
      getTitle(
        event,
        symbol
      );


    const message =
      buildMessage(
        event,
        symbol,
        payload
      );


    const oneSignalResult =
      await sendOneSignal(
        title,
        message,
        {

          source:
            "TradingView",

          event:
            event,

          symbol:
            symbol,

          timeframe:
            clean(
              payload.timeframe ||
              payload.tf ||
              payload.interval
            ),

          entry:
            clean(payload.entry),

          sl:
            clean(payload.sl),

          tp1:
            clean(payload.tp1),

          tp2:
            clean(payload.tp2),

          tp3:
            clean(payload.tp3),

          price:
            clean(
              payload.price ||
              payload.close
            )

        }
      );


    return res
      .status(200)
      .json({

        ok: true,

        event:
          event,

        symbol:
          symbol,

        notification:
          oneSignalResult

      });


  } catch (error) {

    console.error(
      "WEBHOOK ERROR:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        error:
          error.message

      });

  }

}


/* =====================================================
   WEBHOOK ROUTES
===================================================== */

app.post(
  "/tradingview-webhook",
  tradingViewWebhook
);

app.post(
  "/webhook",
  tradingViewWebhook
);


/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "Route not found"

    });

  }
);


/* =====================================================
   START SERVER
===================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `BIT ADAMS server running on port ${PORT}`
    );

    console.log(
      "TradingView webhook ready"
    );

  }
);
