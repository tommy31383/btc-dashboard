# PRE-REGISTRATION — A3: Structure Context (HH/HL/LH/LL, BOS/CHoCH)

**Locked:** 2026-06-11. FEATURE TRIAGE. Data ≤2026-06 = development. No candle labels, no auction.
**Phụ thuộc:** A3 chỉ chạy SAU khi A1 và A2 đã có baseline độc lập; A3 đo event **conditional** theo
state/acceptance của A1/A2 (interaction), không trộn định nghĩa lúc khóa.

## Hypothesis (hẹp)
Structure events (BOS/CHoCH) đơn lẻ — và conditional theo A1/A2 — có chứa thông tin forward return.

## Definitions (KHÓA — closed bars)
- Swing pivot fractal: `L=2` (rightBars=**2** → event xác nhận TRỄ 2 nến).
- Structure: HH/HL/LH/LL gán theo pivot cùng loại gần nhất. Trend = HH+HL(up)/LH+LL(down)/range.
- **BOS:** close vượt swing-high gần nhất khi trend đang UP (BOS_UP) / swing-low khi DOWN (BOS_DOWN).
- **CHoCH:** close vượt swing đối diện khi trend NGƯỢC (CHOCH_UP từ DOWN / CHOCH_DOWN từ UP).
- Event timing: dùng swing đã confirm (trễ L=2). **Đo bắt đầu ở cây kế tiếp** sau bar phá: base=close[i].

## Horizons (KHÓA): 1, 3, 6, 12 bar. TF 4h chính (+1h,1d stability).

## Metrics (KHÓA): mean/median forward return, directional hit-rate, MFE/MAE, range expansion,
rank-biserial (event vs no-event baseline) + p (Mann-Whitney).

## Conditional layer (KHÓA — chỉ sau khi A1/A2 xong)
- Đo event × A1-state KEEP-features và event × A2-accept. Multiple-testing tính LẠI gồm số interaction
  cells thực tế xét (báo rõ số test trước khi chạy lớp conditional).

## Sample minimums (KHÓA): ≥20 events/năm; ≥150 mỗi loại event toàn kỳ.

## Multiple testing (KHÓA): 4 event-type × 4 horizon = 16 (lớp đơn lẻ) → Bonferroni p<0.003125.
Lớp conditional: Bonferroni theo số interaction-cell (chốt trước khi chạy).

## Stability (KHÓA): per-year dấu nhất quán; neighborhood L∈{2,3}.

## Decision rule (triage)
KEEP nếu |rank-biserial|≥0.1, p<Bonferroni, dấu nhất quán năm, giữ qua neighborhood. Else DROP.
Không xuất `confidence`. A3 KHÔNG chạy trước A1/A2.
