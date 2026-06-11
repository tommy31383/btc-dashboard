# Lessons Learned — 2026-06-11 (regime persistence, #6, chart V2)

Phiên fix review dashboard-trust + regime: 2 repo `btc-trader-server` + `btc-dashboard`.

## Việc đã làm (kết quả cuối)

| Hạng mục | Kết quả | Commit |
|---|---|---|
| **P0** regime persistence | Bug: `applyPersistence` đếm theo eval-tick (60s) → lật regime sau ~3 PHÚT thay vì N NGÀY. Fix = **Option B timestamp-guard** (`stepRegimePersist`, chỉ step khi closed daily bar mới) | trader-server |
| **persistBars** | Walk-forward Codex 2-split → **chốt pb=1** (3→1) | `db372fa` |
| **P1** ETag | Fingerprint OHLCV cây cuối → hết đóng băng partial candle | trader-server |
| **#6** regime redesign | Backtest 7y train/OOS → **GIỮ baseline A**, C/D rejected, E research-only | `REGIME_CLASSIFIER_v1` |
| **3A/3B** dashboard | Tách confirmed (closed bars) vs provisional; nhãn MARK/SPOT + DATA AGE | dashboard |
| Test | `regime.test.mjs` 6/6 (idempotency, parity, pb=1 live) | trader-server |

## Bài học KỸ THUẬT

1. **Persistence/debounce phải gate theo BAR-TIME, không theo eval-tick.** Bất kỳ counter "N consecutive" nào chạy trong loop eval 60s mà input chỉ đổi theo closed bar → sẽ tăng sai nhịp. Lưu `lastBarTime`, chỉ step khi bar mới.
2. **Đừng mặc định "chậm hơn = an toàn hơn".** `persistBars=3` (3 ngày) tưởng chống whipsaw tốt, nhưng backtest 7y + walk-forward: **pb=1 (phản ứng ngay mỗi daily close) thắng** cả Sharpe lẫn $. Comment code ghi "=3" không phải bằng chứng.
3. **"Cây cuối là partial" KHÔNG được giả định bằng `slice(0,-1)`.** Phải dùng metadata thật (`closeTime`/`isClosed`). Dataset toàn closed-bars sẽ bị `slice(0,-1)` bỏ nhầm cây hợp lệ. Server đã có sẵn `closeTime/isClosed` trong Kline → client lọc theo đó.
4. **Dashboard từng trộn 3 loại giá vào 1 field** (`price`): server-WS = MARK (futures), fallback = SPOT last. Header ghi cứng "SPOT" trong khi hiện mark → sai. Luôn ghi `source` + `priceTs` (DATA AGE).

## Bài học QUY TRÌNH (quan trọng hơn)

5. **Backtest TRƯỚC khi deploy đã chặn 2 thay đổi sai:** (a) #6 redesign C/D trực giác "đẹp hơn" nhưng kém baseline / chỉ lời nhờ re-enter real-bear; (b) suýt giữ pb=3 vì comment. Real-money: trực giác không thay được số liệu.
6. **Walk-forward đúng chuẩn:** chọn tham số CHỈ bằng train, mở OOS đúng 1 lần, ≥2 split độc lập. pb=1 thắng Split1 OOS + hòa Split2 OOS → robust, không phải artifact 1 split. Full-7y in-sample một mình KHÔNG đủ để chốt live.
7. **Không kết luận "tốt nhất 7y" nếu dataset thiếu giai đoạn quan trọng.** Bản 3y thiếu real-bear 2022 + funding → không test được mặt bảo vệ. Phải fetch đủ 7y + ghi **checksum/span/source/ngày fetch** (provenance) vào registry.
8. **Test phải KHÓA behavior LIVE, không phải behavior cũ.** Sau khi flip pb=1, test vẫn hardcode pb=3 → `npm test` PASS nhưng không bảo vệ gì. Audit bắt đúng. → thêm test pb=1.
9. **Doc/registry phải khớp HEAD thực tế.** "default=3, pb=1 pending" trong khi HEAD đã pb=1 → audit/deploy sau hiểu sai. Ghi rõ trạng thái: **deployed-in-code ≠ deployed-to-VPS**.
10. **Option A vs B:** khi user bấm chọn nhanh (A) mâu thuẫn với comment chi tiết (B), comment chi tiết là ý định thật. Đã rework A→B. Hỏi lại khi conflict thay vì giữ lựa chọn nhanh.
11. **Hard-to-reverse = real-money deploy.** Mọi thay đổi hành vi trading: commit + test + backtest pass nhưng **KHÔNG tự deploy VPS** — chờ lệnh tường minh. "commit" ≠ "deploy".

## Còn treo
- pb=1 + timestamp-guard + 3A/3B: **deployed-in-code, CHƯA lên VPS** (`./deploy.sh`).
- Dashboard 3A/3B: chưa tạo HTML preview, chưa build APK.
- Hysteresis score (enter/exit threshold khác nhau) cho trend zone: chưa test — hướng nghiên cứu riêng.
