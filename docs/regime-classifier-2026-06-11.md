# Regime classifier + persistBars backtest — 2026-06-11

**Câu hỏi:** (#6) có nên đổi định nghĩa BEAR của `regime.ts` (death-cross / slope / drawdown)
thay cho MA200 hiện tại? Và (#P0) `persistBars` mặc định = 3 có tối ưu không?

**Tool:** `tools/regime-classifier-7y-local.py` (faithful hedge01 v0.4.79 + turtle, gate regime).
**Engines:** hedge01 v0.4.79 (ADX18/12, SL3.0/3.5/64h, ATR_BREAK1.3, VOLMA16×1.4, Donchian18,
EMA gates, ATR%ile50, skip h16+Thu/Sun, funding-block 0.05%, RANGE-only LONG) + turtle (Don20/10,
cut1.5, skip-BEAR). Capital $100k, fee 0.05%/side.

## Dataset (provenance)

| File | SHA256 (16) | Size | Records | Span | Source | Fetched |
|---|---|---|---|---|---|---|
| `.cache/binance-1h-7y.json` | `D7CF3C66FC438B69` | 6.4 MB | 59,219 (1h) | 2019-09-08 → 2026-06-11 | `fapi.binance.com /fapi/v1/klines` BTCUSDT 1h | 2026-06-11 |
| `.cache/binance-funding-7y.json` | `89AC541F38568E7C` | 0.5 MB | 7,398 | 2019-09-10 → 2026-06-11 | `fapi.binance.com /fapi/v1/fundingRate` BTCUSDT | 2026-06-11 |

1h klines aggregate → 4h/1d (5m không cần cho daily-regime + 4h-signal engines). Fetcher:
`tools/fetch-7y-local.py`.

## Classifiers tested (chỉ đổi định nghĩa BEAR; BULL giữ nguyên)

- **A** `close<MA200` — baseline = `regime.ts` hiện tại
- **B** `close<MA200 & close<MA50`
- **C** `close<MA200 & MA50<MA200` (death-cross)
- **D** `close<MA200 & MA200 slope<0` (30d)
- **E / E15 / E25 / E30** drawdown-from-rolling-high > 20/15/25/30%

## Kết quả #6 — train (2019–2023) / OOS (2024–2026), hedge01 Sharpe

| cls | TRAIN Sh | OOS Sh | Verdict |
|---|---|---|---|
| **A** | 1.32 | **2.04** | ✅ KEEP (robust cả train+OOS, bảo vệ real-bear 2022/2026 = 0%) |
| B | 1.28 | 1.68 | ❌ rejected (OOS kém + leak 2022/2026) |
| C | 1.22 | 1.77 | ❌ **rejected** (kém A cả train+OOS) |
| D | **1.41** | 1.78 | ❌ **rejected** (cao nhất TRAIN nhưng OOS < A → overfit; full-7y chỉ lời nhờ re-enter real-bear 2022 −15%) |
| E / E15 / E25 / E30 | 1.00–1.04 | 1.76–2.09 | ⚠️ **RESEARCH-ONLY** (train tệ nhất, OOS erratic — không robust, KHÔNG đưa live) |

**Chốt #6:** GIỮ NGUYÊN `regime.ts` (classifier A). Không deploy C/D. E* = research-only.
Full-7y guard: 2022 & 2026 (real bears) A giữ flat 0%; D/B re-enter (−10…−15%) → fail protection.

## Kết quả P0 — persistBars sweep (classifier A), hedge01

| persistBars | TRAIN Sh | TRAIN $ | OOS Sh | OOS $ | full-7y Sh | full-7y $ |
|---|---|---|---|---|---|---|
| **1** | **1.55** | +155,664 | **2.13** | **+123,503** | **1.70** | **+279,167** |
| 2 | 1.45 | +144,807 | 2.04 | +119,771 | 1.62 | +264,578 |
| 3 (default hiện tại) | 1.32 | +130,472 | 2.04 | +119,771 | 1.54 | +250,243 |

turtle full-7y: pb1 $258 / pb2 $208 / pb3 $221. MaxDD 35% cả ba. Bảo vệ 2022/2026 nguyên ở cả ba.

**Phát hiện:** `persistBars=1` (phản ứng ngay mỗi daily close, không debounce nhiều ngày) thắng
**cả TRAIN lẫn OOS** → không overfit. Default = 3 là **tệ nhất**. Cảnh báo "đừng mặc định 3 ngày
tốt hơn 3 phút" của Tommy được data xác nhận.

**Lưu ý kiến trúc:** P0-rework dùng **Option B (timestamp-guard)** — chỉ áp persistence-step 1 lần
mỗi daily close (loại jitter intraday do bug đếm-theo-tick). persistBars=1 + Option B = phản ứng
đúng 1 lần/daily close, sạch và tối ưu. Đổi default 3→1 có cơ sở train+OOS (chờ Tommy chốt).

## Giới hạn

- E* chỉ mới sweep ngưỡng; chưa tune-on-train-only triệt để (rejected nên không đào sâu).
- Hysteresis score (enter/exit threshold khác nhau) CHƯA test — hướng nghiên cứu riêng.
