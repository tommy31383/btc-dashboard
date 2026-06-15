# Bear Rule Evolver — Design (2026-06-09)

Daemon local chạy vô hạn, tự khám phá rule entry MỚI (SHORT đỉnh + LONG đáy) từ
bối cảnh bear, backtest, qua cổng chống-mirage, giữ champion. Mục tiêu: nhiều entry
+ ROI tốt hơn mà KHÔNG phải mirage (bài học capitulation-bottom: in-sample fit +
concentration + long-beta trá hình).

## Nguyên tắc
- KHÔNG dùng kiến thức cũ làm đặc quyền: oscillator (RSI/Stoch) chỉ là 1 feature
  trong ~25, không hardcode K<20. Để search + gate tự chọn.
- Edge phải là ALPHA, không phải long-beta. Phải beat B&H + EMA200-long proxy.
- Judge bằng gate (drop-top-winners, beat-benchmark, per-year, OOS), KHÔNG bằng
  compound thô.

## Kiến trúc (cách C: signature-seed + genetic refine)

### 1. Data + bear segmentation
- Cache 7y BTC 5m → aggregate daily + 4h + 1h.
- Bear segment = drawdown ≥20% từ ATH rolling (hoặc daily close < EMA200d kéo dài).
- Trong bear: tìm swing tops/bottoms tradeable (local extrema ±W + move ≥10% trong FWD ngày).

### 2. Feature library (~25, causal/past-only)
price-action: consUp/consDown, lowWick%, upWick%, body%, gap%, posRange30, dropFrom20H,
riseFrom20L, volRatio20; vol: atrPct, atrRatio; trend: vsEMA50, vsEMA200, ema50slope,
ema200slope; oscillator: rsi, stochK, bbPctB; structure: dist-to-recent-high/low, daysSinceExtreme.

### 3. Candidate (genome)
`{dir: SHORT|LONG, conds: [(feat, op<>, thr)] (1-4), sl: ATR×, trail: ATR×, maxhold}`
- Random init + mutate (đổi thr, thêm/bớt cond, đổi management) + crossover champion.

### 4. Backtest (causal, % return)
- Entry tại close nến tín hiệu; exit: stop=entry∓SL×ATR / trail=peak∓TR×ATR / time maxhold.
- No-overlap (1 vị thế/lúc). Fee round-trip 0.08%. Per-year + per-trade returns.

### 5. CỔNG kiểm định (lõi)
- 🔒 HARD: drop-top-3-winners vẫn dương (chống concentration).
- 🔒 HARD: return > B&H VÀ > EMA200-long proxy (chống long-beta).
- ➕ per-year stability ≥ 5/8.
- ➕ min entries ≥ 3/năm (đủ mẫu, không thin).
- ➕ walk-forward OOS: fit nửa đầu / test nửa sau → cả 2 nửa dương.
- Score = ưu tiên rule qua ĐỦ gate, rồi xếp theo (OOS-return × stability).

### 6. Champion store + loop
- champions.json (top N qua-gate). Mỗi vòng: sinh challenger → backtest → gate →
  nếu beat champion yếu nhất thì thay. Log mỗi vòng. Chạy `nohup`, dừng = `touch bear-evolver-STOP`.

### 7. Output
- bear-evolver-champions.json + log + HTML dashboard (rule, entries/năm, ROI OOS,
  điểm từng gate, per-year) để Tommy mở xem.

## Files
- tools/bear-rule-evolver.py (daemon)
- docs/bear-rule-evolver-design.md (this)
- /tmp hoặc tools/ output: bear-evolver-champions.json, bear-evolver.log, dashboard html

## Chạy
`nohup python3 tools/bear-rule-evolver.py > tools/bear-evolver.log 2>&1 &`
Dừng: `touch tools/bear-evolver-STOP`
