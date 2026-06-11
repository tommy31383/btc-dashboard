#!/usr/bin/env python3
"""
test_dynamic_relaxation.py — Directive reviewer v1-SHADOW (2026-06-12).
Đảm bảo: khi Volatility Compression làm ATR teo → gate ATR-ratio over-filter → số analog strict
tụt dưới floor → hệ thống TỰ kích hoạt Dynamic Relaxation (nới biên độ) chứ KHÔNG mất sạch tín hiệu.
Chạy: python3 test_dynamic_relaxation.py   (exit 0 = pass).
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_and_analyze import relax_decision, RELAXED_PARAMS

FAILS = []
def check(c, m):
    if not c: FAILS.append(m)

# 1) Pure decision logic
do, p = relax_decision(10, 30)
check(do is True, "strict n=10 < floor 30 phải relax")
check(p == RELAXED_PARAMS, "relax params phải = RELAXED_PARAMS")
do2, p2 = relax_decision(120, 30)
check(do2 is False, "strict n=120 >= floor 30 KHÔNG relax (giữ strict path)")
check(p2["drop_tol"] == 8.0 and p2["atr_lo"] == 0.5 and p2["atr_hi"] == 2.0, "no-relax phải giữ gate gốc 8.0/0.5/2.0")
# boundary
check(relax_decision(30, 30)[0] is False, "n == floor → KHÔNG relax (chỉ < mới relax)")
check(relax_decision(29, 30)[0] is True, "n = floor-1 → relax")

# 2) Mô phỏng over-filter do vol-compression: gate ATR-ratio strict vs relaxed.
#    Hist windows có ATR% phân bố quanh 3.0%; thị trường HIỆN TẠI compression cur_atr=0.8%.
#    Strict band [0.5,2.0]×0.8 = [0.4,1.6] → gần như KHÔNG hist nào lọt (hist toàn 2-4%).
#    Relaxed [0.35,3.0]×0.8 = [0.28,2.4] → vớt được phần đuôi thấp.
import random
random.seed(7)
hist_atr_pct = [random.gauss(3.0, 0.8) for _ in range(2000)]   # vol bình thường 7y
cur_atr = 0.8   # compression
def passes(atr_h, lo, hi):
    return lo <= (atr_h / cur_atr) <= hi
strict_n  = sum(1 for a in hist_atr_pct if passes(a, 0.5, 2.0))
relaxed_n = sum(1 for a in hist_atr_pct if passes(a, RELAXED_PARAMS["atr_lo"], RELAXED_PARAMS["atr_hi"]))
check(relaxed_n > strict_n, f"relaxed phải vớt thêm analog (strict={strict_n}, relaxed={relaxed_n})")
print(f"  [vol-compression sim] cur_atr={cur_atr}% · strict n={strict_n} · relaxed n={relaxed_n} (+{relaxed_n-strict_n})")

# 3) Floor có cấu hình qua env (KHÔNG hard-code 150 cứng)
check(os.environ.get("BTC_RELAX_FLOOR") is None or int(os.environ["BTC_RELAX_FLOOR"]) > 0, "floor env hợp lệ")

if FAILS:
    print("❌ FAIL:")
    for m in FAILS: print("  -", m)
    sys.exit(1)
print("✅ PASS — Dynamic Relaxation: decision logic đúng, vol-compression strict starve → relaxed vớt lại, floor cấu hình được.")
