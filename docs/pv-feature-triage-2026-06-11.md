# Price-Volume Feature Triage — CLOSED 2026-06-11

Pre-registered feature triage (A1/A2/A3), OHLCV-only, BTC, development data 2019..2026-06.
Mục tiêu: sàng lọc feature CÓ sức dự báo forward-return hay không — KHÔNG phải strategy.
Tất cả định nghĩa/threshold/horizon/metric/sample-floor/Bonferroni KHÓA TRƯỚC khi chạy.

## Kết quả: cả 3 protocol → DROP

| Protocol | Feature | n | Verdict | Lý do |
|---|---|---|---|---|
| **A1** Effort-vs-Result | candle-state (demand/supply/absorption/exhaustion) | 4h | **DROP** | |rb|≤0.061, không qua Bonferroni (p≥0.006), dấu ngược trực giác (DEMAND âm, SUPPLY dương) |
| **A2** Auction-Acceptance | balance→breakout→accept/reject | 4h underpowered (302 ev); 1h powered | **DROP** | 1h: |rb|≤0.105, không cell qua Bonferroni (p≥0.035), neighborhood ~0 |
| **A3** Structure-Context | BOS/CHoCH (single-event) | 4h | **DROP** | |rb|≤0.049, không qua Bonferroni (p≥0.13), median ngược mean (drift, không directional); delay pivot→confirm 5.2–6.4 bar |

A3 conditional layer (event × A1/A2): **SKIPPED = pre-specified dependency outcome** (A1&A2 DROP,
không KEEP-feature để condition) — không phải sửa protocol hậu nghiệm.

## Kết luận
Feature price-volume đơn giản (candle-state, auction acceptance, structure events) trên BTC
**KHÔNG có sức dự báo forward-return đo được** vượt baseline drift, theo chuẩn pre-registration
nghiêm (Bonferroni 16-test, effect-size ≥0.10, sample-floor, per-year + neighborhood stability).

Đây là kết quả TRIAGE đáng tin (không bị dredge đánh lừa như lần khám phá đầu chưa pre-register).
**Không candidate nào KEEP** → không ghi candidate cho live-forward, không tạo strategy/evolver.

## Kỷ luật đã giữ
- Pre-register trước; không sửa threshold sau khi xem kết quả; không rescue A2 underpowered bằng nới X/W.
- Dev data ≤2026-06 = development (đã nhìn 2026 → không gọi OOS). Validation thật chỉ là live-forward.
- Không xuất `confidence`. Không deploy, không production config.

## Artifacts
`docs/prereg-A{1,2,3}-*.md` (locked) · `tools/pv-A{1,2,3}-runner.py` · `tools/pv-A{1,2,3}-result*.json`.
Commits: A1 `4bd7487be`(+fix `43183592b`), A2 `9e94610bc`, A3 `e45043364`.

NHÁNH FEATURE-TRIAGE ĐÓNG. Mở lại chỉ bằng một giả thuyết KHÁC, định nghĩa khóa trước.
