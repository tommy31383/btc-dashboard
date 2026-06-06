# Research — Khi có tín hiệu thì thế giới VÀO LỆNH thế nào? (2026-06-04)

**Phương pháp:** deep-research harness — 6 góc → 25 nguồn fetch → 92 claim → verify adversarial 25 (20 confirmed, 5 killed) → synthesize.
**Bối cảnh áp dụng:** bot trend-following BTC/ETH/SOL futures Binance, vào MARKET sau khi rule HTF fire + LTF confirm (Phase 2), scale test $200.
**Nối với:** ý **probe→react** bàn cuối phiên (`session-2026-06-04-summary.md` §6) — đây là research để chuẩn bị build & test.

---

## TL;DR
Probe→react / scale-in là kỹ thuật THẬT, institution dùng rộng. NHƯNG bằng chứng định lượng: pyramiding đổi **DD sâu hơn + hit-ratio thấp hơn** lấy return cao (KHÔNG free alpha). Sizing nên scale theo conviction (edge) VÀ nghịch volatility, dùng **fractional Kelly ½–⅓**. Phần optimal-execution/VWAP/Almgren-Chriss **không áp dụng** cho scale nhỏ (market impact ≈ 0). **Override từ lesson-learn của mình:** chỉ scale-IN-on-WINNER đáng test (DCA-down đã chết — "cắt thắng cứu"), và **judge bằng DOLLARS không RA%**.

---

## 1. Probe→react / scale-in — CÓ THẬT, chuẩn institutional ✅
- Institution chia 1 quyết định thành nhiều lệnh con thay vì full 1 phát. Talos (data crypto thật 6/2024–7/2025): 50K lệnh mẹ → 50M lệnh con (~1000:1) trên top-60 spot+perp. Scale-in = vào thăm dò test thesis với ít vốn rủi ro trước khi commit full. *(vote 3-0 Talos; 2-1 scaling-in)*
- **Golden rule add (3-0):** chỉ add SAU KHI giá đi thuận + xác nhận (phá kháng cự phụ / higher-high), trail stop khi pyramid lớn dần. Confirmation-first = risk mitigant. *(blog corroborated, qualitative)*
- **Inverse pyramid (3-0):** size LỚN NHẤT ở entry đầu, add nhỏ dần (vd 1.0/0.5/0.25 hoặc 40/30/15/10/5%) → tổng risk ≤ risk ban đầu. Entry đầu R:R tốt nhất (stop gần nhất). Giới hạn 3-4 tầng. Equal-size adds = overleverage.

## 2. ⚠️ Pyramiding KHÔNG phải free alpha (3-0) — cạm bẫy chính
- Concretum (backtest 40 thị trường futures): VP+Pyramiding **MaxDD 48.69% vs 25.65%** vol-target, **Sharpe tháng THẤP hơn** dù IRR 20% vs 11.46%. Hit-ratio 39.3% vs 42.5%, avg trade 26.2bps vs 13bps, skew 3.74 vs 2.4.
- ⇒ pyramiding mua return cao bằng **DD sâu hơn + thắng ít trận hơn**, lời dồn vào vài winner đuôi-phải (fragile, có thể không lặp lại).
- Lý thuyết Cartea/Bank: hành động theo signal nâng CẢ expected return CẢ variance — lấy value phải gánh thêm risk.
- ❌ Con số headline "556,106% return" của pyramiding **bị BÁC 0-3**.

## 3. Sizing theo conviction + volatility ✅
- Size tỉ lệ với edge (Kelly) VÀ nghịch volatility. Vol-targeting nâng Sharpe 0.43→0.61 + cắt DD (Moreira-Muir; Harvey et al 60 assets). Hybrid Kelly-vol DD control tốt nhất (<11%).
- **Fractional Kelly ½–⅓, KHÔNG full Kelly (3-0):** half-Kelly ≈ 75% growth ở ~nửa variance (MacLean-Ziemba-Blazenko 1992). Full Kelly: lỗi edge 10% → over-bet ~50%; đường growth phẳng quanh optimum → under-bet rẻ, over-bet đắt.
- ⚠️ Số liệu vol-target là **equity/VIX, KHÔNG crypto** → bot phải thay bằng realized/percentile vol của chính BTC/ETH/SOL. Hướng transfer, magnitude không.

## 4. Order type & execution — phần lớn KHÔNG áp dụng ✅
- Almgren-Chriss / VWAP / child-slicing là để lo lệnh khổng lồ tránh market impact. Scale $200 → impact ≈ 0 → bỏ qua. Đòn bẩy còn lại: **timing** (confirm giảm fakeout) + **vol-aware sizing**.
- Market: chắc fill không chắc giá. Limit/stop-limit: chắc giá có thể miss fill. Slippage tăng vọt khi vol cao / news / gap.
- ❌ Bị bác: "VWAP beats TWAP" (0-3), "pre-position trước lệnh ngoài" (0-3), "move stop về breakeven trước khi add" (1-2), "optimal trajectory là static, không gain từ adaptive" (0-3 — tức KHÔNG có bằng chứng phủ nhận adaptive entry).

## 5. 🔴 OVERRIDE từ lesson-learn của mình (quan trọng nhất)
- Backtest 7y: DCA/averaging-down phá hủy dollar P&L. "CẮT thắng CỨU": martingale −$877 < DCA −$445 < cut@−3 −$63. Expectancy ở ENTRY, không ở xử-lý-lỗ.
- ⇒ **CHỈ scale-IN-on-WINNER (pyramiding thuận) đáng test.** Scale-in-on-adverse (DCA ngược) đã chết, không đào lại.
- **Judge bằng DOLLARS, không RA%** (hedge05: RA +0.153 nhưng −$417 thật).

---

## Open questions → hướng test
1. Pyramiding (add-on-winner, inverse size, confirm-gated) có thắng single full-entry tính **DOLLARS** trên harness 7y BTC/ETH/SOL không?
2. Trigger add tối ưu: bao nhiêu ATR thuận + LTF confirm gì thì add (vs single-shot hiện tại)?
3. Inverse-vol sizing (realized/percentile vol crypto, không VIX) có nâng Sharpe/cắt DD không, tương tác sao với breaker (dailyLossCap, consec-loss)?
4. Stop-limit/limit-on-pullback có hơn market-ngay tính cả tỉ lệ miss-fill (fakeout tránh được vs entry bỏ lỡ)?

---

## Nguồn chính (primary)
- Talos — empirical market-impact model in crypto trading (data thật 2024-25)
- Concretum — Position sizing in trend-following: vol-targeting vs vol-parity vs pyramiding
- arXiv 2306.00621 (Cartea/Bank signals), 2309.09094, 2508.16598 (vol-target/Kelly-vol)
- Almgren-Chriss optliq (optimal execution), MacLean-Ziemba-Blazenko 1992 (fractional Kelly)

**Caveat tổng:** số định lượng (DD 48.7%, Sharpe lift...) là equity/futures, KHÔNG crypto BTC/ETH/SOL — chỉ direction transfer. Pyramiding/Kelly findings dựa một phần blog nhưng corroborated bởi academic primary. 5 claim bị bác đã loại.
