# Lessons Learned — Price-Volume research branch (2026-06-11)

Nhánh: phân tích price-action + volume (OHLCV-only) → engine → chart → PV_EVOLVER_v1 →
PV_EVOLVER_v2 → robustness audit. Kết thúc `RESEARCH_ONLY_FRAGILE`, KHÔNG chạm live.
Artifacts: `tools/pv-*`, `docs/price-volume-framework.md`. Verdict push `a6be3c5f6`.

## Kết quả từng bước
1. **Framework + engine + chart** (OHLCV thuần): swing pivot, HH/HL/LH/LL, BOS/CHoCH (close-confirmed), S/R cụm, volume spike/climax/dry-up. Mô tả tốt, chưa phải strategy.
2. **Backtest tay (4h 7y):** LONG `CHoCH↑ + volume-confirm` + exit-theo-structure-flip = expectancy dương (+0.44R, +99.7R/7y, 6/8 năm). SHORT thua; TP cố định làm hỏng đuôi lời. Volume filter đo được giá trị.
3. **PV_EVOLVER_v1** (scoring lỏng, totR thô): "champion" 4h L5 volMult2.47 — nhưng chọn-trên-train + 1-split, và khi mở OOS chỉ **n=1** → vô nghĩa.
4. **PV_EVOLVER_v2** (gates nghiêm: shrinkage expectancy, freq floor, concentration ≤30%, behavior-diversity): top-score TRƯỢT concentration; champion eligible có **median R âm** + **param cliff** (sensitivity volMult+0.2: +37→−45).
5. **Robustness audit:** chỉ 5% hàng xóm pass gate, q25 −48, cluster 33% → `RESEARCH_ONLY_FRAGILE`. Điểm tự nó dương (bootstrap CI dương, chịu phí 2x) nhưng KHÔNG có plateau.

## Bài học QUY TRÌNH (quan trọng nhất)
1. **Scoring lỏng giấu lỗi; scoring nghiêm phơi bày sự thật.** v1 (totR thô) cho "champion" trông ngon; v2 (shrinkage + freq + concentration) lộ ngay fat-tail + fragility. Thiết kế metric quan trọng hơn chạy nhiều round.
2. **Expectancy dương ≠ tradeable.** Champion v2 có median R **âm** — lời chỉ từ đuôi phải. Luôn báo median + profit factor + concentration, không chỉ mean R.
3. **Một điểm tối ưu ≠ edge.** Phải có **parameter plateau**: đo neighborhood (median + worst-quartile), %hàng-xóm-pass-gate, behavior-cluster. Đỉnh nhọn = overfit, dù bootstrap điểm đó dương.
4. **Concentration gate bắt fat-tail.** Nếu 1 trade > 30% tổng R → edge không đáng tin (vài winner gánh cả). Trend signal hay vướng cái này.
5. **OOS là tài nguyên dùng MỘT LẦN.** Mở OOS cho champion freeze đúng 1 lần; khi đã nhìn 2026 thì **toàn bộ ≤2026-06 thành development data**, không được "tạo OOS mới" bằng cách đổi cửa sổ. Validation thật kế tiếp chỉ là **live-forward paper** sau freeze.
6. **Frequency floor phải theo từng năm/window, không chỉ tổng.** v1 MIN_TRADES=40 trên 4 năm → champion ~6 lệnh/năm → OOS 6 tháng chỉ 1 lệnh, không validate được. v2 thêm ≥5/window + ≥8/năm + no-zero-year.
7. **Bootstrap/fee-stress không cứu được structural fragility.** Champion qua bootstrap + phí 2x nhưng vẫn reject vì neighborhood là cliff. Robustness cấu trúc ≠ ổn định thống kê của một điểm.
8. **Pre-registration.** Bước hợp lệ tiếp theo chỉ là **giả thuyết khác, định nghĩa khóa TRƯỚC** — không tune lại cùng search space để cứu candidate đã biết fragile.

## Bài học KỸ THUẬT
- Reproducible: seed cố định, checkpoint atomic (tmp+rename), resume. Re-run cho HOF y hệt (chỉ timestamp khác).
- Versioned search space + manifest (seed, data sha256, windows, weights, gates) → audit/deploy không hiểu nhầm.
- Diversity theo **behavior** (Jaccard tập timestamp lệnh) bắt trùng-hành-vi mà khoảng-cách-tham-số bỏ sót.
- `git add -f` cho artifact bị .gitignore khi đã được phép ghi (vd oos-result một-lần).

## Trạng thái cuối
Candidate = `RESEARCH_ONLY_FRAGILE`. Không paper logger, không production, không deploy. Nhánh đóng.
Liên quan memory: [[price-volume-branch-closed]], [[backtest-before-live-change]], [[commit-not-deploy]].
