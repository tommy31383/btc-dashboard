# Evolver v4 — Design + Research — 2026-06-04

**Mục tiêu:** thoát plateau của v3 (champion #1 giữ ~3000 gen) — từ "máy TINH CHỈNH param" → "máy KHÁM PHÁ rule mới", chạy không ngừng mà vẫn liên tục sinh giá trị.

---

## 1. Chẩn đoán v3 (vì sao đứng)
| Giới hạn | Hệ quả |
|---|---|
| `mutate` chỉ chọn threshold trong `AL.STEPS` + risk/cap | Không gian hữu hạn → quét cạn |
| Reuse `gen_4h/gen_1h` cố định (ADX/DI/RSI/Donchian/EMA200d) | KHÔNG tạo được signal type mới |
| Fitness 1 chiều (train Calmar) | Hội tụ 1 đỉnh, kẹt local-optimum |
| Không giữ đa dạng + seed neo champion | Quần thể co cụm quanh #1 |

**Kết luận:** v3 đã khai thác hết "mỏ" của 1 strategy family. Vượt #1 cần **mỏ mới** (primitive mới) + **cơ chế thoát đỉnh**.

---

## 2. v4 — 4 nâng cấp cốt lõi

### ① Thư viện PRIMITIVE mở rộng (đòn bẩy lớn nhất)
Thay vì signal cứng, v4 có **kho khối entry** ghép được (AND/OR), GA chọn *dùng cái nào + ghép sao*:
- **Trend-follow**: ADX/DI, Donchian breakout, EMA-stack, pullback-to-EMA continuation
- **Reversal** (research validated): RCI oversold + funding>0.05% (64% top precision)
- **Vol**: vol-squeeze breakout (BB width thấp → expand), ATR-percentile gate
- **Mean-rev RANGE**: Stoch/BB trong regime RANGE
- **Breakout-retest**: phá đỉnh → chờ retest mới vào (giảm fakeout)
- **Multi-TF confluence**: 1h+4h+1d cùng hướng

→ Genome = chọn ≤3 primitive + logic ghép + threshold. **Đây là chỗ ra rule MỚI**, không chỉ tune.

**Research note:** Vectorial GP (arXiv 2025) cho thấy primitive nên nhận **vector 21 bars** (4 tuần context) thay vì scalar — "scalar GP performed poorly overall". Áp dụng: mỗi primitive trong kho nhận chuỗi bars, không chỉ giá trị hiện tại.

**Primitive-level BTC edge screen:** Không có paper nào ablate từng primitive trên BTC 7y — **phải tự screen Phase A** trước khi cho vào kho.

### ② Multi-objective Pareto (NSGA-II) thay fitness 1 chiều
Tối ưu ĐỒNG THỜI {Sharpe, −MaxDD} làm base pair (validated empirically: 110 stocks, 10 markets — consistently outperforms SOO). Thêm −corr-vs-live nếu cần → 3 objectives → cân nhắc NSGA-III.

**Research findings (confirmed high confidence):**
- NSGA-II + {Sharpe, −MaxDD} outperforms SOO kể cả khi pick 1 nghiệm từ Pareto front
- NSGA-II crowding distance tốt cho 2 obj; NSGA-III reference-point tốt hơn cho 3+ obj
- Claim "NSGA-II chỉ effective 2 obj" bị **refute** — vẫn work với 3 obj, NSGA-III chỉ tốt hơn ở high-dim

**GT-Score** (arXiv 2602.00080, 2026) — composite robustness metric thay Calmar:
- Gồm: performance + statistical significance + consistency + downside risk
- Design confirmed (3-0 vote). Magnitude "+98% generalization" bị refute (1-2) → đừng tin con số, nhưng design sound
- **Đề xuất:** thử GT-Score như fitness thay Calmar trong MAP-Elites quality metric

### ③ Quality-Diversity (MAP-Elites) — hợp "chạy không ngừng"
Archive nghiệm theo **behavior descriptor** (tần suất lệnh × avg-hold × WR-bucket × regime-active). Mỗi ô giữ elite riêng → ép khám phá **mọi ngách chiến lược**, daemon càng chạy càng lấp đầy bản đồ, KHÔNG bao giờ "hội tụ chết" như v3.

**Research findings (confirmed high confidence):**
- MAP-Elites: uniform random bin selection, 1 fittest per bin, diversity passively acquired
- **Proven**: (1−1/e)-approximation polynomial time trên NP-hard problems mà standard EA cần exponential time (Doerr & Qu, IJCAI 2024)
- **Gap quan trọng:** Chưa có paper nào apply MAP-Elites cho trading rule genome (gene-level OHLCV). Evolver v4 sẽ là **first-of-kind** — rủi ro implementation cao hơn nhưng potential cao

**Behavior descriptor cho trading (open question — phải tự thiết kế):**
- Gợi ý: dim1 = trades/year bucket (thưa/vừa/dày), dim2 = avg-hold bucket (scalp/swing/position), dim3 = regime-preference (RANGE/BULL/mixed)
- Aligned BC (correlated với quality) tốt hơn unaligned — cần validate sau khi chạy

### ④ Validation chống overfit mạnh hơn
- **Purged + embargoed walk-forward CV** (López de Prado AFML) — chặn leakage giữa train/test
- **Held-out tail** (2025H2-2026) KHÔNG đụng trong evolve, chỉ test cuối → gate promote
- Robustness ±1 (giữ từ v3) + **Monte-Carlo trade-shuffle** ước lượng phân phối DD

**Research findings (critical gap):**
- **Zero confirmed paper** apply purged/embargoed CV cho trading strategy evolution — toàn bộ literature dùng rolling-window 2y+1y
- Implementation theo AFML: embargo gap ≈ **42 bars 4h (~1 tuần)** cho BTC 4h data — không có empirical benchmark trên crypto, phải tự calibrate
- Purge loại bỏ training samples có label overlap với test window; embargo thêm gap buffer sau purge

---

## 3. Kiến trúc đề xuất
```
v4 = MAP-Elites (archive theo behavior descriptor)
   + genome = [primitive-set + combine-logic + thresholds + per-sleeve risk]
   + eval = honest single-account margin-cap (reuse honest_resim_v3)
   + fitness = GT-Score (perf + significance + consistency + downside) thay Calmar
   + objectives = {Sharpe, −MaxDD} NSGA-II; thêm −corr-vs-live → NSGA-III
   + promote gate = purged-WF (embargo ~42 bars) + held-out tail + robustness ±1
   + island model (3 đảo, migrate mỗi N gen) cho đa dạng + song song
   + auto-commit khi 1 ô archive cải thiện đáng kể
```

## 4. Output kỳ vọng
- KHÔNG chỉ 1 champion mà **1 BOOK rule đa dạng low-corr** → ghép thành portfolio
- Daemon "chạy không ngừng" có ý nghĩa thật: luôn còn ngách trống để lấp

## 5. Rủi ro / lưu ý
- **Overfit tăng theo độ biểu đạt** → validation (④) là bắt buộc, không nhân nhượng
- Primitive mới phải mỗi cái **screen riêng 7y** trước khi cho vào kho (tránh rác)
- Vẫn **judge DOLLARS honest single-account** (lesson cũ), KHÔNG flat-per-sleeve
- MAP-Elites cho trading rule genome chưa có precedent — implement cẩn thận, validate behavior descriptor alignment sớm
- GT-Score magnitude chưa verified — dùng như direction, không đặt kỳ vọng số cụ thể

## 6. Lộ trình build (đề xuất)
1. **Phase A**: viết kho primitive + screen từng cái 7y (loại rác) — nền tảng
2. **Phase B**: MAP-Elites engine + NSGA-II/GT-Score + honest eval (reuse v3)
3. **Phase C**: purged-WF (embargo ~42 bars 4h) + held-out gate + auto-commit + watchdog
4. **Phase D**: chạy song song v3 (không tắt v3), so output

---

## 7. Research sources (deep-research 2026-06-04)
| Claim | Confidence | Source |
|---|---|---|
| MAP-Elites mechanism (uniform bin, passive diversity) | High | Mouret & Clune 2016 (Frontiers) |
| MAP-Elites polynomial-time proof vs EA exponential | High | Doerr & Qu, IJCAI 2024 (arXiv:2401.10539) |
| NSGA-II Sharpe+MaxDD outperforms SOO, 110 stocks | High | AI Review 2025 + Comp.Econ 2024 |
| GT-Score 4-component design | High | arXiv:2602.00080 (2026) |
| Vectorial GP 21-bar outperforms scalar GP | Medium | arXiv:2504.05418 (preprint 2025) |
| Rolling-window dominant (purged-CV gap in literature) | Medium | Comp.Econ 2024 |
| MAP-Elites applied to trading rule genome | — | **No paper found — first-of-kind** |
