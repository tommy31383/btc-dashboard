#!/usr/bin/env python3
"""Vẽ chart mô phỏng điểm VÀO / ĐÓNG lệnh của phương pháp general trên giá BTC.
   Đọc /tmp/general_trades.json (dump từ probe) + BTC 1h. 2 panel: bull 2021 + bear 2022.
"""
import json, datetime
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
b = {}
for c in raw:
    k = c["time"] // 3600_000
    if k not in b: b[k] = {"t": k * 3600_000, "c": c["close"]}
    else: b[k]["c"] = c["close"]
H = [b[k] for k in sorted(b)]
T = [datetime.datetime.utcfromtimestamp(x["t"] / 1000) for x in H]
P = [x["c"] for x in H]
trades = json.load(open("/tmp/general_trades.json"))

def dt(ms): return datetime.datetime.utcfromtimestamp(ms / 1000)

WINDOWS = [("BULL 2021 (rally → đỉnh)", "2021-01-01", "2021-05-15"),
           ("BEAR/CHOP 2022 (crash)", "2022-04-01", "2022-08-15")]

fig, axes = plt.subplots(len(WINDOWS), 1, figsize=(15, 9))
for ax, (title, s, e) in zip(axes, WINDOWS):
    sd = datetime.datetime.strptime(s, "%Y-%m-%d"); ed = datetime.datetime.strptime(e, "%Y-%m-%d")
    idx = [i for i in range(len(T)) if sd <= T[i] <= ed]
    ax.plot([T[i] for i in idx], [P[i] for i in idx], color="#888", lw=0.8, zorder=1)
    nL = nS = nW = nLs = 0
    for tr in trades:
        et = dt(tr["ets"]); xt = dt(tr["xts"])
        if not (sd <= et <= ed): continue
        win = tr["ret"] > 0
        lc = "#16a34a" if win else "#dc2626"
        # đường nối vào→đóng
        ax.plot([et, xt], [tr["epx"], tr["xpx"]], color=lc, lw=1.0, alpha=0.45, zorder=2)
        # điểm VÀO: ▲ LONG xanh / ▼ SHORT đỏ-cam
        if tr["side"] == "LONG":
            ax.scatter(et, tr["epx"], marker="^", s=42, color="#16a34a", edgecolors="k", linewidths=0.4, zorder=4); nL += 1
        else:
            ax.scatter(et, tr["epx"], marker="v", s=42, color="#ea580c", edgecolors="k", linewidths=0.4, zorder=4); nS += 1
        # điểm ĐÓNG: ● xanh win / đỏ loss
        ax.scatter(xt, tr["xpx"], marker="o", s=22, color=lc, edgecolors="k", linewidths=0.3, zorder=3)
        if win: nW += 1
        else: nLs += 1
    ntot = nL + nS
    ax.set_title(f"{title}  —  {ntot} lệnh (LONG {nL} ▲ / SHORT {nS} ▼ · win {nW} / loss {nLs})", fontsize=11)
    ax.set_ylabel("BTC $"); ax.grid(alpha=0.25)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b-%d"))

# legend chung
from matplotlib.lines import Line2D
leg = [Line2D([0], [0], marker="^", color="w", markerfacecolor="#16a34a", markersize=9, label="VÀO LONG"),
       Line2D([0], [0], marker="v", color="w", markerfacecolor="#ea580c", markersize=9, label="VÀO SHORT"),
       Line2D([0], [0], marker="o", color="w", markerfacecolor="#16a34a", markersize=8, label="ĐÓNG lãi"),
       Line2D([0], [0], marker="o", color="w", markerfacecolor="#dc2626", markersize=8, label="ĐÓNG lỗ"),
       Line2D([0], [0], color="#16a34a", lw=2, alpha=0.5, label="trade win"),
       Line2D([0], [0], color="#dc2626", lw=2, alpha=0.5, label="trade loss")]
fig.legend(handles=leg, loc="upper center", ncol=6, fontsize=9, bbox_to_anchor=(0.5, 0.99))
fig.suptitle("PHƯƠNG PHÁP GENERAL — điểm VÀO / ĐÓNG lệnh trên BTC (multi-TF + cut2.2 + reverse + TP4, forced-daily)", y=0.965, fontsize=12, weight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.93])
OUT = "/Users/lap16116/BTC_PC/btc-dashboard/assets/general_trades_chart.png"
fig.savefig(OUT, dpi=120, bbox_inches="tight")
print(f"SAVED {OUT}")
