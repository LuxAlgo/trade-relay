/*
  The local dashboard: one self-contained HTML page, no build step, no CDN,
  no external requests. It talks to /api/* with the Bearer token the user
  pastes once (kept in localStorage). Dark, quiet, and honest — the signal
  story chain is the product: received → parsed → every risk decision with
  its reason → the order → the fill.
*/

export const renderDashboard = (version: string): string => `<!doctype html>
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
h1{font-size:18px;font-weight:650;letter-spacing:.2px}
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
@media(prefers-color-scheme:light){:root{--bg:#f5f6f9;--panel:#fff;--panel2:#eef0f5;--line:#dde1ea;--text:#1a2130;--dim:#66708a}}
</style>
</head>
<body>
<header>
  <h1>trade-relay <span>flight recorder</span></h1>
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
let open=new Set(), lastSignals=[];

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
      if(a.mode==="watch"){const eq=(a.accounts||[]).reduce((s,x)=>s+(x.equity||0),0);return card(a.id+" (watch)",a.error?"—":fmt(eq),a.error||a.broker)}
      const pos=(a.positions||[]).length;
      return card(a.id,a.error?"—":fmt(a.equity)+" "+(a.currency||""),(a.error||a.broker+" · "+pos+" position"+(pos===1?"":"s")),a.environment)
    }).join("");
    const q=new URLSearchParams({limit:"60"});
    if($("#fstatus").value)q.set("status",$("#fstatus").value);
    if($("#fendpoint").value)q.set("endpoint",$("#fendpoint").value);
    const sigs=await api("/api/signals?"+q);
    lastSignals=sigs;
    $("#count").textContent=sigs.length+" shown";
    $("#rows").innerHTML=sigs.map(row).join("");
    for(const s of sigs)if(open.has(s.id)){const el=document.getElementById("story-"+s.id);if(el)el.classList.add("open")}
  }catch(e){/* token box already shown on 401 */}
}
function card(k,v,s,env){return '<div class="card"><div class="k">'+esc(k)+(env?'<span class="env '+esc(env)+'">'+esc(env)+"</span>":"")+'</div><div class="v">'+esc(v)+'</div><div class="s">'+esc(s)+"</div></div>"}
function sigLabel(s){if(!s.signal)return "—";const g=s.signal;return (g.action||"?").toUpperCase()+(g.symbol?" "+g.symbol:"")}
function ordLabel(s){const o=s.order;if(!o)return s.orders&&s.orders.length?s.orders.length+" order"+(s.orders.length===1?"":"s"):"—";return o.status+(o.filledAvgPrice?" @ "+fmt(o.filledAvgPrice):"")}
function row(s){
  const t=new Date(s.receivedAt).toLocaleTimeString();
  return '<tr class="row" onclick="toggle(\\''+s.id+'\\')"><td class="mono">'+t+'</td><td>'+esc(s.endpointId)+'</td><td class="mono">'+esc(s.parser||"—")+'</td><td>'+esc(sigLabel(s))+'</td><td><span class="chip '+s.status+'">'+s.status+'</span></td><td class="mono">'+esc(ordLabel(s))+'</td><td class="mono">'+(s.latencyMs??"—")+'</td></tr>'
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
tick();setInterval(tick,4000);
</script>
</body>
</html>`;
