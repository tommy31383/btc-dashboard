#!/usr/bin/env python3
"""
Generate interactive HTML report from btc_context_result.json
"""

import json, base64, os, subprocess
from datetime import datetime, timezone

import argparse
_p = argparse.ArgumentParser()
_p.add_argument("--tf", default="1d", choices=["1d","4h","1h"])
_args, _ = _p.parse_known_args()
TF = _args.tf

RESULT_PATH = f"/tmp/btc_context_result_{TF}.json"
CHART_PATH  = f"/tmp/btc_context_chart_{TF}.png"
HTML_PATH   = f"/tmp/btc_context_report_{TF}.html"


def run_analysis():
    print("Running analysis...")
    script = os.path.join(os.path.dirname(__file__), "fetch_and_analyze.py")
    subprocess.run(["python3", script], check=True)


def encode_img(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def build_html(result, chart_b64):
    cur = result["current"]
    ind = cur["indicators"]
    matches = result["matches"]
    stats = result["stats"]["outcomes"]

    def pct_color(v, bold=False):
        if v is None: return '<span style="color:#666">—</span>'
        col = "#26a69a" if v >= 0 else "#ef5350"
        w = "bold" if bold else "normal"
        return f'<span style="color:{col};font-weight:{w}">{v:+.1f}%</span>'

    def rsi_badge(v):
        if v is None: return "—"
        if v < 30: col, label = "#ef5350", "oversold"
        elif v > 70: col, label = "#26a69a", "overbought"
        else: col, label = "#ffa726", "neutral"
        return f'<span style="background:{col};color:#fff;padding:1px 6px;border-radius:4px;font-size:11px">{v} {label}</span>'

    def stk_badge(v):
        if v is None: return "—"
        if v < 20: col = "#ef5350"
        elif v > 80: col = "#26a69a"
        else: col = "#ffa726"
        return f'<span style="background:{col}22;color:{col};border:1px solid {col};padding:1px 6px;border-radius:4px;font-size:11px">{v}</span>'

    def metric(label, value, sub=""):
        sub_html = f'<div style="color:#666;font-size:11px;margin-top:2px">{sub}</div>' if sub else ""
        return f"""
        <div class="metric">
          <div class="metric-label">{label}</div>
          <div class="metric-value">{value}</div>
          {sub_html}
        </div>"""

    # Build matches rows
    match_rows = ""
    for i, m in enumerate(matches):
        o = m["outcomes"]
        ev = m["event"] or "—"
        trend_col = "#ef5350" if "DOWN" in m["trend_14d"] else "#26a69a" if "UP" in m["trend_14d"] else "#ffa726"
        bnc = "✓" if m["next_bar_bounce"] else "✗"
        bnc_col = "#26a69a" if m["next_bar_bounce"] else "#ef5350"
        bb = f'{m["bb_pct_b"]:.3f}' if m["bb_pct_b"] is not None else "—"
        bb_col = "#ef5350" if m["bb_pct_b"] is not None and m["bb_pct_b"] < 0 else "#888"
        match_rows += f"""
        <tr class="match-row" onclick="toggleDetail({i})">
          <td><span style="color:#aaa;font-size:11px">#{i+1}</span></td>
          <td><strong style="color:#e0e0ff">{m["date"]}</strong></td>
          <td><span style="color:#aaa;font-size:12px">{ev}</span></td>
          <td><span style="color:#FFD700;font-weight:bold">{m.get("similarity_score",0):.2f}</span></td>
          <td>{pct_color(m["drop_from_peak_pct"])}</td>
          <td>{rsi_badge(m["rsi"])}</td>
          <td>{stk_badge(m["stoch_rsi_k"])}</td>
          <td style="color:{bb_col}">{bb}</td>
          <td style="color:{bnc_col};font-size:16px">{bnc}</td>
          <td>{pct_color(o["d1"])}</td>
          <td>{pct_color(o["d3"])}</td>
          <td>{pct_color(o["d7"])}</td>
          <td>{pct_color(o["d14"])}</td>
          <td>{pct_color(o["d30"], bold=True)}</td>
        </tr>"""

    # Stats rows
    stat_rows = ""
    for k, label in [("d1","+1D"), ("d3","+3D"), ("d7","+7D"), ("d14","+14D"), ("d30","+30D")]:
        s = stats.get(k, {})
        if not s: continue
        med = s.get("median", 0)
        med_col = "#26a69a" if med >= 0 else "#ef5350"
        stat_rows += f"""
        <tr>
          <td style="color:#aaa;font-weight:bold">{label}</td>
          <td style="color:{med_col};font-weight:bold">{med:+.1f}%</td>
          <td style="color:#888">{s.get("min",0):+.1f}%</td>
          <td style="color:#888">{s.get("max",0):+.1f}%</td>
          <td style="color:#ffa726">{s.get("win_rate","—")}</td>
        </tr>"""

    # ② Regime-conditioned + ③ Conviction blocks
    rs = result["stats"]
    def regime_line(label, g, col):
        if not g or g.get("n", 0) < 1:
            return f'<div style="color:#666">{label}: n=0</div>'
        o = g["outcomes"]
        cells = "".join(
            f'<span style="color:{"#26a69a" if (o[k]["median"] or 0)>=0 else "#ef5350"};margin-right:14px">'
            f'{k} {o[k]["median"]:+.1f}% <span style="color:#777">(win {o[k]["win_rate"]})</span></span>'
            for k in ["d7","d14","d30"] if o.get(k))
        return (f'<div style="margin:4px 0"><span style="color:{col};font-weight:bold">{label}</span> '
                f'<span style="color:#888">n={g["n"]}</span> &nbsp; {cells}</div>')
    regime_html = (
        f'<div style="margin-top:16px;padding:12px 14px;background:#0f1a1a;border:1px solid #1e3a3a;border-radius:6px">'
        f'<div style="color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">'
        f'② Tách regime — hiện tại: <strong style="color:#FFD700">{rs.get("current_regime","")}</strong></div>'
        f'{regime_line("CÙNG regime (giống NOW)", rs.get("regime_same"), "#26a69a")}'
        f'{regime_line("KHÁC regime (tham khảo)", rs.get("regime_diff"), "#ffa726")}'
        f'<div style="color:#777;font-size:11px;margin-top:6px">Chỉ phần CÙNG regime mới sát bối cảnh hiện tại; KHÁC regime dễ gây lạc quan/bi quan sai.</div>'
        f'</div>')
    cv = rs.get("conviction", {})
    cv_col = {"CAO":"#26a69a","TRUNG BÌNH":"#ffa726","THẤP":"#ef5350"}.get(cv.get("level"), "#888")
    conviction_html = (
        f'<div style="margin-top:12px;padding:12px 14px;background:#14101a;border:1px solid {cv_col}55;border-radius:6px">'
        f'<div style="color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">③ Conviction (độ bất định)</div>'
        f'<div style="font-size:15px;font-weight:bold;color:{cv_col};margin-bottom:4px">{cv.get("level","N/A")}'
        + (f' &nbsp;<span style="color:#888;font-size:12px;font-weight:normal">band d30 {cv.get("band_d30","")}  win {cv.get("win_rate","")}</span>' if cv.get("band_d30") else "")
        + f'</div><div style="color:#999;font-size:12px;line-height:1.5">{cv.get("note","")}</div></div>')

    ema_gap_col = "#ef5350" if (ind["ema200_4h_gap_pct"] or 0) < 0 else "#26a69a"
    streak_col  = "#ef5350" if cur["streak"]["color"] == "red" else "#26a69a"

    html = f"""<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BTC Market Context — {cur["date"]}</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0a0a14; color: #ddd; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px; }}
  .container {{ max-width: 1400px; margin: 0 auto; padding: 20px; }}

  h1 {{ font-size: 20px; color: #fff; margin-bottom: 4px; }}
  h2 {{ font-size: 14px; color: #888; font-weight: normal; margin-bottom: 20px; }}
  h3 {{ font-size: 13px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }}

  .section {{ background: #12121f; border: 1px solid #1e1e3a; border-radius: 8px; padding: 20px; margin-bottom: 20px; }}

  /* Metrics grid */
  .metrics {{ display: flex; flex-wrap: wrap; gap: 10px; }}
  .metric {{ background: #0f0f1e; border: 1px solid #1e1e3a; border-radius: 6px;
             padding: 12px 16px; min-width: 130px; flex: 1; }}
  .metric-label {{ color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }}
  .metric-value {{ font-size: 18px; font-weight: bold; color: #e0e0ff; }}

  /* Highlight metrics */
  .metric.warn .metric-value {{ color: #ef5350; }}
  .metric.good .metric-value {{ color: #26a69a; }}
  .metric.gold .metric-value {{ color: #FFD700; }}

  /* Chart */
  .chart-img {{ width: 100%; border-radius: 6px; display: block; }}

  /* Table */
  table {{ width: 100%; border-collapse: collapse; }}
  th {{ color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
        padding: 8px 10px; text-align: right; border-bottom: 1px solid #1e1e3a; }}
  th:nth-child(-n+3) {{ text-align: left; }}
  td {{ padding: 9px 10px; border-bottom: 1px solid #111125; text-align: right; font-size: 12px; }}
  td:nth-child(-n+3) {{ text-align: left; }}
  .match-row {{ cursor: pointer; transition: background 0.15s; }}
  .match-row:hover {{ background: #16162a; }}

  /* Stats table */
  .stats-table {{ max-width: 360px; }}
  .stats-table th {{ text-align: left; }}
  .stats-table td {{ text-align: right; }}
  .stats-table td:first-child {{ text-align: left; }}

  /* Trend badge */
  .trend-dn {{ color: #ef5350; font-size: 11px; }}
  .trend-up {{ color: #26a69a; font-size: 11px; }}

  /* Divider */
  .divider {{ border: none; border-top: 1px solid #1e1e3a; margin: 16px 0; }}

  /* Footer */
  .footer {{ color: #333; font-size: 11px; text-align: center; padding: 12px; }}

  /* Responsive */
  @media (max-width: 800px) {{ .metrics {{ flex-direction: column; }} }}
</style>
</head>
<body>
<div class="container">

  <h1>📊 BTC Market Context Report</h1>
  <h2>Generated {result["generated_at"]} &nbsp;·&nbsp; {result["stats"]["total_matches"]} kịch bản tìm thấy trong 7 năm</h2>

  <!-- Current Structure -->
  <div class="section">
    <h3>Structure hiện tại — {cur["date"]}</h3>
    <div class="metrics">
      {metric("BTC Price", f'${cur["close"]:,.0f}')}
      {metric("14D Drop", f'{cur["drop_from_peak_pct"]:+.1f}%', f'từ ${cur["14d_high"]:,.0f}')}
      {metric("vs 14D Low", f'+{cur["close_vs_low_pct"]:.1f}%', f'low ${cur["14d_low"]:,.0f}')}
      {metric("Trend 14D", cur["trend_14d"].split(" ")[0], cur["trend_14d"])}
      {metric("Streak", f'{cur["streak"]["count"]} nến {cur["streak"]["color"]}')}
      {metric("RSI 1D", str(ind["rsi_1d"]), "cực oversold" if (ind["rsi_1d"] or 99) < 20 else "oversold" if (ind["rsi_1d"] or 99) < 30 else "")}
      {metric("StochRSI K/D", f'{ind["stoch_rsi_k"]} / {ind["stoch_rsi_d"]}')}
      {metric("BB %B", str(ind["bb_pct_b"]), "dưới lower band" if (ind["bb_pct_b"] or 1) < 0 else "")}
      {metric("ATR%", f'{ind["atr_1d_pct"]}%')}
      {metric("Volume", f'{ind["volume_ratio_20d"]}x', "vs 20D avg")}
    </div>

    <hr class="divider">

    <div class="metrics">
      {metric("EMA200 1D", f'${ind["ema200_1d"]:,.0f}', f'gap {ind["ema200_1d_gap_pct"]:+.1f}%')}
      {metric("EMA200 4H", f'${ind["ema200_4h"]:,.0f}', f'gap {ind["ema200_4h_gap_pct"]:+.1f}% ← champion unlock')}
      {metric("Weekly", f'{cur["timeframes"]["weekly"]["pct"]:+.1f}%', "tuần này")}
      {metric("3D", f'{cur["timeframes"]["3d"]["pct"]:+.1f}%', "3 ngày")}
      {metric("Monthly", f'{cur["timeframes"]["monthly"]["pct"]:+.1f}%', "tháng này")}
    </div>
  </div>

  <!-- Chart -->
  <div class="section" style="padding: 12px;">
    <h3 style="margin-bottom:10px">Chart — 45 ngày hiện tại + 15 kịch bản lịch sử</h3>
    <img src="data:image/png;base64,{chart_b64}" class="chart-img" alt="BTC Context Chart">
  </div>

  <!-- Stats -->
  <div class="section">
    <h3>Thống kê outcome ({len(matches)} kịch bản top)</h3>
    <div style="display:flex;gap:30px;flex-wrap:wrap;align-items:flex-start">
      <div>
        <table class="stats-table">
          <thead>
            <tr>
              <th></th>
              <th>Median</th>
              <th>Min</th>
              <th>Max</th>
              <th>Win Rate</th>
            </tr>
          </thead>
          <tbody>{stat_rows}</tbody>
        </table>
      </div>
      <div style="color:#888;font-size:12px;line-height:1.8">
        <div>Bounce ngày tiếp: <strong style="color:#e0e0ff">{result["stats"]["bounce_next_bar"]}</strong></div>
        <div>Total matches found: <strong style="color:#e0e0ff">{result["stats"]["total_matches"]}</strong></div>
        <div>Hiển thị top: <strong style="color:#e0e0ff">{len(matches)}</strong></div>
      </div>
    </div>
    {regime_html}
    {conviction_html}
    <div style="margin-top:16px;padding:12px 14px;background:#2a1a0a;border:1px solid #5a3a1a;border-radius:6px;color:#ffb74d;font-size:12px;line-height:1.6">
      {result["stats"].get("disclaimer","")}
    </div>
  </div>

  <!-- Matches Table -->
  <div class="section">
    <h3>Top {len(matches)} kịch bản tương tự</h3>
    <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Ngày</th>
          <th>Event</th>
          <th>Sim</th>
          <th>Drop 14D</th>
          <th>RSI</th>
          <th>StochK</th>
          <th>BB %B</th>
          <th>Bounce?</th>
          <th>+1D</th>
          <th>+3D</th>
          <th>+7D</th>
          <th>+14D</th>
          <th>+30D</th>
        </tr>
      </thead>
      <tbody>{match_rows}</tbody>
    </table>
    </div>
  </div>

  <div class="footer">BTC Market Context Skill · btc-market-context · {result["generated_at"]}</div>
</div>

<script>
function toggleDetail(i) {{
  // placeholder for future expand/collapse
}}
</script>
</body>
</html>"""

    return html


def main():
    # Run analysis if result doesn't exist or is stale
    import os, time
    if not os.path.exists(RESULT_PATH) or \
       time.time() - os.path.getmtime(RESULT_PATH) > 3600:
        run_analysis()
    else:
        print("Using cached result (< 1h old)")

    with open(RESULT_PATH) as f:
        result = json.load(f)

    # Re-run chart if needed
    if not os.path.exists(CHART_PATH) or \
       os.path.getmtime(CHART_PATH) < os.path.getmtime(RESULT_PATH):
        run_analysis()
        with open(RESULT_PATH) as f:
            result = json.load(f)

    print("Encoding chart...")
    chart_b64 = encode_img(CHART_PATH)

    print("Building HTML...")
    html = build_html(result, chart_b64)

    with open(HTML_PATH, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Report saved → {HTML_PATH}")
    import subprocess
    subprocess.Popen(["open", HTML_PATH])
    return HTML_PATH


if __name__ == "__main__":
    main()
