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
- **Setup:** 5 preset × 8 TP `[3,4,5,6,7,8,10,12]` × 7 SL `[2,2.5,3,4,5,6,8]` = **280 combos**
- **Period:** 2023-04-27 → 2026-04-26 (3y)
- **Capital:** $5000, lev 100x, fee 0.05%/side
- **Winner NET:** 🔴 WHALE_MAX TP=5/SL=6 → $4.15M, DD 2.0%, WR 54.3%
- **Winner WR:** 🟠 WHALE_MID TP=3/SL=8 → 72.5%, NET $2.29M
- **Min DD:** 🔵 TOMI_MAX TP=8/SL=8 → DD 0.1%, NET $3.09M
- **Insight key:** TP < SL (asymmetric) thắng symmetric. SL=2 với TP cao = blew-up. Stack 200 dominate top NET.
- **Children:** `SHORTLIST_v1`

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

