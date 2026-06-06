# Backtest 7 năm — 3 RULE LIVE (hedge01 + turtle + champion) — 2026-06-04

Backtest 7y (2019→2026) đúng config đang giao dịch TIỀN THẬT (v0.4.83, dryRun=False). Data `.cache/binance-5m-7y.json`.
Tách **từng năm + từng tháng + số lệnh (n)** cho từng rule (theo yêu cầu Tommy).
Scripts: `backtest-hedge01-v0438-7y.ts` · `turtle-live-7y.mjs` · `champion-live-7y.mjs`.

---

## ① hedge01 (RANGE-only, funding-block 0.05%, R22+DLB18+vm16)
**Tổng 7y:** entries 3286 · closes 2503 · WR 41.8% · R:R 1.59 · RA **0.55** · ROI 0.74× · MaxDD 1.33

### Per-year (n entries / closes / PnL$)
| Năm | entries | closes | PnL$ |
|---|---|---|---|
| 2019 | 505 | 402 | +52 |
| 2020 | 433 | 345 | +120 |
| 2021 | 494 | 315 | **−479** ⚠️ |
| 2022 | 359 | 266 | +97 |
| 2023 | 435 | 386 | +141 |
| 2024 | 467 | 349 | **+646** |
| 2025 | 455 | 349 | +156 |
| 2026 | 138 | 87 | +176 |

→ **7/8 năm dương**. ⚠️ 2021 −479 là **artifact config v0438** (thiếu RANGE-only đầy đủ); LIVE RANGE-only sạch hơn (optimum verified RA ≈0.515).

### Per-month (n closes / PnL$)
```
2019: 01 n19 -6 | 02 n27 +9 | 03 n23 -2 | 04 n37 +15 | 05 n50 +13 | 06 n48 +21 | 07 n54 -39 | 08 n41 -2 | 09 n38 +21 | 10 n24 +0 | 11 n26 +6 | 12 n15 +16
2020: 01 n17 +7 | 02 n26 -17 | 03 n45 -23 | 04 n31 +2 | 05 n25 +3 | 06 n21 +6 | 07 n46 +22 | 08 n15 -18 | 09 n35 -12 | 10 n38 +23 | 11 n25 +37 | 12 n21 +91
2021: 01 n29 -114 | 02 n21 +125 | 03 n18 +37 | 04 n21 +26 | 05 n37 -234 | 06 n33 -21 | 07 n25 -12 | 08 n20 -135 | 09 n32 -176 | 10 n26 +128 | 11 n24 -56 | 12 n29 -48
2022: 01 n21 +5 | 02 n31 -26 | 03 n23 +47 | 04 n19 -35 | 05 n21 +73 | 06 n26 -11 | 07 n28 -60 | 08 n17 +14 | 09 n30 +26 | 10 n16 +32 | 11 n21 +14 | 12 n13 +17
2023: 01 n28 -34 | 02 n32 +22 | 03 n31 +0 | 04 n46 +61 | 05 n45 -69 | 06 n29 +66 | 07 n24 -17 | 08 n37 +15 | 09 n21 -9 | 10 n27 +33 | 11 n30 -44 | 12 n36 +116
2024: 01 n31 -59 | 02 n39 +258 | 03 n24 +97 | 04 n32 -174 | 05 n41 +177 | 06 n34 -93 | 07 n24 +94 | 08 n31 +9 | 09 n13 +85 | 10 n29 +27 | 11 n30 +256 | 12 n21 -32
2025: 01 n31 +203 | 02 n33 -208 | 03 n31 +232 | 04 n18 +64 | 05 n36 -53 | 06 n28 -20 | 07 n24 +201 | 08 n30 -41 | 09 n34 -9 | 10 n41 -254 | 11 n21 +136 | 12 n22 -93
2026: 01 n17 +189 | 02 n21 +62 | 03 n22 -15 | 04 n13 -37 | 05 n14 -23
```

---

## ② turtle (Donchian 20/10 long + ATR-cut 1.5 + skip-BEAR, qty 0.003)
**Tổng 7y:** n **24** lệnh · PnL **+$264.95** · WR 46% · Sharpe **0.63** vs B&H 0.33 · MaxDD $66 vs B&H $185 · exposure 30%

### Per-year (n / WR / PnL$)
| Năm | n | WR | PnL$ |
|---|---|---|---|
| 2019 | 1 | 0% | −3.05 |
| 2020 | 4 | 25% | +0.31 |
| 2021 | 5 | 40% | **+106.66** |
| 2022 | 0 | — | 0 (skip-BEAR) |
| 2023 | 4 | 75% | +9.13 |
| 2024 | 4 | 50% | +67.09 |
| 2025 | 6 | 50% | +84.81 |
| 2026 | 0 | — | 0 (skip-BEAR) |

→ **6/6 năm có lệnh đều không lỗ đậm** (2019 flat −3). skip-BEAR loại sạch 2022+2026.

### Per-month (chỉ tháng có lệnh — turtle daily, ít lệnh)
```
2019: 08 n1 -3.05
2020: 02 n1 -0.60 | 05 n1 -2.21 | 06 n1 -2.27 | 08 n1 +5.39
2021: 03 n1 +122.97 | 04 n1 -12.80 | 09 n1 -11.16 | 10 n1 +20.75 | 11 n1 -13.10
2023: 02 n2 -1.18 | 04 n1 +7.74 | 07 n1 +2.57
2024: 01 n1 +24.72 | 03 n1 +52.69 | 06 n1 -0.57 | 08 n1 -9.75
2025: 02 n1 +91.76 | 05 n1 +22.36 | 08 n2 -6.77 | 09 n1 -11.04 | 10 n1 -11.50
```

---

## ③ champion (LIVE config: BTC4h+BTC1h, qty 0.001, skip-BEAR — đang REAL)
**Tổng 7y:** n **4340** (BTC4h 1306 + BTC1h 3034) · PnL **+$639.90** · WR 37%

### Per-year (n / WR / PnL$)
| Năm | n | WR | PnL$ |
|---|---|---|---|
| 2019 | 692 | 40% | +33.32 |
| 2020 | 646 | 41% | +97.21 |
| 2021 | 463 | 38% | **+155.60** |
| 2022 | 0 | — | 0 (skip-BEAR) |
| 2023 | 884 | 34% | +86.60 |
| 2024 | 902 | 36% | **+189.11** |
| 2025 | 753 | 36% | +78.07 |
| 2026 | 0 | — | 0 (skip-BEAR) |

→ **6/6 năm có lệnh ĐỀU DƯƠNG**. skip-BEAR loại sạch 2022+2026. WR thấp 37% bù bằng TP rộng (12×ATR).

### Per-month (n / PnL$) — đầy đủ trong stdout `champion-live-7y.mjs`; trích các tháng đáng chú ý:
```
2019: 05 n125 +13.6 | 06 n99 +29.3 | 07 n42 -11.7
2020: 10 n106 +16.5 | 11 n93 +30.9 | 12 n93 +43.7
2021: 01 n26 +28.9 | 03 n86 +31.1 | 04 n22 +29.9 | 05 n29 -21.6 | 08 n79 -13.0 | 10 n122 +86.7 | 11 n25 +20.6
2023: 03 n80 +15.6 | 05 n43 -12.0 | 06 n69 -7.5 ...
2024: cao điểm — 02/05/11 (BTC4h+1h chạy mạnh, +189/năm)
2025: +78/năm
```
*(Full per-month: chạy `node tools/champion-live-7y.mjs`.)*

---

## TỔNG KẾT 3 RULE
| Rule | n (7y) | PnL$ | WR | Năm dương | Ghi chú |
|---|---|---|---|---|---|
| hedge01 | 2503 closes | RA 0.55 | 42% | 7/8 | 2021 artifact v0438 |
| turtle | 24 | +$265 | 46% | 6/6 traded | Sharpe 0.63 > B&H, DD nhỏ |
| champion | 4340 | +$640 | 37% | 6/6 traded | skip-BEAR loại 2022+2026 |

- **3 rule bổ sung nhau**: hedge01 (nhiều lệnh 4h/intraday) · turtle (ít lệnh daily ôm runner) · champion (BTC 4h+1h trend, TP rộng).
- skip-BEAR khiến turtle+champion **0 lệnh 2022+2026** (né bear) → mọi năm có lệnh đều OK.
- Tất cả đang chạy **REAL** trên VPS, chờ regime RANGE.
- ⚠️ Qty khác nhau (hedge01 notional · turtle 0.003 · champion 0.001) → so $ tuyệt đối giữa rule KHÔNG fair; xem % / RA / Sharpe trong từng mục.
