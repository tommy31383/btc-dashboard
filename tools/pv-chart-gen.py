#!/usr/bin/env python3
"""
pv-chart-gen.py — đọc pv-annotated.json → sinh fragment HTML (assets/pv-chart.html) mô phỏng
chart price-action + volume: nến + volume (tô spike) + S/R + pivot HH/HL/LH/LL + BOS/CHoCH.
Fragment không có doctype/html/head/body → dùng được cho show_widget và mở browser.
"""
import json, os

HERE = os.path.dirname(__file__)
data = json.load(open(os.path.join(HERE, "pv-annotated.json")))
# compact bars
cb = [{"o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"],
       "p": b.get("pivot"), "s": b.get("struct"), "vs": b["vol"]["spike"], "vc": b["vol"]["climax"]}
      for b in data["bars"]]
ev = [{"i": e["i"], "ty": e["type"], "px": e["px"], "vcf": e.get("volConfirm", False)} for e in data["events"]]
lv = [{"px": L["px"], "t": L["touches"]} for L in data["levels"][:6]]
payload = json.dumps({"tf": data["tf"], "bars": cb, "events": ev, "levels": lv}, separators=(",", ":"))

html = '''<h2 class="sr-only">Chart mô phỏng price-action + volume cho BTC ''' + data["tf"] + ''': nến, volume, swing HH/HL/LH/LL, vùng S/R, và sự kiện BOS/CHoCH — chỉ từ giá và khối lượng.</h2>
<div style="padding:1rem 0;font-family:var(--font-sans)">
  <div id="pvLegend" style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:10px;font-size:12px;color:var(--color-text-secondary)"></div>
  <canvas id="pv" role="img" aria-label="Price-action and volume chart for BTC ''' + data["tf"] + '''" style="width:100%;border:0.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-md)"></canvas>
</div>
<script>
(function(){
  const D = ''' + payload + ''';
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const COL = {
    up: dark?'#5DCAA5':'#1D9E75', dn: dark?'#E24B4A':'#A32D2D',
    wick: dark?'#888780':'#5F5E5A', spike: dark?'#EF9F27':'#BA7517',
    sr: dark?'#85B7EB':'#185FA5', txt: dark?'#D3D1C7':'#444441',
    choch: dark?'#ED93B1':'#993556', bos: dark?'#888780':'#5F5E5A', grid: dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)'
  };
  const cv = document.getElementById('pv');
  const W = 680, H = 420, PX = 56, PT = 14, PB = 16, VH = 96, GAP = 10;
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  cv.width = W*dpr; cv.height = H*dpr; cv.style.height = H+'px';
  const x = cv.getContext('2d'); x.scale(dpr,dpr);
  const bars = D.bars, n = bars.length;
  const priceTop = PT, priceH = H - PT - PB - VH - GAP;
  const volTop = priceTop + priceH + GAP, plotW = W - PX;
  let lo=1e18, hi=-1e18, vmax=0;
  for(const b of bars){ lo=Math.min(lo,b.l); hi=Math.max(hi,b.h); vmax=Math.max(vmax,b.v); }
  const pad=(hi-lo)*0.04; lo-=pad; hi+=pad;
  const cw = plotW/n, bw = Math.max(1.5, cw*0.62);
  const py = p => priceTop + (hi-p)/(hi-lo)*priceH;
  const cx = i => i*cw + cw/2;
  // grid + price axis labels
  x.strokeStyle=COL.grid; x.fillStyle=COL.txt; x.font='11px '+getComputedStyle(document.body).fontFamily; x.textBaseline='middle';
  for(let k=0;k<=4;k++){ const p=lo+(hi-lo)*k/4, yy=py(p); x.beginPath(); x.moveTo(0,yy); x.lineTo(plotW,yy); x.stroke(); x.fillText(Math.round(p).toLocaleString(), plotW+6, yy); }
  // S/R lines
  for(const L of D.levels){ if(L.px<lo||L.px>hi) continue; const yy=py(L.px); x.save(); x.strokeStyle=COL.sr; x.setLineDash([4,4]); x.globalAlpha=0.7; x.beginPath(); x.moveTo(0,yy); x.lineTo(plotW,yy); x.stroke(); x.restore(); x.fillStyle=COL.sr; x.fillText(L.t+'×', 2, yy-7); }
  // candles + volume
  for(let i=0;i<n;i++){ const b=bars[i], up=b.c>=b.o, cxi=cx(i);
    x.strokeStyle = b.vs?COL.spike:COL.wick; x.beginPath(); x.moveTo(cxi,py(b.h)); x.lineTo(cxi,py(b.l)); x.stroke();
    x.fillStyle = up?COL.up:COL.dn; const yo=py(b.o), yc=py(b.c); x.fillRect(cxi-bw/2, Math.min(yo,yc), bw, Math.max(1,Math.abs(yc-yo)));
    const vh=(b.v/vmax)*VH, vy=volTop+VH-vh; x.fillStyle = b.vc?COL.spike:(b.vs?COL.spike:(up?COL.up:COL.dn)); x.globalAlpha=b.vs?0.9:0.45; x.fillRect(cxi-bw/2, vy, bw, vh); x.globalAlpha=1;
    if(b.p){ x.fillStyle=COL.txt; x.font='9px sans-serif'; if(b.p==='H'){ x.fillText(b.s||'H', cxi-7, py(b.h)-10);} else { x.fillText(b.s||'L', cxi-7, py(b.l)+12);} }
  }
  // event markers (CHoCH/BOS)
  x.font='10px sans-serif';
  for(const e of D.events){ const cxi=cx(e.i), c=e.ty.indexOf('CHoCH')>=0; x.save(); x.strokeStyle=c?COL.choch:COL.bos; x.setLineDash([2,3]); x.globalAlpha=0.8; x.beginPath(); x.moveTo(cxi,priceTop); x.lineTo(cxi,volTop+VH); x.stroke(); x.restore(); x.fillStyle=c?COL.choch:COL.bos; x.fillText(e.ty+(e.vcf?'✓':''), Math.min(cxi+2,plotW-46), priceTop+12); }
  // legend
  const lg=[['nến tăng',COL.up],['nến giảm',COL.dn],['volume spike',COL.spike],['S/R (số touch)',COL.sr],['CHoCH',COL.choch],['BOS',COL.bos]];
  document.getElementById('pvLegend').innerHTML = lg.map(([t,c])=>`<span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:2px;background:${c}"></span>${t}</span>`).join('') + ` <span style="margin-left:auto">BTC ${D.tf} · ${n} nến · ✓=volume confirm</span>`;
})();
</script>'''

out = os.path.join(HERE, "..", "assets", "pv-chart.html")
open(out, "w", encoding="utf-8").write(html)
print("wrote", out, len(html), "bytes")
