#!/usr/bin/env python3
"""Loop cycle 2: audit độ ROBUST của diversification benefit (hedge01 + turtle).
Re-derive monthly series live từ correlation-turtle-hedge01-7y.py (no stale embed, no-lookahead inherited).
Test combined Sharpe dưới: full / ex-2021-03(jackpot) / ex-2021(cả năm) / drop-best-month mỗi series.
Thêm maxDD (cumulative return-%) + active-months/năm. Mục tiêu: benefit có jackpot-driven không?
"""
import importlib.util, os, sys, math
P = "/Users/lap16116/BTC_PC/btc-dashboard/tools/correlation-turtle-hedge01-7y.py"
spec = importlib.util.spec_from_file_location("corr", P)
C = importlib.util.module_from_spec(spec)
# suppress its print
_so = sys.stdout; sys.stdout = open(os.devnull, "w")
spec.loader.exec_module(C)
sys.stdout = _so

allmo = C.allmo
h01 = {m: C.h01_mo.get(m, 0.0) for m in allmo}
tur = {m: C.tur_mo.get(m, 0.0) for m in allmo}

def sharpe(vals):
    n = len(vals)
    if n == 0: return 0.0
    m = sum(vals) / n
    d = (sum((v - m) ** 2 for v in vals) / n) ** 0.5 or 1e-9
    return m / d * math.sqrt(12)

def maxdd(vals):  # cumulative return-% drawdown
    cum = 0.0; peak = 0.0; mdd = 0.0
    for v in vals:
        cum += v
        if cum > peak: peak = cum
        dd = peak - cum
        if dd > mdd: mdd = dd
    return mdd

def combined(xs, ys):  # equal-risk (risk-parity) per correlation script
    sx = (sum((v - sum(xs)/len(xs))**2 for v in xs)/len(xs))**0.5 or 1e-9
    sy = (sum((v - sum(ys)/len(ys))**2 for v in ys)/len(ys))**0.5 or 1e-9
    return [(xs[i]/sx + ys[i]/sy)/2 for i in range(len(xs))]

def scenario(name, drop_months=None, drop_best=False):
    months = [m for m in allmo if not (drop_months and m in drop_months)]
    xs = [h01[m] for m in months]; ys = [tur[m] for m in months]
    if drop_best:
        # drop each series' own single best month independently (fragility test)
        if xs: xs = sorted(xs)[:-1] if len(xs) > 1 else xs
        if ys: ys = sorted(ys)[:-1] if len(ys) > 1 else ys
        # realign for combined: drop best month index per series is messy; for combined use month-aligned drop of the union best
        # simpler: for combined, drop the single month maximizing (x+y) risk-normalized
    sh_h = sharpe(xs); sh_t = sharpe(ys)
    comb = combined([h01[m] for m in months], [tur[m] for m in months])
    sh_c = sharpe(comb)
    benefit = sh_c - max(sh_h, sh_t)
    sum_h = sum(h01[m] for m in months)*100; sum_t = sum(tur[m] for m in months)*100
    # combined dollar-equivalent at equal risk: sum of risk-normalized then rescale to avg vol — report sum of (h01+turtle)/2 raw too
    sum_blend = (sum_h + sum_t)/2
    print(f"  {name:<26} | Sharpe h01 {sh_h:+.2f}  tur {sh_t:+.2f}  COMB {sh_c:+.2f}  benefit {benefit:+.2f} | "
          f"ret% h01 {sum_h:+.0f} tur {sum_t:+.0f} blend {sum_blend:+.0f}")
    return sh_c, benefit

print("=== Cycle 2: diversification benefit ROBUSTNESS (hedge01 + turtle) ===")
print(f"  base months={len(allmo)}")
print("  scenario                   | Sharpe comparison                          | return-% (R-mult sum)")
print("  " + "-"*100)
scenario("FULL")
scenario("ex-2021-03 (jackpot)", drop_months={"2021-03"})
scenario("ex-2021 (cả năm)", drop_months={m for m in allmo if m.startswith("2021")})
# drop turtle's own best month (whatever year)
best_tur = max(allmo, key=lambda m: tur[m])
best_h01 = max(allmo, key=lambda m: h01[m])
print(f"  (turtle best month = {best_tur} {tur[best_tur]*100:+.0f}%, hedge01 best = {best_h01} {h01[best_h01]*100:+.0f}%)")
scenario(f"ex-{best_tur}+ex-{best_h01}", drop_months={best_tur, best_h01})

# maxDD comparison (cumulative monthly return-%)
print("\n  maxDD (cumulative monthly return-%, lower=better):")
xs_all = [h01[m] for m in allmo]; ys_all = [tur[m] for m in allmo]
comb_all = combined(xs_all, ys_all)
print(f"    hedge01 {maxdd(xs_all)*100:.0f}%  |  turtle {maxdd(ys_all)*100:.0f}%  |  blend50/50 {maxdd([(xs_all[i]+ys_all[i])/2 for i in range(len(allmo))])*100:.0f}%  |  risk-parity-comb {maxdd(comb_all)*100:.2f}(norm units)")

# active months per year (stability)
print("\n  active months/năm (stability):")
from collections import defaultdict
ah = defaultdict(int); at = defaultdict(int)
for m in allmo:
    y = m[:4]
    if abs(h01[m]) > 1e-9: ah[y]+=1
    if abs(tur[m]) > 1e-9: at[y]+=1
yrs = sorted(set(list(ah)+list(at)))
print("    year   " + "  ".join(yrs))
print("    h01    " + "  ".join(f"{ah[y]:>4}" for y in yrs))
print("    turtle " + "  ".join(f"{at[y]:>4}" for y in yrs))
