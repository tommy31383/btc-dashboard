# Session Summary — 2026-06-04 (marathon)

Tổng kết phiên: G13→G16 → Evolver daemon v1/v2/v3 → forward-test → audit production+deploy → loss-autopsy → bàn phương pháp.

---

## 1. General Rule G13 → G16

| Version | Mô tả | KPI flat (cũ) | Honest single-account |
|---|---|---|---|
| G13d | BTC vol-target | 7/8 | — |
| G14 | + ETH retest-zone [0.85-1.05]×EMA200d | **8/8** | — |
| G15e | + BTC 1h sleeve | 8/8 | CAGR 70% DD 21% |
| **G16** | autoloop honest hill-climb | — | CAGR 128% DD 24% test 30% |

**⚠️ KPI "8/8 = 100%" là ARTIFACT** (audit): flat-per-sleeve → peak margin 290% capital (29× lev), BTC 1h double-count 4h (corr +0.58). Re-sim 1 account honest: **2022 thực −1.7% (không phải +147%)**, DD thật 19%. → Mọi backtest gộp sleeve PHẢI re-sim single-account margin-cap. Doc: `general-rule-g14-g16-evolver-2026-06-04.md`, audit script `general-rule-g15-exposure-audit.py`.

## 2. Evolver daemon (tự tiến hóa rule)

- **v1** hill-climb threshold-only → plateau (cạn move-set, max ≈ G16)
- **v2** genetic + parallel + structural (sleeve on/off, filter toggle) + Calmar + HOF → **champion Calmar 7.16 / CAGR 146% / DD 20% / test 39%** (qua đêm 33k gen). Genetic tự tắt funding+rsi filter (khớp research RCI).
- **v3** (đang chạy) = + walk-forward train→test + per-sleeve risk + corr-aware per-asset cap. **Audit v3 PASS**: invariant tổng margin ≤ equity mọi config (fix lỗ hổng over-leverage của v1/v2). Pop best đang leo CAGR 186% DD 24.5%.

3 cổng promote: honest constraint (DD≤25, n≥150) + OOS walk-forward + robustness ±1.

Doc playbook tái dùng: `auto-rule-evolution-methodology.md` (pipeline 5 bước + guard-rails).

## 3. Forward-test (champion Calmar 7.16) — LIVE trên VPS

`champion-forward-logger.py` deployed `/var/lib/btc-trader/`, **cron mỗi giờ**, PAPER. Monitor: `python3 tools/champion-forward-monitor.py` (ssh-pull). Sizing gate: ≥3 tháng & ≥30 trades, WR 32-50%, equity>start. CHƯA size.

## 4. Audit production server + deploy v0.4.79

Audit `dist/` (code chạy thật): engine healthy (wallet $176, 2 pos, breakers OK, hedge01 funding-block + order exec + key security OK). **Finding HIGH: version drift** — turtle funding-gate (v0.4.79) chưa deploy. **Đã deploy** (verify post-deploy: 2 pos reconcile đúng, 0 error). Log thật `/var/log/btc-trader/error.log`. `/opt` không git-tracked. Doc: `btc-trader-server/docs/audit-deploy-2026-06-04.md`.

## 5. Loss autopsy → v4 insight

Mổ xẻ lệnh thua champion (WR 40%, 61% thua):
- **KHÔNG filter entry nào lọc được thua** — mọi feature bucket (ADX/ATR/EMA-dist) đều dương expectancy cả train+test. "Mua đỉnh bán đáy" là bản chất trend-following không khử được.
- **Không bỏ được sleeve nào** (kể cả BTC1h yếu — expectancy/lệnh +0.09% OOS nhưng lấp capital + volume → bỏ làm CAGR sụp 146→100).
- **Đòn bẩy thật = ETH** (sleeve tốt nhất test +3%/lệnh, under-utilized n=46). Mở ETH (ADX 18→15) = free Calmar 7.16→7.36.

## 6. Phương pháp tiếp cận (bàn, CHƯA build)

Tommy đặt vấn đề: đổi cách XỬ LÝ một signal thay vì indicator mới (indicator giá = ngõ cụt, đã test cạn RCI/macro). Hướng **probe→react**: vào 1/3 (probe) → đọc phản ứng giá → add lên full nếu xác nhận / cắt ngay nếu bác bỏ. Mục tiêu: thua rẻ hơn (1/3 size) + thắng full → bung R:R, không cần đoán đúng hơn. Khác DCA (add-thuận không add-ngược). **CHƯA test — việc tiếp theo.**

---

## Trạng thái cuối session

- **Daemon v3 ĐANG CHẠY** (gen ~400, pop best CAGR 186% DD 24.5%). Champion #1 committed. Monitor: `cat tools/evolver-v3-heartbeat.txt`. Dừng: `touch tools/evolver-STOP`. caffeinate OFF (Mac ngủ có thể dừng).
- Forward-test champion chạy VPS cron.
- Server LIVE v0.4.79 (turtle funding-gate deployed).

## Việc tiếp theo (mở)
1. Build + test **probe→react** signal-handling trên 7y giá
2. v3 daemon tự tìm ETH-expansion (đã có knob adxe/riske)
3. Verify consec-loss breaker trong dist production
4. Forward-test gate (~3 tháng) trước khi size champion
