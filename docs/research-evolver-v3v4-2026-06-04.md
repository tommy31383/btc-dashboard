# Evolver V3 vs V4 — Research Report (2026-06-04)

## Kết luận

**V3 champion vẫn là tốt nhất.** V4 MAP-Elites mới gen=35, chưa đủ thời gian để beat V3.

---

## V3 Champion (evolver-v3-hof.json)

| Metric | Giá trị |
|---|---|
| Train CAGR | **146.1%** |
| Test CAGR | **39.4%** |
| Max DD | 20.4% |
| n_min | 387 |
| Pos years | **8/8** |

### Per-year ROI

| Năm | ROI | n |
|---|---|---|
| 2019 | +309.8% | 810 |
| 2020 | +631.8% | 1022 |
| 2021 | +202.7% | 763 |
| 2022 | +20.8% | 387 |
| 2023 | +190.0% | 1155 |
| 2024 | +83.4% | 1082 |
| 2025 | +9.1% | 815 |
| 2026 | +11.7% | 347 |

### Params
```json
{
  "adx4": 18, "di4": 0.9, "sl4": 1.6, "tp4": 12, "hold4": 70, "cool4": 2, "pos4": 7,
  "adx1": 16, "di1": 1.05, "sl1": 2.0, "tp1": 8, "hold1": 24, "cool1": 1, "pos1": 4,
  "adxe": 18, "die": 1.3, "sle": 1.4, "tpe": 12, "eblo": 0.85, "ebhi": 1.1, "bg": 0.8,
  "use_btc4h": true, "use_btc1h": true, "use_eth": true, "exit_ema20": true,
  "f_funding": false, "f_rsi": false, "f_bear": true,
  "risk4": 0.04, "risk1": 0.04, "riske": 0.04, "cap_btc": 1.0, "cap_eth": 1.0
}
```

---

## V4 MAP-Elites (evolver-v4-archive.json)

| Metric | Giá trị |
|---|---|
| Gen khi dừng | 35 |
| Cells populated | 9 |
| Best fitness | 6.093 |
| Best CAGR | 113.0% |
| Best DD | 28.7% |
| Pos years | 6/8 (âm 2022, 2026) |

### Tất cả cells (theo fitness)

| Cell | Fitness | CAGR | DD | Pos yr | 2022 | 2026 |
|---|---|---|---|---|---|---|
| (2,0,1) | 6.09 | 113% | 29% | 6/8 | -18% | -16% |
| (2,0,0) | 4.71 | 91%  | 29% | 6/8 | -4%  | -14% |
| (1,1,1) | 4.19 | 83%  | 28% | 5/8 | -15% | -6%  |
| (2,1,1) | 4.14 | 75%  | 27% | 5/8 | -16% | -7%  |
| (1,1,0) | 3.49 | 26%  | 10% | 5/8 | -4%  | -2%  |
| (2,1,0) | 3.48 | 24%  | 9%  | 5/8 | -5%  | -2%  |
| (2,1,2) | 3.44 | 24%  | 9%  | 5/8 | -5%  | -2%  |
| (1,1,2) | 2.89 | 23%  | 11% | 5/8 | -7%  | -3%  |
| (2,0,2) | 2.79 | 29%  | 13% | 6/8 | -8%  | -1%  |

### Best cell genome
```json
{
  "primitives": ["MultiTF_4h1h"], "combine": "OR",
  "prim_cfg": {"MultiTF_4h1h": {"adx": 22, "hold": 70, "sl": 2.0, "adx1": 18, "adx4": 25, "pos": 7}},
  "use_btc4h": true, "use_btc1h": true, "use_eth": true, "exit_ema20": true,
  "f_funding": false, "f_rsi": false, "f_bear": false,
  "risk4": 0.03, "risk1": 0.08, "cap_btc": 0.4, "cap_eth": 1.0,
  "adx4": 20, "di4": 1.0, "sl4": 1.8, "tp4": 8, "hold4": 60, "cool4": 2, "pos4": 5,
  "adx1": 20, "di1": 1.0, "sl1": 1.8, "tp1": 8, "hold1": 24, "cool1": 2, "pos1": 4,
  "bg": 0.85
}
```

---

## Nhận xét

- **V4 chưa đủ thời gian**: gen=35, 9 cells — MAP-Elites cần nhiều gen hơn để explore đủ space
- **V4 không có 8/8**: tất cả cells đều âm 2022 và/hoặc 2026 — constraint 8/8 chưa được solve
- **V3 vẫn là champion live**: CAGR 146% / DD 20.4% / 8/8 năm dương / test 39.4%
- **V4 f_bear=false** ở best cell — khác V3 (f_bear=true), đây là lý do 2022/2026 âm
- Nếu chạy tiếp V4 nên enforce constraint pos_years=8 cứng hơn trong fitness function
