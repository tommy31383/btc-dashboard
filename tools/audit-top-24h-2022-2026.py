#!/usr/bin/env python3
"""
audit-top-24h-2022-2026.py
Thống kê đỉnh 24h (high nến 1d) của 2022 và 2026
StochRSI K+D đa TF tại mỗi đỉnh
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],
                              "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"]=max(b[k]["high"],c["high"]); b[k]["low"]=min(b[k]["low"],c["low"])
            b[k]["close"]=c["close"]; b[k]["volume"]+=c.get("volume",0)
    return [b[k] for k in sorted(b)]

MS = {"15m":900_000,"1h":3_600_000,"4h":14_400_000,"1d":86_400_000}
TF = {n: build_tf(ms) for n,ms in MS.items()}

def rsi(closes, period=14):
    out=[None]*len(closes)
    if len(closes)<=period: return out
    g=l=0.0
    for i in range(1,period+1):
        d=closes[i]-closes[i-1]
        if d>0: g+=d
        else: l-=d
    g/=period; l/=period; out[period]=100-100/(1+g/l) if l else 100.0
    for i in range(period+1,len(closes)):
        d=closes[i]-closes[i-1]
        g=(g*(period-1)+max(d,0))/period; l=(l*(period-1)+max(-d,0))/period
        out[i]=100-100/(1+g/l) if l else 100.0
    return out

def stoch_rsi(closes):
    r=rsi(closes,14); n=len(r); rk=[None]*n
    for i in range(13,n):
        w=[x for x in r[i-13:i+1] if x is not None]
        if len(w)<14: continue
        lo,hi=min(w),max(w)
        rk[i]=50.0 if hi==lo else (r[i]-lo)/(hi-lo)*100
    K=[None]*n
    for i in range(2,n):
        w=[x for x in rk[i-2:i+1] if x is not None]
        if len(w)==3: K[i]=sum(w)/3
    D=[None]*n
    for i in range(2,n):
        w=[x for x in K[i-2:i+1] if x is not None]
        if len(w)==3: D[i]=sum(w)/3
    return K, D

STOCH={}
for name,bars in TF.items():
    closes=[b['close'] for b in bars]
    K,D=stoch_rsi(closes)
    STOCH[name]={"K":K,"D":D,"bars":bars}

IDX={name:{b['time']:i for i,b in enumerate(data['bars'])} for name,data in STOCH.items()}

def get_stoch(tf_name, t_ms):
    ms=MS[tf_name]; bar_t=(t_ms//ms)*ms
    idx=IDX[tf_name].get(bar_t)
    if idx is None:
        times=[b['time'] for b in STOCH[tf_name]['bars']]
        diffs=[abs(tt-bar_t) for tt in times]
        idx=diffs.index(min(diffs))
    k=STOCH[tf_name]['K'][idx]; d=STOCH[tf_name]['D'][idx]
    return (round(k,1) if k is not None else None,
            round(d,1) if d is not None else None)

TFS = ["15m","1h","4h","1d"]

# Lấy tất cả nến 1d của 2022 và 2026
TARGET_YEARS = {"2022","2026"}
rows = []
for bar in TF["1d"]:
    dt = datetime.datetime.utcfromtimestamp(bar['time']/1000).strftime('%Y-%m-%d')
    yr = dt[:4]
    if yr not in TARGET_YEARS: continue
    t_close = bar['time'] + 86_400_000 - 1
    row = {"date":dt,"year":yr,"high":round(bar['high'],1),
           "low":round(bar['low'],1),"close":round(bar['close'],1),
           "range_pct": round((bar['high']-bar['low'])/bar['low']*100, 2)}
    for tf in TFS:
        k,d = get_stoch(tf, t_close)
        row[f"K_{tf}"]=k; row[f"D_{tf}"]=d
        row[f"KgtD_{tf}"]=(k>d) if (k is not None and d is not None) else None
    rows.append(row)

def sep(c="─",w=120): print(c*w)

# ═══════════════════════════════════════════════════════════════════════════════
# BẢNG TỪNG NGÀY
# ═══════════════════════════════════════════════════════════════════════════════
for yr in ["2022","2026"]:
    yr_rows = [r for r in rows if r['year']==yr]
    sep("═")
    print(f"ĐỈNH 24H — {yr}  (n={len(yr_rows)} nến)  — snapshot tại close ngày")
    sep("─")
    print(f"{'Date':<12} {'High':>9} {'Close':>9} {'Range%':>7} | "
          f"{'K15m':>6}{'D15m':>6}{'↕':>4} | "
          f"{'K1h':>6}{'D1h':>6}{'↕':>4} | "
          f"{'K4h':>6}{'D4h':>6}{'↕':>4} | "
          f"{'K1d':>6}{'D1d':>6}{'↕':>4}")
    sep("─")
    for r in yr_rows:
        def fmt(tf):
            k=r[f"K_{tf}"]; d=r[f"D_{tf}"]
            if k is None: return f"{'N/A':>6}{'N/A':>6}{'':>4}"
            delta=round(k-d,1) if d is not None else 0
            arrow="↑" if delta>=0 else "↓"
            return f"{k:>6.1f}{d:>6.1f}{arrow+str(abs(delta)):>4}"
        print(f"{r['date']:<12} {r['high']:>9,.0f} {r['close']:>9,.0f} {r['range_pct']:>7.2f}% | "
              f"{fmt('15m')} | {fmt('1h')} | {fmt('4h')} | {fmt('1d')}")

# ═══════════════════════════════════════════════════════════════════════════════
# THỐNG KÊ SO SÁNH 2022 vs 2026
# ═══════════════════════════════════════════════════════════════════════════════
sep("═")
print("THỐNG KÊ SO SÁNH 2022 vs 2026 — TẠI ĐỈNH 24H")
sep("═")

for yr in ["2022","2026"]:
    yr_rows=[r for r in rows if r['year']==yr]; n=len(yr_rows)
    sep("─")
    print(f"\n[{yr}] n={n} ngày")
    print(f"\n  avg K tại close ngày:")
    for tf in TFS:
        vk=[r[f"K_{tf}"] for r in yr_rows if r[f"K_{tf}"] is not None]
        vd=[r[f"D_{tf}"] for r in yr_rows if r[f"D_{tf}"] is not None]
        if not vk: continue
        avg_k=sum(vk)/len(vk); med_k=sorted(vk)[len(vk)//2]
        avg_d=sum(vd)/len(vd) if vd else 0
        gt80=sum(1 for v in vk if v>80)/len(vk)*100
        gt70=sum(1 for v in vk if v>70)/len(vk)*100
        gt90=sum(1 for v in vk if v>90)/len(vk)*100
        kgtd=sum(1 for r in yr_rows if r[f"KgtD_{tf}"]==True)/len(vk)*100
        print(f"    [{tf}]  avg_K={avg_k:5.1f}  med={med_k:5.1f}  avg_D={avg_d:5.1f}  "
              f"K>70={gt70:.0f}%  K>80={gt80:.0f}%  K>90={gt90:.0f}%  K↑D={kgtd:.0f}%")

    # Combo overbought
    print(f"\n  Combo K>80 cùng lúc (overbought multi-TF):")
    for thr in [80, 90]:
        counts=defaultdict(int)
        for r in yr_rows:
            cnt=sum(1 for tf in TFS if r[f"K_{tf}"] is not None and r[f"K_{tf}"]>thr)
            counts[cnt]+=1
        parts=" | ".join(f"{k}TF:{counts[k]}({counts[k]/n*100:.0f}%)" for k in range(5))
        print(f"    K>{thr}: {parts}")

    # Alignment distribution
    print(f"\n  Phân bố K bucket tại đỉnh:")
    for tf in TFS:
        vk=[r[f"K_{tf}"] for r in yr_rows if r[f"K_{tf}"] is not None]
        if not vk: continue
        nn=len(vk)
        b={"<10":0,"10-30":0,"30-50":0,"50-70":0,"70-90":0,">90":0}
        for v in vk:
            if v<10: b["<10"]+=1
            elif v<30: b["10-30"]+=1
            elif v<50: b["30-50"]+=1
            elif v<70: b["50-70"]+=1
            elif v<=90: b["70-90"]+=1
            else: b[">90"]+=1
        row_s=" | ".join(f"{k}:{b[k]/nn*100:.0f}%" for k in b)
        print(f"    {tf:4s}: {row_s}")

    # D-K gap (momentum direction)
    print(f"\n  avg (K-D) — dương = bullish momentum, âm = bearish:")
    for tf in TFS:
        v=[]
        for r in yr_rows:
            k=r[f"K_{tf}"]; d=r[f"D_{tf}"]
            if k is not None and d is not None: v.append(k-d)
        if v: print(f"    [{tf}]  avg K-D = {sum(v)/len(v):+.1f}")

# ═══════════════════════════════════════════════════════════════════════════════
# MONTHLY BREAKDOWN
# ═══════════════════════════════════════════════════════════════════════════════
sep("═")
print("THÁNG TỪNG NĂM — avg K_1h và % K_1h>80 (overbought) tại đỉnh")
sep("─")
print(f"{'Month':<10} | {'2022 avgK1h':>12} {'K>80':>6} {'K>70':>6} | {'2026 avgK1h':>12} {'K>80':>6} {'K>70':>6}")
sep("─")
months=["01","02","03","04","05","06","07","08","09","10","11","12"]
mnames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
for m,mn in zip(months,mnames):
    def mstat(yr):
        rr=[r for r in rows if r['year']==yr and r['date'][5:7]==m]
        if not rr: return "      N/A","   N/A","   N/A"
        vk=[r["K_1h"] for r in rr if r["K_1h"] is not None]
        if not vk: return "      N/A","   N/A","   N/A"
        avg=f"{sum(vk)/len(vk):10.1f}"
        p80=f"{sum(1 for v in vk if v>80)/len(vk)*100:5.0f}%"
        p70=f"{sum(1 for v in vk if v>70)/len(vk)*100:5.0f}%"
        return avg,p80,p70
    a22,p22_80,p22_70 = mstat("2022")
    a26,p26_80,p26_70 = mstat("2026")
    print(f"{mn:<10} | {a22:>12} {p22_80:>6} {p22_70:>6} | {a26:>12} {p26_80:>6} {p26_70:>6}")

sep("═")
print("""
CHÚ THÍCH TỔNG QUAN:
  • K>80 tại close ngày = ngày overbought — đây là vùng SELL tiềm năng
  • K>D = momentum đang đi lên — nếu K>80 mà K>D vẫn = chưa turn, chờ K<D mới sell
  • K<D khi K vẫn cao (>70) = momentum bắt đầu turn → tín hiệu sell sớm hơn
  • 1h K>80 sensitive nhất — thường overbought trước khi giá thật đỉnh
  • 4h K>80 = confirm — khi cả 1h và 4h đều >80 = high probability đỉnh cục bộ
  • 1d K>80 = major top (ít lần hơn nhưng đỉnh lớn hơn)
  • So sánh 2022 vs 2026: cùng bear year — xem pattern K tại đỉnh có giống nhau không
""")
print("Done.")
