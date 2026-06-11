#!/usr/bin/env python3
"""
pv-oos-eval.py — MỞ OOS MỘT LẦN cho champion đã freeze (PV_EVOLVER_v1).

Import logic từ pv-evolver-v1.py (cùng engine, không drift). Đọc champion-frozen.json,
chạy signal trên OOS window (2026) ĐÚNG 1 LẦN, ghi oos-result.json.
KHÔNG dùng OOS để chọn/tinh chỉnh — đây là lần mở duy nhất, sau khi champion đã freeze.
"""
import json, os, importlib.util, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pvev", os.path.join(HERE, "pv-evolver-v1.py"))
pv = importlib.util.module_from_spec(spec); spec.loader.exec_module(pv)

champ = json.load(open(os.path.join(HERE, "pv-evolver-v1", "champion-frozen.json")))
c = champ["params"]
oos_lo, oos_hi = champ["oos"]["window"]

trades = pv.run_trades(c["tf"], c)
oos = pv.wm(trades, oos_lo, oos_hi)
# tham chiếu train+val tổng (2019..2025) để đo degradation
ref = pv.wm(trades, 2019, 2025)
val_ref = champ["train_validation"]["valMeanAvg"]

result = {
    "version": pv.VERSION, "opened_at": f"{datetime.datetime.utcnow():%Y-%m-%dT%H:%M:%SZ}",
    "champion_params": c, "oos_window": [oos_lo, oos_hi],
    "oos": oos, "ref_2019_2025": ref,
    "valMeanAvg_at_freeze": val_ref,
    "degradation_val_to_oos": (round(val_ref - oos["avg"], 3) if oos else None),
    "note": "OOS opened ONCE. Sample nhỏ (window ~6 tháng) → kết luận độ tin cậy THẤP; không tinh chỉnh theo OOS.",
}
out = os.path.join(HERE, "pv-evolver-v1", "oos-result.json")
json.dump(result, open(out, "w"), indent=2)

print(f"Champion: {c}")
print(f"OOS window: {oos_lo}-{oos_hi}")
if oos:
    print(f"OOS: n={oos['n']} win={oos['win']:.0f}% avgR={oos['avg']:+.2f} medR={oos['med']:+.2f} totR={oos['tot']:+.1f} maxDD={oos['mdd']:.1f}R")
    print(f"val avgR @freeze={val_ref:+.2f} -> OOS avgR={oos['avg']:+.2f} | degradation={val_ref-oos['avg']:+.2f}")
else:
    print("OOS: 0 trade trong window (signal không kích hoạt) — không kết luận được.")
print(f"-> {out}")
