# 5m ALL TRADING ENGINE — Rule & Preset

**Version:** v3.1 (last updated 2026-04-28 — anh Tommy v4.8.23, doc cleanup pass)

---

## 🆕 v3.0 — 5 PRESETS từ Stack-Sweep Backtest (12 combo 3y)

EAGLE/BALANCED + TURTLE bị **bỏ luôn** vì dominated bởi WHALE/TOMI ở mọi stack size.
3 preset cũ × 4 stack [50/75/100/200] = 12 combo, em pick 5 winner:

| Key | Label | Emoji | TP/SL | Stack | NET 3y | DD % | WR | PF | Vai trò |
|-----|-------|-------|-------|-------|--------|------|----|----|---------|
| `WHALE_MAX` | WHALE 200 | 🔴 | 5/2.5 | 200 | $3.03M | 8.0% | 34% | 2.31 | Max NET — yolo |
| `WHALE_MID` | WHALE 100 | 🟠 | 5/2.5 | 100 | $1.89M | 2.6% | 34% | 2.27 | WHALE balanced |
| `TOMI_MAX` | TOMI 200 | 🔵 | 4/4 | 200 | $2.63M | 0.3% | 50% | 3.51 | TOMI scaled max |
| **`TOMI_MID`** ★ | **TOMI 100** | 🟢 | 4/4 | 100 | $1.87M | **0.2%** | **50%** | **3.55** | **DEFAULT — best risk-adj** |
| `TOMI_MIN` | TOMI 50 | ⚪ | 4/4 | 50 | $1.16M | 0.3% | 50% | 3.52 | Starter — vốn ít |

### Migration legacy keys (auto trong `getActivePresetKey`):

| Legacy | → v4.8.23 |
|--------|-----------|
| `AGGRESSIVE` | `WHALE_MID` (gần với WHALE-75 cũ nhất) |
| `BALANCED`   | `TOMI_MID`  (EAGLE bỏ → TOMI safest) |
| `TURTLE`     | `TOMI_MIN`  |
| `TOMI`       | `TOMI_MIN`  (TOMI cũ stack=50) |

### Decision log:
- **EAGLE bỏ:** dominated. TOMI cùng stack luôn NET cao hơn + DD thấp hơn + WR cao hơn.
- **WHALE giữ 2:** stack 200 (max yolo) + 100 (balanced). Stack 75/50 dominated bởi TOMI cùng range.
- **TOMI giữ 3:** 200/100/50 phủ đều profile vốn từ ít → max.
- **TOMI-75 bỏ:** không ưu việt hơn TOMI-100. DD% 2.0% chỉ là artifact timing (DD xảy ra sớm khi capital base nhỏ); DD absolute $1.86k gần với TOMI-50/100.
- **TOMI bỏ trailing:** test TP4/SL4 fixed cho consistency với WHALE. Có thể re-enable trailing cho TOMI variants sau.

---
**Engine:** `utils/all5mAccount.ts` + `hooks/use5mAllTrader.ts`
**Backtest:** `tools/backtest-5mall-3y.ts` + `tools/sweep-5mall-improve.ts` + `tools/sweep-5mall-improve-v2.ts`
**Account:** Paper $5000 (local AsyncStorage `@all5m_data_v1`; gist mirror leader/follower qua `all5m_account.json`)

---

## 🔑 ENGINE CƠ BẢN

### Trigger (mỗi cây 5m close — actual values per active preset):

1. **Stoch5m K < `stochLongLevel`** → LONG (`stoch_long`)
2. **Stoch5m K > `stochShortLevel`** → SHORT (`stoch_short`)
3. **Fallback S/R 15m** (nếu stoch không trigger):
   - `close ≤ support15m × (1 + srProximityPct%)` → LONG (`sr_long`)
   - `close ≥ resistance15m × (1 - srProximityPct%)` → SHORT (`sr_short`)
   - Support/resistance = min low / max high của `srLookback15m` cây 15m gần nhất (exclude in-progress bar)

### Hedge mode + Plan B (giống LIVE engine):

- LONG và SHORT là **2 stack độc lập**, có thể coexist
- Mỗi entry có TP/SL riêng (Plan B: tick `processOpen()` → first hit TP/SL → close)
- Stack max tunable per side
- Distance gate giữa các entry cùng side
- Cooldown all-side sau mỗi trade
- **Capital $5000**, margin $30 × leverage 100x = notional $3000, fee 0.05%/side ($1.5/side, round-trip $3)

### Block gates (theo thứ tự — gọi trong `tryEntry5mBar`):

1. **Dedup** theo `bar5mTime` (1 cây 5m chỉ 1 entry)
2. **Cooldown** all-side: `now - lastEntryMs < cooldownMin × 60s`
3. **Free margin** ≥ $30
4. **Stack full** (≥ `stackMaxPerSide` cùng side)
5. **Spacing** (`stackPerSideSpacingMin` phút giữa 2 entry cùng side)
6. **Distance** (entry mới phải xa entry gần nhất cùng side ≥ `stackMinEntryDistPct`%)
7. **Better entry** (v4.7.27, `stackBetterEntryMode` — hiện DISABLED ở cả 3 preset, xem section dưới)

---

## 🏆 5 PRESET CHÍNH — Stack-sweep winners (3y BTCUSDT, capital $5000)

Chi tiết bảng so sánh đã ghi ở section v3.0 đầu doc. Phần này có **config đầy đủ TypeScript** + lý do chọn từng preset.

### 🔴 WHALE_MAX (stack 200) — Max NET / yolo

```typescript
{
  tpPct: 5, slPct: 2.5,
  stackMaxPerSide: 200, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
  stackBetterEntryMode: "off",
  cooldownMin: 5,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 30,
  expectedNet3y: 3_028_056, expectedMaxDd3y: 15_627,  // NET +$3.03M, DD 8.0%
}
```

**Lý do chọn:** Stack tối đa = max NET. DD/Equity 8% là cao nhất 5 preset → chỉ phù hợp vốn ≥ $20k để chịu DD tuyệt đối ~$15k.

---

### 🟠 WHALE_MID (stack 100) — WHALE balanced

```typescript
{
  tpPct: 5, slPct: 2.5,
  stackMaxPerSide: 100, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
  stackBetterEntryMode: "off",
  cooldownMin: 5,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 30,
  expectedNet3y: 1_888_767, expectedMaxDd3y: 7_359,  // NET +$1.89M, DD 2.6%
}
```

**Lý do chọn:** WHALE-style (TP5/SL2.5, stoch 10/90, srLB 30) nhưng stack giảm xuống 100 → DD chỉ 2.6%. Phù hợp anh thích WHALE volatility nhưng vốn vừa.

---

### 🔵 TOMI_MAX (stack 200) — TOMI scaled max

```typescript
{
  tpPct: 4, slPct: 4,
  stackMaxPerSide: 200, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
  stackBetterEntryMode: "off",
  cooldownMin: 5,
  stochLongLevel: 5, stochShortLevel: 95,
  srProximityPct: 0.2, srLookback15m: 50,
  expectedNet3y: 2_633_499, expectedMaxDd3y: 2_424,  // NET +$2.63M, DD 0.3%
}
```

**Lý do chọn:** TOMI style (TP4/SL4 symmetric, stoch cực trị 5/95) scaled max stack. NET ~88% WHALE_MAX nhưng DD chỉ 1/6 → ROI/risk vượt trội.

---

### 🟢 TOMI_MID (stack 100) ★ DEFAULT — Best risk-adjusted

```typescript
{
  tpPct: 4, slPct: 4,
  stackMaxPerSide: 100, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
  stackBetterEntryMode: "off",
  cooldownMin: 5,
  stochLongLevel: 5, stochShortLevel: 95,
  srProximityPct: 0.2, srLookback15m: 50,
  expectedNet3y: 1_865_622, expectedMaxDd3y: 2_046,  // NET +$1.87M, DD 0.2%, PF 3.55
}
```

**Lý do chọn:** **PF 3.55** + **DD 0.2%** + **WR 50%** — chỉ tiêu nào cũng top. NET ~$1.87M cùng range với WHALE_MID nhưng DD nhỏ 9× lần. **DEFAULT_PRESET_KEY** trong code.

---

### ⚪ TOMI_MIN (stack 50) — Starter / vốn ít

```typescript
{
  tpPct: 4, slPct: 4,
  stackMaxPerSide: 50, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
  stackBetterEntryMode: "off",
  cooldownMin: 5,
  stochLongLevel: 5, stochShortLevel: 95,
  srProximityPct: 0.2, srLookback15m: 50,
  expectedNet3y: 1_165_062, expectedMaxDd3y: 1_149,  // NET +$1.16M, DD 0.3%
}
```

**Lý do chọn:** TOMI style với stack 50 → max margin used = $1.5k → phù hợp account $5k base. Starter preset cho ai mới chạy 5m ALL.

---

**Default preset:** `TOMI_MID` (`DEFAULT_PRESET_KEY = "TOMI_MID"` trong `utils/all5mAccount.ts`).
**Storage:** active preset key trong AsyncStorage `@all5m_preset_v1` (LOCAL ONLY, KHÔNG sync gist).

**Reference data:**
- 12-combo stack sweep: `assets/backtest_5mall_stack_sweep_3y.json`
- TOMI diagnostic: `assets/diag_tomi_stack_dd.json`
- Phase 2 sweep cũ (3 preset đã thay): `assets/sweep_5mall_v2.json`

---

## ❌ CONFIGS ĐÃ TEST — KHÔNG XÀI

| Variant | Lý do bỏ |
|---|---|
| **A1** TP=3% / SL=1.5% | NET -46% (cắt sớm quá, bỏ lỡ trend) |
| **B1** stoch-only | Không cải thiện, mất S/R fallback |
| **B2** EMA200 trend filter | NET -50%, MaxDD tăng (filter sai phase) |
| **B3** confluence stoch+SR | Quá ít trade (3k), NET -77% |
| **C1** trailing stop | NET -24%, DD giảm 30% (không xứng) |
| **C2** partial TP 50% @ +2% | NET -16%, DD giảm 58% — risk-off được nhưng không gọn bằng SAFE preset |
| **C3** time exit 4h | **BLEW UP $1k → $8** — KHÔNG BAO GIỜ XÀI |

---

## 🔧 CÁCH ÁP DỤNG

### Apply preset trong UI:

1. Mở tab **5m ALL** → SETTINGS card
2. Chỉnh `stackMaxPerSide`, `distance`, `tp`, `sl` theo bảng trên
3. SAVE → engine reload với config mới

### Apply preset programmatically:

Xem section "🏆 5 PRESET CHÍNH" ở trên — đã có config đầy đủ TypeScript cho từng preset.

**API:**
```typescript
import { setActivePresetKey, getActivePreset } from "./utils/all5mAccount";

// Switch preset
await setActivePresetKey("TOMI_MAX");

// Read current
const preset = await getActivePreset();
```

---

## 🧠 LEARNING — Knob sensitivity (từ Phase 2 sweep cũ + stack-sweep v3)

### Phase 2 sweep tool (legacy reference)
- `tools/sweep-5mall-improve-v2.ts` · 81 runs · one-at-a-time tuning per anchor
- Output: `assets/sweep_5mall_v2.json` · grid: cooldown[5,10,15] · stoch[10/90,5/95,15/85] · srProx[0.2,0.3,0.4] · srLB[30,50,80] · stack[15,30,50,75] · tpsl[3.5/2,4/2,4.5/2.25,5/2.5]

### Stack sweep v3 (current — 12 combo)
- `tools/backtest-5mall-stack-sweep-3y.ts` · 3 anchors × 4 stack [50/75/100/200]
- Output: `assets/backtest_5mall_stack_sweep_3y.json`
- → 5 preset hiện tại (WHALE_MAX/MID, TOMI_MAX/MID/MIN) là winners pick từ 12-combo này.

### 🔬 KNOB SENSITIVITY (insight đúng tại v4.8.23)

1. **TOMI symmetric `4/4` >> WHALE `5/2.5` ở mọi stack:** PF 3.5+ vs 2.3, WR 50% vs 34%, DD nhỏ ~6× lần. WHALE chỉ thắng NET tuyệt đối ở stack max 200 (ăn nhiều cú stack).
2. **Stack scale linear NET, sub-linear DD:** stack 50→100→200 → NET tăng 1.6× / 1.4× nhưng DD chỉ 1.8× / 2.2× → ROI/risk cải thiện theo stack.
3. **Stoch `5/95` (cực trị)** cho TOMI thắng `10/90` của WHALE — vào ít trade hơn nhưng tỉ lệ thắng cao hơn (50% vs 34%).
4. **`srProximityPct 0.2`** cho TOMI nhạy hơn `0.4` của WHALE — bắt được trade gần S/R chặt hơn → entry tốt hơn.
5. **`srLookback15m 50`** cho TOMI cân bằng — ít noise hơn 30 (WHALE), không quá lag như 80 (TURTLE cũ đã bỏ).
6. **`cooldownMin 5`** thắng all 5 preset — high-freq capture nhiều opportunity, không có downside vs cooldown 10/15.

### Lý do bỏ EAGLE/BALANCED
- TOMI cùng stack luôn dominate EAGLE: NET cao hơn + DD thấp hơn + WR cao hơn ở mọi anchor.
- EAGLE TP5/SL2.5 + stoch relax 15/85 → vào nhiều trade nhưng PF chỉ 1.7x, không vượt được TOMI 3.5x.

### Lý do bỏ TURTLE
- TURTLE cũ TP3.5/SL2 stack 15 → quá conservative, NET chỉ $241k vs TOMI_MIN $1.16M cùng vốn.
- Replace bằng TOMI_MIN (stack 50) cho user vốn ít — vẫn TOMI style, NET 4.8× cao hơn TURTLE.

---

## 🧪 BETTER ENTRY MODE (v4.7.27 — đang DISABLED trong production)

**Field:** `Preset.stackBetterEntryMode: "off" | "vs-last" | "vs-best" | "vs-avg"`

Nếu khác `"off"`, gate này chạy **sau** distance check trong `tryEntry5mBar`. Entry mới chỉ được phép khi giá tốt hơn benchmark cùng side:

| Mode | Benchmark | Ý nghĩa |
|---|---|---|
| `vs-last` | `lastSame.entryPrice` | Mỗi lệnh mới phải có entry tốt hơn lệnh gần nhất cùng side |
| `vs-best` | LONG: `min(entryPrice)` · SHORT: `max(entryPrice)` | Tốt hơn lệnh có entry tốt nhất từ trước tới giờ |
| `vs-avg` | trung bình entry của tất cả OPEN cùng side | Tốt hơn average — giảm bớt averaging up/down |

**Quy tắc** (trong code): LONG cần `fillPrice < benchmark`, SHORT cần `fillPrice > benchmark`. Không thoả → block.

**Trạng thái production hiện tại:** cả 5 preset (WHALE_MAX/MID, TOMI_MAX/MID/MIN) đều set `"off"`. Logic có sẵn để Tommy bật khi đã backtest đủ.

---

## 💰 CAPITAL MIGRATION (v4.7.20)

`INITIAL_CAPITAL` bumped **$1000 → $5000** để stack ≥75 khả thi:
- 200 LONG × $30 + 200 SHORT × $30 = $12k max margin → cần Tommy bump capital cao hơn $5k cho `WHALE_MAX`/`TOMI_MAX` stack 200, OR chạy với bot $5k và chấp nhận free margin block sớm.
- Stack 100 max margin = $6k → nhỏ hơn $5k buffer là OK (account chỉ stack được tới khi free margin < $30).
- Stack 50 max margin = $1.5k → thừa buffer rộng.

**Migration tự động** trong `loadAccount()`:
- Account cũ (`capitalVersion === undefined || < 2`) → top up `+$4000` ONCE
- Sau migration: `capitalVersion = 2`, equityHistory ghi 1 điểm mới
- Lệnh OPEN hiện tại được giữ nguyên (không bị reset)

**`PREV_INITIAL_CAPITAL = 1000`** vẫn export làm reference cho ROI legacy.

---

## 🧪 TRAILING STOP (DEAD CODE — chờ re-enable)

Code có sẵn trong `processOpen()` (line 439-469) + Position fields `trailingStopEnabled` + `lastTrailMilestone`. Logic đầy đủ:

- Mỗi tick `processOpen(currentPrice)` tính `leveragedPnlPct = priceMove × 100x`
- Khi `pnl ≥ N×100%` → SL ratchet lên `(N-1)×100%` PnL (lag 1 milestone, raw price = (N-1)/100)
- Position chỉ exit qua SL (KHÔNG có fixed TP)

**Trạng thái production hiện tại (v4.8.23):** TẤT CẢ 5 preset đều **KHÔNG** set `trailingStopEnabled`, nên branch trailing là **DEAD CODE** chưa active. Lý do (decision log từ doc top):
> TOMI bỏ trailing: test TP4/SL4 fixed cho consistency với WHALE. Có thể re-enable trailing cho TOMI variants sau.

**Nếu muốn re-enable cho 1 preset cụ thể** (vd `TOMI_MAX`):
```typescript
TOMI_MAX: {
  ...,
  trailingStopEnabled: true, // re-enable
}
```
→ Position mới sẽ tự copy flag → `processOpen` route qua trailing branch. Position OPEN cũ giữ logic fixed (không retroactive).

---

## 🔄 LEADER / FOLLOWER (multi-device sync)

**Pattern:** `use5mAllTrader(rawKlines, tfData, currentPrice, enabled, isLeader)`

| Role | Trigger entry | Process TP/SL | Reset/close manual | Pull state |
|---|---|---|---|---|
| **Leader** (`isLeader=true`) | ✅ chạy `tryEntry5mBar` mỗi 5m close | ✅ chạy `processOpen` mỗi tick | ✅ | ❌ |
| **Follower** (`isLeader=false`) | ❌ | ❌ | ❌ | ✅ pull `all5m_account.json` từ gist mỗi **120s** |

- Leader push gist debounce **20s** sau mỗi save (`scheduleFilePush`)
- Follower pull-only → chỉ mirror state, không tạo trade ghost
- Reset/manual-close trên follower → no-op (silent skip)

---

## 📝 CHANGELOG

- **v3.1** (2026-04-28): Doc cleanup — xóa 2 section cũ tự mâu thuẫn (3 preset TURTLE/EAGLE/WHALE + "Apply preset programmatically" Phase 2 v2). Toàn bộ doc giờ đồng nhất với 5 preset v4.8.23. Thêm section Trailing Stop (dead code — chờ re-enable).
- **v3.0** (2026-04-28): 5 PRESET mới từ stack-sweep 12-combo backtest. Bỏ EAGLE/BALANCED + TURTLE (dominated). Bumped to WHALE_MAX/MID + TOMI_MAX/MID/MIN với DEFAULT = TOMI_MID (PF 3.55, DD 0.2%).
- **v2.1** (2026-04-28): Doc sync với code v4.7.27 — full Preset interface (cooldown/stoch/srProx/srLB), Better Entry Mode + Capital Migration v4.7.20 + Leader/Follower
- **v2.0** (2026-04-27): Phase 2 sweep — 3 preset (WHALE/EAGLE/TURTLE) re-tuned via 81-run sweep
- **v1.0** (2026-04-27): Initial doc với 3 preset SAFE/BALANCED/AGGRESSIVE từ 11-variant sweep

### Code-level milestones (cho cross-reference)
- **v4.8.23**: 5-preset stack-sweep era (WHALE_MAX/MID, TOMI_MAX/MID/MIN). Migration map LEGACY_KEY_MAP cho key cũ → mới. DEFAULT = TOMI_MID.
- **v4.8.22**: Trailing stop logic added (`trailingStopEnabled` flag + milestone ratchet) — currently DEAD CODE (no preset enables).
- **v4.7.27**: `stackBetterEntryMode` field thêm vào Preset (`"off"|"vs-last"|"vs-best"|"vs-avg"`) — currently OFF all presets.
- **v4.7.20**: `INITIAL_CAPITAL` 1000 → 5000 + auto-migration via `capitalVersion`.
- **v4.7.1**: Phase 2 sweep apply — 3 preset (now legacy) với 9 knob (TP, SL, stack, dist, spacing, cooldown, stoch×2, srProx, srLookback).
- **v4.5.3**: Follower pull 60s → 120s, leader push debounce 10s → 20s
