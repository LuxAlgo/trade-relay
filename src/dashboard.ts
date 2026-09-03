/*
  The local dashboard: one self-contained HTML page, no build step, no CDN,
  no external requests. It talks to /api/* with the Bearer token the user
  pastes once (kept in localStorage). Dark, quiet, and honest — the signal
  story chain is the product: received → parsed → every risk decision with
  its reason → the order → the fill.

  The Tape panel puts those fills on a price chart drawn by Vela
  (@luxalgo/vela, Apache-2.0), served from this same origin. Its script is
  fetched only when the panel is first opened, so the default page weighs
  exactly what it did without it. Vela's own attribution mark stays on the
  chart (see THIRD_PARTY_NOTICES.md).
*/

export const renderDashboard = (version: string, velaVersion = version): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trade-relay</title>
<style>
:root{--bg:#0b0e14;--panel:#11151f;--panel2:#161b28;--line:#232a3b;--text:#dfe4ee;--dim:#8b93a7;--green:#2ecc8f;--red:#ff5470;--yellow:#ffc24b;--blue:#5aa2ff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px;max-width:1200px;margin:0 auto}
header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:20px}
h1{font-size:18px;font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:10px}
h1 .mark{height:22px;width:auto;flex:none;color:var(--text)}
h1 span{color:var(--dim);font-weight:400}
.pill{font:12px var(--mono);padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.spacer{flex:1}
button{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
button:hover{border-color:var(--dim)}
#kill{font-weight:700}
#kill.on{background:var(--red);border-color:var(--red);color:#fff}
#kill.off{background:transparent;border-color:var(--red);color:var(--red)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.card .k{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.6px}
.card .v{font:600 22px var(--mono);margin-top:2px}
.card .s{color:var(--dim);font-size:12px;margin-top:4px}
.pnl-up{color:var(--green)}.pnl-down{color:var(--red)}
.env{font:11px var(--mono);padding:1px 7px;border-radius:6px;margin-left:8px;vertical-align:2px}
.env.paper,.env.simulated,.env.sandbox{background:#173a2c;color:var(--green)}
.env.live{background:#3a1720;color:var(--red)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
td{padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--panel2)}
.mono{font-family:var(--mono);font-size:12px}
.chip{font:11px var(--mono);padding:2px 8px;border-radius:6px}
.chip.executed{background:#173a2c;color:var(--green)}
.chip.rejected{background:#3a2c17;color:var(--yellow)}
.chip.parse_error,.chip.error{background:#3a1720;color:var(--red)}
.chip.noop,.chip.received{background:#20263a;color:var(--dim)}
.story{display:none}
.story.open{display:table-row}
.story>td{background:var(--panel2);padding:14px 16px}
.stage{margin-bottom:12px}
.stage h4{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:6px}
pre{font:12px/1.5 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.rule{font:12px var(--mono);padding:2px 0}
.rule .ok{color:var(--green)}.rule .no{color:var(--red)}.rule .skip{color:var(--dim)}
.toolbar{display:flex;gap:10px;align-items:center;margin:18px 0 10px;flex-wrap:wrap}
select,input{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13px}
#tokenbox{display:none;background:var(--panel);border:1px solid var(--yellow);border-radius:12px;padding:16px;margin-bottom:16px}
#tokenbox input{width:340px;max-width:100%}
.err{color:var(--red);font:12px var(--mono);margin-top:6px}
footer{margin-top:24px;color:var(--dim);font-size:12px}
a{color:var(--blue);text-decoration:none}
.tape{display:none;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:20px}
.tape.open{display:block}
#tapechart{height:380px}
.tape-foot{display:flex;gap:14px;flex-wrap:wrap;padding:8px 12px;color:var(--dim);font-size:12px;border-top:1px solid var(--line)}
.tape-foot .mono{font-size:12px}
#tapecontrols{display:none;gap:10px;align-items:center;flex-wrap:wrap}
#tapecontrols.open{display:flex}
input[type=date]{font-family:var(--mono);font-size:12px}
tr.pinned td:first-child{box-shadow:inset 3px 0 0 var(--blue)}
@media(prefers-color-scheme:light){:root{--bg:#f5f6f9;--panel:#fff;--panel2:#eef0f5;--line:#dde1ea;--text:#1a2130;--dim:#66708a}h1 .mark{filter:invert(1)}}
</style>
</head>
<body>
<header>
  <h1>
    <!-- The LuxAlgo mark: a trademark of LuxAlgo Global, LLC (see TRADEMARKS.md), giving the brand its visual credit next to the product name. -->
    <img class="mark" alt="LuxAlgo" src="data:image/png;base64,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">
    Trade Relay <span>flight recorder</span>
  </h1>
  <span class="pill" id="ver">v${version}</span>
  <span class="pill" id="up">–</span>
  <div class="spacer"></div>
  <button id="flatten" title="Cancel all open orders and close every position">Flatten all</button>
  <button id="kill" class="off">KILL SWITCH</button>
</header>

<div id="tokenbox">
  <div style="margin-bottom:8px">This dashboard needs your <b>dashboard token</b> (the <span class="mono">DASHBOARD_TOKEN</span> you configured).</div>
  <input id="token" type="password" placeholder="paste token…">
  <button id="savetoken">Save</button>
  <div class="err" id="tokenerr"></div>
</div>

<div class="grid" id="accounts"></div>

<div class="toolbar">
  <b>Tape</b>
  <button id="tapetoggle" title="Chart the recorded fills of one symbol">Show tape</button>
  <span id="tapecontrols">
    <select id="tsym" title="Symbols with recorded fills"></select>
    <select id="tacct" title="Account"><option value="">all accounts</option></select>
    <input id="tfrom" type="date" title="From (UTC day)">
    <span class="mono" style="color:var(--dim)">→</span>
    <input id="tto" type="date" title="To (UTC day, inclusive)">
    <span class="pill" id="tapepill">–</span>
  </span>
</div>
<div class="tape" id="tape">
  <div id="tapechart"></div>
  <div class="tape-foot" id="tapefoot"></div>
</div>

<div class="toolbar">
  <b>Signals</b>
  <select id="fstatus">
    <option value="">all statuses</option>
    <option>executed</option><option>rejected</option><option>parse_error</option>
    <option>error</option><option>noop</option>
  </select>
  <select id="fendpoint"><option value="">all endpoints</option></select>
  <span class="pill" id="count">–</span>
</div>
<table>
  <thead><tr><th>time</th><th>endpoint</th><th>parser</th><th>signal</th><th>status</th><th>order</th><th>ms</th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<footer>trade-relay: open source, self-hosted, no telemetry. Built by <a href="https://luxalgo.com" rel="noopener">LuxAlgo</a>. <a href="https://github.com/LuxAlgo/trade-relay" rel="noopener">GitHub</a><br>Not financial advice. You operate this software; trading involves substantial risk of loss.</footer>

<script>
const $=q=>document.querySelector(q);
let token=localStorage.getItem("tr_token")||"";
const H=()=>token?{Authorization:"Bearer "+token}:{};
const api=async(p,opt)=>{const r=await fetch(p,Object.assign({headers:Object.assign({"Content-Type":"application/json"},H())},opt||{}));if(r.status===401){$("#tokenbox").style.display="block";throw new Error("unauthorized")}return r.json()};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt=n=>typeof n==="number"?n.toLocaleString(undefined,{maximumFractionDigits:2}):n;
let open=new Set(), lastSignals=[], pinned=new Map();

$("#savetoken").onclick=()=>{token=$("#token").value.trim();localStorage.setItem("tr_token",token);$("#tokenbox").style.display="none";tick()};

async function tick(){
  try{
    const st=await api("/api/status");
    $("#up").textContent="up "+Math.floor(st.uptimeSec/60)+"m";
    const k=$("#kill");k.className=st.killSwitch.on?"on":"off";
    k.textContent=st.killSwitch.on?"KILLED — click to resume":"KILL SWITCH";
    k.onclick=async()=>{const on=!st.killSwitch.on;if(on&&!confirm("Stop ALL order placement?"))return;if(!on&&!confirm("Resume trading?"))return;await api("/api/kill",{method:"POST",body:JSON.stringify({on,reason:"dashboard"})});tick()};
    $("#flatten").onclick=async()=>{if(!confirm("Cancel all open orders and close every position?"))return;await api("/api/flatten",{method:"POST",body:JSON.stringify({})});tick()};
    const fe=$("#fendpoint");
    if(fe.options.length===1)for(const e of st.endpoints){const o=document.createElement("option");o.textContent=e.id;fe.appendChild(o)}
    const accs=await api("/api/accounts");
    $("#accounts").innerHTML=accs.map(a=>{
      if(a.mode==="watch"){const eq=(a.accounts||[]).reduce((s,x)=>s+(x.equity||0),0);return card(a.id+" (watch)",a.error?"—":fmt(eq),a.error||a.broker,null,a.stats)}
      const pos=(a.positions||[]).length;
      return card(a.id,a.error?"—":fmt(a.equity)+" "+(a.currency||""),(a.error||a.broker+" · "+pos+" position"+(pos===1?"":"s")),a.environment,a.stats)
    }).join("");
    const q=new URLSearchParams({limit:"60"});
    if($("#fstatus").value)q.set("status",$("#fstatus").value);
    if($("#fendpoint").value)q.set("endpoint",$("#fendpoint").value);
    const sigs=await api("/api/signals?"+q);
    lastSignals=sigs;
    $("#count").textContent=sigs.length+" shown";
    renderRows();
    if(tape.open)refreshTape();
  }catch(e){/* token box already shown on 401 */}
}
// Rows the tape pinned (a marker's story that the current filter or page
// no longer lists) stay on top until the page reloads.
function renderRows(){
  const shown=[...pinned.values()].filter(p=>!lastSignals.some(s=>s.id===p.id)).concat(lastSignals);
  $("#rows").innerHTML=shown.map(row).join("");
  for(const s of shown)if(open.has(s.id)){const el=document.getElementById("story-"+s.id);if(el)el.classList.add("open")}
}
function card(k,v,s,env,st){
  let stat="";
  if(st&&st.closedTrades){
    const up=st.realizedPnl>=0;
    stat='<div class="s"><span class="'+(up?"pnl-up":"pnl-down")+'">'+(up?"+":"")+fmt(st.realizedPnl)+' realized</span>'+(st.winRate!=null?' · '+Math.round(st.winRate*100)+'% win':'')+' · '+st.closedTrades+' closed</div>';
  }
  return '<div class="card"><div class="k">'+esc(k)+(env?'<span class="env '+esc(env)+'">'+esc(env)+"</span>":"")+'</div><div class="v">'+esc(v)+'</div><div class="s">'+esc(s)+"</div>"+stat+"</div>"
}
function sigLabel(s){if(!s.signal)return "—";const g=s.signal;return (g.action||"?").toUpperCase()+(g.symbol?" "+g.symbol:"")}
function ordLabel(s){const o=s.order;if(!o)return s.orders&&s.orders.length?s.orders.length+" order"+(s.orders.length===1?"":"s"):"—";return o.status+(o.filledAvgPrice?" @ "+fmt(o.filledAvgPrice):"")}
function row(s){
  const t=new Date(s.receivedAt).toLocaleTimeString();
  return '<tr class="row'+(pinned.has(s.id)?" pinned":"")+'" id="row-'+s.id+'" onclick="toggle(\\''+s.id+'\\')"><td class="mono">'+t+'</td><td>'+esc(s.endpointId)+'</td><td class="mono">'+esc(s.parser||"—")+'</td><td>'+esc(sigLabel(s))+'</td><td><span class="chip '+s.status+'">'+s.status+'</span></td><td class="mono">'+esc(ordLabel(s))+'</td><td class="mono">'+(s.latencyMs??"—")+'</td></tr>'
  +'<tr class="story" id="story-'+s.id+'"><td colspan="7">'+story(s)+"</td></tr>"
}
function story(s){
  let h="";
  h+=stage("1 · payload received"+(s.sourceIp?" from "+esc(s.sourceIp):""),"<pre>"+esc(pretty(s.rawBody))+"</pre>");
  if(s.signal)h+=stage("2 · understood as ("+esc(s.parser)+")","<pre>"+esc(JSON.stringify(s.signal,null,2))+"</pre>");
  if(s.decisions)h+=stage("3 · risk rules",s.decisions.map(d=>'<div class="rule"><span class="'+(d.outcome==="pass"?"ok":d.outcome==="reject"?"no":"skip")+'">'+(d.outcome==="pass"?"✓":d.outcome==="reject"?"✕":"·")+"</span> "+esc(d.rule)+(d.reason?' <span class="skip">— '+esc(d.reason)+"</span>":"")+"</div>").join(""));
  if(s.intent)h+=stage(s.order?"4 · order sent":"4 · order intent (not sent)","<pre>"+esc(JSON.stringify(s.intent,null,2))+"</pre>");
  if(s.order)h+=stage("5 · broker answered","<pre>"+esc(JSON.stringify(s.order,null,2))+"</pre>");
  if(s.orders&&s.orders.length)h+=stage("also touched","<pre>"+esc(JSON.stringify(s.orders,null,2))+"</pre>");
  if(s.error)h+=stage("error","<pre>"+esc(s.error)+"</pre>");
  h+='<button onclick="event.stopPropagation();replay(\\''+s.id+'\\')">↻ Replay this signal</button>'
  +(s.replayOf?' <span class="pill">replay of '+esc(s.replayOf.slice(0,8))+"…</span>":"");
  return h;
}
function stage(t,b){return '<div class="stage"><h4>'+t+"</h4>"+b+"</div>"}
function pretty(x){try{return JSON.stringify(JSON.parse(x),null,2)}catch(e){return x}}
window.toggle=id=>{const el=document.getElementById("story-"+id);if(!el)return;el.classList.toggle("open");el.classList.contains("open")?open.add(id):open.delete(id)};
window.replay=async id=>{if(!confirm("Re-run this payload through the whole pipeline?"))return;await api("/api/signals/"+id+"/replay",{method:"POST",body:JSON.stringify({})});tick()};
$("#fstatus").onchange=tick;$("#fendpoint").onchange=tick;

// ── Tape: the recorded fills of one symbol on a Vela chart ──────────────
// Vela is loaded lazily from this origin the first time the panel opens.
const VELA_SRC="/vela.global.min.js?v=${velaVersion}";
const tape={open:false,chart:null,unsub:[],vela:null,summary:null,data:null,key:"",registered:false,lastTime:null,busy:false,bars:null,tf:"1"};
// Crypto pairs can chart real public candles from Vela's bundled keyless
// providers when the server has no bars (Trade Journal's heuristic).
const looksCrypto=sym=>/^[A-Z0-9]{2,10}(USDT|USDC|USD|PERP|BTC|ETH)(\.P)?$/.test(sym);
const tfMs=tf=>{const m=/^(\d+)\s*(m|h|d|w)?$/i.exec(tf);if(!m)return 60000;const n=parseInt(m[1],10),u=(m[2]||"m").toLowerCase();return n*(u==="m"?60000:u==="h"?3600000:u==="d"?86400000:604800000)};
// A timeframe that frames the whole fill span in a few dozen bars (public candles).
const tfForSpan=ms=>{const m=ms/60000;return m<=90?"1":m<=480?"5":m<=2880?"15":m<=14400?"60":"1D"};
// On a bar chart a fill sits on the bar that contains its instant.
const snap=(t,bars,tf)=>{if(!bars)return t;const w=tfMs(tf);let best=bars[0].time;for(const b of bars){if(b.time<=t)best=b.time;else break}return t-best<w?best:Math.floor(t/w)*w};
const cssVar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// Vela wants literal colors; these are the page's own variables, resolved.
const velaTheme=()=>({background:cssVar("--panel"),textColor:cssVar("--dim"),gridColor:cssVar("--line"),borderColor:cssVar("--line"),upColor:cssVar("--green"),downColor:cssVar("--red"),fontFamily:getComputedStyle(document.body).fontFamily});
function loadVela(){
  if(window.Vela)return Promise.resolve(window.Vela);
  if(tape.vela)return tape.vela;
  tape.vela=new Promise((res,rej)=>{const s=document.createElement("script");s.src=VELA_SRC;s.onload=()=>res(window.Vela);s.onerror=()=>{tape.vela=null;rej(new Error("could not load "+VELA_SRC))};document.head.appendChild(s)});
  return tape.vela;
}
const day=iso=>iso.slice(0,10);
const money=n=>(n>=0?"+":"−")+Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
// Bar spacing for the fill path: the coarsest timeframe that still gives the
// typical gap between consecutive fills its own bar (Vela's floor is one minute).
const tfFor=times=>{const gaps=[];for(let i=1;i<times.length;i++)if(times[i]>times[i-1])gaps.push(times[i]-times[i-1]);
  if(!gaps.length)return "1";gaps.sort((a,b)=>a-b);const m=gaps[Math.floor(gaps.length/2)]/60000;
  return m>=1440?"1D":m>=60?"60":m>=15?"15":m>=5?"5":"1"};
// Offline mode: the fills themselves are the price series (one bar per
// instant, OHLC of the fills at that instant). Nothing is interpolated.
function fillPath(fills){
  const bars=[];
  for(const f of fills){const t=Date.parse(f.at);const last=bars[bars.length-1];
    if(last&&last.time===t){last.high=Math.max(last.high,f.price);last.low=Math.min(last.low,f.price);last.close=f.price}
    else bars.push({time:t,open:f.price,high:f.price,low:f.price,close:f.price,volume:0})}
  return bars;
}
function paint(d){
  const up=cssVar("--green"),down=cssVar("--red"),text=cssVar("--text");
  const bars=tape.bars,tf=tape.tf,x=t=>snap(Date.parse(t),bars,tf);
  // Realized P&L per exit, summed over the lots it closed, rides the exit's own marker.
  const pnlByExit=new Map();
  for(const p of d.pairs)pnlByExit.set(p.exitSignalId,(pnlByExit.get(p.exitSignalId)||0)+p.pnl);
  // Markers ride the bar of their fill (the exact price is in the tooltip and
  // the line geometry); the marker text carries side, size, and the P&L an exit realized.
  const labels=d.fills.map((f,i)=>{const pnl=f.side==="sell"?pnlByExit.get(f.signalId):undefined;return {id:"fill-"+i,paneId:"price",xloc:"bar_time",x:x(f.at),y:f.price,yloc:f.side==="buy"?"belowbar":"abovebar",
    text:(f.side==="buy"?"▲ BUY ":"▼ SELL ")+fmt(f.quantity)+(pnl!==undefined?"  "+money(pnl):""),style:f.side==="buy"?"triangleup":"triangledown",color:f.side==="buy"?up:down,textColor:pnl===undefined?text:pnl>=0?up:down,
    size:"small",textAlign:"center",fontFamily:"default",tooltip:f.side+" "+fmt(f.quantity)+" @ "+fmt(f.price)+" · "+new Date(f.at).toLocaleString()+(pnl!==undefined?" · realized "+money(pnl):"")+" · click for the story",overlay:true}});
  const lines=d.pairs.map((p,i)=>({id:"pair-"+i,paneId:"price",xloc:"bar_time",x1:x(p.entryAt),y1:p.entryPrice,x2:x(p.exitAt),y2:p.exitPrice,extend:"none",
    color:p.pnl>=0?up:down,invisible:false,width:2,style:"dashed",arrowLeft:false,arrowRight:true,overlay:true}));
  return {lines,labels};
}
// Where the candles came from, in the legend's words.
function sourceLabel(d,provider){
  if(provider)return esc(provider)+" public data";
  if(!d.bars)return "fill path, no market data";
  if(d.barsSource==="simulator")return "simulated bars"+(d.barsTimeframe?" · "+esc(d.barsTimeframe):"");
  return "bars: "+esc(d.barsSource)+(d.barsTimeframe?" · "+esc(d.barsTimeframe):"");
}
function footer(d,sym,src){
  $("#tapefoot").innerHTML='<span><b>'+esc(sym)+'</b> · '+d.fills.length+' fill'+(d.fills.length===1?"":"s")+' · '+d.pairs.length+' FIFO pair'+(d.pairs.length===1?"":"s")+'</span>'
    +'<span class="'+(d.realizedPnl>=0?"pnl-up":"pnl-down")+'">'+money(d.realizedPnl)+' realized</span><span id="tapesrc">'+src+'</span><span>▲ buy below the bar · ▼ sell above, with the P&amp;L it realized · dashed line: entry → exit · click a marker to open its story</span>'
    +'<span style="margin-left:auto">chart by <a href="https://github.com/LuxAlgo/Vela" rel="noopener">Vela</a></span>';
}
// Vela's bundled keyless providers, when the global bundle carries them.
const publicProviders=V=>[["binance",V.BinanceProvider],["coinbase",V.CoinbaseProvider]].filter(p=>typeof p[1]==="function");
function ensureIndicator(V){
  if(tape.registered)return;
  // A native indicator that paints whatever tape is currently loaded; the
  // chart is rebuilt per load, so one registered type is enough.
  V.registerNativeIndicator({type:"trade-relay-fills",title:"Fills",shortTitle:"fills",paneHint:"price",overlay:true,inputsSchema:()=>[],defaultInputs:()=>({}),
    create:()=>({start(ctx){if(tape.data)ctx.emit(paint(tape.data));ctx.setStatus("idle")},onBars(){},onViewport(){},setInputs(){},suspend(){},resume(){},stop(){}})});
  tape.registered=true;
}
function destroyChart(){for(const u of tape.unsub)try{u()}catch(e){}tape.unsub=[];if(tape.chart){try{tape.chart.destroy()}catch(e){}tape.chart=null}$("#tapechart").innerHTML=""}
function tapeParams(){
  const q=new URLSearchParams();
  if($("#tfrom").value)q.set("from",$("#tfrom").value+"T00:00:00.000Z");
  if($("#tto").value)q.set("to",$("#tto").value+"T23:59:59.999Z");
  if($("#tacct").value)q.set("account",$("#tacct").value);
  return q;
}
async function loadSummary(){
  const sum=await api("/api/tape");tape.summary=sum;
  const sel=$("#tsym"),prev=sel.value;
  sel.innerHTML=sum.symbols.map(s=>'<option value="'+esc(s.symbol)+'">'+esc(s.symbol)+" · "+s.fills+" fill"+(s.fills===1?"":"s")+"</option>").join("")||'<option value="">no fills recorded yet</option>';
  if(prev&&sum.symbols.some(s=>s.symbol===prev))sel.value=prev;
  const acct=$("#tacct");
  for(const a of sum.accounts)if(![...acct.options].some(o=>o.value===a)){const o=document.createElement("option");o.value=a;o.textContent=a;acct.appendChild(o)}
  if(!$("#tfrom").value&&!$("#tto").value)defaultRange();
}
// Default window: the last five sessions (UTC days) that have fills for the symbol.
function defaultRange(){
  const s=(tape.summary&&tape.summary.symbols||[]).find(x=>x.symbol===$("#tsym").value);
  if(!s)return;const last=s.sessions.slice(-5);
  $("#tfrom").value=last[0];$("#tto").value=last[last.length-1];
}
async function refreshTape(){
  if(tape.busy)return;tape.busy=true;
  try{
    if(!tape.summary)await loadSummary();
    const sym=$("#tsym").value;
    if(!sym){$("#tapefoot").innerHTML="No fills in the flight recorder yet — fire a signal and it lands here.";$("#tapepill").textContent="0 fills";destroyChart();tape.key="";return}
    const d=await api("/api/tape/"+encodeURIComponent(sym)+"?"+tapeParams());
    const key=JSON.stringify([d,cssVar("--bg")]);
    if(key===tape.key)return;tape.key=key;tape.data=d;
    $("#tapepill").textContent=d.fills.length+" fill"+(d.fills.length===1?"":"s");
    footer(d,sym,sourceLabel(d));
    destroyChart();
    if(!d.fills.length)return;
    const V=await loadVela();ensureIndicator(V);
    const times=d.fills.map(f=>Date.parse(f.at)),first=times[0],lastT=times[times.length-1],span=Math.max(lastT-first,60000);
    const serverBars=d.bars&&d.bars.length?d.bars:null;
    const base={theme:velaTheme(),height:380,live:false,volume:false,drawings:false,currentPriceLine:false};
    const frame=tf=>{const pad=Math.max(span*0.15,3*tfMs(tf));return {from:first-pad,to:lastT+pad}};
    // Offline chart: the server's bars as candles, else the fill path as a line.
    const offline=()=>{tape.bars=serverBars;tape.tf=serverBars?(d.barsTimeframe||"1m"):tfFor(times);
      return new V.Vela($("#tapechart"),Object.assign({},base,{data:serverBars||fillPath(d.fills),timeframe:tape.tf,priceStyle:serverBars?"candles":"line",visibleRange:frame(tape.tf)}))};
    let chart=null,provider=null;
    const providers=!serverBars&&looksCrypto(sym)?publicProviders(V):[];
    if(providers.length){
      // Real public candles for a crypto pair, from Vela's keyless providers.
      // The load parks until a provider resolves the symbol; if none does in
      // time (or the host is unreachable) the fill path takes over instead.
      tape.bars=null;tape.tf=tfForSpan(span);
      chart=new V.Vela($("#tapechart"),Object.assign({},base,{symbol:sym,timeframe:tape.tf,priceStyle:"candles",visibleRange:frame(tape.tf)}));
      try{
        for(const [name,P] of providers)chart.data.registerProvider(name,new P());
        await Promise.race([chart.ready(),new Promise((_,rej)=>setTimeout(()=>rej(new Error("candle feed timeout")),10000))]);
        const r=chart.data.resolve(sym);provider=r&&r.provider?r.provider.charAt(0).toUpperCase()+r.provider.slice(1):"public";
      }catch(e){try{chart.destroy()}catch(_){}chart=null}
    }
    if(!chart)chart=offline();
    tape.chart=chart;
    // Nothing here is live: no last-price tag, no bar-close countdown.
    try{chart.renderer.set({priceLabel:false,countdown:false})}catch(e){}
    footer(d,sym,sourceLabel(d,provider));
    chart.addNativeIndicator("trade-relay-fills");
    // Click → the fill nearest the crosshair's time → that signal's story row.
    // A drag (pan) is not a click: the pointer must land where it went down.
    const near=t=>{if(t==null)return null;let best=null,bd=Infinity;for(const f of d.fills){const dt=Math.abs(Date.parse(f.at)-t);if(dt<bd){bd=dt;best=f}}return bd<=Math.max(span/40,30000,tfMs(tape.tf))?best:null}; // on candles, the whole bar is the marker's target
    const cross=typeof chart.onCrosshairMove==="function"?chart.onCrosshairMove.bind(chart):chart.renderer&&typeof chart.renderer.onCrosshairMove==="function"?chart.renderer.onCrosshairMove.bind(chart.renderer):null;
    if(cross)tape.unsub.push(cross(e=>{tape.lastTime=e.time}));
    const el=$("#tapechart");let downAt=null;
    const down=e=>{downAt=[e.clientX,e.clientY]};
    const up=e=>{if(!downAt)return;const moved=Math.hypot(e.clientX-downAt[0],e.clientY-downAt[1]);downAt=null;if(moved>5)return;const f=near(tape.lastTime);if(f)openStory(f.signalId)};
    el.addEventListener("pointerdown",down);el.addEventListener("pointerup",up);
    tape.unsub.push(()=>{el.removeEventListener("pointerdown",down);el.removeEventListener("pointerup",up)});
  }catch(e){$("#tapefoot").innerHTML='<span class="err">'+esc(e.message||e)+"</span>"}
  finally{tape.busy=false}
}
async function openStory(id){
  if(!document.getElementById("row-"+id)){
    try{const s=await api("/api/signals/"+id);pinned.set(id,s);renderRows()}catch(e){return}
  }
  const el=document.getElementById("story-"+id);if(!el)return;
  el.classList.add("open");open.add(id);
  const r=document.getElementById("row-"+id);if(r)r.scrollIntoView({behavior:"smooth",block:"center"});
}
$("#tapetoggle").onclick=async()=>{
  tape.open=!tape.open;
  $("#tapetoggle").textContent=tape.open?"Hide tape":"Show tape";
  $("#tape").classList.toggle("open",tape.open);$("#tapecontrols").classList.toggle("open",tape.open);
  if(tape.open){tape.key="";refreshTape()}else destroyChart();
};
$("#tsym").onchange=()=>{$("#tfrom").value="";$("#tto").value="";defaultRange();tape.key="";refreshTape()};
$("#tacct").onchange=$("#tfrom").onchange=$("#tto").onchange=()=>{tape.key="";refreshTape()};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>{if(tape.chart)tape.chart.setTheme(velaTheme())});

tick();setInterval(tick,4000);
</script>
</body>
</html>`;
