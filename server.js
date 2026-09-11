import express from "express";
import cors from "cors";
import dotenv from "dotenv";

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
  Number(process.env.MIN_CONFIDENCE || 78);

const PUSH_COOLDOWN_MIN =
  Number(process.env.PUSH_COOLDOWN_MIN || 15);


/* =========================
   ASSETS
========================= */

const ASSETS = {

  XAUUSD:{
    api:"XAU/USD",
    label:"GOLD"
  },

  BTCUSD:{
    api:"BTC/USD",
    label:"BITCOIN"
  }

};


const TIMEFRAMES = {

  M5:"5min",

  M15:"15min"

};


/* =========================
   STATE
========================= */

const state = {

  updatedAt:null,

  running:false,

  error:null,

  assets:{

    XAUUSD:{
      M5:null,
      M15:null
    },

    BTCUSD:{
      M5:null,
      M15:null
    }

  }

};


const candleCache =
  new Map();

const lastPush =
  new Map();

let apiRequestTimes = [];

let apiGate =
  Promise.resolve();


function sleep(ms){

  return new Promise(
    resolve=>
    setTimeout(resolve,ms)
  );

}


/* =========================
   API CREDIT GUARD
   MAX 8 / MINUTE
========================= */

async function reserveApiCredit(){

  const run =
  apiGate.then(async()=>{

    while(true){

      const now =
        Date.now();

      apiRequestTimes =
      apiRequestTimes.filter(
        t=>
        now-t<60000
      );

      if(
        apiRequestTimes.length<8
      ){

        apiRequestTimes.push(
          Date.now()
        );

        return;

      }

      const wait =
        Math.max(
          500,
          60000-
          (
            now-
            apiRequestTimes[0]
          )
          +400
        );

      await sleep(wait);

    }

  });


  apiGate =
    run.catch(()=>{});

  return run;

}


/* =========================
   INDICATORS
========================= */

function roundPrice(value){

  if(
    !Number.isFinite(
      Number(value)
    )
  ){
    return null;
  }

  return Number(
    Number(value)
    .toFixed(2)
  );

}


function emaSeries(
  values,
  period
){

  if(!values.length)
    return[];

  const k =
    2/(period+1);

  const out =
    [values[0]];

  for(
    let i=1;
    i<values.length;
    i++
  ){

    out.push(

      values[i]*k
      +
      out[i-1]*(1-k)

    );

  }

  return out;

}


function rsi(
  values,
  period=14
){

  if(
    !Array.isArray(values)
    ||
    values.length<=period
  ){
    return 50;
  }

  let gains=0;
  let losses=0;

  for(
    let i=
    values.length-period;
    i<values.length;
    i++
  ){

    const change =
      values[i]-
      values[i-1];

    if(change>=0){

      gains+=change;

    }

    else{

      losses+=
      Math.abs(change);

    }

  }

  const avgGain =
    gains/period;

  const avgLoss =
    losses/period;

  if(avgLoss===0)
    return 100;

  const rs =
    avgGain/avgLoss;

  return(
    100-
    100/(1+rs)
  );

}


function atr(
  candles,
  period=14
){

  if(
    !Array.isArray(candles)
    ||
    candles.length<=period
  ){
    return 0;
  }

  const trs=[];

  for(
    let i=
    candles.length-period;
    i<candles.length;
    i++
  ){

    const current =
      candles[i];

    const previous =
      candles[i-1];

    trs.push(

      Math.max(

        current.high-
        current.low,

        Math.abs(
          current.high-
          previous.close
        ),

        Math.abs(
          current.low-
          previous.close
        )

      )

    );

  }

  return(
    trs.reduce(
      (a,b)=>a+b,
      0
    )
    /
    trs.length
  );

}


function slope(
  values,
  lookback=5
){

  if(
    !Array.isArray(values)
    ||
    values.length<
    lookback+1
  ){
    return 0;
  }

  const a =
    values.at(-1);

  const b =
    values[
      values.length-
      1-
      lookback
    ];

  return(
    (
      a-b
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


function macd(values){

  if(
    values.length<35
  ){

    return{
      line:0,
      signal:0,
      hist:0
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
      (_,i)=>
      e12[i]-e26[i]
    );

  const signalSeries =
    emaSeries(
      lineSeries,
      9
    );

  return{

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
  outputsize=80,
  force=false
){

  if(
    !TWELVE_DATA_API_KEY
  ){

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
    Date.now()-
    cached.time
    <
    45000
  ){

    return(
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
        headers:{
          Accept:
          "application/json"
        }
      }
    );


  const data =
    await response
    .json()
    .catch(
      ()=>({})
    );


  if(
    !response.ok
    ||
    data.status==="error"
    ||
    !Array.isArray(
      data.values
    )
  ){

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
      v=>({

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
      c=>
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


  return(
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
){

  if(
    !Array.isArray(candles)
    ||
    candles.length<50
  ){

    throw new Error(
      "Not enough candles"
    );

  }


  const closes =
    candles.map(
      c=>c.close
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
      latest.close-
      latest.open
    );


  const range =
    Math.max(
      latest.high-
      latest.low,
      1e-9
    );


  const bodyRatio =
    body/range;


  const atrPct =
    atr14
    /
    Math.max(
      latest.close,
      1
    )
    *
    100;


  let buy=0;

  let sell=0;


  if(fast>slow)
    buy+=18;
  else
    sell+=18;


  if(slow>long)
    buy+=15;
  else
    sell+=15;


  if(latest.close>fast)
    buy+=9;
  else
    sell+=9;


  if(latest.close>slow)
    buy+=7;
  else
    sell+=7;


  if(
    trendSlope>0.010
  ){

    buy+=10;

  }

  else if(
    trendSlope<-0.010
  ){

    sell+=10;

  }


  if(
    rsi14>=52
    &&
    rsi14<=70
  ){

    buy+=13;

  }

  else if(
    rsi14<=48
    &&
    rsi14>=30
  ){

    sell+=13;

  }

  else if(
    rsi14>72
  ){

    sell+=3;

  }

  else if(
    rsi14<28
  ){

    buy+=3;

  }


  if(
    momentum>0.015
  ){

    buy+=10;

  }

  else if(
    momentum<-0.015
  ){

    sell+=10;

  }


  if(
    M.hist>0
    &&
    M.line>M.signal
  ){

    buy+=10;

  }

  else if(
    M.hist<0
    &&
    M.line<M.signal
  ){

    sell+=10;

  }


  if(
    latest.close>
    latest.open
  ){

    buy+=4;

  }


  if(
    latest.close<
    latest.open
  ){

    sell+=4;

  }


  if(
    latest.close>
    latest.open
    &&
    previous.close>
    previous.open
  ){

    buy+=4;

  }


  if(
    latest.close<
    latest.open
    &&
    previous.close<
    previous.open
  ){

    sell+=4;

  }


  if(
    bodyRatio>0.50
  ){

    if(
      latest.close>
      latest.open
    ){

      buy+=5;

    }

    else{

      sell+=5;

    }

  }


  const dominant =
    Math.max(
      buy,
      sell
    );


  const difference =
    Math.abs(
      buy-sell
    );


  const buyTrend =

    fast>slow
    &&
    latest.close>slow
    &&
    trendSlope>=0;


  const sellTrend =

    fast<slow
    &&
    latest.close<slow
    &&
    trendSlope<=0;


  const volatilityOK =

    atrPct>=(
      symbol==="BTCUSD"
      ? 0.06
      : 0.018
    );


  let side =
    "WAIT";


  if(
    volatilityOK
    &&
    buy>=60
    &&
    difference>=10
    &&
    buyTrend
    &&
    rsi14<74
    &&
    momentum>-0.015
  ){

    side="BUY";

  }


  if(
    volatilityOK
    &&
    sell>=60
    &&
    difference>=10
    &&
    sellTrend
    &&
    rsi14>26
    &&
    momentum<0.015
  ){

    side="SELL";

  }


  const confidence =

    side==="WAIT"

    ?

    Math.round(

      Math.min(
        72,
        45+
        dominant*0.25
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
          dominant*0.34
          +
          difference*0.10
        )

      )

    );


  const entry =
    latest.close;


  const atrFloor =

    entry*(

      symbol==="BTCUSD"

      ? 0.0011

      : 0.0008

    );


  const risk =
    Math.max(
      atr14*1.10,
      atrFloor
    );


  let sl=null;

  let tp1=null;

  let tp2=null;

  let tp3=null;


  if(
    side==="BUY"
  ){

    sl=
      entry-risk;

    tp1=
      entry+
      risk*0.85;

    tp2=
      entry+
      risk*1.45;

    tp3=
      entry+
      risk*2.20;

  }


  if(
    side==="SELL"
  ){

    sl=
      entry+risk;

    tp1=
      entry-
      risk*0.85;

    tp2=
      entry-
      risk*1.45;

    tp3=
      entry-
      risk*2.20;

  }


  const quality =

    side==="WAIT"

    ? "WAIT"

    : confidence>=90

    ? "EXCELLENT"

    : confidence>=82

    ? "STRONG"

    : "VALID";


  return{

    symbol,

    asset:
      symbol,

    timeframe,

    side,

    direction:
      side,

    confidence,

    quality,

    price:
      roundPrice(
        entry
      ),

    entry:
      side==="WAIT"
      ? null
      : roundPrice(
          entry
        ),

    sl:
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
  data={}
){

  if(
    !ONESIGNAL_APP_ID
    ||
    !ONESIGNAL_API_KEY
  ){

    console.log(
      "OneSignal skipped - keys missing"
    );

    return{
      skipped:true
    };

  }


  const response =
    await fetch(

      "https://api.onesignal.com/notifications",

      {

        method:"POST",

        headers:{

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

            headings:{
              en:title
            },

            contents:{
              en:message
            },

            data

          })

      }

    );


  const body =
    await response
    .json()
    .catch(
      ()=>({})
    );


  if(
    !response.ok
  ){

    console.error(
      "OneSignal error:",
      body
    );

    return{

      ok:false,

      status:
        response.status,

      body

    };

  }


  console.log(
    "OneSignal sent:",
    title
  );


  return{

    ok:true,

    body

  };

}


/* =========================
   SIGNAL NOTIFICATION
========================= */

async function maybeNotify(
  signal
){

  if(
    !signal
    ||
    signal.side==="WAIT"
    ||
    signal.confidence<
    MIN_CONFIDENCE
  ){

    return;

  }


  const slot =
    `${signal.symbol}:${signal.timeframe}`;


  const fingerprint =
    `${signal.side}|${signal.candleTime}`;


  const now =
    Date.now();


  const previous =
    lastPush.get(
      slot
    );


  const cooldownMs =
    PUSH_COOLDOWN_MIN
    *
    60
    *
    1000;


  if(
    previous
    &&
    previous.fingerprint===
    fingerprint
    &&
    now-
    previous.time
    <
    cooldownMs
  ){

    return;

  }


  lastPush.set(

    slot,

    {

      fingerprint,

      time:now

    }

  );


  await sendPush(

    `BIT ADAMS • ${signal.side} ${signal.symbol} ${signal.timeframe}`,

    `Confidence ${signal.confidence}% • Entry ${signal.entry} • SL ${signal.sl} • TP1 ${signal.tp1} • TP2 ${signal.tp2} • TP3 ${signal.tp3}`,

    {

      type:"signal",

      symbol:
        signal.symbol,

      timeframe:
        signal.timeframe,

      side:
        signal.side,

      confidence:
        signal.confidence,

      entry:
        signal.entry,

      sl:
        signal.sl,

      tp1:
        signal.tp1,

      tp2:
        signal.tp2,

      tp3:
        signal.tp3

    }

  );

}


/* =========================
   MAIN SCAN
========================= */

async function refreshAll(){

  if(
    state.running
  ){

    return state;

  }


  state.running=true;

  state.error=null;


  try{


    for(
      const[
        symbol,
        asset
      ]
      of
      Object.entries(
        ASSETS
      )
    ){


      for(
        const[
          tf,
          interval
        ]
        of
        Object.entries(
          TIMEFRAMES
        )
      ){


        try{


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

        catch(err){


          console.error(
            `${symbol} ${tf} error:`,
            err.message
          );


          state.assets[
            symbol
          ][
            tf
          ]={

            symbol,

            asset:
              symbol,

            timeframe:
              tf,

            side:
              "ERROR",

            direction:
              "ERROR",

            confidence:
              0,

            error:
              err.message,

            candles:[]

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
        m5.side===
        m15?.side
      ){


        m5.confidence =
          Math.min(
            99,
            m5.confidence+4
          );


        m15.confidence =
          Math.min(
            99,
            m15.confidence+4
          );

      }


      await maybeNotify(
        m5
      );


      await maybeNotify(
        m15
      );

    }


    state.updatedAt =
      new Date()
      .toISOString();


    console.log(
      "BIT ADAMS scan OK",
      state.updatedAt
    );


  }

  catch(err){


    state.error =
      err.message;


    console.error(
      "Scan error:",
      err
    );


  }

  finally{


    state.running=
      false;


  }


  return state;

}


/* =========================
   NORMALIZE
========================= */

function normalizeSymbol(
  value
){

  const v =
    String(
      value||""
    )
    .toUpperCase()
    .replace(
      /[^A-Z]/g,
      ""
    );


  if(
    v==="XAUUSD"
    ||
    v==="GOLD"
  ){

    return "XAUUSD";

  }


  if(
    v==="BTCUSD"
    ||
    v==="BITCOIN"
    ||
    v==="BTC"
  ){

    return "BTCUSD";

  }


  return null;

}


function normalizeTimeframe(
  value
){

  const v =
    String(
      value||""
    )
    .toUpperCase();


  if(
    v==="M5"
    ||
    v==="5MIN"
    ||
    v==="5"
  ){

    return "M5";

  }


  if(
    v==="M15"
    ||
    v==="15MIN"
    ||
    v==="15"
  ){

    return "M15";

  }


  return null;

}


async function ensureFresh(){

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
    age>45000
  ){

    await refreshAll();

  }

}


/* =========================
   ROUTES
========================= */

app.get(
  "/",
  (req,res)=>{

    res.json({

      ok:true,

      name:
        "BIT ADAMS SERVER",

      assets:[
        "XAUUSD",
        "BTCUSD"
      ],

      timeframes:[
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
  (req,res)=>{

    res.json({

      ok:true,

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

      updatedAt:
        state.updatedAt,

      error:
        state.error

    });

  }
);


app.get(
  "/api/market",
  async(req,res)=>{

    await ensureFresh();

    res.json(
      state
    );

  }
);


app.get(
  "/api/scan",
  async(req,res)=>{

    await refreshAll();

    res.json(
      state
    );

  }
);


app.get(
  "/api/analyze",
  async(req,res)=>{

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
    ){

      return res
      .status(400)
      .json({

        ok:false,

        error:
          "Use symbol=XAUUSD or BTCUSD and timeframe=M5 or M15"

      });

    }


    await ensureFresh();


    res.json({

      ok:true,

      ...state.assets[
        symbol
      ][
        timeframe
      ]

    });

  }
);


/* =========================
   CANDLES FOR CHART
========================= */

app.get(
  "/api/candles",
  async(req,res)=>{

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
    ){

      return res
      .status(400)
      .json({

        ok:false,

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

      ok:true,

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
  async(req,res)=>{

    const result =
      await sendPush(

        "BIT ADAMS TEST",

        "Notifications from the BIT ADAMS server are working.",

        {
          type:"test"
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

  ()=>{


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

      ()=>{

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
