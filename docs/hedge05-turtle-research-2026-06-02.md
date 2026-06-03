# HEDGE05 REDESIGN + HEDGE01 VERIFY — Research Log 2026-06-02

> **Mục đích:** reference đầy đủ để đào sâu. Mọi kết quả + bảng số + script (path/flags/cách chạy) + open questions.
> **Headline:** Tìm + validate + tune được **edge hedge05 THẬT đầu tiên = ③ Turtle (daily Donchian + ATR cut)** — alpha Sharpe 0.61-0.73 vs B&H 0.35, additive với hedge01 (r≈0.04), defensive trong bear. **CAVEAT: return lumpy, 2021-heavy** (1 lệnh epic +363% tháng 3/2021). hedge01 verified CLEAN (không sửa).

## Mục lục
1. [State of system](#1-state-of-system)
2. [hedge01 verification (CLEAN)](#2-hedge01-verification--clean-không-sửa)
3. [hedge05 multi-TF audit (exhausted)](#3-hedge05-multi-tf-audit--real-nhưng-yếufragile-exhausted)
4. [Brainstorm 3 KIND mới](#4-brainstorm-3-kind-mới--①②-dead-③-turtle-win)
5. [③ Turtle deep validation](#5-③-turtle-deep-validation)
6. [Bảng từng tháng 2019-2026](#6-bảng-từng-tháng-2019-2026)
7. [Scripts inventory](#7-scripts-inventory--pathflagscách-chạy)
8. [Open questions / hướng đào sâu](#8-open-questions--hướng-đào-sâu)
9. [Lessons / methodology](#9-lessons--methodology)

---

## 1. State of system
- **hedge01** = LIVE v0.4.69 (`btc-trader-server/src/engine/rules/hedge01.ts`). 4h-native, S12 EMA-cross / S13 ATR-breakout / S14 Donchian, **LONG-only RANGE-only**, filters: ADX>20 sticky, EMA200 1h, ATR%ile 50th, volMA10×1.2, skip h8/h16/Thu/Sun, ATR mult 1.2, SL ATR×4→×3 @96h. **Verified CLEAN — không sửa gì.**
- **hedge05** = ENTRY OFF (kill-switch `H05_ENABLE_ENTRY=false` v0.4.68). Old mean-rev method dollar-âm/killed. **multi-TF trend** deployed PAPER (`multiTfLogger.ts` v0.4.69) — exhausted (real nhưng yếu). **Turtle = redesign lead mới (chưa build).**
- **Data:** `btc-dashboard/.cache/binance-5m-7y.json` (77MB, Jan 2019 → May 2026 full cycle). Mọi script aggregate 4h/1d/1h on-the-fly từ 5m.
- **Run:** `cd btc-dashboard/tools && python3 <script>.py [flags]` (python3.13, no deps).

---

## 2. hedge01 verification — CLEAN (không sửa)

### Overext gate REJECT (cả % lẫn $)
Bối cảnh: phiên trước thấy overext (skip LONG khi 1d-close > MA50×1.15) cho +$920/+14% trên `backtest-hedge01-v0438-7y.ts`. **NHƯNG đó là v0438 — KHÔNG có RANGE-only** (vào cả BULL). Re-test trên harness live-faithful (`verify-overext-live-7y.py`, Config A = RANGE-only):

| overext | n | ROI% | RA | 2021% | $-weighted | vs base$ |
|--:|--:|--:|--:|--:|--:|--:|
| **0.00** | 107 | **+396** | 0.515 | −0.9 | **+415** | — |
| 0.10 | 56 | +216 | 0.627 | +0.4 | +308 | −106 |
| **0.15** | 69 | +240 | 0.540 | +0.4 | +316 | **−99 (−24%)** |
| 0.20 | 82 | +272 | 0.501 | −0.9 | +309 | −105 |
| 0.25 | 98 | +338 | 0.511 | −0.9 | +391 | −24 |

→ overext cắt winners 2019(+157→+23%)/2024(−$71). 2021-live = **−$2 (phẳng)**, không phải −$480 (=agg cũ, đã tắt) hay −$86 (=v0438). **REJECT. hedge01 không cần fix 2021.**

### Re-enable BULL (nới RANGE-only) REJECT
`backtest-bull-regime-reaudit-7y.py`:

| Config | n | RA | ROI% | DD% | stab |
|---|--:|--:|--:|--:|:-:|
| A: RANGE-only (LIVE) | 107 | **0.515** | +396 | **20.7** | 5/6 |
| B: RANGE+BULL | 127 | 0.410 | +393 | **42.5** | 6/6 |
| C: BULL-only | 21 | 0.029 | +5 | 49.8 | 2/5 ❌ |

→ thêm BULL = 0 return, **DD gấp đôi**, RA tụt. RANGE-only đúng optimum. **hedge01 ở local optimum tốt; SHORT killed (v0.4.51), thêm filter=overfit, exit-tune≠edge. Đừng đẽo thêm.**

---

## 3. hedge05 multi-TF audit — real nhưng YẾU/fragile (exhausted)

`probe-hedge05-multitf-7y.py`. **Lookahead audit PASS** (đọc `cidx`/`decide`: `cidx(tf,t_close)` chỉ trả bar có close-time ≤ t_close = loại bar-đang-chạy; daily D-1) — fix đúng bug đã giết mean-rev cũ. Dollar-faithful (qty cố định no-DCA → RA & $ cùng dấu).

| config | $/7y | RA | stab | note |
|---|--:|--:|:-:|---|
| **CHAMPION** `--nomeanrev --nomacd --cut=2 --tp=4` | **+291** | 0.056 | 6/8 | TRAIN0.065/TEST0.045 |
| FULL (all on) | −135 | −0.025 | 3/8 | meanrev+macd HẠI |
| +meanrev | +53 | 0.012 | 4/8 | meanrev cắt $238 |
| −no1d | +9 | — | 5/8 | **sụp → edge ≈ toàn bộ là 1d-trend** |
| −noadx | +194 | — | 7/8 | |

**Iterate (không vượt champion):** 1d-only $152, 1d+adx **−$41** (flip dấu = overfit-signature), +obv $105, trail $16, tp6/ts120 $154. **Conviction-gate** (`--noforce`): dec2 $41, dec3 −$21 → **forced-daily LÀ load-bearing; +$291 = structural-drift, KHÔNG concentrate bằng selectivity = không sharp alpha.**

→ Frame multi-TF gần exhausted về direction/param. RA 0.056 mỏng.

### 3b. FLIP / reverse-v2 GHÉP VÀO forced-daily (Tommy directive: giữ 1-entry/day, dùng mọi method)
Thêm flag `--flip` vào probe: khi CẮT (SL), nếu vote multi-TF flip decisive NGƯỢC lại → đảo chiều luôn (reverse-v2 có xác nhận, "đảo chiều có đánh giá" Tommy endorse).

| config | $/7y | recent | TEST RA | stab |
|---|--:|--:|--:|:-:|
| champion (no flip) | +291 | +121 | 0.045 | 6/8 |
| **+ flip cut2.2 (robust)** | +227 | +152 | **0.058** | **7/8** |
| + flip cut2.0 (đỉnh fragile) | +336 | +175 | 0.055 | 6/8 |
| + flip + convsize2 | +437 | +172 | 0.058 | 6/8 |

**FLIP = method DUY NHẤT giúp.** Lợi chính: 2025 chop +$60 (bắt reversal), recent +45%, generalize↑ (TEST 0.045→0.058), stab↑ 7/8. Mọi direction-method khác trên base cut2.2+flip ĐỀU HẠI (1w $81, obv $46, macd $44, tp6 $100, cut1.5 −$117) → champion+flip+conv = TRẦN. **Caveat:** cut-fragile ($336@cut2.0 đỉnh nhọn, robust ~$227-336); convsize=leverage thuần; **RA vẫn 0.056** (structural-drift, flip cứu loser chứ chưa sharp-alpha). Run: `probe-hedge05-multitf-7y.py --nomeanrev --nomacd --cut=2.2 --tp=4 --flip [--convsize=2]`.

---

## 4. Brainstorm 3 KIND mới — ①② DEAD, ③ Turtle WIN

Ràng buộc tránh dead-end: mean-rev (−$417), multi-TF forced-trend (trần $291), SHORT all-regime/funding (RA âm), DCA/pyramid/martingale (ruin).

### ① Vol-squeeze breakout — DEAD
`probe-hedge05-squeeze-7y.py`. BB-bandwidth percentile thấp (nén) + breakout. Default $+21 RA0.021 **TEST−0.007**; long −$19, short −$10, adx −$30, trail −$57. WR 42% — **hướng sau nén là coin-flip + false-breakout giết. Không edge.**

### ② BEAR/SHORT complement — DEAD
`probe-hedge05-squeeze-7y.py --mode=bearshort`. BEAR-confirmed + Donchian-low breakdown SHORT. Mọi variant **RA ÂM** (−0.034→−0.148), WR 33-39%, stab 1-4/8. Best +$24 (ts30 tp6) nhưng RA âm. **BTC up-drift + đáy chữ-V phạt short. hedge01 né BEAR là đúng.**

### ③ Daily Donchian Turtle — WIN ✅
`probe-hedge05-turtle-7y.py`:

| config | $/7y | RA | TEST RA | stab | n | hold |
|---|--:|--:|--:|:-:|--:|--:|
| **S1 long-only** (20/10) | +153 | **0.240** | **+0.311** | 6/8 | 37 | 36d |
| S2 long-only (55/20) | +130 | **0.337** | +0.282 | 5/8 | 19 | 61d |
| S1 +ATR cut2 | +231 | 0.165 | +0.135 | 6/8 | 76 | 23d |

→ Đầu tiên có RA >> multi-TF (0.056) VÀ **TEST RA dương** (generalize). SHORT drag → long-only.

---

## 5. ③ Turtle deep validation

### 5a. Alpha vs Beta (Sharpe leverage-invariant)
`validate-turtle-vs-bh-7y.py` (daily mark-to-market vs Buy-and-Hold, qty 0.003):

| config | Total$ | Sharpe | MaxDD$ | expo | verdict |
|---|--:|--:|--:|--:|---|
| S1 no-stop | +153 | 0.37 | 146 | 51% | **chỉ BETA** (≈B&H 0.35) |
| **S1 +cut2** | +236 | **0.61** | 96 | 44% | **ALPHA** |
| S2 no-stop | +130 | 0.32 | 116 | 45% | beta |
| Buy-Hold | +210 | 0.35 | 185 | 100% | — |

**CUT robustness sweep (S1 long, B&H Sharpe 0.35):**

| cut | Total$ | Sharpe | MaxDD$ |
|--:|--:|--:|--:|
| 0 | +153 | 0.37 | 146 |
| **1** | +278 | **0.73** | 103 |
| 1.5 | +238 | 0.62 | 109 |
| 2 | +236 | 0.61 | 96 |
| 2.5-3 | +224 | 0.57 | 102 |
| 4 | +202 | 0.52 | 112 |

→ **Alpha ROBUST cả range cut=1→4** (đều > 0.35) = KHÔNG fluke. **Edge ở CẮT LOSER (ATR stop), KHÔNG ở breakout** (breakout trơn = beta). Khớp "cut beats rescue". S2+cut = vẫn beta → alpha chỉ ở FAST 20/10+cut.

### 5b. Additive với hedge01 (`correlation-turtle-hedge01-7y.py`)
```
PEARSON r = +0.039  [LOW → DIVERSIFY THẬT]
both-active 17 tháng: same-sign 8/17 (47% coin-flip)
turtle dương khi hedge01 âm/0: 4 tháng | hedge01 dương khi turtle âm/0: 5 tháng
monthly Sharpe: hedge01 +1.44  turtle +0.72  COMBINED(equal-risk) +1.50 > 1.44 ✓
```
→ uncorrelated, combined Sharpe nâng. **Đáng thêm như rule bổ sung, không redundant.**

### 5c. Tune skip-BEAR (final config)

| config | Total$ | Sharpe | MaxDD$ | expo |
|---|--:|--:|--:|--:|
| cut1.5 (no gate) | +238 | 0.62 | 109 | 42% |
| **cut1.5 + skip-BEAR** | +210 | **0.63** | **66** | 30% |

→ MaxDD giảm 40% (=2.8× < B&H), 2022 break-even +$0, 7/8 năm dương-phẳng.

### ⭐ CONFIG CHỐT: `daily Donchian 20/10 long-only + ATR cut1.5 + skip-BEAR`
Daily-native (enter/exit tại daily-close, Donchian prior-N exclude today, regime D-1) = pattern AN TOÀN không-lookahead.

---

## 6. Bảng từng tháng 2019-2026
(return-% = tổng return mỗi lệnh đóng trong tháng = R-multiple trên notional, KHÔNG phải %vốn; · = không lệnh)

**hedge01 (live RANGE-breakout 4h):**
```
year |  M1  M2  M3  M4  M5  M6  M7  M8  M9 M10 M11 M12 | TOTAL
2019 |   ·  +7  -4 +17 +82 +61   ·   ·  -5   ·   ·   · |  +157
2020 |   ·  -8   ·   ·  -5   ·   · +22   · +31 +18   · |   +57
2021 |   ·   ·   ·   ·  +0   ·   ·   ·  -1   ·   ·   · |    -1
2022 |   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   · |    +0  (BEAR, 0 lệnh)
2023 |  +1  +7 +11  +7   ·  +5   ·   ·   · +24  +5  +2 |   +63
2024 |   · +57 +18   ·  -2  -5   ·   ·   ·  -3 +45   · |  +110
2025 |  -1   ·   ·   ·  -3   ·  +6 -14  +2 +20   ·   · |   +10
2026 |   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   · |    +0
7y TOTAL: +396
```

**hedge05/turtle (daily Donchian 20/10 + cut2):**
```
year |  M1  M2  M3  M4  M5  M6  M7  M8  M9 M10 M11 M12 | TOTAL
2019 |   ·  -6   ·   ·   · +87  +7 -12   ·   ·  -5   · |   +72
2020 |   · +20   ·   · +19 -10   · +19   ·   ·   ·   · |   +48
2021 |   ·   ·+363  -9   ·   ·   ·   ·  +21 +13  -9   · |  +380 ⚠️
2022 |   ·  -8   ·  -2   ·   · -12   ·  -8   ·  -6  -6 |   -41
2023 |   · +27  -7 +10   ·   ·  +3   ·   ·  -5   ·   · |   +29
2024 | +25   · +40   ·   ·  -0   · -14   ·  -2   ·   · |   +48
2025 |   · +46   ·   · +11   ·   ·  -3  -4  -4   ·   · |   +45
2026 |  -3   ·  -7   ·  +5   ·   ·   ·   ·   ·   ·   · |    -5
7y TOTAL: +575
```

### ⚠️ Phát hiện từ bảng tháng (aggregate giấu):
**Turtle bị thống trị bởi 1 lệnh epic: M3/2021 = +363%** = 1 lệnh long giữ xuyên bull-run cuối 2020→Q1 2021 (BTC ~$13k→$58k), book vào tháng đóng. Bản chất trend-following fat-tail (ít lệnh, vài winner khổng lồ gánh hết). **KHÔNG bug** nhưng:
- **Bỏ 2021: turtle còn +196%/7y** (5/7 năm xanh) — vẫn dương nhưng nhỏ hơn HẲN +575. **Đừng extrapolate +575 tuyến tính.**
- Alpha (né bear 2022 −41 vs B&H −89; recent 2023-25 đều dương) vẫn thật, độc lập 2021.
- Diversification nhìn được: hedge01 đậm 2019(Apr-Jun)/2024, turtle đậm 2021 → các tháng khác nhau → r≈0.04.

---

## 7. Scripts inventory — path/flags/cách chạy
Tất cả ở `btc-dashboard/tools/`, chạy `python3 <script>.py [flags]`.

| Script | Purpose | Key flags |
|---|---|---|
| `backtest-bull-regime-reaudit-7y.py` | hedge01 live-faithful A/B/C (RANGE vs +BULL vs BULL-only) | (none) |
| `verify-overext-live-7y.py` | overext gate trên hedge01 RANGE-only + dollar-weight sweep | (clone của reaudit + overext) |
| `probe-hedge05-multitf-7y.py` | multi-TF champion | `--nomeanrev --nomacd --cut= --tp= --no{1d,adx,macd,vol,15m} --obv --noforce --decisive=` |
| `probe-hedge05-squeeze-7y.py` | ① vol-squeeze + ② bearshort | `--mode=squeeze\|bearshort --cut= --tp= --sqpctl= --adxmin= --trail= --donlb= --long-only --short-only` |
| `probe-hedge05-turtle-7y.py` | ③ turtle daily Donchian | `--donentry= --donexit= --cut= --ts= --long-only --short-only` |
| `validate-turtle-vs-bh-7y.py` | turtle alpha-vs-beta (Sharpe/MaxDD vs B&H) | `--donentry= --donexit= --cut= --skipbear` |
| `correlation-turtle-hedge01-7y.py` | monthly corr hedge01 vs turtle + bảng lưới năm×tháng | (edit DE/DX/CUT trong file) |

**Champion configs:**
- multi-TF: `--nomeanrev --nomacd --cut=2 --tp=4`
- turtle FINAL: `validate-turtle-vs-bh-7y.py --cut=1.5 --skipbear` (Sharpe 0.63, MaxDD$66)

---

## 8. Open questions / hướng đào sâu
**Turtle robustness (ưu tiên cao — vì lumpy 2021):**
1. **Ex-2021 robustness:** edge có thật KHÔNG có cú jackpot 2021? Sub-period chặt (vd train 2019-22 / test 2023-26 riêng full-backtest, không chỉ TEST-RA). Per-trade distribution (mấy lệnh gánh bao nhiêu %?).
2. **Soi lệnh +363 M3/2021:** entry/exit date chính xác, 1 hay nhiều lệnh, entry price. Confirm fat-tail nature.
3. **Partial-exit / scale-out / pyramid-into-winner** (turtle classic adds units khi trend tiếp diễn) — tăng capture fat-tail?
4. **Multi-asset** (ETH/SOL...): turtle generalize cross-asset không? (data alt chỉ 3y trong cache).
5. **Entry/exit param finer sweep** (Donchian N, EMA-channel thay Donchian, breakout confirmation) — cẩn thận overfit.
6. **Regime-adaptive / vol-target sizing.**

**Portfolio:**
7. **hedge01 + turtle combined sizing** (weight, risk-parity) — combined Sharpe 1.50, tối ưu weight?
8. **Có nên turtle thay vai trò "05"** (hedge05 entry đang off) hay là rule MỚI (hedge06) song song?

**Production:**
9. **Design turtleLogger.ts** (paper, mirror multiTfLogger) → forward-test live vs backtest trước khi size. (design đã phác, chờ "build").
10. **Forward-test gate:** so RA/Sharpe live vs backtest qua cửa sổ đủ dài.

**Multi-TF (nếu quay lại):**
11. Multi-TF còn để paper (multiTfLogger v0.4.69) — so live vs 0.056 sau vài tháng.

---

## 9. Lessons / methodology
1. **No-lookahead harness pattern:** mỗi TF dùng bar ĐÃ ĐÓNG tại t_close (`cidx`: `bars[m].time + ms <= t_close`); regime D-1; rule native-TF (eval đúng TF của nó) an toàn, mix-TF đọc bar-chứa-ts = lookahead (đã giết mean-rev hedge05). Turtle daily-native = an toàn.
2. **Dollar không phải RA khi size thay đổi** (DCA) — nhưng turtle/hedge01 fixed-qty no-DCA → RA/Sharpe OK.
3. **Verify on LIVE-faithful harness** trước khi port (overext +$920 trên v0438 → −24% trên live RANGE-only).
4. **Alpha vs Beta = Sharpe** (leverage-invariant): under-levered beta có Sharpe = full beta. Turtle trơn = beta; +cut = alpha (Sharpe 0.61 > 0.35).
5. **Bảng THÁNG lộ lumpiness** mà per-year/aggregate giấu (turtle +363 M3/2021 gánh phần lớn).
6. **Trend-following = fat-tail** (vài winner khổng lồ); **edge = CẮT** (risk mgmt), không phải entry/breakout.
7. **Additive = correlation thấp + combined Sharpe tăng**, không phải standalone return.

## 10. Frontier cuối phiên (2026-06-02) + việc còn lại

### Correlation 3 chiều (monthly, return-%) — `probe FD_MONTHLY` + `correlation-turtle-hedge01-7y.py`
| cặp | Pearson r |
|---|--:|
| forced-daily-05+flip ↔ hedge01 | **+0.200** (additive, cao hơn turtle vì trade cả RANGE) |
| forced-daily-05+flip ↔ turtle | **+0.088** (gần uncorrelated — 2 candidate khác exposure THẬT) |
| hedge01 ↔ turtle | +0.069 |
→ Cả 3 rule mutually low-corr (≤0.20). **Portfolio 3-rule (hedge01 + forced-daily-05+flip + turtle) = diversified thật, không redundant.** Chạy cả 3 hợp lý (hedge01 live + 2 hedge05-candidate paper).

### 2 candidate hedge05 — chốt:
- **forced-daily-05+flip:** champion `--nomeanrev --nomacd --cut=2.2 --tp=4 --flip` ≈ $285, RA 0.056, TEST 0.058, stab 7/8, 141/yr. Identity "mỗi ngày 1 entry". Đã thử HẾT methods → trần.
- **turtle:** `daily Donchian 20/10 long + cut1.5 + skip-BEAR`, Sharpe 0.63 vs B&H 0.35, additive r≈0.04. Chất cao nhất (lumpy 2021).

### BUILT v0.4.70 (2026-06-02, tsc CLEAN — CHƯA DEPLOY):
1. ✅ `btc-trader-server/src/engine/turtleLogger.ts` (mới) — paper-logger turtle daily Donchian 20/10 long + cut1.5 + skip-BEAR, daily-native no-lookahead, log `turtle-paper-BTCUSDT.jsonl`.
2. ✅ `multiTfLogger.ts` — thêm FLIP (reverse-v2) + cut 2.0→2.2.
3. ✅ Wired `index.ts` (startTurtleLogger) + version 0.4.70. `npx tsc --noEmit` clean.
4. ⏳ **CHỜ "deploy"** → `./deploy.sh` lên VPS + verify post-deploy (tail log). LIVE vẫn v0.4.69.
5. Sau deploy: forward-test cả 2 paper song song hedge01 → so live vs backtest trước khi size.

### Deep-dive leads (§8) vẫn mở:
ex-2021 turtle robustness, soi cú +363, partial-exit, multi-asset, combined sizing.

## Memory liên quan
`project_hedge05_turtle_alpha.md`, `hedge05-method-lessons`, `project_hedge01_overext_2021_verified.md`, `verify-on-live-faithful-harness`, `feedback_loss_handling_cut_beats_rescue`, `feedback_dollar_not_ra_when_size_varies`.
