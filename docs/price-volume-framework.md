# Price-Action + Volume Framework (OHLCV-only) — 2026-06-11

Bộ kiến thức đọc chart **chỉ bằng giá (OHLC) + volume**. KHÔNG dùng RSI/EMA/MACD/Bollinger/StochRSI
hay bất kỳ indicator phái sinh nào. "Trung bình" duy nhất xuất hiện là để **chuẩn hoá** range &
volume (so cây hiện tại với nền gần đây) — không phải tín hiệu dự báo.

Engine tham chiếu: `tools/pv-structure-engine.py` · Chart: `assets/pv-chart.html`.

---

## 1. Swing pivot (fractal)
- **Pivot High** tại nến `i`: `high[i]` ≥ high của `L` nến mỗi bên (mặc định `L=2` → fractal 5 nến) và cao hơn thực sự ít nhất 1 nến.
- **Pivot Low**: đối xứng với `low`.
- Pivot **xác nhận trễ `L` nến** (cần đủ nến bên phải) → không lookahead. Đây là đơn vị cơ bản của mọi phân tích structure/S-R bên dưới.

## 2. Market structure (HH/HL/LH/LL)
Lấy chuỗi pivot xen kẽ, gắn nhãn so với pivot CÙNG LOẠI gần nhất:
- **HH** (higher high) / **HL** (higher low) → phe mua kiểm soát.
- **LH** (lower high) / **LL** (lower low) → phe bán kiểm soát.
- **Uptrend** = chuỗi HH + HL. **Downtrend** = LH + LL. **Range** = đan xen không nhất quán.

## 3. BOS & CHoCH (xác nhận bằng CLOSE, không phải wick)
- **BOS (Break of Structure):** close vượt swing-high gần nhất (BOS↑) / swing-low (BOS↓) — xác nhận trend hiện tại tiếp diễn.
- **CHoCH (Change of Character):** BOS **đầu tiên ngược hướng** structure đang chạy → dấu hiệu sớm đổi trend (vd đang DOWN mà close vượt swing-high → CHoCH↑).
- Dùng **close** để tránh nhiễu wick. Engine track `recentSwingH/L` và cập nhật `trend` mỗi nến.

## 4. Support / Resistance (cụm pivot)
- Gom các pivot có giá nằm trong `SR_TOL=0.6%` của nhau thành 1 **level**; số pivot trong cụm = **strength (touches)**.
- Chỉ giữ level có **≥2 touch**. Level nhiều touch = vùng giá phản ứng mạnh (cung/cầu).
- Đỉnh/đáy cũ (swing) tự nhiên thành S/R; round number có thể thêm thủ công.

## 5. Volume (chuẩn hoá theo avg gần đây)
- `avgVol` = SMA volume `VOL_LB=20` (chỉ để so sánh, không dự báo).
- **Spike:** `vol ≥ 1.8× avgVol` — có lực.
- **Climax:** `vol ≥ 2.5× avgVol` KÈM range lớn — kiệt sức/đảo chiều tiềm năng (Wyckoff: effort cao).
- **Dry-up:** `vol ≤ 0.6× avgVol` — cạn lực, hay gặp ở pullback lành mạnh hoặc cuối range.
- **Volume confirm breakout:** BOS/CHoCH **đáng tin hơn** khi nến phá có volume ≥ avg (engine gắn `volConfirm`). Phá vỡ volume cạn = dễ là bull/bear trap.

## 6. Candle / range (price thuần)
- `body=|c-o|`, `upWick=h-max(c,o)`, `dnWick=min(c,o)-l`, `range=h-l`; `avgRange`= SMA range 20.
- **Large-range bar:** `range ≥ 1.8× avgRange` — bứt phá/biến động mạnh.
- **Rejection:** `upWick > 2×body` (chối bán phía trên) / `dnWick > 2×body` (chối mua phía dưới) — đảo chiều tại biên.
- **Inside bar:** `h≤prevH & l≥prevL` (nén, sắp bung). **Outside bar:** `h>prevH & l<prevL` (nuốt, biến động).

---

## Cách đọc tổng hợp (effort vs result — Wyckoff-lite)
1. **Xác định structure** (HH/HL hay LH/LL) → biết phe nào kiểm soát.
2. **Chờ BOS/CHoCH** xác nhận tiếp diễn / đảo chiều — bằng **close**.
3. **Lọc bằng volume:** breakout có spike = thật; volume cạn = nghi trap. Climax + rejection tại S/R cũ = cảnh báo đảo chiều.
4. **Vào vùng S/R** (cụm pivot nhiều touch) là nơi xác suất phản ứng cao nhất.
5. **Range vs trend:** trong range → fade biên (rejection + dry-up); trong trend → theo BOS, mua HL/bán LH.

## Giới hạn (thẳng thắn)
- Pivot trễ `L` nến → tín hiệu structure luôn chậm `L` bar (đánh đổi để không lookahead).
- Khung này **mô tả + chú giải**, CHƯA phải chiến lược đã backtest. Muốn đưa vào bot phải backtest/walk-forward như [[backtest-before-live-change]] (xem `REGIME_CLASSIFIER_v1` làm mẫu quy trình).
- Tham số (L, các mult, tol) là điểm khởi đầu hợp lý, **không phải tối ưu** — đừng tune trên live data.
