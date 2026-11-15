// Optional ringing Android alerts for server-approved M5 signals ONLY.
// Configured by environment variables; never called by public notification routes.
const env = name => process.env[name] || "";
const skip = () => ({skipped:true});

async function pushover(title, message) {
  if (!env("PUSHOVER_APP_TOKEN") || !env("PUSHOVER_USER_KEY")) return skip();
  const body = new URLSearchParams({
    token:env("PUSHOVER_APP_TOKEN"), user:env("PUSHOVER_USER_KEY"),
    title, message, priority:"2", retry:"60", expire:"300", sound:"siren"
  });
  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method:"POST",signal:AbortSignal.timeout(8000),body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status !== 1) throw new Error("Pushover error HTTP " + response.status);
  return {queued:true,receipt:data.receipt || null};
}

async function voiceCall(direction, symbol, trade) {
  const sid=env("TWILIO_ACCOUNT_SID"), token=env("TWILIO_AUTH_TOKEN");
  const from=env("TWILIO_FROM_NUMBER"), to=env("ALERT_TO_NUMBER");
  if (!sid || !token || !from || !to) return skip();
  const details = [
    "BIT ADAMS. Strong signal.",symbol === "XAUUSD" ? "Gold" : "Bitcoin",
    direction === "BUY" ? "Buy." : "Sell.",
    "Entry.",trade.entry,"Stop loss.",trade.sl,
    "Take profit one.",trade.tp1,
    "Informational demo signal. Check the chart before trading."
  ].join(" ").replace(/[<>&"']/g, " ");
  const body=new URLSearchParams({
    To:to,From:from,
    Twiml:'<Response><Say voice="alice" language="en-GB">' + details + '</Say></Response>'
  });
  const endpoint="https://api.twilio.com/2010-04-01/Accounts/"+encodeURIComponent(sid)+"/Calls.json";
  const response=await fetch(endpoint,{
    method:"POST",signal:AbortSignal.timeout(10000),
    headers:{
      Authorization:"Basic "+Buffer.from(sid+":"+token).toString("base64"),
      "Content-Type":"application/x-www-form-urlencoded"
    },body
  });
  if (!response.ok) throw new Error("Twilio voice call error HTTP "+response.status);
  return {queued:true};
}

export function ringAlertConfiguration() {
  return {
    pushoverConfigured:Boolean(env("PUSHOVER_APP_TOKEN") && env("PUSHOVER_USER_KEY")),
    phoneCallConfigured:Boolean(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") &&
      env("TWILIO_FROM_NUMBER") && env("ALERT_TO_NUMBER"))
  };
}

export async function sendStrongSignalAlert(direction,symbol,trade) {
  if (!["BUY","SELL"].includes(direction) || !trade || !trade.agentReview?.approved) {
    return {skipped:true,reason:"Not an approved internal strong signal"};
  }
  const title="BIT ADAMS STRONG "+direction+" "+(symbol === "XAUUSD" ? "GOLD" : "BITCOIN");
  const message=title+"\nQuality "+trade.qualityScore+"/99 (not win probability)"+
    "\nEntry "+trade.entry+"\nSL "+trade.sl+"\nTP1 "+trade.tp1+
    "\nBoth M5 agents confirmed. Demo/confirm manually.";
  const results=await Promise.allSettled([pushover(title,message),voiceCall(direction,symbol,trade)]);
  return {
    pushover:results[0].status === "fulfilled" ? results[0].value : {error:String(results[0].reason)},
    phone:results[1].status === "fulfilled" ? results[1].value : {error:String(results[1].reason)}
  };
}
