#!/usr/bin/env python3
"""
hurst-gauntlet.py — BĂM NÁT hurst_rs_30 qua 3 dao mổ honest mà memory bắt buộc,
trước khi cho phép gọi nó là "regime-gate v0.5.0".

Khung: dùng Hurst làm GATE long forward-5d.
  - top-quintile (H cao = trend-persist) là "tín hiệu BẬT long".
  - bottom-quintile (H thấp = chợ-nát) là "tín hiệu TẮT".
  aggSpread = topRet − botRet (đã có ở script cũ). Đây CHỈ là điểm khởi đầu.

3 DAO MỔ (bất kỳ con nào fail = Hurst KHÔNG phải gate, chỉ là beta/mirage):
  D1. RANDOM-NULL (shuffle): hoán vị nhãn H vs forward-ret N lần → phân phối null của aggSpread.
       observed nằm trong đám mây shuffle (p>0.05) = NHIỄU, không có selection.
  D2. DROP-TOP-20%: bỏ 20% forward-ret LỚN NHẤT trong top-quintile.
       Nếu topRet sụp về ~0 hoặc dưới botRet = edge là FAT-TAIL/beta, KHÔNG phải gate đều tay.
  D3. medAlpha-vs-HOLD: topRet − mean(toàn bộ forward-ret).
       >0 robust per-asset = gate có chọn lọc thật; ≈0/âm = chỉ bắt beta (LONG bull).
Cross-asset BTC/ETH/SOL, KHÔNG đụng env live.
"""
import json, math, statistics as st, datetime as dt
from collections import defaultdict

FWD = 5
SHUFFLE_N = 1000
SEED = 12345  # LCG tự cuốn, không cần random module để reproducible tuyệt đối

def agg(b5, h=24):
    out = []; span = h*3600*1000; cur = None
    for b in b5:
        bk = (b["time"]//span)*span
        if cur is None or bk != cur["time"]:
            if cur: out.append(cur)
            cur = dict(time=bk, close=b["close"])
        else: cur["close"] = b["close"]
    if cur: out.append(cur)
    return out

def hurst_series(C):
    n = len(C); out = [None]*n
    ret = [0.0]+[math.log(C[i]/C[i-1]) for i in range(1, n)]
    for i in range(35, n):
        seg = ret[i-29:i+1]
        mean = sum(seg)/len(seg); dev = [x-mean for x in seg]
        cum = []; s = 0
        for x in dev: s += x; cum.append(s)
        R = (max(cum) or 1e-9)-(min(cum) or 0); S = st.pstdev(seg) or 1e-9
        out[i] = math.log((R/S)+1e-9)/math.log(30)
    return out

class LCG:
    def __init__(self, seed): self.s = seed & 0xFFFFFFFF
    def next(self): self.s = (1103515245*self.s + 12345) & 0xFFFFFFFF; return self.s
    def shuffle(self, arr):
        for i in range(len(arr)-1, 0, -1):
            j = self.next() % (i+1); arr[i], arr[j] = arr[j], arr[i]

def analyze(path, label):
    D = agg(json.load(open(path))); n = len(D); C = [b["close"] for b in D]
    yr = lambda i: dt.datetime.utcfromtimestamp(D[i]["time"]/1000).year
    fwd = lambda i: C[i+FWD]/C[i]-1 if i+FWD < n else None
    H = hurst_series(C)
    pairs = [(H[i], fwd(i), yr(i)) for i in range(40, n-FWD) if H[i] is not None and fwd(i) is not None]
    pairs.sort(key=lambda x: x[0]); q = len(pairs)//5
    bot, top = pairs[:q], pairs[-q:]
    topR = [p[1] for p in top]; botR = [p[1] for p in bot]
    allR = [p[1] for p in pairs]
    sb = sum(botR)/len(botR)*100; stp = sum(topR)/len(topR)*100
    obs_spread = stp - sb
    overall = sum(allR)/len(allR)*100

    # ── D1 RANDOM-NULL: hoán vị forward-ret độc lập với rank H ──
    rng = LCG(SEED ^ (len(pairs) & 0xFFFFFFFF))
    fwds = [p[1] for p in pairs]
    null_spreads = []
    for _ in range(SHUFFLE_N):
        sh = fwds[:]; rng.shuffle(sh)
        nb = sh[:q]; ntp = sh[-q:]   # đã shuffle nên "top/bot" chỉ là vị trí ngẫu nhiên
        null_spreads.append((sum(ntp)/len(ntp) - sum(nb)/len(nb))*100)
    null_spreads.sort()
    # p-value 1 phía (đếm null >= observed)
    ge = sum(1 for x in null_spreads if x >= obs_spread)
    pval = ge / SHUFFLE_N
    null_mean = sum(null_spreads)/len(null_spreads)
    null_p95 = null_spreads[int(0.95*SHUFFLE_N)]

    # ── D2 DROP-TOP-20%: bỏ 20% forward-ret lớn nhất trong top-quintile ──
    topR_sorted = sorted(topR)
    keep = topR_sorted[:int(len(topR_sorted)*0.80)]   # giữ 80% thấp, bỏ 20% đỉnh
    stp_dropped = sum(keep)/len(keep)*100
    spread_dropped = stp_dropped - sb

    # ── D3 medAlpha-vs-HOLD ──
    medAlpha = stp - overall   # top-quintile selection vs cầm đều

    return dict(label=label, n=len(pairs), obs_spread=obs_spread, topRet=stp, botRet=sb,
                overall=overall, pval=pval, null_mean=null_mean, null_p95=null_p95,
                stp_dropped=stp_dropped, spread_dropped=spread_dropped, medAlpha=medAlpha)

ASSETS = [(".cache/binance-5m-7y.json", "BTC(7y)"),
          (".cache/binance-eth-5m-7y.json", "ETH(7y)"),
          (".cache/binance-sol-5m-3y.json", "SOL(3y)")]

print("="*88)
print(f"HURST GAUNTLET — 3 dao mổ honest · forward-{FWD}d · shuffle N={SHUFFLE_N}")
print("="*88)
results = []
for path, lab in ASSETS:
    try: results.append(analyze(path, lab))
    except Exception as e: print(f"  {lab}: LỖI {e}")

print(f"\n{'asset':>8} | {'obsSpread':>9} | {'topRet':>7} {'botRet':>7} | {'medAlpha':>8}")
for r in results:
    print(f"{r['label']:>8} | {r['obs_spread']:>+8.2f}% | {r['topRet']:>+6.2f}% {r['botRet']:>+6.2f}% | {r['medAlpha']:>+7.2f}%")

print("\n" + "─"*88)
print("D1 · RANDOM-NULL (shuffle) — observed spread có thoát đám mây nhiễu không?")
print("─"*88)
for r in results:
    verdict = "✅ THOÁT NHIỄU" if r['pval'] < 0.05 else "🔴 TRONG NHIỄU (mirage)"
    print(f"  {r['label']}: obs {r['obs_spread']:+.2f}% · null mean {r['null_mean']:+.2f}% p95 {r['null_p95']:+.2f}% · "
          f"p-value {r['pval']:.3f} → {verdict}")

print("\n" + "─"*88)
print("D2 · DROP-TOP-20% — bỏ 20% winner đỉnh khỏi top-quintile, spread còn sống?")
print("─"*88)
for r in results:
    surv = r['spread_dropped'] / r['obs_spread'] * 100 if r['obs_spread'] else 0
    verdict = "✅ SỐNG" if r['spread_dropped'] > 0.10 and surv > 40 else "🔴 SỤP (fat-tail/beta)"
    print(f"  {r['label']}: spread {r['obs_spread']:+.2f}% → sau drop {r['spread_dropped']:+.2f}% "
          f"(giữ {surv:.0f}%) → {verdict}")

print("\n" + "─"*88)
print("D3 · medAlpha-vs-HOLD — top-quintile có chọn lọc hơn cầm đều, hay chỉ beta?")
print("─"*88)
for r in results:
    verdict = "✅ chọn lọc" if r['medAlpha'] > 0.10 else "🔴 ≈beta (LONG bull)"
    print(f"  {r['label']}: topRet {r['topRet']:+.2f}% − overall {r['overall']:+.2f}% = medAlpha {r['medAlpha']:+.2f}% → {verdict}")

print("\n" + "="*88)
print("PHÁN QUYẾT TỔNG (cần PASS cả 3 dao + cross-asset ≥2/3 mới được lên v0.5.0):")
print("="*88)
for r in results:
    d1 = r['pval'] < 0.05
    d2 = r['spread_dropped'] > 0.10 and (r['spread_dropped']/r['obs_spread']*100 if r['obs_spread'] else 0) > 40
    d3 = r['medAlpha'] > 0.10
    passed = sum([d1, d2, d3])
    print(f"  {r['label']}: D1{'✅' if d1 else '🔴'} D2{'✅' if d2 else '🔴'} D3{'✅' if d3 else '🔴'} → {passed}/3 dao")
