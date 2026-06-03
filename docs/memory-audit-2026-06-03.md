# Memory Audit — 2026-06-03

Audit toàn bộ 24 memory file tại `/Users/lap16116/.claude/projects/-Users-lap16116-BTC-PC/memory/`.

---

## 1. Tổng quan index

| # | File | Type | Dòng | Tình trạng |
|---|------|------|------|-----------|
| 1 | `project_btc_dashboard.md` | project | 16 | ✅ OK |
| 2 | `project_btc_trader_server.md` | project | **1240** | ⚠️ Quá lớn — cần prune |
| 3 | `project_btc_backtest_workflow.md` | project | 61 | ✅ OK |
| 4 | `project_macro_ai_research.md` | project | 41 | ✅ OK |
| 5 | `project_hedge01_overext_2021_verified.md` | project | 17 | ✅ OK |
| 6 | `project_hedge05_method.md` | project | 45 | ✅ OK |
| 7 | `project_hedge05_turtle_alpha.md` | project | 31 | ✅ OK |
| 8 | `project_general_rule_multiasset_book.md` | project | 152 | ⚠️ Đang phình (R50-R89 thêm vào cuối) |
| 9 | `feedback_backtest_full_cycle.md` | feedback | 25 | ✅ OK |
| 10 | `feedback_build_only_when_asked.md` | feedback | ~6 | ✅ OK |
| 11 | `feedback_capital_is_test_scale.md` | feedback | 81 | ⚠️ Hơi dài nhưng OK |
| 12 | `feedback_dollar_not_ra_when_size_varies.md` | feedback | ~8 | ✅ OK |
| 13 | `feedback_filter_overfit_risk.md` | feedback | 22 | ✅ OK |
| 14 | `feedback_loss_handling_cut_beats_rescue.md` | feedback | 25 | ✅ OK |
| 15 | `feedback_model_confirm_before_task.md` | feedback | 20 | ✅ OK |
| 16 | `feedback_never_suggest_rest.md` | feedback | ~5 | ✅ OK |
| 17 | `feedback_no_sl_is_survivorship_bias.md` | feedback | 46 | ✅ OK |
| 18 | `feedback_only_btc_eth_sol.md` | feedback | ~5 | ✅ OK |
| 19 | `feedback_prefer_minimal_setup.md` | feedback | ~5 | ✅ OK |
| 20 | `feedback_review_must_check_runtime.md` | feedback | ~8 | ✅ OK |
| 21 | `feedback_strategy_iteration_patterns.md` | feedback | **409** | ⚠️ Rất lớn — đúng mục đích (reference) |
| 22 | `feedback_verify_on_live_faithful_harness.md` | feedback | 20 | ✅ OK |
| 23 | `reference_deploy_pipeline.md` | reference | 23 | ✅ OK |
| 24 | `reference_repo_data_sync.md` | reference | 19 | ✅ OK |

---

## 2. Issues tìm được

### 🔴 Issue #1: MEMORY.md index quá verbose (CẦN FIX)

`MEMORY.md` theo spec phải có mỗi dòng ≤150 chars. Hiện tại dòng 2 (BTC Trader Server) và dòng 3 (hedge05 method) là những đoạn văn dài hàng trăm từ được nhồi vào index. Điều này:
- Khiến MEMORY.md = 25 dòng nhưng 2 dòng chiếm ~80% content
- Dẫn đến hệ thống có thể bị truncate sau dòng 200 (context cap)
- Index nên là pointer, KHÔNG phải nội dung

**Cần rút gọn 2 dòng này về ~150 chars.**

### 🟡 Issue #2: `project_btc_trader_server.md` quá lớn (1240 dòng, 73KB)

File này tích lũy lesson learn từ v0.4.13 → v0.4.71 qua nhiều session. Phần lớn là lịch sử cũ (v0.4.13→v0.4.58) không còn actionable. Nên:
- Giữ: ops audit mới nhất, version history từ v0.4.60 trở đi, deployed logger status
- Archive: history v0.4.13→v0.4.58 vào separate archive doc

### 🟡 Issue #3: `project_general_rule_multiasset_book.md` phình (R50-R89 appended)

Nội dung được append thêm qua nhiều session thành 152 dòng dài. Cấu trúc hiện tại là "research journal" hơn là memory. Nên refactor thành:
- Phần trên: canonical config hiện tại + key numbers
- Phần dưới: kill list + lessons (compressed)
- Archive: chi tiết R50-R89 vào doc riêng đã có (`frequency-improvement-research-2026-06-03.md`)

### 🟡 Issue #4: Cross-reference naming không nhất quán

Một số file dùng `[[feedback_dollar_not_ra_when_size_varies]]` (underscore), số khác dùng `[[verify-on-live-faithful-harness]]` (dash). Tên slug trong frontmatter phải khớp với `[[link]]` trong body.

Kiểm tra:
- `feedback_verify_on_live_faithful_harness.md` → name slug: `verify-on-live-faithful-harness` ← dùng dash
- `feedback_dollar_not_ra_when_size_varies.md` → name slug: có thể khác với link `[[feedback_dollar_not_ra_when_size_varies]]`

---

## 3. Nội dung từng file — tóm tắt audit

### PROJECT FILES

#### `project_btc_dashboard.md`
- **Status:** ✅ Current
- **Nội dung:** React Native (Expo 54) + TypeScript, GitHub Pages, repo `tommy31383/btc-dashboard`, code tại `/Users/lap16116/BTC_PC/btc-dashboard/`. Version bump cần sửa `App.tsx` (APP_VERSION + BUILD_DATE) VÀ `app.json`.
- **Ghi chú:** Súc tích, đúng spec memory. Không cần sửa.

#### `project_btc_trader_server.md`
- **Status:** ⚠️ Current nhưng quá lớn (1240 dòng)
- **Key facts cần nhớ:**
  - Live VPS: `root@159.223.90.60` (DO Singapore), deploy `./deploy.sh`
  - Version hiện tại: **v0.4.71** (2026-06-02)
  - ALWAYS_ON_RULES = [hedge01, hedge05]
  - hedge01: LIVE, RANGE-only, RA +0.425, 17 entries/yr
  - hedge05: ENTRY OFF (H05_ENABLE_ENTRY=false), evalClose vẫn chạy wind-down
  - Paper loggers live: `turtleLogger.ts` + `multiTfLogger.ts` (zero-risk, paper-only)
  - Telegram alerts BẬT (chat_id 7048117097)
  - pm2-logrotate installed
  - v0.4.71 audit-fix: faithfulness bug (ADX_TREND 20→25, intrabar exit check)
- **Khuyến nghị:** Archive phần v0.4.13→v0.4.58, giữ từ v0.4.59 trở đi

#### `project_btc_backtest_workflow.md`
- **Status:** ✅ Current
- **Key facts:**
  - Primary data: `.cache/binance-5m-7y.json` (76MB, Jan 2019→May 2026)
  - Pipeline: mark → features → combo → train/test → TP/SL grid → integrate
  - Combo C2 winner: RSI≥70 5m + upWick + mom_all_up
  - SHORT BTC 5m: không có edge
  - Tools: `tools/fetch-spot-5m-7y.ts`, `tools/mark-hedge02new*.ts`, `tools/sweep-tpsl-c2-7y.ts`
- **Ghi chú:** Đúng spec, không cần sửa.

#### `project_macro_ai_research.md`
- **Status:** ✅ Current
- **Key facts:**
  - 4 macro AI proposals đều FAIL/KILL trên 7y BTC
  - #1 regime-prob: rho=0.04 (negligible)
  - #2 CPD: premise đảo ngược trên BTC
  - #3 vol forecast: ATR ≈ HAR-RV (ATR đã optimal)
  - #4 alt-data: chỉ 14 ngày history (file name "7y" misleading)
  - AltData logger DEPLOYED v0.4.50 → `altdata-BTCUSDT.jsonl`
  - Kết luận: design đơn giản hiện tại (trend+ADX+ATR+EMA200) là optimal
- **Ghi chú:** Đầy đủ, có doc reference. Không cần sửa.

#### `project_hedge01_overext_2021_verified.md`
- **Status:** ✅ Current (verified 2026-06-02)
- **Key facts:**
  - overext gate REJECT: −24%$ / −39%return (artifact v0438 thiếu RANGE-only)
  - 2021 = −$2 phẳng (không phải vấn đề)
  - Re-enable BULL REJECT: DD gấp đôi 20.7%→42.5%, RA tụt
  - **Baseline live-faithful:** n=107, RA +0.515, WR 64%, R:R 2.44, DD 20.7%, ROI +396%
  - **Kết luận: hedge01 ở optimum, không đẽo thêm**
- **Ghi chú:** Súc tích, có cross-ref. Không cần sửa.

#### `project_hedge05_method.md`
- **Status:** ✅ Current (comprehensive, 2026-06-02)
- **Key facts:**
  - hedge05 = phương pháp đánh (DCA/cut/reverse), KHÔNG phải entry rule
  - ENTRY OFF từ v0.4.68 (H05_ENABLE_ENTRY=false)
  - Backtest RA 0.308 = LOOKAHEAD-INFLATED → faithful thật RA 0.153, dollar −$417/7y
  - Lookahead bugs: (1) idx4h chứa ts, (2) regime ngày D thay vì D-1
  - DCA phình lệnh THUA: RA% dương nhưng dollar âm
  - Multi-TF method: +$291/7y RA 0.056 nhưng fragile (1d-EMA50 load-bearing, drop→$9)
  - **Kết luận: forced-daily = structural-drift thuần, RA 0.056 = trần, giữ paper, không size**
  - Handling optimal đã deploy: cut@-2.2×ATR + flip reverse-v2
  - Meta-sizing KILLED: AUC test=0.509 (coin-flip)
- **Ghi chú:** Rất đầy đủ. Có vẻ một số section bị duplicate (lesson #1 đính chính ở dưới). OK.

#### `project_hedge05_turtle_alpha.md`
- **Status:** ✅ Current (2026-06-02)
- **Key facts:**
  - Config: daily Donchian 20/10 LONG-only + ATR-cut + skip-BEAR
  - Cut1.5-2: Sharpe 0.61-0.73 vs B&H 0.35, MaxDD ~nửa B&H
  - **Edge ở CẮT LOSER, không phải breakout** (turtle trơn = beta)
  - DEPLOYED: `turtleLogger.ts` v0.4.70 → `turtle-paper-BTCUSDT.jsonl`
  - Corr hedge01↔turtle: +0.069 (diversify thật)
  - ex-2021: dollar-Sharpe 0.63→0.62 (robust, +363% là % illusion)
  - **Còn gate: forward-test paper trước khi size**
  - Research doc: `btc-dashboard/docs/hedge05-turtle-research-2026-06-02.md`
- **Ghi chú:** Đầy đủ, có methodology refs. Không cần sửa.

#### `project_general_rule_multiasset_book.md`
- **Status:** ⚠️ Current nhưng phình (152 dòng, nhiều session appended)
- **Key facts:**
  - General rule = hedge01 áp {BTC, SOL} + turtle-BTC sleeve + risk-parity
  - OOS walk-forward Sharpe ~0.71, DD ~11%, corr(BTC,SOL)≈0
  - Turtle cross-asset KILLED (2024-only, không robust 2025)
  - SOL: hedge01 yêu (Sh 2.0) / turtle ghét (−0.24)
  - ETH KILLED (R47): corr BTC/ETH = +0.639, không diversify
  - **FINAL CONFIG R87:** BTC ADX18, SOL ADX15, Turtle DE20/DX14/CUT2.0/BEAR-gate, weight 1:1:1.2, skip-August (robust 3/3 holdout)
  - Ceiling xác nhận R89: Sh+2.48 DD4.6% (3y 2023-2025)
  - **CHƯA DEPLOY** — cần wire SOL paper-logger
  - Deliverable: `btc-dashboard/docs/general-rule-multiasset-book-2026-06-02.md`
  - Research doc: `btc-dashboard/docs/frequency-improvement-research-2026-06-03.md`
- **Khuyến nghị:** Refactor — giữ Final Config + key numbers ở đầu, compress lịch sử R10-R89

---

### FEEDBACK FILES

#### `feedback_backtest_full_cycle.md`
- **Rule:** Default dataset = 7y (`binance-5m-7y.json`). Train/test chronological 70/30. Per-year stability ≥ 5/8 năm.
- **Why:** Combo 3y bull-only survivorship bias (distMA50 3y +59.4% ROI → 7y train ROI −226%).
- **Status:** ✅ Current, còn relevant.

#### `feedback_build_only_when_asked.md`
- **Rule:** KHÔNG run build/deploy cho đến khi Tommy gõ "build".
- **Status:** ✅ Active rule. Simple, súc tích.

#### `feedback_capital_is_test_scale.md`
- **Rule:** $200 wallet = test scale ONLY. KHÔNG dùng excuse "quá nhỏ" hay "ROI tuyệt đối thấp". Judge theo % ROI + RA. KHÔNG đề xuất "stop dev" hay "buy-and-hold".
- **Status:** ✅ Active rule. 81 dòng hơi dài nhưng có nhiều case examples cụ thể.

#### `feedback_dollar_not_ra_when_size_varies.md`
- **Rule:** Khi rule có DCA/pyramid/scale-in → RA% CÓ THỂ ngược dấu dollar thật. JUDGE bằng DOLLARS.
- **Why:** hedge05 RA +0.153/stab 8/8 nhưng dollar −$417/7y.
- **Status:** ✅ Active, critical rule.

#### `feedback_filter_overfit_risk.md`
- **Rule:** Thêm filter → n giảm → overfit risk. Structural filters (ADX, RANGE) = safe. Data-scan filters (h=16, Thu/Sun) = risky. n<20/yr = red flag.
- **Status:** ✅ Active rule.

#### `feedback_loss_handling_cut_beats_rescue.md`
- **Rule:** Xử lý lệnh âm KHÔNG tạo edge. Expectancy ở ENTRY. Adverse gradient: <1ATR gỡ 84-98%, >3ATR = 0% → cắt tối ưu ≈−3×ATR. Reverse cần multi-factor confirm.
- **Ladder dollar/7y:** martingale −$877 < DCA+rev-mù −$445 < ... < cut@−3 −$63 ≈ reverse-v2 −$58 < noshort+conviction ≈ $0.
- **Status:** ✅ Active, well-documented với số cụ thể.

#### `feedback_model_confirm_before_task.md`
- **Rule:** Trước mỗi task đề xuất model (Haiku/Sonnet/Opus) + lý do ngắn, chờ Tommy confirm.
- **Status:** ✅ Active rule. Simple.

#### `feedback_never_suggest_rest.md`
- **Rule:** CẤM hỏi "anh nghỉ ạ" / "muốn dừng không". Kết thúc task → hỏi task tiếp theo.
- **Status:** ✅ Active rule.

#### `feedback_no_sl_is_survivorship_bias.md`
- **Rule:** TUYỆT ĐỐI cấm đề xuất "no SL" trong bất kỳ context. Rule cũ kill bởi SL → redesign, không rollback.
- **Status:** ✅ Active, critical.

#### `feedback_only_btc_eth_sol.md`
- **Rule:** CẤM test alt-asset ngoài BTC, ETH, SOL.
- **Status:** ✅ Active. (Note: trong general-rule research Tommy đã test SOL/ETH — consistent với rule này.)

#### `feedback_prefer_minimal_setup.md`
- **Rule:** Hardcode defaults. Không expose config Tommy không cần vary.
- **Status:** ✅ Active.

#### `feedback_review_must_check_runtime.md`
- **Rule:** Review VPS BUỘC tail log thật + verify post-deploy. KHÔNG dừng ở `npx tsc`.
- **Status:** ✅ Active.

#### `feedback_strategy_iteration_patterns.md`
- **Status:** ✅ Rất đầy đủ (409 dòng, reference doc)
- **Content:**
  - **29 process lessons:** combo ≠ sum, drop-bad paradox, per-bucket reveal, 4-metric accept, single-knob, ablation 2-way, param sweep ±1
  - **ADX 14 4h** = single biggest filter, threshold 20-22, period 14 optimal
  - **8 confirmed winners:** ADX>20 sticky, EMA200 1h gate, ATR%ile 30th, volMA 10 (→ sau thành 16), A20 dynamic SL, L2 skip h=8 BTC, E1 drop S12 ETH
  - **28 anti-patterns** gồm: DI agree, pyramid A25, weighted qty A23, VWAP, funding arb BTC, SOL multi-symbol, M1/M3 bucket filter
  - v0.4.55 7y baseline: RA +0.546, WR 60%, R:R 3.28, DD 14% (note: current live RA +0.425 với strict RANGE-only)
- **Ghi chú:** File này là reference lớn, không phải memory ngắn — OK để dài. Số RA v0.4.55 (+0.546) khác live canonical (+0.515 trong hedge01 verify file) — v0.4.55 dùng RANGE+strict config khác, không conflict.

#### `feedback_verify_on_live_faithful_harness.md`
- **Rule:** Trước khi port "win" backtest sang live, re-verify trên harness khớp config live HIỆN TẠI (đủ filter). Case: overext +$920 trên v0438 → −24% trên live RANGE-only.
- **Status:** ✅ Active, critical lesson.

---

### REFERENCE FILES

#### `reference_deploy_pipeline.md`
- **Content:** `npx expo export -p web` → copy dist/ → docs/app/ → commit + push master. GitHub Pages live URL: `https://tommy31383.github.io/btc-dashboard/app/`.
- **Status:** ✅ Current. Steps đúng, commands cụ thể.

#### `reference_repo_data_sync.md`
- **Content:** State files sync via GitHub Contents API trên `paper-data` branch (tách khỏi master để tránh Pages rebuild limit 10/hr). Files: `paper_trades.json`, `auto_account.json`. Auth: PAT key `@gist_pat`. Push debounce: 5s.
- **Status:** ✅ Current.

---

## 4. Issues cần fix — ưu tiên

### Priority 1: MEMORY.md — rút gọn dòng 2 và 3 (ảnh hưởng context)

Dòng 2 (`project_btc_trader_server.md`) và dòng 3 (`project_hedge05_method.md`) trong MEMORY.md hiện dài hàng trăm từ. Theo spec, mỗi dòng index ≤150 chars. Cần rút về:

```
- [BTC Trader Server project](project_btc_trader_server.md) — Node server VPS DO Singapore, LIVE v0.4.71. hedge01 ON (RA+0.425). hedge05 ENTRY OFF. Paper loggers: turtle+multiTf.
- [hedge05 method + lessons](project_hedge05_method.md) — forced-daily method ENTRY OFF. Dollar −$417/7y (RA 0.308 lookahead-inflated). Multi-TF paper deployed v0.4.71. GIỮ PAPER, không size.
```

### Priority 2: `project_btc_trader_server.md` — archive old history

Nên prune về ~100-150 dòng, giữ:
- Ops status (Telegram, pm2, health hiện tại)
- v0.4.60 trở đi (hedge04, hedge05, paper loggers)
- VPS deploy info
- Archive v0.4.13–v0.4.59 vào `btc-trader-server/docs/changelog-archive.md`

### Priority 3: `project_general_rule_multiasset_book.md` — refactor structure

Hiện tại là append-only journal. Refactor thành:
- Section 1: FINAL CONFIG (R87/R89) + canonical numbers
- Section 2: Kill list (compressed)
- Section 3: Key lessons (compressed)
- Archive: chi tiết rounds → đã có trong `frequency-improvement-research-2026-06-03.md`

---

## 5. Trạng thái live (2026-06-03)

| Component | Status | Version |
|-----------|--------|---------|
| VPS server | 🟢 Online | v0.4.71 |
| hedge01 | 🟢 LIVE | RANGE-only, RA+0.425 |
| hedge05 entry | 🔴 OFF | kill-switch active |
| hedge05 evalClose | 🟢 Running | wind-down mode |
| turtle paper logger | 🟢 Running | `turtle-paper-BTCUSDT.jsonl` |
| multiTf paper logger | 🟢 Running | `multitf-paper-BTCUSDT.jsonl` |
| altData logger | 🟢 Running | `altdata-BTCUSDT.jsonl` |
| General rule (SOL) | ⚪ NOT deployed | cần wire SOL paper-logger |

---

## 6. Hướng nghiên cứu tiếp (còn open)

| Hướng | File | Status |
|-------|------|--------|
| Turtle forward-test tích lũy vs backtest | `project_hedge05_turtle_alpha.md` | Paper running (v0.4.70) |
| MultiTf forward-test vs backtest RA 0.056 | `project_hedge05_method.md` | Paper running (v0.4.71) |
| Wire SOL paper-logger (general rule) | `project_general_rule_multiasset_book.md` | Cần build |
| hedge05 ENTRY redesign từ đầu (live-faithful harness + no-DCA + judge dollars) | `project_hedge05_method.md` | Open |
| Alt-data backtest sau khi đủ sample (~3 tháng) | `project_macro_ai_research.md` | Open (logger running) |

---

*Audit by Claude Code — 2026-06-03*
