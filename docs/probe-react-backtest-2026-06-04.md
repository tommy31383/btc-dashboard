# Probe→react / Pyramiding — Backtest validate (2026-06-04)

**Status:** BACKTEST validated trên BTC 4h 7y · **CHƯA test ETH/SOL · CHƯA deploy.**
**Script:** `tools/probe-react-pyramid-7y.py` (modes: `full` | `wf` | `honest` | `matched`).
**Nối:** research `research-signal-entry-execution-2026-06-04.md` + ý probe→react session 4/6 §6.

---

## Thiết kế (isolate biến ENTRY-HANDLING)
Cùng signal G1 (ADX>20+DI+RSI-dip+EMA200+funding-gate) BTC 4h, cùng SL 2×ATR, cùng max-hold 60 (10d).
Chỉ đổi cách vào:
- **A. Baseline** — full size ngay.
- **B. Probe→react** — vào ⅓ (probe). Giá đi thuận ≥ K×ATR trong W nến → add ⅔ lên full. Chạm probe-SL hoặc hết W nến chưa confirm → cắt phần đang mở (thua rẻ ⅓).
- **C. Inverse-pyramid** — full ngay → add ½N tại +1ATR, ¼N tại +2ATR. Margin-cap 1.75N.

Judge: DOLLARS + DrawDown + per-year (theo lesson "judge dollar, không RA").

---

## Kết quả

### 1. Fixed-notional 7y (mode `full`)
| Variant | net | MaxDD | Return/DD | WR | năm dương |
|---|---|---|---|---|---|
| A baseline | $34,184 | $18,615 | 1.84 | 34% | 5/8 |
| B (K0.5/W12) | $40,292 | $14,232 | 2.84 | 29% | 6/8 |
| C inv-pyramid | $58,388 | $28,373 | 2.05 | 31% | 5/8 |
- B cứu năm chop 2022 (−$4,257 → +$116) → 6/8 năm dương. C raw-net cao nhất nhưng DD sâu + 75% leverage hơn.

### 2. Walk-forward (mode `wf`) — ⚠️ CẤM TUNE K/W
- Chọn B theo TRAIN 2019-23 return/DD → cell train-best (K1.5/W12, rDD 2.29) **SẬP OOS** (test rDD 0.40 < A 1.70).
- Train ranking KHÔNG transfer sang test → **tune K/W = overfit**.
- Nhưng đa số cell B vẫn ≥ A trên test, và **giảm DD là robust** (mọi B test-DD ≤ A). → dùng param CỐ ĐỊNH hợp lý, đừng optimize.

### 3. Honest compounding (mode `honest`, size=10%×equity, K1.0/W6 fixed)
| Variant | final Eq | CAGR | MaxDD | Calmar |
|---|---|---|---|---|
| A baseline | $135,157 | 4.2% | 17.4% | 0.24 |
| B probe→react | $127,812 | 3.4% | 10.3% | 0.33 |
| C inv-pyramid | $161,906 | 6.7% | 25.6% | 0.26 |
- Ở **size bằng nhau**: B thua dollar (xài chưa hết room rủi ro), đổi 0.8pp CAGR lấy 40% giảm DD.

### 4. ✅ Matched-DD (mode `matched`) — SO CÔNG BẰNG, verdict cuối
Bơm size tới cùng DD ≈ 17.4% (baseline):
| Variant | exposure | CAGR | MaxDD | final Eq | Calmar |
|---|---|---|---|---|---|
| A baseline | 10% | 4.2% | 17.4% | $135,157 | 0.24 |
| **B probe→react** | 17% | **5.4%** | 17.0% | **$147,912** | **0.32** |
| C inv-pyramid | 7% | 5.0% | 18.5% | $143,034 | 0.27 |

---

## ✅ VERDICT
1. **Probe→react THẮNG khi judge matched-DD**: cùng rủi ro 17.4%, **+$12,755 (+9.4% equity)** so baseline. Đây là **dollar edge thật**.
2. Cơ chế = **capital-efficiency**: thua nhỏ ⅓ trên lệnh bị bác → tiết kiệm DD budget → size lớn hơn ở cùng risk. KHÔNG phải đoán đúng hơn.
3. **Calmar: B 0.32 > C 0.27 > A 0.24**; B phẳng khi scale (robust, linear).
4. **Probe→react > inverse-pyramid** (ít leverage, Calmar cao hơn) → ý Tommy hơn cách institutional hay dùng.
5. ⚠️ **CẤM tune K/W** (walk-forward = overfit). Dùng fixed K=1.0/W=6 (untuned middle, đã đủ).

## Còn lại trước deploy
- Test ETH + SOL + signal khác (G2/G5) — benefit có general không.
- Cắm vào honest single-account autoloop multi-sleeve (thay fixed-notional toy).
- Slippage trên leg add (hiện fill tại trigger price, optimistic).
- Đưa vào engine LIVE paper: single-shot MARKET → probe ⅓ → add ⅔ on LTF/ATR confirm.
