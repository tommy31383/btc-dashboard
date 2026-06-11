# PRE-REGISTRATION — A2: Auction Acceptance (balance → breakout → accept/reject)

**Locked:** 2026-06-11. FEATURE TRIAGE. Data ≤2026-06 = development. No candle labels, no structure
labels, no TP/SL/sizing. Volume CHỈ là biến phân tầng (stratifier), KHÔNG gate.

## Hypothesis (hẹp)
Acceptance ngoài balance range (so với rejection) có chứa thông tin về forward return / range expansion.

## Definitions (KHÓA — closed bars)
- **Balance range:** trên cửa sổ W=**20** bar, hi=max(high), lo=min(low). "Balanced" nếu
  `(hi-lo)/medRange50 ≤ X=4.0` (nén). Range edges = hi/lo của W bar đó.
- **Breakout (tại i):** close[i] > hi (up) hoặc close[i] < lo (down), trong khi i-1 còn trong range.
- **Acceptance:** K=**2** nến SAU breakout giữ close ngoài edge cùng phía → `ACCEPT`.
- **Rejection:** trong K nến có close quay lại trong [lo,hi] → `REJECT`.
- Event timing: breakout xác nhận tại close[i]; acceptance/rejection xác nhận tại i+K (rightBars=K).
  **Đo bắt đầu ở cây kế tiếp sau khi nhãn accept/reject ĐÃ biết** (i+K+1), base=close[i+K].

## Volume stratifier (KHÓA — không gate)
- Phân breakout-bar theo volRatio tercile (low<0.8, mid, high>1.5) chỉ để báo cáo theo tầng.

## Horizons (KHÓA): 1, 3, 6, 12 bar (từ i+K). TF 4h chính (+1h,1d stability).

## Metrics (KHÓA): mean/median forward return, directional hit-rate, MFE/MAE, future range expansion,
rank-biserial (ACCEPT vs REJECT) + p (Mann-Whitney normal approx).

## Sample minimums (KHÓA): ≥30 events/năm để stability; ≥150 ACCEPT và ≥150 REJECT toàn kỳ.

## Multiple testing (KHÓA): 2 nhóm (ACCEPT, REJECT) × 4 horizon × 2 hướng(up/down) = 16 → Bonferroni
α=0.05 → p<0.003125.

## Stability (KHÓA): per-year dấu nhất quán; neighborhood W∈{15,20,30}, X∈{3,4,5}, K∈{1,2,3}.

## Decision rule (triage)
KEEP nếu ACCEPT-vs-REJECT có |rank-biserial|≥0.1, p<Bonferroni, dấu nhất quán theo năm, giữ qua
neighborhood. Else DROP. Không xuất `confidence`.
