#!/usr/bin/env python3
"""
④ Multi-TF context agreement.
Chạy market-context cho 1d + 4h + 1h, gộp regime + conviction → verdict đồng thuận.
Đồng thuận đa khung = context đáng tin hơn (conviction tổng cao hơn).

Usage: python3 multi_tf_context.py
Output: /tmp/btc_context_multitf.json + bảng console
"""
import json, subprocess, sys, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FAA = os.path.join(SCRIPT_DIR, "fetch_and_analyze.py")
TFS = ["1d", "4h", "1h"]


def run_tf(tf):
    """Chạy fetch_and_analyze --tf X --no-chart, đọc result JSON."""
    subprocess.run([sys.executable, FAA, "--tf", tf, "--no-chart"],
                   capture_output=True, text=True)
    path = f"/tmp/btc_context_result_{tf}.json"
    with open(path) as f:
        return json.load(f)


def regime_side(label):
    if "DƯỚI" in label: return "DƯỚI"
    if "TRÊN" in label: return "TRÊN"
    return "?"


def main():
    print("Chạy 3 khung 1d/4h/1h (mỗi khung ~30-60s)...\n")
    results = {tf: run_tf(tf) for tf in TFS}

    rows = []
    for tf in TFS:
        r = results[tf]
        st = r["stats"]
        cur = r["current"]
        reg = st.get("current_regime", "N/A")
        cv = st.get("conviction", {})
        d30 = st["outcomes"].get("d30", {})
        rows.append({
            "tf": tf,
            "drop": cur["drop_from_peak_pct"],
            "rsi": cur["indicators"]["rsi_1d"],
            "regime": reg,
            "regime_side": regime_side(reg),
            "conviction": cv.get("level", "N/A"),
            "band_d30": cv.get("band_d30", ""),
            "dir_bias": cv.get("dir_bias", ""),
            "d30_median": d30.get("median"),
            "d30_win": d30.get("win_rate"),
            "top_analog": (r["matches"][0]["date"] if r["matches"] else None),
        })

    # ── Đồng thuận ──
    sides = set(x["regime_side"] for x in rows if x["regime_side"] != "?")
    regime_agree = len(sides) == 1
    biases = set(x["dir_bias"] for x in rows if x["dir_bias"])
    bias_agree = len(biases) == 1
    conv_levels = [x["conviction"] for x in rows]

    # verdict conviction tổng: đồng thuận regime + hướng + đa số CAO → conviction tổng CAO
    high = sum(1 for c in conv_levels if c == "CAO")
    low = sum(1 for c in conv_levels if c == "THẤP")
    if regime_agree and bias_agree and low == 0:
        overall = "CAO — 3 khung đồng pha"
    elif not regime_agree or (not bias_agree and low >= 1):
        overall = "THẤP — khung mâu thuẫn / coin-flip"
    else:
        overall = "TRUNG BÌNH — đồng thuận một phần"

    # ── Print ──
    print(f"{'TF':>4} {'Drop':>7} {'RSI':>5} {'Regime':>22} {'Conv':>6} {'BandD30':>16} {'Bias':>6} {'TopAnalog':>12}")
    print("─" * 90)
    for x in rows:
        print(f"{x['tf']:>4} {x['drop']:>+6.1f}% {str(x['rsi']):>5} {x['regime']:>22} "
              f"{x['conviction']:>6} {x['band_d30']:>16} {x['dir_bias']:>6} {str(x['top_analog']):>12}")

    print(f"\n④ ĐỒNG THUẬN ĐA KHUNG")
    print(f"  Regime side: {'✓ ĐỒNG ' + list(sides)[0] if regime_agree else '✗ MÂU THUẪN ' + str(sides)}")
    print(f"  Hướng bias:  {'✓ ĐỒNG ' + list(biases)[0] if bias_agree else '✗ CHIA RẼ ' + str(biases)}")
    print(f"  → CONVICTION TỔNG: {overall}")
    if regime_agree and bias_agree:
        print(f"    3 khung cùng kể 1 câu chuyện → context đáng tin hơn để tư duy.")
    else:
        print(f"    Khung đá nhau → bất định, KHÔNG nên hành động mạnh, chờ đồng pha.")

    out = {"rows": rows, "regime_agree": regime_agree, "bias_agree": bias_agree,
           "overall_conviction": overall}
    with open("/tmp/btc_context_multitf.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\n→ /tmp/btc_context_multitf.json")

    print(f"\n⚠️ Đồng thuận đa khung tăng độ TIN của CONTEXT, KHÔNG biến median thành tín hiệu lệnh "
          f"(median vẫn ≈ coin-flip về hướng — xem disclaimer từng khung).")


if __name__ == "__main__":
    main()
