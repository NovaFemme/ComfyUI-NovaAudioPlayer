from __future__ import annotations

import json, math, re
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

try:
    from ..nova_categories import DELIVERY
except ImportError:
    from nova_categories import DELIVERY

VERSION = "0.2.0"

THEMES = {
    "Nova Dark": dict(bg="#080c11", panel="#101720", panel2="#18212c", border="#293746", text="#edf5fb", muted="#8fa0b1", accent="#54bfff", good="#52d486", warn="#f3c45b", bad="#ff6674", info="#74a8ff"),
    "Studio Slate": dict(bg="#121518", panel="#191e23", panel2="#20262d", border="#363e46", text="#edf5fb", muted="#9ba7b1", accent="#61bfff", good="#52d486", warn="#f3c45b", bad="#ff6674", info="#74a8ff"),
    "High Contrast": dict(bg="#020507", panel="#080d12", panel2="#0d141b", border="#3a4652", text="#ffffff", muted="#aeb8c2", accent="#63c8ff", good="#63e09a", warn="#ffd166", bad="#ff6674", info="#80b4ff"),
}


def _safe_name(v: str, fallback="report"):
    v = re.sub(r"[^\w\-. ]+", "_", (v or "").strip(), flags=re.UNICODE)
    v = re.sub(r"\s+", "_", v).strip("._-")
    return v[:140] or fallback


def _parse_json(v: Any) -> Dict[str, Any]:
    if isinstance(v, dict): return v
    if isinstance(v, str):
        o = json.loads(v.strip())
        if isinstance(o, dict): return o
    raise ValueError("report_json must contain a JSON object")


def _get(o, path, default=None):
    c=o
    for k in path.split('.'):
        if not isinstance(c, dict) or k not in c: return default
        c=c[k]
    return c


def _num(v,d=1,suffix=""):
    try:
        f=float(v)
        return f"{f:.{d}f}{suffix}" if math.isfinite(f) else "—"
    except: return "—"


def _font(size,bold=False):
    paths = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"] if bold else ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf","/usr/share/fonts/TTF/DejaVuSans.ttf"]
    for p in paths:
        if Path(p).exists(): return ImageFont.truetype(p,size)
    return ImageFont.load_default()


def _rr(d,b,r,fill,outline=None,w=1): d.rounded_rectangle(b,radius=r,fill=fill,outline=outline,width=w)
def _txt(d,xy,t,f,c,anchor=None): d.text(xy,str(t),font=f,fill=c,anchor=anchor)

def _wrap(d,text,font,maxw):
    out=[]; cur=""
    for word in str(text or "").split():
        test=(cur+" "+word).strip()
        if not cur or d.textbbox((0,0),test,font=font)[2] <= maxw: cur=test
        else: out.append(cur); cur=word
    if cur: out.append(cur)
    return out or [""]


def _sev(theme,s):
    s=str(s or "").upper()
    if s in {"EXCELLENT","GOOD","PASS","A+","A","TARGET_REACHED","PREFERRED"}: return theme["good"]
    if s in {"A-","B+","B","B-","REVIEW","WARNING","CONDITIONAL_PASS"}: return theme["warn"]
    if s in {"REJECT","POOR","CRITICAL","F","D"}: return theme["bad"]
    return theme["info"]


def _canvas(name):
    return {"Portrait 1200x1600":(1200,1600),"Portrait HD 1440x1920":(1440,1920),"Tall Portrait 1440x2160":(1440,2160)}.get(name,(1200,1600))


def _base(W,H,theme,ref):
    img=Image.new("RGB",(W,H),theme["bg"]); d=ImageDraw.Draw(img)
    _txt(d,(24,16),"NOVA AUDIO SUITE",_font(11,True),theme["accent"])
    _txt(d,(W-24,16),f"Reference: {ref}",_font(11),theme["muted"],anchor="ra")
    return img,d


def _header(d,W,y,kicker,title,subtitle,score,grade,status,theme):
    _rr(d,(24,y,W-24,y+106),12,theme["panel"],theme["border"])
    _txt(d,(42,y+13),kicker,_font(11,True),theme["accent"])
    _txt(d,(42,y+37),title,_font(24,True),theme["text"])
    _txt(d,(42,y+73),subtitle,_font(11),theme["muted"])
    _txt(d,(W-42,y+16),status or "",_font(10,True),_sev(theme,status or grade),anchor="ra")
    _txt(d,(W-42,y+36),grade or "—",_font(29,True),theme["text"],anchor="ra")
    _txt(d,(W-42,y+74),f"{_num(score,1)} / 100",_font(11),theme["muted"],anchor="ra")
    return y+116


def _cards(d,W,y,cards,theme,cols=4):
    gap=10; cw=(W-48-gap*(cols-1))/cols; ch=72
    for i,(label,value,color) in enumerate(cards):
        r,c=divmod(i,cols); x=24+c*(cw+gap); yy=y+r*(ch+gap)
        _rr(d,(x,yy,x+cw,yy+ch),9,theme["panel2"],theme["border"])
        _txt(d,(x+10,yy+10),label.upper(),_font(9),theme["muted"])
        _txt(d,(x+10,yy+33),value,_font(17,True),color or theme["text"])
    return y+math.ceil(len(cards)/cols)*(ch+gap)


def _section(d,W,y,title,theme):
    _txt(d,(28,y),title.upper(),_font(10,True),theme["text"])
    d.line((24,y+20,W-24,y+20),fill=theme["border"],width=1)
    return y+30


def _bar(d,x,y,w,v,theme):
    try: v=max(0,min(100,float(v)))
    except: v=0
    _rr(d,(x,y,x+w,y+7),4,"#070a0d",theme["border"])
    col=theme["good"] if v>=85 else theme["warn"] if v>=65 else theme["bad"]
    if v>0:_rr(d,(x,y,x+max(3,w*v/100),y+7),4,col)


def _wave(d,W,y,report,theme,h=190):
    env=_get(report,"timeline.waveform_envelope",[]) or []; markers=report.get("markers",[]) or []
    dur=float(_get(report,"identity.duration_seconds",1) or 1); x0,x1=30,W-30
    _rr(d,(x0,y,x1,y+h),9,"#070a0d",theme["border"])
    if env:
        mid=y+h/2; amp=h*.40; top=[]; bot=[]
        for i,e in enumerate(env):
            x=x0+(i/max(1,len(env)-1))*(x1-x0)
            top.append((x,mid-float(e.get("max",0))*amp)); bot.append((x,mid-float(e.get("min",0))*amp))
        d.polygon(top+list(reversed(bot)),fill="#244e67"); d.line(top,fill=theme["accent"],width=1); d.line(list(reversed(bot)),fill=theme["accent"],width=1)
        for m in markers[:120]:
            a=max(0,min(dur,float(m.get("start_seconds",0)))); xa=x0+a/dur*(x1-x0)
            col=_sev(theme,m.get("severity")); d.line((xa,y,xa,y+h),fill=col,width=2)
    return y+h+10


def _spark(d,x,y,w,h,points,key,label,theme,lo=None,hi=None):
    _rr(d,(x,y,x+w,y+h),8,theme["panel"],theme["border"]); _txt(d,(x+10,y+8),label,_font(10,True),theme["muted"])
    vals=[]
    for p in points:
        try: vals.append(float(p.get(key,0)))
        except: vals.append(0.0)
    if not vals:return
    lo=min(vals) if lo is None else lo; hi=max(vals) if hi is None else hi
    if hi<=lo: hi=lo+1
    pts=[]; yy0=y+28; hh=h-38
    for i,v in enumerate(vals):
        xx=x+8+i/max(1,len(vals)-1)*(w-16); yy=yy0+hh-(max(lo,min(hi,v))-lo)/(hi-lo)*hh; pts.append((xx,yy))
    if len(pts)>1:d.line(pts,fill=theme["accent"],width=2)


def _render_inspector_overview(r,W,H,t,ref):
    img,d=_base(W,H,t,ref); s=r.get("summary",{}) or {}; tm=r.get("track_metrics",{}) or {}; subs=r.get("subscores",{}) or {}; y=42
    y=_header(d,W,y,"NOVA TRACK INSPECTOR","Whole-Track Integrity Analysis",f"v{r.get('inspector_version','')} · {_num(_get(r,'identity.duration_seconds'),1)}s · {_num(_get(r,'identity.sample_rate_hz'),0)} Hz",s.get("track_integrity_score"),s.get("grade"),s.get("verdict"),t)
    y=_cards(d,W,y,[("Noise Risk",_num(s.get("noise_likelihood_percent"),1,"%"),t["good"]),("Markers",_num(s.get("marker_count"),0),t["text"]),("Critical",_num(s.get("critical_markers"),0),t["bad"] if s.get("critical_markers") else t["good"]),("Sections",_num(s.get("section_count"),0),t["text"]),("Track RMS",_num(tm.get("rms_dbfs"),2," dBFS"),t["text"]),("Crest",_num(tm.get("crest_db"),2," dB"),t["text"]),("L/R Corr",_num(tm.get("lr_correlation"),3),t["text"]),("Global Coherence",_num(tm.get("coherence_score_median"),1),t["good"])],t)
    y=_section(d,W,y,"Waveform + Issue Markers",t); y=_wave(d,W,y,r,t,190); y=_section(d,W,y,"Integrity Scores",t)
    for k,v in list(subs.items())[:8]:
        _txt(d,(32,y+4),k.replace('_',' ').title(),_font(10),t["muted"]); _bar(d,240,y+8,W-345,v,t); _txt(d,(W-32,y+4),_num(v,1),_font(10,True),t["text"],anchor="ra"); y+=25
    y=_section(d,W,y+6,"Priority Markers",t)
    for m in (r.get("markers",[]) or [])[:9]:
        sev=str(m.get("severity","INFO")); _txt(d,(32,y),f"{_num(m.get('start_seconds'),0)}–{_num(m.get('end_seconds'),0)}s",_font(9),t["muted"]); _txt(d,(130,y),sev,_font(9,True),_sev(t,sev)); _txt(d,(210,y),m.get("type",""),_font(9,True),t["text"]); _txt(d,(W-32,y),_num(m.get("score"),0),_font(9,True),t["text"],anchor="ra"); y+=18
        lines=_wrap(d,m.get("message",""),_font(9),W-260)[:1]
        if lines:_txt(d,(210,y),lines[0],_font(9),t["muted"])
        y+=20
        if y>H-60:break
    return img


def _render_inspector_graphs(r,W,H,t,ref):
    img,d=_base(W,H,t,ref); s=r.get("summary",{}) or {}; y=42
    y=_header(d,W,y,"NOVA TRACK INSPECTOR","Whole-Track Integrity Analysis",f"v{r.get('inspector_version','')} · {_num(_get(r,'identity.duration_seconds'),1)}s · {_num(_get(r,'identity.sample_rate_hz'),0)} Hz",s.get("track_integrity_score"),s.get("grade"),s.get("verdict"),t)
    y=_section(d,W,y,"Waveform + Issue Markers",t); y=_wave(d,W,y,r,t,180); pts=_get(r,"timeline.points",[]) or []
    specs=[("rms_dbfs","Window RMS (dBFS)",None,None),("crest_db","Crest Factor (dB)",None,None),("lr_correlation","Stereo Correlation",-1,1),("bass_percent","Bass %",0,100),("mid_percent","Mid %",0,100),("presence_percent","Presence %",0,100),("hf_percent","HF %",0,100),("noise_likelihood_percent","Noise Likelihood %",0,100),("coherence_score","Coherence Score",0,100)]
    gap=10; colw=(W-58)//2; gh=130
    for i,(key,label,lo,hi) in enumerate(specs):
        rr,cc=divmod(i,2); _spark(d,24+cc*(colw+gap),y+rr*(gh+gap),colw,gh,pts,key,label,t,lo,hi)
    return img


def _render_master(r,W,H,t,ref,compare=False):
    img,d=_base(W,H,t,ref); rel=r.get("release",{}) or {}; src=r.get("source",{}) or {}; mas=r.get("mastered",{}) or {}; y=42
    y=_header(d,W,y,"NOVA AUDIO MASTER","Source → Master Comparison" if compare else "Mastering Report",f"v{r.get('master_version','')} · {r.get('mode','')} · {r.get('profile','')}",rel.get("confidence"),rel.get("grade"),rel.get("status"),t)
    if not compare:y=_cards(d,W,y,[("LUFS",_num(mas.get("integrated_lufs"),2),t["text"]),("True Peak",_num(mas.get("true_peak_dbtp"),2," dBTP"),t["text"]),("Crest",_num(mas.get("crest_db"),2," dB"),t["text"]),("L/R Corr",_num(mas.get("lr_correlation"),3),t["text"])],t)
    y=_section(d,W,y,"Core Metrics",t)
    for label,key,suf in [("LUFS","integrated_lufs",""),("True Peak","true_peak_dbtp"," dBTP"),("RMS","rms_dbfs"," dBFS"),("Crest","crest_db"," dB"),("L/R Corr","lr_correlation","")]:
        sv,mv=src.get(key),mas.get(key); _txt(d,(32,y),label,_font(10,True),t["text"]); _txt(d,(260,y),_num(sv,2,suf),_font(10),t["muted"]); _txt(d,(500,y),_num(mv,2,suf),_font(10),t["text"])
        try: dv=float(mv)-float(sv); ds=_num(dv,2,suf)
        except: ds="—"
        _txt(d,(W-32,y),ds,_font(10,True),t["accent"],anchor="ra"); y+=28
    y=_section(d,W,y+6,"Processing Outcome",t)
    for label,path in [("Release Status","release.status"),("Tonal Status","classification.tonal_balance.status"),("Crest Status","classification.crest.status"),("Loudness Status","classification.loudness.status"),("Limiter GR","processing.limiter.max_gain_reduction_db")]:
        val=_get(r,path,"—"); val=_num(val,2) if isinstance(val,(int,float)) else str(val); _txt(d,(32,y),label,_font(10),t["muted"]); _txt(d,(W-32,y),val,_font(10,True),_sev(t,val),anchor="ra"); y+=26
    return img


def _render_lyric(r,W,H,t,ref,score_view=False):
    img,d=_base(W,H,t,ref); score=r.get("score",r.get("word_accuracy",0)); grade=r.get("grade","—"); y=42
    y=_header(d,W,y,"NOVA LYRIC REPORT","Nova Lyric Score" if score_view else "Nova Lyric Report","Reference lyrics vs transcription",score,grade,"",t)
    y=_cards(d,W,y,[("Word Accuracy",_num(r.get("word_accuracy"),1,"%"),t["good"]),("Char Accuracy",_num(r.get("char_accuracy"),1,"%"),t["text"]),("Similarity",_num(r.get("similarity"),1,"%"),t["text"]),("Reference",_num(r.get("reference_words"),0," words"),t["text"]),("Correct",_num(r.get("correct"),0),t["good"]),("Substituted",_num(r.get("substituted"),0),t["warn"]),("Missing",_num(r.get("missing"),0),t["info"]),("Extra",_num(r.get("extra"),0),t["bad"])],t)
    y=_section(d,W,y,"Actual vs. Transcription",t); lines=_wrap(d,r.get("diff",""),_font(9),W-70)[:24]; _rr(d,(24,y,W-24,min(H-30,y+40+len(lines)*16)),9,t["panel"],t["border"])
    for i,line in enumerate(lines):_txt(d,(34,y+12+i*16),line,_font(9),t["muted"])
    return img


def _render_view(r,view,W,H,theme_name,ref):
    t=THEMES.get(theme_name,THEMES["Nova Dark"])
    if view=="Mastering Report": return _render_master(r,W,H,t,ref,False)
    if view=="Source → Master Comparison": return _render_master(r,W,H,t,ref,True)
    if view=="Nova Lyric Report": return _render_lyric(r,W,H,t,ref,False)
    if view=="Nova Lyric Score": return _render_lyric(r,W,H,t,ref,True)
    if view=="Track Inspector Overview": return _render_inspector_overview(r,W,H,t,ref)
    if view=="Track Inspector Graphs": return _render_inspector_graphs(r,W,H,t,ref)
    raise ValueError(f"Unsupported view_type: {view}")


def _tensor(img):
    a=np.asarray(img.convert("RGB")).astype(np.float32)/255.0
    return torch.from_numpy(a).unsqueeze(0)


class NovaReportsImages:
    CATEGORY = DELIVERY
    FUNCTION = "render_report"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE","STRING")
    RETURN_NAMES = ("report_image","saved_path")
    DESCRIPTION = "One node instance renders one Nova report view to one fixed portrait image and saves it separately."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required":{
            "report_json":("STRING",{"forceInput":True}),
            "text_reference":("STRING",{"default":"nova_report","multiline":False}),
            "view_type":(["Mastering Report","Source → Master Comparison","Nova Lyric Report","Nova Lyric Score","Track Inspector Overview","Track Inspector Graphs"],{"default":"Mastering Report"}),
            "theme":(["Nova Dark","Studio Slate","High Contrast"],{"default":"Nova Dark"}),
            "canvas_preset":(["Portrait 1200x1600","Portrait HD 1440x1920","Tall Portrait 1440x2160"],{"default":"Portrait 1200x1600"}),
            "image_format":(["PNG","JPG"],{"default":"PNG"}),
            "output_subfolder":("STRING",{"default":"NovaAudioMasters/ReportImages","multiline":False}),
        }}

    def render_report(self,report_json,text_reference,view_type="Mastering Report",theme="Nova Dark",canvas_preset="Portrait 1200x1600",image_format="PNG",output_subfolder="NovaAudioMasters/ReportImages"):
        r=_parse_json(report_json); W,H=_canvas(canvas_preset); img=_render_view(r,view_type,W,H,theme,text_reference)
        try:
            import folder_paths
            outroot=Path(folder_paths.get_output_directory())
        except Exception:
            outroot=Path.cwd()/"output"
        parts=[p for p in output_subfolder.replace('\\','/').split('/') if p not in ('','.','..')]
        outdir=outroot.joinpath(*[_safe_name(p,"Reports") for p in parts]); outdir.mkdir(parents=True,exist_ok=True)
        ref=_safe_name(text_reference,"nova_report"); suffix=_safe_name(view_type.replace('→','to'),"report"); ext='png' if image_format=='PNG' else 'jpg'; target=outdir/f"{ref}_{suffix}.{ext}"
        if image_format=='JPG': img.save(target,'JPEG',quality=95,optimize=True)
        else: img.save(target,'PNG',optimize=True)
        return (_tensor(img),str(target))


# Please add in every node
NODE_CLASS_MAPPINGS = {"NovaReportsImages": NovaReportsImages,}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaReportsImages": "Nova Reports Images 🖼️",}
