import { app } from "../../scripts/app.js";

const EXT = "NovaAudio.TrackInspectorReportViewer";
(function css(){const id="nova-track-inspector-css";if(document.getElementById(id))return;const l=document.createElement("link");l.id=id;l.rel="stylesheet";l.href=new URL("./nova_track_inspector.css",import.meta.url).href;document.head.appendChild(l)})();
const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const num=(v,d=1)=>Number.isFinite(Number(v))?Number(v).toFixed(d):"—";
const get=(o,p,f)=>{let c=o;for(const k of p.split(".")){if(c==null||!(k in c))return f;c=c[k]}return c};
function cls(s){s=String(s??"").toUpperCase();if(["EXCELLENT","PASS","A+","A","GOOD"].includes(s))return"good";if(["REVIEW","B+","B","B-","WARNING"].includes(s))return"warn";if(["POOR","REJECT","CRITICAL","F","D"].includes(s))return"bad";return"info"}
function badge(s){return `<span class="nti-badge ${cls(s)}">${esc(s)}</span>`}
function fmtTime(sec){sec=Math.max(0,Number(sec)||0);const m=Math.floor(sec/60),s=Math.floor(sec-m*60);return `${m}:${String(s).padStart(2,"0")}`}
function hero(p){const s=p.summary||{};return `<div class="nti-hero"><div><div class="nti-kicker">NOVA TRACK INSPECTOR</div><div class="nti-title">Whole-Track Integrity Analysis</div><div class="nti-sub">v${esc(p.inspector_version||"")} · ${num(get(p,"identity.duration_seconds"),1)}s · ${num(get(p,"identity.sample_rate_hz"),0)} Hz</div></div><div class="nti-score">${badge(s.verdict)}<div class="nti-grade">${esc(s.grade||"—")}</div><div class="nti-scorev">${num(s.track_integrity_score,1)} / 100</div></div></div>`}
function severityColor(v){v=Math.max(0,Math.min(100,Number(v)||0));return `hsl(${Math.round(v*1.2)} 72% 52%)`}
function metricCard(label,value,quality){const q=Math.max(0,Math.min(100,Number(quality)||0)),c=severityColor(q);return `<div class="nti-metric-card" style="--mc:${c};--mp:${q}%"><span>${esc(label)}</span><b>${esc(value)}</b></div>`}
function waveform(p){const env=get(p,"timeline.waveform_envelope",[])||[],ms=p.markers||[],dur=Number(get(p,"identity.duration_seconds",1))||1;if(!env.length)return `<div class="nti-empty">No waveform envelope.</div>`;const uid="nti-wave-"+Math.random().toString(36).slice(2),W=1200,H=190,mid=H/2,amp=H*.42;const top=env.map((e,i)=>`${i/Math.max(1,env.length-1)*W},${mid-(Number(e.max)||0)*amp}`).join(" "),bot=[...env].reverse().map((e,ri)=>{const i=env.length-1-ri;return `${i/Math.max(1,env.length-1)*W},${mid-(Number(e.min)||0)*amp}`}).join(" ");const shades=ms.map((m,i)=>{const x=Math.max(0,Math.min(W,Number(m.start_seconds)/dur*W)),x2=Math.max(x+2,Math.min(W,Number(m.end_seconds)/dur*W));return `<rect data-marker="${i}" x="${x}" y="0" width="${x2-x}" height="${H}" class="nti-marker-band ${String(m.severity||"").toLowerCase()}"><title>${esc(m.type)} · ${fmtTime(m.start_seconds)} · ${esc(m.message)}</title></rect>`}).join(""),lines=ms.map((m,i)=>{const x=Math.max(0,Math.min(W,Number(m.start_seconds)/dur*W));return `<line data-marker="${i}" x1="${x}" x2="${x}" y1="0" y2="${H}" class="nti-marker-line ${String(m.severity||"").toLowerCase()}"/>`}).join("");const html=`<div class="nti-wave-block" id="${uid}"><div class="nti-wave-legend"><b>Waveform + analysis-window markers</b><span>Wheel zoom · Drag pan · Double-click reset</span></div><svg class="nti-wave" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${shades}<polygon points="${top} ${bot}" class="nti-wave-fill"/><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="nti-zero"/>${lines}</svg><div class="nti-axis"><span class="a0">0:00</span><span class="a1">${fmtTime(dur*.25)}</span><span class="a2">${fmtTime(dur*.5)}</span><span class="a3">${fmtTime(dur*.75)}</span><span class="a4">${fmtTime(dur)}</span></div><div class="nti-range-row"><span>Visible range</span><input class="nti-range" type="range" min="0" max="1000" value="0"><span class="nti-range-label">0:00 – ${fmtTime(dur)}</span></div><div class="nti-wave-disclaimer"><b>Marker overlay:</b> colours represent issue severity and analysed time windows. Boundaries follow the analysis window/hop and are not sample-accurate event boundaries; colour intensity does not represent waveform amplitude.</div></div>`;requestAnimationFrame(()=>wireWave(uid,dur,ms));return html}
function wireWave(uid,dur,markers){const root=document.getElementById(uid);if(!root)return;const svg=root.querySelector("svg"),range=root.querySelector(".nti-range"),lab=root.querySelector(".nti-range-label");let z=1,center=.5,drag=false,lastX=0;const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));function apply(){const span=1/z,start=clamp(center-span/2,0,1-span);center=start+span/2;svg.setAttribute("viewBox",`${start*1200} 0 ${span*1200} 190`);const st=start*dur,en=(start+span)*dur;lab.textContent=`${fmtTime(st)} – ${fmtTime(en)}`;range.disabled=z<=1;range.value=String(Math.round(start/Math.max(1e-9,1-span)*1000)||0);[st,st+(en-st)*.25,st+(en-st)*.5,st+(en-st)*.75,en].forEach((v,i)=>root.querySelector(".a"+i).textContent=fmtTime(v))}svg.addEventListener("wheel",e=>{e.preventDefault();const r=svg.getBoundingClientRect(),pos=clamp((e.clientX-r.left)/r.width,0,1),old=1/z,anchor=center-old/2+pos*old;z=clamp(z*(e.deltaY<0?1.35:1/1.35),1,32);const nw=1/z;center=anchor+(0.5-pos)*nw;apply()},{passive:false});svg.addEventListener("mousedown",e=>{drag=true;lastX=e.clientX;svg.classList.add("dragging")});window.addEventListener("mouseup",()=>{drag=false;svg.classList.remove("dragging")});window.addEventListener("mousemove",e=>{if(!drag)return;const r=svg.getBoundingClientRect();center-=((e.clientX-lastX)/r.width)/z;lastX=e.clientX;apply()});svg.addEventListener("dblclick",()=>{z=1;center=.5;apply()});range.addEventListener("input",()=>{if(z<=1)return;const span=1/z,start=Number(range.value)/1000*(1-span);center=start+span/2;apply()});root.focusMarker=i=>{const m=markers[i];if(!m)return;const a=Number(m.start_seconds)||0,b=Math.max(a+.5,Number(m.end_seconds)||a+.5),span=clamp((b-a)/dur*3,.025,.25);z=clamp(1/span,1,32);center=((a+b)/2)/dur;root.querySelectorAll("[data-marker]").forEach(x=>x.classList.toggle("selected",Number(x.dataset.marker)===i));apply()};apply()}
function spark(p,key,label,minv=null,maxv=null){const pts=get(p,"timeline.points",[])||[];if(!pts.length)return"";const vals=pts.map(x=>Number(x[key])).filter(Number.isFinite);if(!vals.length)return"";const lo=minv??Math.min(...vals),hi=maxv??Math.max(...vals),span=(hi-lo)||1,W=1000,H=100;const poly=pts.map((x,i)=>{const v=Number(x[key]);const y=H-(Math.max(lo,Math.min(hi,v))-lo)/span*H;return `${i/Math.max(1,pts.length-1)*W},${y}`}).join(" ");return `<div class="nti-spark-card"><div class="nti-spark-head"><b>${esc(label)}</b><span>${num(lo,1)} → ${num(hi,1)}</span></div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${poly}" class="nti-spark-line"/></svg></div>`}
function subscores(p){const s=p.subscores||{},labels={content_coherence:"Content Coherence",spectral_consistency:"Spectral Consistency",dynamic_integrity:"Dynamic Integrity",stereo_integrity:"Stereo Integrity",artifact_safety:"Artifact Safety",level_continuity:"Level Continuity",structural_integrity:"Structural Integrity",technical_integrity:"Technical Integrity"};return `<div class="nti-subgrid">${Object.entries(labels).map(([k,l])=>{const v=Math.max(0,Math.min(100,Number(s[k]??0))),c=severityColor(v);return `<div class="nti-subcard"><div><span>${esc(l)}</span><b style="color:${c}">${num(v,1)}</b></div><div class="nti-bar"><i style="width:${v}%;background:linear-gradient(90deg,hsl(0 72% 52%),hsl(55 78% 52%),${c})"></i></div></div>`}).join("")}</div>`}
function markerList(p,limit=20){const ms=p.markers||[];if(!ms.length)return `<div class="nti-empty">No anomaly markers detected.</div>`;const uid="nti-markers-"+Math.random().toString(36).slice(2),html=`<div class="nti-marker-panel scroll-mode" id="${uid}"><div class="nti-marker-toolbar"><span>${ms.length} events</span><button type="button" class="nti-marker-mode">↕ Expand</button></div><div class="nti-markers">${ms.slice(0,limit).map((m,i)=>`<div class="nti-marker-row" data-index="${i}" title="Click to focus this event on the waveform"><div class="nti-time">${fmtTime(m.start_seconds)}${Number(m.end_seconds)>Number(m.start_seconds)?`–${fmtTime(m.end_seconds)}`:""}</div><div>${badge(m.severity)} <b>${esc(m.type)}</b><div class="nti-msg">${esc(m.message)}</div></div><div class="nti-mscore">${num(m.score,0)}</div></div>`).join("")}</div></div>`;requestAnimationFrame(()=>wireMarkers(uid));return html}
function wireMarkers(uid){const p=document.getElementById(uid);if(!p)return;const btn=p.querySelector(".nti-marker-mode");btn.onclick=()=>{p.classList.toggle("scroll-mode");btn.textContent=p.classList.contains("scroll-mode")?"↕ Expand":"▤ Scroll"};p.querySelectorAll(".nti-marker-row").forEach(r=>r.onclick=()=>{p.querySelectorAll(".nti-marker-row").forEach(x=>x.classList.toggle("selected",x===r));const w=p.closest(".nti-root")?.querySelector(".nti-wave-block");w?.focusMarker?.(Number(r.dataset.index));w?.scrollIntoView?.({behavior:"smooth",block:"nearest"})})}
const section=(t,b)=>`<section class="nti-section"><h3>${esc(t)}</h3>${b}</section>`;
function inspectorView(p){const s=p.summary||{},tm=p.track_metrics||{},coh=Number(tm.coherence_score_median||0),local=Number(get(p,"subscores.content_coherence",0)),noise=Number(s.noise_likelihood_percent||0),crit=Number(s.critical_markers||0),warn=Number(s.warning_markers||0),review=Number(s.review_markers||0),concernLoad=crit*18+warn*8+review*3,markerQuality=Math.max(0,100-concernLoad);return hero(p)+`<div class="nti-metrics">${metricCard("Noise Risk",`${num(noise,1)}%`,100-noise)}${metricCard("Markers",num(s.marker_count,0),markerQuality)}${metricCard("Critical",num(crit,0),Math.max(0,100-crit*18))}${metricCard("Sections",num(s.section_count,0),75)}${metricCard("Track RMS",`${num(tm.rms_dbfs,2)} dBFS`,70)}${metricCard("Crest",`${num(tm.crest_db,2)} dB`,Math.max(0,100-Math.abs(Number(tm.crest_db||0)-12)*5))}${metricCard("L/R Corr",num(tm.lr_correlation,3),Math.max(0,Math.min(100,(Number(tm.lr_correlation||0)+.2)/1.2*100)))}${metricCard("Global Coherence",num(coh,1),coh)}</div><div class="nti-coherence-note"><b>Global Coherence ${num(coh,1)}</b> is the median local-stability measure. <b>Local Integrity ${num(local,1)}</b> includes only penalized coherence faults; stable verse/chorus/instrumentation transitions are retained as visual observations rather than treated as defects. Marker colour quality is based on concerns, not observation count.</div>`+section("Waveform + Issue Markers",waveform(p))+section("Integrity Scores",subscores(p))+section("Priority Markers",markerList(p,9999))+`<div class="nti-note">${esc(get(p,"interpretation.note",""))}</div>`}
function timelineView(p){return hero(p)+section("Waveform + Issue Markers",waveform(p))+`<div class="nti-sparks">${spark(p,"rms_dbfs","Window RMS (dBFS)")}${spark(p,"crest_db","Crest Factor (dB)")}${spark(p,"lr_correlation","Stereo Correlation",-1,1)}${spark(p,"bass_percent","Bass %",0,100)}${spark(p,"mid_percent","Mid %",0,100)}${spark(p,"presence_percent","Presence %",0,100)}${spark(p,"hf_percent","HF %",0,100)}${spark(p,"noise_likelihood_percent","Noise Likelihood %",0,100)}${spark(p,"coherence_score","Coherence Score",0,100)}</div>`}
function render(p,m){if(!p||typeof p!=="object")return `<div class="nti-empty">No inspector report.</div>`;if(m==="Timeline")return timelineView(p);if(m==="Markers")return hero(p)+section("All Markers",markerList(p,9999));if(m==="Technical")return `<pre class="nti-json">${esc(JSON.stringify(p,null,2))}</pre>`;return inspectorView(p)}
function root(){const d=document.createElement("div");d.className="nti-root";d.innerHTML=`<div class="nti-empty">Run Nova Track Inspector to render the report.</div>`;return d}
function widgetValue(node,name,fallback){
  const w=node?.widgets?.find(x=>x?.name===name);
  return w?.value ?? fallback;
}
function renderCachedInspector(node){
  const el=node?.__ntiRoot;
  if(!el)return;
  const b=node.__ntiLastBlock;
  if(!b?.payload){
    el.innerHTML=`<div class="nti-empty"><b>No cached Inspector report yet.</b><br>Run this report node once. After that, view/theme/font changes are applied locally. <b>Apply View</b> is available as an explicit refresh and never re-runs the flow.</div>`;
    return;
  }
  const mode=widgetValue(node,"view_mode",b.view_mode||"Inspector");
  const theme=widgetValue(node,"theme",b.theme||"Nova Dark");
  const scale=Number(widgetValue(node,"font_scale",b.font_scale||1))||1;
  el.dataset.theme=theme;
  el.style.setProperty("--nti-scale",String(scale));
  el.innerHTML=b.error?`<div class="nti-error">${esc(b.error)}</div>`:render(b.payload,mode);
  node.__ntiRenderedView={view_mode:mode,theme,font_scale:scale};
}
app.registerExtension({
  name:EXT,
  beforeRegisterNodeDef(nodeType,nodeData){
    if(nodeData?.name!=="NovaTrackInspectorReportViewer")return;
    const created=nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated=function(){
      const r=created?.apply(this,arguments);
      this.size=this.size||[760,720];
      if(this.size[0]<680)this.size[0]=760;
      if(this.size[1]<520)this.size[1]=720;

      // Front-end-only view loader. It never queues ComfyUI and therefore never
      // re-runs generation, mastering, saving, transcription or inspection.
      const load=this.addWidget?.("button","Apply View",null,()=>renderCachedInspector(this),{serialize:false});
      if(load){
        load.name="Apply View";
        load.label="Apply View";
        load.tooltip="Apply the selected view/theme/font scale from cached report data. Frontend only; does not execute the workflow.";
        this.__ntiApplyViewButton=load;
        // Nova Report Viewer standard: action button sits above view controls.
        const li=this.widgets?.indexOf(load) ?? -1;
        const vi=this.widgets?.findIndex?.(w=>w?.name==="view_mode") ?? -1;
        if(li>=0 && vi>=0 && li!==vi){
          this.widgets.splice(li,1);
          const target=this.widgets.findIndex(w=>w?.name==="view_mode");
          this.widgets.splice(Math.max(0,target),0,load);
        }
      }

      const el=root();
      this.__ntiRoot=el;
      const w=this.addDOMWidget?.("nova_track_inspector_report","NTI_REPORT",el,{serialize:false,hideOnZoom:false,getMinHeight:()=>360});
      if(w){
        this.__ntiWidget=w;
        this.__ntiHeight=440;
        el.style.width="100%";
        el.style.height="440px";
        el.style.overflow="auto";
        el.style.boxSizing="border-box";
        w.computeSize=width=>[Math.max(360,width),Math.max(260,this.__ntiHeight||440)];
      }
      // Nova Report Viewer standard: changing view mode immediately redraws from
      // cached data. Theme/font scale also refresh locally; Apply View remains an
      // optional explicit refresh. No callback queues ComfyUI.
      for(const name of ["view_mode","theme","font_scale"]){
        const ctrl=this.widgets?.find?.(x=>x?.name===name);
        if(ctrl && !ctrl.__novaLocalViewWrapped){
          const prior=ctrl.callback;
          ctrl.callback=(value,...args)=>{
            const out=prior?.call(ctrl,value,...args);
            requestAnimationFrame(()=>renderCachedInspector(this));
            return out;
          };
          ctrl.__novaLocalViewWrapped=true;
        }
      }

      requestAnimationFrame(()=>this.onResize?.(this.size));
      return r;
    };

    const resize=nodeType.prototype.onResize;
    nodeType.prototype.onResize=function(size){
      const r=resize?.apply(this,arguments),el=this.__ntiRoot,w=this.__ntiWidget;
      if(!el||!w||!size)return r;
      const top=Number.isFinite(Number(w.y))?Number(w.y):185,
            h=Math.max(260,Number(size[1])-top-18);
      this.__ntiHeight=h;
      el.style.height=`${h}px`;
      if(Array.isArray(w.size))w.size[1]=h;
      return r;
    };

    const configured=nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure=function(info){
      const r=configured?.apply(this,arguments);
      // ComfyUI restores combo values during workflow configuration. Rendering is
      // deferred so saved widget values win over schema defaults when possible.
      requestAnimationFrame(()=>{
        if(this.__ntiLastBlock)renderCachedInspector(this);
      });
      return r;
    };

    const executed=nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted=function(message){
      const r=executed?.apply(this,arguments),el=this.__ntiRoot;
      if(!el)return r;
      try{
        const raw=message?.nova_track_inspector_viewer,
              b=Array.isArray(raw)?raw[0]:raw;
        if(!b){
          el.innerHTML=`<div class="nti-empty">No inspector payload returned.</div>`;
          return r;
        }
        // Cache the data, but render with the CURRENT front-end controls. This
        // prevents a stale backend view_mode/theme/font_scale from visually
        // disagreeing with the widgets after workflow/page restore.
        this.__ntiLastBlock=b;
        renderCachedInspector(this);
      }catch(e){
        console.error("[NovaTrackInspectorViewer]",e);
        el.innerHTML=`<div class="nti-error">${esc(e?.message||e)}</div>`;
      }
      return r;
    };
  }
});
