#!/usr/bin/env python3
"""HTML tương tác (Plotly) — điểm VÀO/ĐÓNG lệnh phương pháp general trên BTC. Zoom/pan/hover.
   Đọc /tmp/general_trades.json + BTC (agg 4h). Output: assets/general_trades.html.
"""
import json, datetime
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
b = {}
for c in raw:
    k = c["time"] // (4 * 3600_000)
    if k not in b: b[k] = {"t": k * 4 * 3600_000, "c": c["close"]}
    else: b[k]["c"] = c["close"]
H = [b[k] for k in sorted(b)]
def iso(ms): return datetime.datetime.utcfromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")
price_x = [iso(x["t"]) for x in H]; price_y = [round(x["c"], 1) for x in H]
trades = json.load(open("/tmp/general_trades.json"))

# build traces
lx, ly, ltext = [], [], []   # LONG entry
sx, sy, stext = [], [], []   # SHORT entry
wx, wy, wtext = [], [], []   # exit win
zx, zy, ztext = [], [], []   # exit loss
linw_x, linw_y, linl_x, linl_y = [], [], [], []
for tr in trades:
    et, xt = iso(tr["ets"]), iso(tr["xts"]); ep, xp = round(tr["epx"], 1), round(tr["xpx"], 1)
    win = tr["ret"] > 0; r = tr["ret"] * 100
    if tr["side"] == "LONG":
        lx.append(et); ly.append(ep); ltext.append(f"VÀO LONG<br>${ep}<br>{et}")
    else:
        sx.append(et); sy.append(ep); stext.append(f"VÀO SHORT<br>${ep}<br>{et}")
    if win:
        wx.append(xt); wy.append(xp); wtext.append(f"ĐÓNG {tr['reason']} (LÃI)<br>${xp}<br>{r:+.2f}%<br>{xt}")
        linw_x += [et, xt, None]; linw_y += [ep, xp, None]
    else:
        zx.append(xt); zy.append(xp); ztext.append(f"ĐÓNG {tr['reason']} (LỖ)<br>${xp}<br>{r:+.2f}%<br>{xt}")
        linl_x += [et, xt, None]; linl_y += [ep, xp, None]

def tr_(**k): return k
DATA = [
    tr_(x=price_x, y=price_y, type="scattergl", mode="lines", name="BTC", line=dict(color="#94a3b8", width=1), hoverinfo="x+y"),
    tr_(x=linw_x, y=linw_y, type="scattergl", mode="lines", name="trade lãi", line=dict(color="#16a34a", width=1), opacity=0.35, hoverinfo="skip", showlegend=True),
    tr_(x=linl_x, y=linl_y, type="scattergl", mode="lines", name="trade lỗ", line=dict(color="#dc2626", width=1), opacity=0.35, hoverinfo="skip", showlegend=True),
    tr_(x=lx, y=ly, type="scattergl", mode="markers", name="VÀO LONG ▲", marker=dict(symbol="triangle-up", size=9, color="#16a34a", line=dict(color="#000", width=0.5)), text=ltext, hoverinfo="text"),
    tr_(x=sx, y=sy, type="scattergl", mode="markers", name="VÀO SHORT ▼", marker=dict(symbol="triangle-down", size=9, color="#ea580c", line=dict(color="#000", width=0.5)), text=stext, hoverinfo="text"),
    tr_(x=wx, y=wy, type="scattergl", mode="markers", name="ĐÓNG lãi ●", marker=dict(symbol="circle", size=6, color="#16a34a", line=dict(color="#000", width=0.4)), text=wtext, hoverinfo="text"),
    tr_(x=zx, y=zy, type="scattergl", mode="markers", name="ĐÓNG lỗ ●", marker=dict(symbol="circle", size=6, color="#dc2626", line=dict(color="#000", width=0.4)), text=ztext, hoverinfo="text"),
]
LAYOUT = dict(
    title=dict(text=f"PHƯƠNG PHÁP GENERAL — điểm VÀO/ĐÓNG lệnh trên BTC ({len(trades)} lệnh 7y) · multi-TF + cut2.2 + reverse + TP4", font=dict(size=15)),
    xaxis=dict(type="date", rangeslider=dict(visible=True), rangeselector=dict(buttons=[
        dict(count=1, label="1th", step="month", stepmode="backward"),
        dict(count=3, label="3th", step="month", stepmode="backward"),
        dict(count=6, label="6th", step="month", stepmode="backward"),
        dict(count=1, label="1năm", step="year", stepmode="backward"),
        dict(step="all", label="Tất cả")])),
    yaxis=dict(title="BTC $", autorange=True, fixedrange=False),
    hovermode="closest", dragmode="zoom", height=720, legend=dict(orientation="h", y=1.06),
    margin=dict(t=90))
html = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<title>General method — vào/đóng lệnh BTC</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>body{{margin:0;font-family:system-ui}} #c{{width:100vw;height:100vh}}
.hint{{position:fixed;top:6px;right:10px;font-size:12px;color:#555;background:#fff8;padding:3px 8px;border-radius:6px;z-index:9}}</style></head>
<body><div class="hint">Cuộn chuột = zoom · Kéo = chọn vùng zoom · Double-click = reset · Hover = chi tiết lệnh</div>
<div id="c"></div>
<script>
Plotly.newPlot('c', {json.dumps(DATA)}, {json.dumps(LAYOUT)}, {{scrollZoom:true, responsive:true, displaylogo:false}});
</script></body></html>"""
OUT = "/Users/lap16116/BTC_PC/btc-dashboard/assets/general_trades.html"
open(OUT, "w").write(html)
print(f"SAVED {OUT}  ({len(html)//1024} KB)")
