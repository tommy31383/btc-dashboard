# 📊 BACKTEST REGISTRY

Canonical registry cho mọi dataset backtest. Mỗi entry có **tên (key)** + **path file** + **meta** + **status** để Tommy + future Claude reference qua tên thay vì nhớ filename dài.

**Naming convention:**
- `<DOMAIN>_<TYPE>_v<N>` — ví dụ `TPSL_GRID_v1`, `STACK_SWEEP_v1`
- Children inherit parent + có `parent` field
- Khi superseded, không xoá entry — set `status: "superseded"` + ghi `replaced_by`

---

## 🟢 ACTIVE — current canonical

### `TPSL_GRID_v1`
- **Type:** TP × SL grid sweep
- **Date:** 2026-04-28
- **Tool:** `tools/backtest-5mall-tpsl-grid-3y.ts`
- **Data JSON:** `assets/backtest_5mall_tpsl_grid_3y.json` (604 KB)
- **HTML heatmap:** `assets/backtest_5mall_tpsl_grid_3y_report.html`
- **PnL chart 12 picks:** `assets/pnl_chart_tpsl_grid_3y.html`
- **PnL chart top WR:** `assets/pnl_chart_top_wr_3y.html`
- **Setup:** 5 preset (WHALE_MAX 200, WHALE_MID 100, TOMI_MAX 200, TOMI_MID 100, TOMI_MIN 50) × 8 TP `[3,4,5,6,7,8,10,12]` × 7 SL `[2,2.5,3,4,5,6,8]` = **280 combos**
- **Period:** 2023-04-27 → 2026-04-26 (3y)
- **Capital:** $5000, lev 100x, fee 0.05%/side
- **Winner NET:** 🔴 WHALE_MAX TP=5/SL=6 → $4.15M, DD 2.0%, WR 54.3%
- **Winner WR:** 🟠 WHALE_MID TP=3/SL=8 → 72.5%, NET $2.29M
- **Min DD:** 🔵 TOMI_MAX TP=8/SL=8 → DD 0.1%, NET $3.09M
- **Children:** `SHORTLIST_v1`

#### 📚 LESSONS LEARNED (anh Tommy 2026-04-29 — note để Claude tiếp theo resume)

**🏆 TOP 5 BY NET (WHALE_MAX stack 200 dominate):**
1. WHALE_MAX 200 TP5/SL6 → $4.15M · DD 1.98% · WR 54.3% · PF 5.30
2. WHALE_MAX 200 TP5/SL5 → $4.12M · DD 1.18% · WR 49.8% · PF 4.41
3. WHALE_MAX 200 TP6/SL6 → $4.09M · DD 0.87% · WR 50.1% · PF 5.38 ⭐ MAIN current default
4. WHALE_MAX 200 TP4/SL6 → $4.08M · DD 2.16% · WR 59.5% · PF 5.22
5. WHALE_MAX 200 TP3/SL6 → $4.06M · DD 1.61% · WR 66.3% · PF 5.18

**🏆 TOP 5 BY PF (TP cao + SL=8 dominate):**
1. WHALE_MAX 200 **TP12/SL8** → PF **7.53** · NET $3.16M · DD 6.46%
2. TOMI_MID 100 **TP12/SL8** → PF 7.52 · NET $1.59M · DD 3.51% (KHÔNG có trong app!)
3. WHALE_MID 100 **TP10/SL8** → PF 7.42 · NET $1.80M · DD 2.34%
4. TOMI_MIN 50 **TP12/SL8** → PF 7.42 · NET $845k · DD 3.39%
5. WHALE_MID 100 **TP12/SL8** → PF 7.39 · NET $1.66M · DD 2.51%

**🏆 TOP 5 MIN DD (NET >$100k filter):**
1. WHALE_MID 100 TP6/SL6 → DD **0.10%** · NET $2.31M · PF 5.41 ← current `WHALE_MID_66`
2. TOMI_MAX 200 TP5/SL5 → DD 0.10% · NET $3.05M · PF 4.43 ← current `TOMI_MAX_55`
3. TOMI_MIN 50 TP8/SL8 → DD 0.12% · NET $986k · PF 7.18
4. TOMI_MAX 200 TP6/SL6 → DD 0.13% · NET $3.08M · PF 5.22
5. WHALE_MAX 200 TP8/SL8 → DD 0.14% · NET $3.65M · PF 7.18 ← current `WHALE_MAX_88`

**🚨 DISASTERS — TP cao + SL=2 = BLOW UP (TUYỆT ĐỐI KHÔNG dùng):**
- WHALE_MAX TP10/SL2 → DD **108.57%** · NET -$6k · WR 7.0%  ← **liquidation!**
- WHALE_MAX TP12/SL2 → DD 105.27% · NET -$6k · WR 6.3%
- TOMI_MAX TP8/SL2 → DD 107.10% · NET -$6k · WR 10.6%
- TOMI_MAX TP10/SL2 → DD 105.70% · NET -$5k · WR 5.6%
- TOMI_MID TP10/SL2 → DD 105.70% · NET -$5k · WR 5.6%
- → **Pattern:** SL=2% với leverage 100x = -$6 (=$30 margin × 2% × 100x → 20% margin loss/lệnh) × 75-200 stack → equity blow.
- → **Rule of thumb:** SL >= TP/2 mới safe, SL < TP/3 = burn.

**🎯 KEY PATTERNS từ 280 runs:**

1. **TP12/SL8 ratio 1.5:1 = best PF universal** — winner across all 5 stacks (WHALE 200/100, TOMI 200/100/50)
2. **SL=8 thắng SL=6 về PF** (dù NET có thể thấp hơn) — SL rộng = ít stop sớm = PF cao hơn
3. **TP=3 high-WR (72%), TP=12 low-WR (~50%) but PF cao hơn** — đánh đổi WR vs PF
4. **Stack 200 dominate top NET** (4/5 top NET là stack 200) — capacity quan trọng hơn quality cho NET tổng
5. **DD<1% phần lớn là TP=SL hoặc TP<SL** — symmetric/conservative TP/SL
6. **Spec winner luôn LONG side bias** — backtest period 2023-2026 BTC trend tổng thể UP
7. **TP=8 sweet spot** — nhiều combo TP=8 có PF 7+ và DD <0.5%

**📋 CURRENT STATE (sau v4.8.34 — Tommy add lại 3 LEGACY):**
- 10 presets active: 7 picks (composite rank tốt) + 3 LEGACY (TP5/SL2.5 + TP4/SL4)
- 3 LEGACY có DD cao (8.02%, 2.59%, 0.28%) so với variants cùng stack (0.87%, 0.10%, 1.18%)
- Migration map đã có: old key auto map sang variant tốt hơn cùng stack

**🔮 FUTURE BACKTEST RECOMMENDATIONS:**

1. **Mở rộng grid TP `[15, 20, 25, 30]`** — vì 5/5 best PF đều pick TP=12 (max grid hiện tại) → có thể TP cao hơn còn ăn nhiều hơn
2. **Test SL `[1.5, 1.75]` với TP=3** — high-WR sniper mode chưa test
3. **Test ASYMMETRIC ratio TP:SL = 2:1, 3:1** — đa số top PF là 1.5:1, có thể thử cao hơn
4. **Test out-of-sample 2020-2022** — backtest hiện tại trend BTC up nhiều, cần verify trên downtrend period
5. **Test STACK 300, 500** — chưa biết capacity vs quality tradeoff ở stack lớn
6. **Test STOCH levels khác** — current WHALE 10/90, TOMI 5/95. Thử WHALE 15/85 cho nhiều entry hơn
7. **Test S/R proximity 0.5%, 0.6%** — current WHALE 0.4, TOMI 0.2

**🚧 PITFALLS cho Claude tiếp theo:**

1. **ĐỪNG dùng SL<3% với leverage 100x** — risk liquidation cao
2. **ĐỪNG quá tin top NET** — top NET (TP5/SL6 PF 5.30) không bằng top PF (TP12/SL8 PF 7.53). Tommy ưu tiên PF (consistency) hơn NET (max yolo)
3. **DD% là PEAK-TO-TROUGH** trong period, không phải mỗi lệnh — DD 8% nghĩa là equity sụt 8% từ peak, có thể recover
4. **WR thấp (50%) + PF cao (7+) = OK** — winners lớn hơn losers nhiều, khác với rule HTF cần WR ≥ 30%
5. **Stack 200 = max margin lock $6000** ($30 × 200) — đảm bảo capital >= $5000 + 20% buffer
6. **TPSL_GRID_v1 là TRUTH cho 5m ALL TP/SL** — đừng dùng `STACK_SWEEP_v1` cũ (superseded)
7. **Check `equityTrend: "UP"`** trước khi recommend rule — nếu DOWN thì rule đã hết edge dù NET dương

**🔄 RESUME COMMAND:**
```
"Anh Tommy resume TPSL_GRID_v1 — em xem lại 280 combos cleanup 5m ALL presets (current 10 → propose 7 picks)"
```
- Read: `assets/preset_shortlist_v1.json` (full grid backup)
- Read: `utils/all5mAccount.ts` PRESETS object (current state)
- Recommend: drop 3 LEGACY (DD cao + PF thấp) hoặc replace bằng best PF picks (TP12/SL8 family)

### `SHORTLIST_v1`
- **Parent:** `TPSL_GRID_v1`
- **Type:** Curated picks
- **Date:** 2026-04-28
- **Data JSON:** `assets/preset_shortlist_v1.json` (605 KB, embed full grid backup)
- **Picks:** 7 (Tommy curated)
  | # | Preset | TP/SL | NET | MaxDD | Role |
  |---|---|---|---|---|---|
  | 1 | 🔴 WHALE_MAX | 6/6 | $4.09M | $2,772 (0.87%) | ⭐ MAIN yolo |
  | 2 | 🔴 WHALE_MAX | 4/8 | $3.91M | $6,534 (0.39%) | high-WR yolo |
  | 3 | 🔴 WHALE_MAX | 3/8 | $3.87M | $6,534 (0.39%) | top WR (72%) |
  | 4 | 🔴 WHALE_MAX | 8/8 | $3.65M | $2,970 (0.14%) | min DD yolo |
  | 5 | 🔵 TOMI_MAX | 5/5 | $3.05M | $2,385 (0.10%) | TOMI 200 stable |
  | 6 | 🟠 WHALE_MID | 6/6 | $2.31M | $1,683 (0.10%) | mid balanced |
  | 7 | ⚪ TOMI_MIN | 6/6 | $1.15M | $957 (0.60%) | starter |

### `STEP_TRAIL_v1`
- **Type:** Step-trail mode comparison (LIVE engine, NOT 5m ALL)
- **Date:** 2026-04-28
- **Tool:** `tools/backtest-step-trail-no-tp-3y.ts`
- **Data JSON:** `assets/backtest_step_trail_no_tp_3y.json` (92 KB)
- **HTML report:** `assets/backtest_step_trail_no_tp_3y_report.html`
- **Setup:** 6 modes (E0 off, E-T15 fixedTp, E-T15-NoTP cap10, NoTP-Extended cap20, NoTP-Unlimited, NoTP-PnL100-S20)
- **Winner:** E-T15-NoTP cap 10 → NET 1,142,106%, DD 36k%, WR 56.24%, PF 1.71
- **Insight key:** Cap 10 step optimal — Unlimited drag SL → WR sụt. PnL-based step KÉM TP-distance-based -23%.
- **Applied to production:** btc-trader-server v0.2.4 commit `d73f41e`

---

## 🟡 SUPERSEDED — kept for historical reference

### `STACK_SWEEP_v1`
- **Type:** Stack size sweep (3 preset × 4 stack)
- **Date:** 2026-04-28 (early)
- **Tool:** `tools/backtest-5mall-stack-sweep-3y.ts`
- **Data JSON:** `assets/backtest_5mall_stack_sweep_3y.json` (28 KB)
- **HTML report:** `assets/backtest_5mall_stack_sweep_3y_report.html`
- **Setup:** 3 preset (WHALE/EAGLE/TOMI) × 4 stack [50/75/100/200] = 12 combos
- **Status:** `superseded` — basis cho 5-preset v4.8.23 (WHALE_MAX/MID + TOMI_MAX/MID/MIN)
- **Replaced by:** `TPSL_GRID_v1` cho TP/SL exploration; preset 5 đã chốt từ này.

---

## 📂 OLDER (pre-v4.8.20)

### `PHASE2_SWEEP_v1` (legacy)
- **Tool:** `tools/sweep-5mall-improve-v2.ts`
- **Data JSON:** `assets/sweep_5mall_v2.json`
- **Setup:** 81 runs one-at-a-time tuning per anchor
- **Status:** `superseded` by `STACK_SWEEP_v1` → `TPSL_GRID_v1`
- **Note:** Generated 3 preset cũ (WHALE 75 / EAGLE 30 / TURTLE 15) đã bỏ ở v4.8.20.

---

## 🛠 Cách add entry mới

Khi anh chạy backtest mới:

1. **Đặt tên:** `<DOMAIN>_<TYPE>_v<N>` (vd `STOCH_SWEEP_v1`, `SR_GRID_v1`)
2. **Embed metadata vào JSON** với fields: `name`, `version`, `generated_at`, `description`, `source_meta`
3. **Add entry vào registry này** (`BACKTEST_REGISTRY.md`)
4. Nếu thay thế cái cũ → set `status: "superseded"` + `replaced_by: <new_key>` cho cái cũ

---

## 🔍 Quick reference (current truth)

```
TPSL_GRID_v1     → 280 TP/SL combos · current canonical TP/SL truth
└─ SHORTLIST_v1  → 7 picks Tommy curated (yolo → starter ladder)
STEP_TRAIL_v1    → LIVE engine step-trail (E-T15-NoTP cap 10 winner, applied v0.2.4)
STACK_SWEEP_v1   → superseded, basis cho 5 preset v4.8.23
```

---

## 🆕 `HTF_TPSL_GRID_v2` (2026-04-29 — anh Tommy yêu cầu mở rộng grid)

- **Tool:** `tools/backtest-htf-tpsl-grid-3y.ts`
- **Data JSON:** `assets/backtest_htf_tpsl_grid_3y.json`
- **Report HTML:** `assets/backtest_htf_tpsl_grid_3y_report.html` (per-rule heatmap)
- **Setup:** Sweep TP × SL grid lớn cho từng HTF rule trong `hard_rules.json`.
  - **TFs:** 15m + 1h + 4h + 1d (41 rules tested, 5m baseline disabled)
  - **TP grid:** `[3, 4, 5, 6, 7, 8, 10, 12, 15, 20]` (10 values)
  - **SL grid:** `[2, 2.5, 3, 4, 5, 6, 8, 10]` (8 values)
  - **Combos:** 80/rule × 41 rules = **3,280 runs total**
  - **Mode:** Fixed TP/SL, NO trail (test pure rule edge)
  - **Dataset:** `.cache/binance-{tf}-3y.json` (3 năm BTC/USDT)
  - **Engine:** Reuse `simulateTradeStepTrail` với `stepMode: "off"` + `steps: []`
  - **Filters preserved:** htfTrendFilter, htfRsiFilter, htfFilters, divergence, EMA dist, force side, maxHoldBars
  - **Cooldown:** 10m per rule (LIVE PRESET B)
- **Status:** `current` — applied cleanup 2026-04-29
- **Use case:**
  1. Identify duplicates (cùng signal logic, khác config)
  2. Identify weak rules (low PF, rare signals)
  3. Find best TP/SL per rule (chưa apply, chờ anh Tommy review)
- **Result snapshot:**
  - 41 tested → 24 unique signals (17 dup detected)
  - Best PF cao nhất: **4h:20 LONG TP20/SL10 PF 10.76**
  - Best PF (≥50 trades): **4h:19 LONG TP20/SL2 PF 3.86**, 1h:24 LONG TP3/SL2.5 PF 3.36 WR 57%
  - 100% rules KHÔNG dùng best TP/SL hiện tại → có room tune
- **CLI:**
  ```bash
  npx tsx tools/backtest-htf-tpsl-grid-3y.ts                    # full 4 TFs
  npx tsx tools/backtest-htf-tpsl-grid-3y.ts --tfs=1h,4h,1d     # subset
  npx tsx tools/backtest-htf-tpsl-grid-3y.ts --tfs=15m          # 15m only
  npx tsx tools/backtest-htf-tpsl-grid-3y.ts --rules=3          # top 3 per TF (smoke test)
  ```

### Cleanup applied 2026-04-29 (SAFE — no TP/SL change)
- **Disabled 23 rules** (44 → 21 enabled HTF):
  - 17 duplicates: keeping rep với orig PF cao nhất
  - 6 rare (signals <30/3y)
- **Backup:** `assets/hard_rules.backup.20260429_*.json`
- **Servers:** synced `/Users/lap16116/BTC_PC/btc-trader-server/assets/hard_rules.json`
- **TP/SL UNCHANGED** cho 21 rules giữ lại → LIVE budget 0 thay đổi


---

## 🚨 LESSON LEARNED 2026-05-02 — CROSS MARGIN vs ISOLATED (anh Tommy critical fix)

### Bug em gây ra trong nhiều version cũ:
Code paper engine + UI hiển thị + tools backtest TẤT CẢ đều có dòng:
```ts
if (grossPnl < -margin) grossPnl = -margin; // SAI cho cross margin
```

→ Cap loss tại -margin ($30) per position = **assumption ISOLATED mode**.

### Anh Tommy dùng CROSS margin:
- Tất cả positions share TOTAL WALLET làm collateral
- **Per-position uPnL có thể âm > 100% margin** (wallet còn cover)
- Position close khi hit user-set TP/SL — KHÔNG có per-position liq cap
- LIQ chỉ trigger ở ACCOUNT level: `totalEquity ≤ totalMaintMargin`

### Hậu quả của bug:
1. **Backtest cũ SAI**: position lỗ -260% bị cap thành -100% margin → understate loss
2. **WR giả**: position SHOULD have hit SL ở -300% với loss thực $90 (nếu raw price -3%) nhưng cap giả tạo thành -$30 → record LOSS bình thường nhưng amount sai
3. **NET PnL backtest INFLATED** vì max loss giới hạn → looks safer than reality

### Hedge mode liquidation đúng (Binance docs):
```
net_qty   = qty_LONG - qty_SHORT (signed)
net_entry = (qty_L × entry_L - qty_S × entry_S) / net_qty (break-even)
buffer    = wallet - mm_total

Net long  → LIQ = net_entry × (1 - buffer/net_notional)  (giá ↓)
Net short → LIQ = net_entry × (1 + buffer/net_notional)  (giá ↑)
Hedged    → NO LIQ (wallet tăng cùng chiều price move)
```

→ KHÔNG có per-side liq trong hedge cross. **CHỈ 1 LIQ duy nhất theo NET direction.**

### Fix applied (server v0.3.9 + dashboard v4.9.14+):
- ✅ Bỏ `if (gross < liqLoss) gross = liqLoss` trong presetEngine.ts
- ✅ Bỏ liqPrice per-position
- ✅ UI: bỏ cap upnlUsd ≥ -margin, show full leveraged loss
- ✅ Add ConsolidatedPositions với Account NET LIQ (1 price duy nhất)

### TODO tools/backtest-*.ts:
**TẤT CẢ tools backtest 5m ALL có cap loss đều SAI.** Cần re-run sau fix:
- `tools/backtest-5mall-tpsl-grid-3y.ts` (TPSL_GRID_v1 — 280 combos)
- `tools/backtest-5mall-stack-sweep-3y.ts`
- `tools/backtest-5mall-3y.ts`
- `tools/backtest-htf-tpsl-grid-3y.ts` (HTF_TPSL_GRID_v2)
- `tools/backtest-step-trail-sizes-3y.ts` (STEP_TRAIL_v1)

→ Sau khi fix, **TẤT CẢ kết quả backtest CŨ trong registry này có thể KHÔNG còn chính xác**. Re-run + cập nhật picks.

### Pitfalls cho Claude tiếp theo:
1. **Anh Tommy LUÔN dùng CROSS margin** trên Binance Futures → KHÔNG cap loss per position
2. Khi viết backtest mới: max loss = full leveraged loss, KHÔNG cap tại margin
3. Hiển thị uPnL: show -260% raw nếu position chưa close, KHÔNG cap tại -100%
4. LIQ price: chỉ tính theo NET direction, KHÔNG tính per-side (sai logic)
5. Kiểm tra Binance liq formula: `buffer = wallet - mm_total + uPnL_other_side` (cho net_position)
