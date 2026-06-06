# Primitive Screen 7Y — Phase A Report
Date: 2026-06-04
Total primitives: 8

### ✅ ADX_DI_4h
- ADX/DI trend-follow BTC 4h — baseline (already in v3)
- Calmar=1.59 | CAGR=52.9% | DD=33.2% | n=1067 min_n/yr=86 | pos_yrs=6/7 | WF=100%
- Per-year: 2019:+109% | 2020:+183% | 2021:+68% | 2022:-24% | 2023:+66% | 2024:+37% | 2025:+39% | 2026:-8%

### ✅ Donchian_4h
- Donchian channel breakout BTC 4h
- Calmar=0.56 | CAGR=20.9% | DD=37.5% | n=661 min_n/yr=60 | pos_yrs=5/7 | WF=60%
- Per-year: 2019:+67% | 2020:+60% | 2021:+47% | 2022:-33% | 2023:+46% | 2024:+29% | 2025:-8% | 2026:-14%

### ❌ EMA_Stack_4h
- EMA20>EMA50>EMA200 stack + pullback entry BTC 4h
- FAIL: pos_yrs=3<5
- Calmar=0.31 | n=557 | 2019:-0% | 2020:+62% | 2021:+34% | 2022:-3% | 2023:-3% | 2024:+7% | 2025:-2% | 2026:-1%

### ❌ Vol_Squeeze_4h
- BB squeeze breakout BTC 4h
- FAIL: pos_yrs=3<5
- Calmar=0.11 | n=271 | 2019:+29% | 2020:+22% | 2021:-2% | 2022:-8% | 2023:+8% | 2024:-8% | 2025:-4% | 2026:-10%

### ❌ RCI_Funding_4h
- RCI oversold reversal + high funding gate BTC 4h
- FAIL: min_n=2<20, pos_yrs=3<5
- Calmar=1.87 | n=39 | 2019:+0% | 2020:+6% | 2021:+24%

### ❌ Stoch_Range_4h
- Stoch oversold in RANGE regime BTC 4h
- FAIL: pos_yrs=4<5, calmar=-0.04<0.1
- Calmar=-0.04 | n=576 | 2019:-13% | 2020:+17% | 2021:-2% | 2022:-23% | 2023:+11% | 2024:+4% | 2025:+9% | 2026:-9%

### ✅ Breakout_Retest_4h
- Breakout + retest entry BTC 4h
- Calmar=0.79 | CAGR=25.2% | DD=32.0% | n=633 min_n/yr=53 | pos_yrs=5/7 | WF=60%
- Per-year: 2019:+76% | 2020:+57% | 2021:+32% | 2022:-22% | 2023:+51% | 2024:+40% | 2025:-5% | 2026:-9%

### ✅ MultiTF_4h1h
- 4h+1h ADX/DI confluence BTC
- Calmar=1.81 | CAGR=45.6% | DD=25.3% | n=876 min_n/yr=69 | pos_yrs=7/7 | WF=100%
- Per-year: 2019:+89% | 2020:+137% | 2021:+56% | 2022:-19% | 2023:+52% | 2024:+32% | 2025:+31% | 2026:+1%

---
## Summary
- Passed: 4/8
- Failed: 4/8

### Passed primitives (kho v4):
- ADX_DI_4h: Calmar=1.59 | 52.9% CAGR | 33.2% DD
- Donchian_4h: Calmar=0.56 | 20.9% CAGR | 37.5% DD
- Breakout_Retest_4h: Calmar=0.79 | 25.2% CAGR | 32.0% DD
- MultiTF_4h1h: Calmar=1.81 | 45.6% CAGR | 25.3% DD

### Failed primitives (loại):
- EMA_Stack_4h: pos_yrs=3<5
- Vol_Squeeze_4h: pos_yrs=3<5
- RCI_Funding_4h: min_n=2<20, pos_yrs=3<5
- Stoch_Range_4h: pos_yrs=4<5, calmar=-0.04<0.1