#!/usr/bin/env python3
"""Task 4: Alt-season 2024 REGIME detection for SOL.
Question: in mid-2024 alt-season, was regime BULL or RANGE?
If BULL → SOL entries gated out by RANGE-only → co-fire risk reduces automatically.
Count SOL entries in 2024-Q3/Q4 WITH and WITHOUT RANGE gate.
"""
import importlib.util, datetime, math
from collections import defaultdict

HP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py"
spec = importlib.util.spec_from_file_location("H", HP)
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
FEE = H.FEE
CC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"
SOL_CACHE = f"{CC}/binance-sol-5m-3y.json"

def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year
def uhour(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def udow(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

H.CACHE = SOL_CACHE
bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600*1000); bars1d = H.load_tf(86400*1000)
n = len(bars4h); c4 = [b["close"] for b in bars4h]
e50 = H.ema_s(c4, H.EMA_FAST); e200 = H.ema_s(c4, H.EMA_SLOW)
atr4 = H.atr_series(bars4h); adx4 = H.adx_wilder(bars4h)
e200_1h = H.ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
regime_1d = H.regime_with_persistence(bars1d)
reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}

def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")
def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
def atp_pass(i):
    if i < H.ATR_PCT_LB+14: return False
    vs = [atp(j) for j in range(i-H.ATR_PCT_LB, i) if atp(j) is not None]
    if len(vs) < H.ATR_PCT_LB: return False
    cur = atp(i); return cur is not None and cur >= sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
def vol_pass(i):
    if i < H.VOL_MA: return False
    ma = sum(bars4h[j]["volume"] for j in range(i-H.VOL_MA, i))/H.VOL_MA
    return bars4h[i]["volume"] >= ma*H.VOL_MULT
def e200_1h_at(ts):
    lo, hi, idx = 0, len(h1t)-1, 0
    while lo <= hi:
        m = (lo+hi)//2
        if h1t[m] <= ts: idx = m; lo = m+1
        else: hi = m-1
    return e200_1h[idx]

def filt_no_regime(i):
    """All filters EXCEPT regime gate"""
    adv = adx4[i]
    if adv is None or adv <= H.ADX_THRESH: return False
    ap = adx4[i-1] if i >= 1 else None
    if ap is None or ap <= H.ADX_THRESH: return False
    e1h = e200_1h_at(bars4h[i]["time"])
    if e1h is None or c4[i] < e1h: return False
    if not atp_pass(i): return False
    return True  # no regime gate

def filt_with_regime(i):
    """All filters WITH RANGE-only regime gate"""
    if not filt_no_regime(i): return False
    return get_reg(bars4h[i]["time"]) == "RANGE"

def sig_s12(i):
    if None in (e50[i], e200[i]) or i < 1 or None in (e50[i-1], e200[i-1]): return None
    return "LONG" if e50[i-1] <= e200[i-1] and e50[i] > e200[i] else None
def sig_s13(i):
    if atr4[i] is None or i < 1: return None
    return "LONG" if c4[i] > bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
def sig_s14(i):
    if i < H.DONCHIAN_LB: return None
    hi = max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB, i))
    return "LONG" if c4[i] > hi else None
sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}
do_vol = {"S12": False, "S13": True, "S14": True}
CD_map = {"S12": 36, "S13": 1, "S14": 36}

# Target: 2024-Q3/Q4 = July through December 2024
# Also check Q1/Q2 for completeness
TARGET_MONTHS = ["2024-07","2024-08","2024-09","2024-10","2024-11","2024-12"]
ALT_SEASON_START = datetime.datetime(2024, 7, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000
ALT_SEASON_END   = datetime.datetime(2025, 1, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000

# First: print daily regime for SOL in 2024 to see what RANGE/BULL/BEAR looks like
print("=== SOL Daily Regime 2024 (monthly summary) ===")
reg_by_month = defaultdict(lambda: defaultdict(int))
for i, b in enumerate(bars1d):
    ts = b["time"]
    if ts < ALT_SEASON_START - 180*86400000: continue  # start from early 2024
    if ts > ALT_SEASON_END: break
    mo = mo_of(ts)
    r = regime_1d[i]
    reg_by_month[mo][r] += 1

for mo in sorted(reg_by_month):
    d = reg_by_month[mo]
    total = sum(d.values())
    parts = " | ".join(f"{k}:{v}/{total}" for k, v in sorted(d.items()))
    print(f"  {mo}: {parts}")

# Count entries in 2024-Q3/Q4 with and without regime gate
entries_with = defaultdict(int)    # with RANGE gate
entries_without = defaultdict(int) # without regime gate (just ADX+EMA+ATR)
gated_out = defaultdict(int)       # gated out because regime != RANGE
regime_at_entry = defaultdict(list) # what regime was when entry attempted (no gate)

last_with = {s: 0 for s in sigs}
last_without = {s: 0 for s in sigs}

for i in range(250, n-H.MAX_HOLD):
    ts = bars4h[i]["time"]
    mo = mo_of(ts)
    if mo < "2024-01" or mo > "2024-12": continue

    for sn in ("S12", "S13", "S14"):
        if sigs[sn](i) != "LONG": continue

        # WITHOUT regime gate
        if i-last_without[sn] >= CD_map[sn]:
            if not do_vol[sn] or vol_pass(i):
                if filt_no_regime(i):
                    entries_without[mo] += 1
                    regime_at_entry[mo].append(get_reg(ts))
                    last_without[sn] = i

        # WITH regime gate
        if i-last_with[sn] >= CD_map[sn]:
            if not do_vol[sn] or vol_pass(i):
                if filt_with_regime(i):
                    entries_with[mo] += 1
                    last_with[sn] = i

print("\n=== SOL Entries 2024: WITH vs WITHOUT RANGE gate ===")
print(f"{'Month':>9} | {'No-gate':>7} | {'RANGE-gate':>10} | {'Gated%':>7} | Regimes at entry")
total_no_gate = 0; total_with_gate = 0
for mo in sorted(set(entries_without) | set(entries_with)):
    ng = entries_without.get(mo, 0)
    wg = entries_with.get(mo, 0)
    total_no_gate += ng; total_with_gate += wg
    if ng > 0:
        gated_pct = (ng - wg) / ng * 100
        regs = entries_without.get(mo, 0)
        reg_list = regime_at_entry.get(mo, [])
        reg_summary = ", ".join(f"{r}:{reg_list.count(r)}" for r in sorted(set(reg_list)))
        alt_flag = "*** ALT-SEASON ***" if mo in TARGET_MONTHS else ""
        print(f"  {mo} | {ng:>7} | {wg:>10} | {gated_pct:>6.0f}% | {reg_summary} {alt_flag}")

if total_no_gate > 0:
    overall_gated = (total_no_gate - total_with_gate) / total_no_gate * 100
    print(f"\nFull 2024 total: no-gate={total_no_gate}, with-gate={total_with_gate}, gated-out={overall_gated:.0f}%")

# Summary for alt-season months specifically
alt_ng = sum(entries_without.get(m, 0) for m in TARGET_MONTHS)
alt_wg = sum(entries_with.get(m, 0) for m in TARGET_MONTHS)
if alt_ng > 0:
    alt_gated = (alt_ng - alt_wg) / alt_ng * 100
    print(f"\n2024-Q3/Q4 (Jul-Dec): no-gate={alt_ng}, with-gate={alt_wg}, gated-out={alt_gated:.0f}%")
    print(f"VERDICT: {'RANGE-gate ELIMINATES {:.0f}% of alt-season SOL entries → co-fire risk AUTO-REDUCED'.format(alt_gated) if alt_gated > 50 else 'RANGE-gate only partially reduces alt-season entries → co-fire risk REMAINS'}")
else:
    print("\n2024-Q3/Q4: no entries generated even without regime gate (SOL data limited to 3y)")

# Show what regime SOL was in during alt-season
print("\n=== SOL Regime Distribution in 2024-Q3/Q4 (Jul-Dec 2024) ===")
for mo in TARGET_MONTHS:
    regs = regime_at_entry.get(mo, [])
    if regs:
        reg_summary = " | ".join(f"{r}:{regs.count(r)}" for r in sorted(set(regs)))
        print(f"  {mo}: {reg_summary}")
    else:
        print(f"  {mo}: (no pre-gate entries)")
