# BTC Dashboard — Design System v4.3.20
**Material You Warm Dark** · lesson learn từ migration v4.3.19 → v4.3.20

---

## 🎨 Palette (single source of truth: `utils/v2Theme.ts` → `P`)

### Backgrounds (warm dark)
| Token | Hex | Dùng cho |
|---|---|---|
| `P.bg` | `#131313` | surface / background root |
| `P.card` | `#1c1b1b` | **card chính** (mọi component) |
| `P.cardAlt` | `#201f1f` | card nested (rule row, warn row) |
| `P.surface` | `#0e0e0e` | deep nested (snapshot box) |
| `P.elevated` | `#2a2a2a` | active tab bg |
| `P.highest` | `#353534` | chips, tab separator |

### Text
| Token | Hex | Dùng cho |
|---|---|---|
| `P.text` | `#e5e2e1` | primary text |
| `P.text2` | `#d6c3b4` | secondary warm beige (caption) |
| `P.dim` | `#9f8e80` | label, meta, muted |
| `P.fade` | `#514439` | faded/disabled, accent dim (history) |

### Semantic
| Token | Hex | Vai trò |
|---|---|---|
| `P.primaryContainer` | `#ffb874` | **ACCENT CHÍNH** (border-l, title, pill) |
| `P.primary` | `#ffdcc0` | soft peach text |
| `P.onPrimary` | `#4b2800` | dark text on amber bg |
| `P.bitcoinOrange` | `#F7931A` | ₿ brand, hero accent, firing signal |
| `P.tertiary` | `#b5ebff` | ice blue (info, waiting, snapshot) |
| `P.green` | `#10b981` | bull, LONG, safe |
| `P.red` / `P.error` | `#ffb4ab` | bear, SHORT, error, danger (soft coral) |

### Borders
| Token | Hex | Dùng cho |
|---|---|---|
| `P.border` | `#514439` | outline-variant (card border) |
| `P.borderSoft` | `#2a2a2a` | divider row, soft separator |
| `P.grid` | `#514439` | chart grid |

❌ **CẤM dùng** Binance blue, purple Stitch (`#4f46e5`), gold `#ffd700`.

---

## 🖋 Typography

| Role | Font | Size | Letter-spacing | Dùng cho |
|---|---|---|---|---|
| Headline | `SpaceGrotesk_700Bold` | 10-14px | 2 (caps wide) | labels UPPERCASE, section titles |
| Medium | `SpaceGrotesk_500Medium` | 10px | 1.5 | nav labels |
| Body | `Inter_400Regular` / `Inter_700Bold` | 11-13px | 0 | paragraphs, card titles |
| Mono | `JetBrainsMono_500Medium` | 9-12px | 0.5 | numbers, raw values, meta |
| Icon | Material Symbols Outlined (via `MaterialIcon`) | 16-22px | — | icons |

**Quy tắc:**
- Labels/captions LUÔN uppercase + Space Grotesk + `letterSpacing: 2`
- Numbers LUÔN JetBrains Mono, fontWeight 700
- Card title: Inter_700Bold 12-13px
- Meta/secondary: Mono 9-10px color `P.dim`

---

## 🟧 Signature pattern: border-l-4 accent bar

**EVERY card** phải có border-left color-coded:

| Component | Color | Meaning |
|---|---|---|
| PriceHeader | `bitcoinOrange` | ₿ main |
| RuleAlertBanner (firing) | `primaryContainer` | signal live |
| AlertBanner (critical) | `red` | danger |
| LiveFeatureSnapshot | `primaryContainer` (HTF cell) | info accent |
| LiveRulesSummary quote | `tertiary` | waiting/info |
| TradingRulesPanel | `green` | tracking |
| TradingRules rule card (tracked) | `green` | active |
| TradingRules rule card (firing) | `red` | hot |
| TradingRules rule card (highlighted) | `primaryContainer` | focus |
| BinanceChart | `primaryContainer` | data |
| TimeframeTable | `tertiary` | info |
| OverallVerdict | `bitcoinOrange` | ₿ main verdict |
| AlertLog | `fade` (#514439) | history dim |
| SettingsPanel | `primaryContainer` | config |
| RiskRadar Hero | `bitcoinOrange` | ₿ ultra-main |
| RiskRadar Goldens | `primaryContainer` | opportunity |
| RiskRadar LONG check | `green` | bull |
| RiskRadar SHORT check | `red` | bear |
| RiskRadar Snapshot | `tertiary` | raw/info |

**Rule:** `borderLeftWidth: 4` + `paddingLeft: 16-18` để text không đè accent bar.

---

## 📐 Shape rules

| Element | Radius | Ghi chú |
|---|---|---|
| Card default | `borderRadius: 2` (rounded-sm) | TẤT CẢ card/chip |
| Pill status (MODERATE, PREFER LONG) | `borderRadius: 999` | CHỈ cho verdict pill + status dots |
| Avatar / dot | `borderRadius: 999` | circle only |

❌ **CẤM** `rounded-2xl`, `rounded-3xl` kiểu Stitch — phá sharp edge Material You.

---

## 📏 Spacing

- `cardPadding: 16` default
- `marginBottom: 10` giữa các card trong ScrollView
- `gap: 12` horizontal between columns
- `paddingLeft: 16-18` khi có `borderLeftWidth: 4`

---

## 🧭 Shell (TopAppBar + BottomNavBar)

- **TopAppBar**: h=56, bg `P.bg` + `borderBottom P.borderSoft`, title Space Grotesk `#ffb874` uppercase letterSpacing 2.5em, icons MaterialSymbols `P.dim` 20px
- **BottomNavBar**: h=64, bg `P.card` + `borderTop P.highest`, 4 tabs **RADAR / TRADES / ASSETS / PROFILE**
- Active tab: `bg P.elevated` + `borderTop 2px P.bitcoinOrange` + label `P.primaryContainer`
- Inactive: label `P.dim`

**Tab routing (v4.3.20):**
- `RADAR` → dashboard chính (default)
- `TRADES` → Risk Radar screen (5 sections) ⬅ **v4.3.20 wire**
- `ASSETS` → TODO
- `PROFILE` → TODO

---

## 🎯 Component patterns

### Hero card (PriceHeader, RiskRadar hero, OverallVerdict)
```
border-l-4 bitcoinOrange
padding: 14 · paddingLeft: 18
big display number (Space Grotesk 32-56px)
3-col stats row (border-top P.border)
```

### List card (AlertLog, warnings, rules)
```
border-l-4 (color-coded)
row: flexDirection row, py: 6-8, border-bottom P.borderSoft
icon (emoji/Material) — label Inter bold — meta Mono dim — pill/value right
```

### Section card (Goldens, Checklists)
```
outer: border-l-4 · bg P.card
header: title (Space Grotesk caps) + meta (Mono dim) — justifyContent: space-between
sub-caption (Inter dim) mt-1 mb-2
child rows: border-l-3 inner accent · bg P.cardAlt
```

### Verdict pill
```
rounded-full · borderWidth 1 · borderColor color+"55" · bg color+"15"
Space Grotesk ExtraBold 10px letterSpacing 2
px-3 py-0.5
```

---

## 📝 Lesson learn từ migration

### ✅ Good practices
1. **Preview HTML trước**: luôn tạo `assets/*_preview.html` + open browser trước khi code RN → Tommy duyệt visual trước → tránh build tốn thời gian mới phát hiện lệch.
2. **Surgical vs rewrite**: component logic-heavy (TradingRulesPanel, BinanceChart, OverallVerdict, SettingsPanel, TimeframeTable) → **surgical edit** chỉ styles. Component presentational (LiveFeatureSnapshot, LiveRulesSummary, AlertLog, RiskRadar) → **full rewrite**.
3. **Typecheck sau mỗi batch**: `npx tsc --noEmit` phải 0 errors TRƯỚC khi build APK.
4. **Single source of truth**: mọi color/spacing/font qua `P` + `fonts` + `typeSize` từ `utils/v2Theme.ts`. Không hardcode hex trong component.

### ⚠️ Pitfalls
1. **Stitch diverges**: Stitch AI hay trả về palette khác spec (purple + gold + Be Vietnam Pro thay vì warm + Space Grotesk). → Phải convert thủ công, không adopt 1:1.
2. **Local `P` override**: OverallVerdict có local `P` const riêng → phải sửa cả 2 chỗ (local const + import). Check kỹ khi refactor.
3. **`NavTab` type mismatch**: BottomNav có 4 tabs `radar|trades|assets|profile` NHƯNG `activeTab` state là `"dashboard"|"risk"`. Đừng nhầm — map cẩn thận onSelect handler.
4. **Pre-built rules không regen**: `assets/hard_rules.json` là data nặng (scan 20K entries 2.7Y), chỉ regen khi Tommy duyệt.

### 🔁 Quy trình chuẩn (lặp lại cho next migration)
1. Research current code + user intent
2. Propose 1-3 phương án, chờ duyệt
3. Code theo phương án đã chọn (surgical/rewrite)
4. Typecheck 0 errors
5. Tạo preview HTML → open browser
6. Chờ Tommy "ok"
7. Build APK khi Tommy gõ "build"
8. Update lesson learn

---

## 📦 Files liên quan

- `utils/v2Theme.ts` — palette + typography + spacing tokens
- `components/v2/TopAppBar.tsx` — shell top
- `components/v2/BottomNavBar.tsx` — shell bottom (4 tabs)
- `components/v2/MaterialIcon.tsx` — icon wrapper
- `components/v2/useAppFonts.ts` — font loader expo-font
- `assets/claude_design_ref/*.html` — Stitch reference (DO NOT adopt 1:1, chỉ lấy structure)
- `assets/v4.3.20_*_preview.html` — Claude preview (apply palette đúng) → show Tommy duyệt
- `assets/DESIGN_SYSTEM_v4.3.20.md` — file này

---

## 🔖 Versions

- **v4.3.19** → Binance Pro dark-blue (rejected by Tommy)
- **v4.3.20** → Material You warm dark (approved) ✅
  - 11 components refactored + 1 new screen (Risk Radar wired to TRADES tab)
  - APK: `android/app/build/outputs/apk/release/app-release.apk`
  - Build date: 2026-04-22

---

## 🧪 Forward Test & Rule Quality Lessons (2026-04-22)

### Nguyên tắc vàng: scan WR ≠ forward test WR

- Scan WR thường **overfit 20-30%** so với forward test. Lesson xương máu:
  - Scan claim `R1 macd+ema+FLAT WR 93%` → fresh 2.3Y chỉ còn **WR 64.9%**
  - Scan claim `SHORT ema+atr+UP WR 86.7%` → forward **WR 34.4%** (G8 cũ, đã xóa)
- **Luôn verify bằng forward test trước khi claim**. Số liệu trong UI phải là forward, không phải scan.

### Methodology: 20K candles 1h ≈ 2.3 năm

- Default sample size **10K-20K candles** tuỳ TF (balance giữa recency & statistical significance).
- N ≥ 30 là sàn cứng để có ý nghĩa thống kê; N ≥ 50 + WR ≥ 60 = tier GOLD.
- Luôn xét **PF (Profit Factor)** + **Expectancy** song song WR, không dùng WR đơn lẻ.
  - WR 60% N=240 NET -5920% PF 0.92 → bẫy "WR cao, PF < 1 vì fee ăn sạch"
  - WR 50% PF 4 > WR 70% PF 1.1 khi cần robustness

### SHORT direction rule

- **SHORT ăn khi XUÔI trend DOWN, KHÔNG chống trend UP.**
- Gate đúng: `htfTrendFilter: DOWN` (chứ không phải UP như scan gốc).
- WR test: htf UP WR 34% vs htf DOWN WR 69% — khác biệt 2x.

### RR (Risk:Reward) insight

| TP/SL | RR | Break-even WR | Phù hợp |
|-------|----|----|----|
| +5/-2 | 2.5 | 28.5% | **Default cho Goldens** — forgiving, ít SL quét |
| +3/-5 | 0.6 | 62.5% | Chỉ top Goldens LONG (5 rule) đạt được |
| +2/-2 | 1.0 | 50% | Tốt cho 15m SHORT MACD (18 RESCUED rule) |
| +5/-1.5 | 3.3 | 23% | Rule 4h LONG (WR thấp bù bằng RR cao) |

**Bài học:** TP/SL không phải one-size-fits-all. Grid search TP × SL trên rule net âm/nhỏ để "cứu" — 18/73 candidate được rescue chỉ bằng đổi TP/SL.

### Duplicate rules trong hard_rules.json

- 26 groups / 27 rule dup — chủ yếu là variant `lev 10x` vs `lev 100x` cùng config logic.
- Signature dedupe: `tf|side|htfFilter|[sorted required]|reversal|emaPos|TP/SL`.

### Tool stack đã build (giữ lại cho next migration)

- `tools/verify-all-rules.ts` — backtest 1 loạt hard_rules trên fresh Binance data.
- `tools/dedupe-and-rank.ts` — signature + rank theo tier (GOLD/SILVER/BRONZE/JUNK/DEAD).
- `tools/rescue-rules.ts` — grid search TP × SL cho rule net âm/nhỏ.
- `tools/apply-rescue.ts` — apply kết quả rescue vào hard_rules.json (có backup).
- `tools/inject-goldens.ts` — inject 11 Goldens (from useRiskRadar) vào hard_rules.json với flag `config.delegatedTo: "useRiskRadar"`.
- `tools/test-fixed-tpsl.ts` — test TOÀN BỘ rule với TP/SL cố định (native + golden).

### Convention quan trọng

- **Flag `config.disabled: true`** → `useRuleAlerts.ts` skip (DEAD rule).
- **Flag `config.delegatedTo: "useRiskRadar"`** → `useRuleAlerts.ts` skip (native logic handle).
- **Backup hard_rules.json** trước mọi write: `assets/hard_rules.backup-<ISO>.json`.
- Stats đầy đủ: `trades, wins, losses, winRate, netPnL, profitFactor, expectancy, verified, source, rescuedAt|deadAt|injectedAt`.

### Tier classification (production)

- **GOLD** WR ≥ 60% & N ≥ 50
- **SILVER** WR ≥ 50% & N ≥ 30
- **BRONZE** WR ≥ 40% & N ≥ 30
- **JUNK** WR < 40% hoặc PF < 1
- **DEAD** N < 30 hoặc bất kỳ TP/SL đều lỗ

### State hiện tại hard_rules.json (2026-04-22 post-rescue)

- Total: **92 rules** (81 native + 11 Goldens injected)
- GOLD: 10 (toàn bộ là Goldens) + Golden SHORT SILVER: 1
- RESCUED: 18 (TP/SL updated — phần lớn 15m SHORT MACD → `+2/-2`)
- DEAD disabled: 18
- needsReview (IMPROVED): 37
- Last rescue: `rescue_summary` trong hard_rules.json

### Lesson áp dụng next time

1. **Đừng tin WR scan** — forward test là chuẩn duy nhất.
2. **Grid search TP/SL trước khi vứt rule** — nhiều rule tệ vì TP/SL sai, không phải logic sai.
3. **Backup trước mọi ghi đè** `hard_rules.json`. Tool phải idempotent (re-run safe).
4. **SHORT xuôi trend DOWN** — không bao giờ set `htfTrendFilter=UP` cho SHORT.
5. **Goldens (feature-based) ≠ hard_rules (signal-based)** — feature space khác nhau, không overlap duplicate trực tiếp. Inject Goldens qua flag `delegatedTo` tránh double-eval.
6. **PF là vua** — WR cao PF<1 là bẫy. Luôn show PF cạnh WR trong UI.

---

## 🔁 Flip & Rescue Full-Grid Lessons (2026-04-22)

### Bài học về grid TP/SL

- **Grid hẹp = bỏ sót cơ hội**. Lần đầu chạy `flip-and-rescue.ts` với grid `TP[1..5] × SL[0.5..2]` + ràng buộc `RR ≥ 1` → chỉ tìm được **3 rule flip**.
- Mở rộng ra **full grid** `TP[0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15] × SL[0.5, 1, 1.5, 2, 3, 4, 5, 7, 10]` (99 combo) **bỏ luôn RR filter** → phát hiện **13 rule flip** (4.3× so với grid hẹp).
- Nhiều combo "kỳ quặc" (RR<1, SL rộng 7-10%) lại là combo tối ưu vì BTC có drawdown sâu trước khi hit TP nhỏ → **đừng pre-filter theo RR, để data quyết định**.

### Bài học về flip side

- **Hypothesis "WR<30% = side sai, flip sang là win"** → **phần lớn SAI**. Chỉ 6/34 rule loss>70% flip được thành GOLD/SILVER/BRONZE sau dedupe.
- Rule flip thành công đa số là **rule SHORT trong uptrend** (hoặc LONG trong downtrend) — bản thân signal catch được reversal nhưng side nghịch với HTF trend → flip đúng.
- **Wide SL (5-10%)** cần thiết cho rule flip vì entry thường sớm, phải chịu drawdown lớn.

### State sau flip-apply (2026-04-22)

- Disabled 6 rule gốc loss>70% (flippedAt stamp).
- Append 6 rule flipped mới (source: `flipped-from-{tf}-rank{N}`, tier GOLD/SILVER/BRONZE).
- Top flipped:
  - **1h rank19 SHORT→LONG** WR 17%→68.6% (GOLD, +1.5/-10, N=452)
  - **4h rank2 LONG→SHORT** WR 28.9%→63.6% (GOLD, +3/-10, N=717)
  - **1d rank1 LONG→SHORT** WR 23.5%→55% (SILVER, +10/-10)

### Tools mới

- `tools/flip-and-rescue.ts` — full grid, output `assets/flip_rescue.json`.
- `tools/apply-flip.ts` — dedupe theo signature `{tf}|{flipSide}|{required}|{htf}|+{tp}/-{sl}`, disable gốc + append flipped. Idempotent + backup.

### Warning: wide SL risk

- Combo `+1.5/-10` hoặc `+3/-10` có **break-even WR = SL/(TP+SL)**:
  - `+1.5/-10` → BE WR = 87% (chỉ cần 1 loss wipe 6-7 win)
  - `+3/-10` → BE WR = 77%
- Rule GOLD WR 68.6% với SL -10 → **1 trade loss = 10% cap × 10x lev = -100%** → cần capital management nghiêm, **không đánh full size**.

---

## 🔬 Post-Flip Audit + OOS Validation (2026-04-22)

### 7 điểm bổ sung sau khi Tommy audit

1. **Slim flip_summary**: `apply-flip.ts` trước ghi cả mảng `unique` nặng → fix thành `uniqueCount` + `slim-flip-summary.ts` oneshot.
2. **Dedupe post-flip** (`tools/dedupe-post-flip.ts`): signature `{tf}|{side}|{required}|{htf}|TP/SL` → tìm **11 group dup, disable 23 rule**. Tại sao có dup? scan-tpsl generate 2 version lev (10x vs 100x) cùng config.
3. **HTF filter bug ở rule flipped** (CRITICAL): `flip-and-rescue.ts` dùng `want = side==="LONG" ? "UP" : "DOWN"` trong `computeEntries` với `side = originalSide`. Khi apply, rule có `forceSide = flipped`, `useRuleAlerts` tính `want` theo side MỚI → **HTF semantic bị đảo ngược** → production không reproduce được backtest.
4. **Fix (`useRuleAlerts.ts` + `apply-flip.ts` + `patch-flipped-htf.ts`)**: thêm flag `config.htfTrendFilter.invertedFromFlip = true`. `useRuleAlerts` invert `want` khi flag set → replicate backtest đúng semantic.
5. **Disable 3 flipped BRONZE overfit**: 5m rank9 (PF=999 N=6325 overfit), 15m rank26 (edge −41%), 1h rank42 (edge −28%). Chỉ giữ 3 rule flipped chắc ăn.
6. **OOS 90 ngày** (`tools/test-oos.ts`): test 3 rule flipped trên hold-out (2026-01-22 → nay):

| Rule | Claim WR | OOS WR | N | PF | maxDD | Max cons loss |
|---|---|---|---|---|---|---|
| **4h r10 SHORT GOLD** | 63.6% | **68.8% ✅** | 490 | 1.66 | −2389% | **14** |
| **1d r9 SHORT SILVER** | 55% | 100% | **1** ⚠ | — | 0% | 0 |
| **1h r41 LONG GOLD** | 68.6% | **67.4% ✅** | 43 | 1.09 | −3228% | 3 |

→ 2 GOLD **giữ được WR trên OOS** (1d N=1 không đủ data), nhưng **maxDD lớn** → cần risk sizing.

7. **Tier badge UI** (`TradingRulesPanel.tsx`): 🥇GOLD / 🥈SILVER / 🥉BRONZE / ⚠JUNK auto-classify theo WR+N+PF. Badge `⚠` khi edge âm (WR < BE-WR). Badge `⇄` khi rule flipped.

### Convention mới

- **`config.htfTrendFilter.invertedFromFlip: true`** → `useRuleAlerts` tính `want` ngược side (giữ semantic gốc rule trước flip).
- **`stats.tier`** chuẩn: GOLD/SILVER/BRONZE/JUNK. Nếu thiếu → UI auto classify.
- **`stats.oos`**: `{ days, N, WR, edge, PF, finalEquity, maxDD, maxConsL, note }` → ghi sau mỗi OOS test.
- **`stats.dedupeDisabledAt` / `stats.dedupeReason`** → track lý do disable.

### Checklist tools production (đầy đủ hiện tại)

```
tools/
  verify-all-rules.ts        — forward test all rules (native)
  dedupe-and-rank.ts         — signature-based dedupe + tier ranking
  rescue-rules.ts            — grid TP/SL rescue cho rule kém
  apply-rescue.ts            — apply rescue → hard_rules.json (backup + idempotent)
  inject-goldens.ts          — inject 11 Goldens với delegatedTo flag
  test-fixed-tpsl.ts         — test ALL rules với TP/SL cố định
  test-clean-checklist.ts    — WR khi pass all N warning
  flip-and-rescue.ts         — full grid flip side + TP/SL
  apply-flip.ts              — apply flipped rules (signature dedupe + invertedFromFlip)
  slim-flip-summary.ts       — cleanup flip_summary bloat
  dedupe-post-flip.ts        — post-flip signature dedupe
  patch-flipped-htf.ts       — patch invertedFromFlip + disable BRONZE overfit
  test-oos.ts                — OOS hold-out 90 days + maxDD + maxConsL
```

### Lesson áp dụng next time (cộng dồn)

7. **Mọi rule flip phải flag `invertedFromFlip`** — semantic HTF filter không tự động flip theo side.
8. **OOS hold-out là bắt buộc** — không commit rule production mà chỉ có full-history backtest.
9. **maxDD + maxConsecutiveLoss quan trọng hơn NET** — user cần biết tail risk trước khi vào lệnh.
10. **Signature-based dedupe là cần thiết sau mọi lần inject/rescue/flip** — duplicate tích lũy qua nhiều lần generate.
11. **Lev 100x là bẫy** — rule `flipped-from-1h-rank19` inherit lev 100 → 1.5% TP = 150% gain, nhưng 10% SL = 1000% loss. Nên cap lev ≤ 20 cho mọi rule production.

---

## 🔧 Fix Round 2 — Filter Completeness + Lev Standardization (2026-04-22)

### Bug phát hiện khi review

1. **`apply-flip.ts` CHỈ copy** `forceSide/targetPct/stopPct/leverage/maxHoldBars/requiredConditions/htfTrendFilter` → **BỎ SÓT** `candleReversalFilter`, `emaPosFilter`, `minScore`, `stochOBLevel`, `rsiOBLevel`, `weights`, ... từ rule gốc. Hậu quả: rule flipped live fire khác hẳn backtest (VD 4h r10 thiếu `candleReversalFilter + emaPosFilter:"below"` → fire mọi bar thay vì ~14% bar).
2. **`candleReversalFilter`** cũng có bug side-semantic giống `htfTrendFilter`: `useRuleAlerts` tính `want = side==="LONG" ? UP_REVERSAL : DOWN_REVERSAL` từ side → khi side flip, reversal direction cũng flip → không match backtest.
3. **`test-oos.ts` ban đầu** chỉ check `macdCross + divergence + htfTrendFilter` → miss `candleReversalFilter + emaPosFilter` → entry count sai (490/490 thay vì 82/490).

### Fix

- **`apply-flip.ts`**: `{...origCfg, override flip fields}` → copy FULL config + flag `candleReversalFilter.invertedFromFlip = true` + `htfTrendFilter.invertedFromFlip = true` + explicit `disabled: false`.
- **`useRuleAlerts.ts`**: handle `candleReversalFilter.invertedFromFlip` tại 2 checkpoint (line 523 + line 903) — invert `want` khi flag true.
- **`test-oos.ts`**: implement đủ 5 filter (CRF, emaPos, macdCross, divergence, HTF) với invertedFromFlip semantic. Log skip reasons để debug.

### OOS kết quả SAU fix (chuẩn xác)

| Rule | Claim WR | **OOS WR (fix)** | N OOS | maxDD | Cons Loss |
|---|---|---|---|---|---|
| **4h r10 SHORT GOLD** | 63.6% | **69.5% ↑** | **82** (từ 490 sai) | −637% | 4 |
| **1h r41 LONG GOLD** | 68.6% | **67.4%** | 43 | −3228% | 3 |
| **1d r9 SHORT SILVER** | 55% | 100% | **1** ⚠ | 0% | 0 |

→ 2 GOLD vẫn hold up, nhưng N OOS của 4h r10 giảm 6× (490→82) vì giờ CRF+emaPos filter → 365 bar skip CRF + 43 bar skip ema.

### Force leverage = 100 (Tommy directive)

- **`tools/force-lev100.ts`**: set `config.leverage = 100` cho TẤT CẢ rule (98/98). 37 rule có lev khác (10, 20) được đổi.
- Không recalc `stats.netPnL` — số scan gốc đã ở scale lev 100.
- Lý do: nhất quán UI + calc PnL, tránh user nhầm lẫn giữa rule lev 10 và lev 100.

### Lesson cộng dồn

12. **Mọi filter side-dependent** (`htfTrendFilter`, `candleReversalFilter`, future: `emaPosFilter` nếu side-ware) **PHẢI có flag `invertedFromFlip`** khi copy sang rule flipped. Không thì production khác backtest.
13. **Copy config bằng spread `{...origCfg, overrides}`** — không list field một cách thủ công. An toàn hơn, không bỏ sót.
14. **OOS test phải replicate ĐẦY ĐỦ filter chain** — nếu miss 1 filter, N sai → WR sai. Skip reason logging là bắt buộc để debug.
15. **Leverage thống nhất 100** (per Tommy 2026-04-22): mọi rule production có lev=100 trong config. UI fallback `cfg.leverage || 100`. PnL scale đồng nhất.


---

## 🔍 Fix Round 3 — ARMED skipReason expose (2026-04-22)

**Vấn đề Tommy phát hiện:** Rule UI show "REQUIRED 1/1 khớp" nhưng status vẫn **ARMED** (chưa FIRE). Không hiểu vì sao.

**Root cause:** `ruleMatchesSmart()` trong `hooks/useRuleAlerts.ts` có **9 tầng filter** nhưng UI chỉ show 6 tầng đầu. Hai tầng ẩn:
- `multiTfScoreFilter` (line 574-581) — score < threshold → silent skip
- `minScore` / `minWeightedScore` (line 611-614) — nếu rule đòi `minScore: 2` nhưng chỉ 1 required cond → fail dù UI show 1/1

**Fix:** Expose `skipReason` từ `ruleMatchesSmart` xuống `RuleMatchDetail.skipReason` rồi render lên UI. Với BOTH-side rule, chọn reason của side tiến xa nhất trong filter chain (priority-based).

```ts
// useRuleAlerts.ts — priority-based skip reason
const reasonPriority = { candleReversal:1, emaPos:2, zeroCond:3, htfTrend:4,
  atr:5, macdHist:6, emaDist:7, multiTfScore:8, htfRsi:9, htfFilters:10,
  required:11, score:12 };
const setReason = (code, detail, side) => {
  if ((reasonPriority[code] ?? 0) > (bestReason ? reasonPriority[bestReason.code] : -1))
    bestReason = { code, detail, side };
};
// ... tại mỗi `continue` trong filter chain gọi setReason(...)
return { matches:false, ..., skipReason: bestReason ? `[${bestReason.side}] ${bestReason.detail}` : undefined };
```

**UI (TradingRulesPanel.tsx):** khi ARMED + có `skipReason` → render `CHẶN: {skipReason}` thay vì chỉ show "N/M điều kiện khớp".

### Lessons learn (bổ sung 16-17)
16. **Mọi filter `continue` PHẢI có `setReason`** — nếu không, rule ARMED silent → user không debug được. Bất kỳ filter mới thêm vào `ruleMatchesSmart` phải gọi `setReason(code, detail, side)` ngay trước `continue`.
17. **Priority-based reason** với rule BOTH-side (forceSide undefined): side tiến xa nhất trong chain = reason hữu ích nhất. Side chỉ fail ở `candleReversal` (tầng 1) ít giá trị hơn side fail ở `score` (tầng 12) — user muốn biết cái suýt khớp.


---

## 🎨 Fix Round 4 — RuleCard v2 Golden-clone + Rarity (2026-04-23)

**Yêu cầu Tommy:** "các item trong RULE LIST trình bày kém, trình bày giống golden rule, sử dụng skill UI UX". Thêm: "màu sắc phụ thuộc vào rank — rank càng cao càng rare".

### Rarity tier theo absolute rank

| Rank | Tier | Color | Border | Effect |
|---|---|---|---|---|
| 1-2 | 🔥 LEGENDARY | `#ff6b1a` | 4px | pulse glow + gradient tint |
| 3-5 | 💎 EPIC | `#c77dff` | 3px | gradient tint |
| 6-10 | ⚡ RARE | `#4aa8ff` | 3px | subtle tint |
| 11-20 | 🟢 UNCOMMON | `#7dd87d` | 2px | — |
| 21+ | ⚪ COMMON | `#9f8e80` | 1px | opacity 0.88 |

**FIRING override tất cả:** orange (`P.bitcoinOrange`) + pulse 600ms + fire badge footer.

### Layout v2 (mimic GoldenCard line 88-136 của RiskRadar.tsx)

1. **Header row:** `SIDE pill (LONG/SHORT/BOTH)` · `#rank` (colored theo rarity) · `title` (flex) · `rarity badge` · `WR pill` · `Switch`
2. **Meta line:** `lv · PF · N · TP/SL · freq` | `NET

---

## 🎨 Fix Round 4 — RuleCard v2 Golden-clone + Rarity (2026-04-23)

**Yêu cầu Tommy:** "các item trong RULE LIST trình bày kém, trình bày giống golden rule, sử dụng skill UI UX". Thêm: "màu sắc phụ thuộc vào rank — rank càng cao càng rare".

### Rarity tier theo absolute rank

| Rank | Tier | Color | Border | Effect |
|---|---|---|---|---|
| 1-2 | LEGENDARY | #ff6b1a | 4px | pulse glow + gradient tint |
| 3-5 | EPIC | #c77dff | 3px | gradient tint |
| 6-10 | RARE | #4aa8ff | 3px | subtle tint |
| 11-20 | UNCOMMON | #7dd87d | 2px | — |
| 21+ | COMMON | #9f8e80 | 1px | opacity 0.88 |

**FIRING override tất cả:** orange (`P.bitcoinOrange`) + pulse 600ms + fire badge footer.

### Layout v2 (mimic GoldenCard tại RiskRadar.tsx:88)

1. **Header row:** SIDE pill · #rank (colored) · title (flex) · rarity badge · WR pill · Switch
2. **Meta line:** `lv · PF · N · TP/SL · freq` | NET% (right)
3. **Status banner** full-width: FIRED / READY / BLOCKED:skipReason / WAITING
4. **Progress bar** 4px
5. **Condition groups row-based:** REQUIRED · FEATURE · HTF TREND — mỗi row `✓/· label ...... live`
6. **Fire badge footer** khi FIRED

### Code changes
- `components/TradingRulesPanel.tsx`: helper `getRarity(rank)`, import Animated+Easing+useRef cho pulse, rewrite RuleCard JSX thành `Animated.View`, ~30 styles mới prefix `rc*`. Bỏ compactRow + chip soup.

### Lessons 18-20
18. **Rarity theo absolute rank** (không %) cho consistent visual cross-TF — rank #1 luôn glow dù ở 4h (10 rule) hay 1h (42 rule).
19. **FIRING priority > rarity** — override cả 5 tier, bitcoin orange pulse nhanh hơn (600ms vs 900ms) để attention.
20. **Row-based conditions > chip soup** — 1 condition/row với `✓ label ...... live value` dễ scan hơn 7 chip chen ngang. Pattern GoldenCard (RiskRadar) đã chứng minh hiệu quả.
