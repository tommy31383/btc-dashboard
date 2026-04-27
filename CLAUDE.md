# Quy tắc làm việc — Anh Tommy (BTC Dashboard)

**Skill bắt buộc load đầu tiên:** `anthropic-skills:tommy-workflow`

---

## 📈 BACKTEST PHẢI LƯU EQUITY CURVE (PnL CHART)

Mỗi lần chạy backtest cho 1 rule, **BẮT BUỘC** lưu equity curve (cumulative PnL theo
trade index) vào `rule.stats.equityCurve` trong `assets/hard_rules.json`.

**Format:**
- `rule.stats.equityCurve`: array số (cumulative NET PnL %) sau mỗi trade, max 100 điểm (downsample nếu trade > 100)
- `rule.stats.equityTrend`: `"UP"` | `"FLAT"` | `"DOWN"` — slope của 30% trades cuối so với đoạn đầu
- `rule.stats.maxDrawdownPct`: drawdown lớn nhất từ peak (NET %)

**Mục đích:** Tommy nhìn vào panel rule là biết rule **đang lên (UP)** hay **đang xuống (DOWN)**.
Rule có NET tổng dương nhưng equityTrend=DOWN nghĩa là **đã hết edge** → cần disable.

**Tools nào phải tuân:**
- `tools/backtest-active-3y.ts` (và mọi script backtest khác) phải emit `equityCurve`,
  `equityTrend`, `maxDrawdownPct` trong output JSON
- `tools/sync-rules-from-backtest.ts` phải copy 3 field này vào `rule.stats`
- `components/TradingRulesPanel.tsx` (RuleCard) phải render mini sparkline + badge
  UP/DOWN dựa trên 3 field này

---

## 🔖 BUMP VERSION MỖI LẦN BUILD (BẮT BUỘC)

Trước MỌI lần build (web `npx expo export -p web` hoặc APK), **PHẢI** bump 3 chỗ đồng bộ:

1. `App.tsx` → `APP_VERSION` (vd `4.7.4` → `4.7.5`)
2. `App.tsx` → `BUILD_DATE` (vd `2026-04-27` — ngày hiện tại)
3. `app.json` → `expo.version` (sync với APP_VERSION)

**Quy tắc bump số:**
- Patch (4.7.4 → 4.7.5): bug fix, doc update, config tweak
- Minor (4.7.x → 4.8.0): feature mới (panel mới, preset mới, engine mới)
- Major (4.x.x → 5.0.0): breaking change, refactor lớn

**KHÔNG được build mà KHÔNG bump version** — Tommy cần track được "build này có gì mới" qua version hiển thị trên TopAppBar.

---

## 🚫 CẤM TỰ Ý BUILD APK

- **KHÔNG bao giờ** tự chạy `./gradlew assembleRelease` hoặc build APK
- **CHỈ** khi anh Tommy gõ **"build"**, **"build apk"**, **"ok build"** mới được build
- Sau khi code xong mà chưa có lệnh build → **đứng yên, chờ anh Tommy duyệt**

## 📦 APK OUTPUT PATH — LƯU CỐ ĐỊNH

Sau khi `./gradlew assembleRelease` xong, **LUÔN copy APK** về đúng chỗ:

```bash
cp android/app/build/outputs/apk/release/app-release.apk ../btc-dashboard-v<VERSION>.apk
```

- Path chuẩn: `E:\AI\BTC\btc-dashboard-v<MAJOR.MINOR.PATCH>.apk` (folder CHA của btc-dashboard)
- Version lấy từ `app.json` hoặc từ `APP_VERSION` constant trong `App.tsx`
- **KHÔNG** để APK nằm mỗi build 1 chỗ khác — anh Tommy cần 1 pattern duy nhất để tìm
- Các version cũ giữ nguyên (không xóa) để Tommy rollback khi cần

## 📺 LUÔN SHOW HTML TRÊN BROWSER TRƯỚC KHI BUILD

- Mỗi lần thay đổi UI (RuleAlertBanner, TradingRulesPanel, BinanceChart, v.v.):
  1. Update/tạo file HTML preview trong `assets/` (ví dụ: `alert_banner_final_preview.html`, `sr_preview.html`)
  2. Mở file HTML bằng `start "" "path\to\preview.html"` để anh Tommy xem trên browser
  3. Chờ anh Tommy confirm "ok" → rồi mới build APK khi anh Tommy ra lệnh
- Không skip bước preview — anh Tommy cần nhìn trực tiếp UI trước

## 🔄 Quy trình chuẩn khi nhận task UI

1. **Research** — đọc code hiện tại, hiểu logic
2. **Giải thích** — trình bày em hiểu task như nào
3. **Đề xuất phương án** — nêu 1-3 phương án, ưu/nhược điểm
4. **Chờ anh Tommy duyệt phương án** → KHÔNG tự quyết
5. **Code** — implement theo phương án đã duyệt
6. **Update HTML preview** — tạo/sửa file HTML tương ứng
7. **Mở HTML** cho anh Tommy xem trên browser
8. **Chờ anh Tommy nói "ok"** hoặc feedback
9. **Nếu anh Tommy gõ "build"** → build APK
10. **Update lesson learn** sau khi task xong

## 🎨 Xưng hô

- **"dạ anh Tommy"**, **"em"** — luôn luôn
- Thẳng thắn, không vòng vo, không bịa data
- Khi chưa rõ → hỏi lại, không tự suy đoán

## 📁 Files quan trọng

- `assets/hard_rules.json` — rule set production, NẶNG, chỉ regen khi anh Tommy duyệt
- `assets/scan_tpsl_*.json` + `scan_tpsl_htf_*.json` — output của scan tools
- `components/RuleAlertBanner.tsx` — banner signal live (top của app)
- `components/TradingRulesPanel.tsx` — danh sách rule theo dõi (dưới banner, default collapsed)
- `components/BinanceChart.tsx` — chart có S/R overlay
- `hooks/useRuleAlerts.ts` — logic eval rule match live
- `tools/scan-tpsl.ts` + `scan-tpsl-htf.ts` — scan combo TP/SL (track avgHoldBars)
- `tools/inject-verified-rules.ts` — inject rule vào hard_rules.json

## ⚙️ Lưu ý kỹ thuật

- `avgWinPct` / `avgLossPct` trong `hard_rules.json` **ĐÃ** nhân leverage (từ `leveragedPnlPct`)
  → UI render THẲNG, KHÔNG nhân `× lev` nữa
- `cfg.targetPct` / `cfg.stopPct` là raw price % → UI cần nhân `× lev` để show PnL
- Rule **không** bắt buộc `stochExtreme` (K>95/K<5) — chỉ hiển thị StochK hiện tại cho user tham khảo
- Default scan period = 10,000 candles (realistic, không survivorship bias)
- TradingRulesPanel default `collapsed = true` — user tự bấm mở

---

## 🧠 ARCHITECTURE — 3 ENGINE TRADING ĐỘC LẬP

App có **3 engine song song**, mỗi cái có nguồn trigger + account riêng. KHÔNG nhầm lẫn:

### 1. `use5mAllTrader` — Tab 5m ALL (paper test, local) — v4.7.1+
- File: `hooks/use5mAllTrader.ts` + `utils/all5mAccount.ts`
- Storage: AsyncStorage `@all5m_data_v1` (sync gist) + `@all5m_preset_v1` (preset key, local only)
- Trigger: **mỗi cây 5m close** → Stoch K<level → LONG, K>level → SHORT, fallback S/R 15m
- Account: paper $1000, margin $30, lev 100x
- Chạy nền **liên tục** (App.tsx pass `enabled=true`, không gate theo activeTab) — fix v4.3.66
- KHÔNG liên quan rule trong `hard_rules.json`. KHÔNG liên quan Binance.
- **3 PRESET switch trong UI** (default BALANCED 🟡 EAGLE):
  - 🔴 **WHALE** (highest PnL): TP5/SL2.5, stack 75, dist 0%, cooldown 5m, stoch 10/90, srProx 0.4%, srLB 30 — expected 3y +$1.52M / DD $5.9k
  - 🟡 **EAGLE** (balanced): TP5/SL2.5, stack 30, dist 0.1%, cooldown 5m, stoch 15/85, srProx 0.4%, srLB 50 — expected 3y +$634k / DD $1.98k
  - 🟢 **TURTLE** (lowest DD): TP3.5/SL2, stack 15, dist 0.3%, cooldown 15m, stoch 10/90, srProx 0.4%, srLB 80 — expected 3y +$241k / DD $792
- Switch preset → lệnh OPEN giữ TP/SL CŨ, lệnh MỚI dùng preset mới
- Doc đầy đủ: `5MALL_TRADING_RULES.md` (Phase 2 sweep insights)

### 2. `useAutoTrader` — paper engine (LEGACY, v4.7+)
- File: `hooks/useAutoTrader.ts` + `utils/autoAccount.ts`
- Storage: AsyncStorage `paper_trades.json` + sync gist
- Trigger: subscribe `activeAlerts` từ `useRuleAlerts`
- Account: paper $1000 cap, $30 margin, 100x, limit ±0.1% chờ tối đa 5p
- Render trong `AutoTraderPanel` (Dashboard tab cuối panel)
- **STATUS:** Legacy — đã được LIVE engine thay thế cho production.
  Giữ lại để compare paper vs live nếu cần. Tab HISTORY (xem paper closed trades) **đã xoá v4.7.2**.

### 3. `useBinanceLive` — Tab LIVE (Binance real) — production
- File: `hooks/useBinanceLive.ts` + `utils/liveTraderEngine.ts` + `utils/binanceLive.ts`
- Storage: AsyncStorage `@live_trader_v2` (settings + journal — sync git via `live_trading.json`) + `@live_trader_secret_v1` (API key/secret — LOCAL ONLY, KHÔNG sync)
- Trigger: subscribe `activeAlerts` từ `useRuleAlerts` (cùng nguồn AutoTrader)
- Filter: `state.settings.excludedTfs` (default `["5m"]`)
- 2 mode: **DRY RUN** (chỉ log) hoặc **REAL ORDERS** (POST /fapi/v1/order MARKET — Plan B self-monitor TP/SL, KHÔNG dùng STOP_MARKET)
- Hedge mode + ledger 2 lớp (Binance gộp 1 net LONG + 1 net SHORT, app maintain N tracked entries với TP/SL riêng, partial close reduceOnly khi hit)
- Circuit breakers: `maxOpen`, `dailyLossCapUsd` → `cooldownMinutes` pause; **Equity DD Protection** (`equityDdPausePct` / `equityDdPauseHours`)
- PRESET B mặc định: stack max 50/side, dist 0%, spacing 0m, notional cap $200k
- "Apply Best" button trong SETTINGS card → 1-click optimal config
- Render trong `LiveTab` (BottomNav → LIVE)
- Doc đầy đủ: `LIVE_TRADING_RULES.md`

### Bảng trigger summary

| Source event | 5m ALL | AutoTrader (paper, legacy) | LIVE (Binance) |
|---|---|---|---|
| Cây 5m close + Stoch theo preset | ✅ paper | ❌ | ❌ |
| Rule `1h:rank3` FIRE | ❌ | ✅ paper | ✅ real (nếu AUTO ON, qua Phase 2 LTF confirm) |
| Rule `5m:1` baseline FIRE | ❌ | ✅ paper | ❌ (TF 5m excluded mặc định) |

### BottomNav tabs hiện tại (v4.7.2)

| Tab | Component | Mô tả |
|---|---|---|
| **RULE** (default) | `App.tsx` dashboard | Rule list + chart + AutoTraderPanel |
| **LIVE** | `LiveTab` | Binance Futures real |
| **5m ALL** (PC only) | `All5mPanel` | Paper engine với 3 preset switch |

Tab HISTORY đã xoá v4.7.2 (HistoryScreen render AutoTrader closed — paper legacy redundant với Rule backtest stats + LIVE journal).

### Quy tắc khi sửa engine
- **KHÔNG cross-trigger**: 5m ALL không được fire vào LIVE (và ngược lại) trừ khi Tommy yêu cầu rõ.
- **API key/secret KHÔNG bao giờ vào gist** — phải lưu key riêng `@live_trader_secret_v1`.
- Engine chạy nền nếu cần history liên tục → pass `enabled=true` thay vì gate theo `activeTab`.
- Mọi trigger lệnh thật trên Binance phải qua `decideEntry()` → check circuit breakers (auto, dryRun, paused, dailyCap, maxOpen, dedup).

### CÁCH VÀO LỆNH LIVE (Phase 2 — v4.3.82+)

**KHÔNG vào MARKET ngay khi rule HTF fire.** Flow:

1. **Rule HTF fire** (vd `1h:24` LONG) → `decideEntry` kiểm tra basic blocks (auto, paused, capacity, cap, excludedTfs, per-rule cooldown 10m, đã pending chưa).
2. **Pass tất cả** → return `PENDING` action → `addToPending()` push vào `state.pendingAlerts[]` (lưu `tpPct/slPct` raw từ rule).
3. **Mỗi tick price + LTF data update** → `confirmPending()` quét pending list:
   - **LONG confirm:** `Stoch5m K < confirmStochOsLevel (20)` HOẶC `price ≤ support15m × (1 + 0.4%)`
   - **SHORT confirm:** `K > confirmStochObLevel (80)` HOẶC `price ≥ resistance15m × (1 - 0.4%)`
4. **Confirmed** → recalc entry/TP/SL theo current price → `executeAction(ENTRY)` → MARKET vào.
5. **Pending KHÔNG timeout** — miễn rule còn trong `activeAlerts` (vẫn FIRED). Khi rule chuyển OFF/ARMED → log `DISCARD` + remove khỏi pending.

**Per-rule cooldown 10 phút** — sau ENTRY thành công, rule đó bị block 10m mới vào lại được (giảm nhồi cùng rule).

**TP/SL tự monitor (Plan B):** entry chỉ gửi MARKET; TP/SL prices lưu trong `trackedPositions`; mỗi tick app check mark price → gửi MARKET reduceOnly khi hit.

**Tools/backtest áp dụng cùng logic:** mọi backtest cho rule HTF từ giờ phải simulate logic confirm này (chờ LTF condition trước khi entry).
