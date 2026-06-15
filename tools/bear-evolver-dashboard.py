#!/usr/bin/env python3
"""bear-evolver-dashboard.py — render champions.json → HTML để xem. Mở: python3 tools/bear-evolver-dashboard.py"""
import json,os,html,datetime as dt,subprocess
HERE=os.path.dirname(os.path.abspath(__file__))
d=json.load(open(os.path.join(HERE,"bear-evolver-champions.json")))
rows=""
for i,c in enumerate(d["champions"],1):
    g=c["genome"]
    conds=" AND ".join(f"{f}{op}{thr}" for f,op,thr in g["conds"])
    yrs=" ".join(f"<span style='color:{'#2ebd85' if v>0 else '#e5484d'}'>{y}:{v:+.0f}%</span>" for y,v in sorted(c["byYear"].items()))
    rows+=f"""<tr><td>{i}</td><td class='{'g' if g['dir']=='LONG' else 'r'}'>{g['dir']}</td>
    <td>{c['n']}</td><td>{c['wr']}%</td><td class='g'>{c['sumRet']:+.0f}%</td>
    <td class='{'g' if c['bearRet']>0 else 'r'}'>{c['bearRet']:+.0f}% (n{c['nBear']})</td>
    <td>{c['sharpe']}</td><td>{c['stab']}</td><td class='g'>{c['drop3']:+.0f}%</td>
    <td class='code'>{html.escape(conds)} · SL{g['sl']} trail{g['trail']} hold{g['maxhold']}</td></tr>
    <tr><td colspan='9'></td><td class='yr'>{yrs}</td></tr>"""
upd=dt.datetime.fromtimestamp(d["updated"]).strftime("%Y-%m-%d %H:%M")
H=f"""<!DOCTYPE html><html><head><meta charset='utf-8'><title>Bear Rule Evolver — Champions</title>
<style>body{{background:#0a0a0a;color:#e6e6e6;font-family:-apple-system,monospace;padding:20px;max-width:1200px;margin:auto}}
h1{{font-size:19px}}.sub{{color:#888;font-size:12px;margin-bottom:14px}}
table{{width:100%;border-collapse:collapse;font-size:12px}}td,th{{padding:5px 7px;border-bottom:1px solid #1f1f1f;text-align:left}}
th{{color:#888}}.g{{color:#2ebd85}}.r{{color:#e5484d}}.code{{font-family:monospace;font-size:11px;color:#bcd}}.yr{{font-size:10px;font-family:monospace}}
.note{{background:#16202e;border-left:3px solid #f7931a;padding:9px 13px;border-radius:5px;font-size:12px;color:#bcd;margin-bottom:14px}}</style></head><body>
<h1>🧬 Bear Rule Evolver — Champions</h1>
<div class='sub'>Cập nhật {upd} · B&amp;H Sharpe {d['bhSharpe']} · EMA200-proxy Sharpe {d['pxSharpe']} · daemon chạy vô hạn</div>
<div class='note'>Mọi champion đã qua 4 cổng chống-mirage: <b>drop-top-3-winners dương</b> · <b>Sharpe &gt; B&amp;H &amp; proxy</b> (alpha không beta) · <b>DƯƠNG trong bear</b> (close&lt;EMA200d) · <b>OOS 2 nửa cùng dương</b> · stab ≥60% · ≥3 entry/năm. CHƯA forward-test — vẫn cần audit + cross-asset trước khi tin.</div>
<table><tr><th>#</th><th>Dir</th><th>n</th><th>WR</th><th>sumRet</th><th>BEAR ret</th><th>Sharpe</th><th>stab</th><th>drop3</th><th>Rule</th></tr>{rows}</table></body></html>"""
out="/tmp/bear_evolver_dashboard.html"
open(out,"w").write(H)
print("→",out)
subprocess.run(["open",out])
