# 5m ALL TRADING ENGINE — Rule & Preset

**Version:** v2.1 (last updated 2026-04-28)
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

## 🏆 3 PRESET CHÍNH (3y backtest BTCUSDT, vốn $1000)

### 🟢 PRESET SAFE — "TURTLE" (recommend cho vốn ít / risk-averse)

```
TP=5%, SL=2.5%, stackMax=15/side, distance=0.3%, spacing=10m, cooldown=10m
```

| Metric | Value |
|---|---|
| Final equity | **$300,133** (300x) |
| NET | +$299,133 |
| ROI | +29,913% |
| Trades | 11,019 |
| Win rate | 33.4% |
| Profit factor | ~1.8 |
| **MaxDD** | **$993** (~3 lần margin) |
| **DD/NET ratio** | **0.33%** |

**Lý do chọn:** TP/SL nới rộng → ít trade chéo nhau, MaxDD ≈ baseline nhưng NET cao hơn baseline +24%. Ổn định nhất.

---

### 🟡 PRESET BALANCED — "EAGLE" (recommend cho vốn vừa)

```
TP=4%, SL=2%, stackMax=30/side, distance=0.2%, spacing=10m, cooldown=10m
```

| Metric | Value |
|---|---|
| Final equity | **$393,019** (393x) |
| NET | +$392,019 |
| ROI | +39,201% |
| Trades | 22,007 |
| Win rate | 33.9% |
| Profit factor | ~1.78 |
| **MaxDD** | **$3,069** |
| **DD/NET ratio** | **0.78%** |

**Lý do chọn:** Stack 30 + distance 0.2% → bắt được nhiều cú stack hơn baseline mà DD vẫn quản lý được. 1.6× NET so với baseline.

---

### 🔴 PRESET AGGRESSIVE — "WHALE" (recommend cho vốn lớn / chịu được DD cao)

```
TP=4%, SL=2%, stackMax=50/side, distance=0%, spacing=0m, cooldown=10m
```

**= LIVE PRESET B (cùng config với LIVE engine production)**

| Metric | Value |
|---|---|
| Final equity | **$726,319** (726x) |
| NET | +$725,319 |
| ROI | +72,531% |
| Trades | 42,107 |
| Win rate | 33.5% |
| Profit factor | ~1.78 |
| **MaxDD** | **$5,217** |
| **DD/NET ratio** | **0.72%** |

**Lý do chọn:** Bỏ tất cả gate stack → maximize cú stack khi market trend mạnh. 3× NET so với baseline, DD đổi lại 5.4× — chấp nhận được nếu vốn ≥ $5k để chịu DD.

---

## 📊 BẢNG SO SÁNH 3 PRESET

| Preset | TP/SL | Stack | Dist | NET | MaxDD | Trades | DD/NET |
|---|---|---|---|---|---|---|---|
| 🟢 SAFE | 5/2.5 | 15 | 0.3% | $299k | $993 | 11k | 0.33% ⭐ |
| 🟡 BALANCED | 4/2 | 30 | 0.2% | $392k | $3,069 | 22k | 0.78% |
| 🔴 AGGRESSIVE | 4/2 | 50 | 0% | $725k | $5,217 | 42k | 0.72% |
| (baseline) | 4/2 | 15 | 0.3% | $240k | $972 | 14k | 0.41% |

**Reference:**
- 11 variants A+B+C đầy đủ: `assets/sweep_5mall_improve_report.html`
- JSON raw: `assets/sweep_5mall_improve.json`

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

### Apply preset programmatically (utils/all5mAccount.ts — Phase 2 v2 values):

```typescript
// 🔴 AGGRESSIVE (WHALE) — highest PnL
{
  tpPct: 5, slPct: 2.5,
  stackMaxPerSide: 75, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
  stackBetterEntryMode: "off",
  cooldownMin: 5,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 30,
  expectedNet3y: 1_516_473, expectedMaxDd3y: 5_874,
}

// 🟡 BALANCED (EAGLE) — default, balance NET vs DD
{
  tpPct: 5, slPct: 2.5,
  stackMaxPerSide: 30, stackMinEntryDistPct: 0.1, stackPerSideSpacingMin: 10,
  stackBetterEntryMode: "off",
  cooldownMin: 5,
  stochLongLevel: 15, stochShortLevel: 85,
  srProximityPct: 0.4, srLookback15m: 50,
  expectedNet3y: 633_753, expectedMaxDd3y: 1_983,
}

// 🟢 SAFE (TURTLE) — lowest MaxDD
{
  tpPct: 3.5, slPct: 2,
  stackMaxPerSide: 15, stackMinEntryDistPct: 0.3, stackPerSideSpacingMin: 10,
  stackBetterEntryMode: "off",
  cooldownMin: 15,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 80,
  expectedNet3y: 240_975, expectedMaxDd3y: 792,
}
```

**Default preset:** `BALANCED` (`DEFAULT_PRESET_KEY = "BALANCED"`).
**Storage:** active preset key trong AsyncStorage `@all5m_preset_v1` (LOCAL ONLY, KHÔNG sync gist).

---

## 🧠 LEARNING IMPROVE — Phase 2 Sweep (v2.0)

**Sweep tool:** `tools/sweep-5mall-improve-v2.ts` · 81 runs · one-at-a-time tuning per anchor
**Output:** `assets/sweep_5mall_v2.json` · `assets/sweep_5mall_v2_report.html`

### Knob grid tested

| Knob | Values |
|---|---|
| `cooldownMin` | 5, 10, 15 |
| `stochThr` (long/short) | 10/90, 5/95, 15/85 |
| `srProxPct` | 0.2, 0.3, 0.4 |
| `srLookback15m` | 30, 50, 80 |
| `distPct` (entry distance) | 0, 0.1, 0.2, 0.3, 0.5 |
| `stackMax` | 15, 30, 50, 75 |
| `tpsl` | 3.5/2, 4/2, 4.5/2.25, 5/2.5 |

### 🏆 3 PRESET MỚI (đã apply vào engine)

| Preset | NET v1 | NET v2 | Δ NET | DD v1 | DD v2 | Δ DD |
|---|---|---|---|---|---|---|
| 🔴 WHALE | $725k | **$1,516k** | **+109%** ⭐ | $5,217 | $5,874 | +13% |
| 🟡 EAGLE | $392k | **$634k** | **+62%** ⭐ | $3,069 | **$1,983** | **-35%** ⭐ |
| 🟢 TURTLE | $299k | $241k | -19% | $993 | **$792** | **-20%** ⭐ |

**Đánh giá:**
- 🔴 **WHALE**: +109% NET cho cùng risk envelope (DD chỉ tăng nhẹ 13%) — **win lớn**
- 🟡 **EAGLE**: +62% NET VÀ giảm DD -35% — **win cả 2 mặt**, preset balance đẹp nhất
- 🟢 **TURTLE**: theo criterion "lowest MaxDD" — DD giảm 20%, đổi lại NET giảm 19% (proportional)

### 🔬 KNOB SENSITIVITY (insight chính)

1. **`tpsl` 5/2.5 thắng cho cả AGGRESSIVE + BALANCED** — TP rộng cho phép trade đi trọn cú trend, không bị scalp out sớm. Chỉ SAFE chọn 3.5/2 (cắt nhanh)
2. **`srProxPct` 0.4% thắng all 3 anchor** — proximity cao hơn bắt được nhiều cú reversal hơn (vs 0.3% gốc)
3. **`stackMax` 75 cho AGGRESSIVE** (vs 50 gốc) — đẩy stack tới ngưỡng vốn cho phép → +50% NET single change
4. **`stochThr` 15/85 cho BALANCED** (vs 10/90) — relax stoch giúp bắt nhiều entry hơn, NET tăng mà DD vẫn quản được
5. **`cooldownMin` 5m thắng AGGRESSIVE/BALANCED, 15m thắng SAFE** — high-freq cho aggressive, low-freq cho safe — hợp lý
6. **`srLookback15m`**: 30 cho AGGRESSIVE (S/R nhạy hơn), 80 cho SAFE (S/R bền hơn)

### 📋 CONFIG ĐẦY ĐỦ 3 PRESET (sau Phase 2)

```typescript
// AGGRESSIVE 🔴 WHALE
{ tpPct: 5, slPct: 2.5, stackMaxPerSide: 75, stackMinEntryDistPct: 0,
  stackPerSideSpacingMin: 0, cooldownMin: 5,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 30 }

// BALANCED 🟡 EAGLE
{ tpPct: 5, slPct: 2.5, stackMaxPerSide: 30, stackMinEntryDistPct: 0.1,
  stackPerSideSpacingMin: 10, cooldownMin: 5,
  stochLongLevel: 15, stochShortLevel: 85,
  srProximityPct: 0.4, srLookback15m: 50 }

// SAFE 🟢 TURTLE
{ tpPct: 3.5, slPct: 2, stackMaxPerSide: 15, stackMinEntryDistPct: 0.3,
  stackPerSideSpacingMin: 10, cooldownMin: 15,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 80 }
```

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

**Trạng thái production hiện tại:** cả 3 preset (WHALE/EAGLE/TURTLE) đều set `"off"`. Logic có sẵn để Tommy bật khi đã backtest đủ.

---

## 💰 CAPITAL MIGRATION (v4.7.20)

`INITIAL_CAPITAL` bumped **$1000 → $5000** để stack 75 (WHALE) khả thi:
- 75 LONG × $30 + 75 SHORT × $30 = $4500 max margin → cần buffer ≥ $500 để chịu fee + slippage

**Migration tự động** trong `loadAccount()`:
- Account cũ (`capitalVersion === undefined || < 2`) → top up `+$4000` ONCE
- Sau migration: `capitalVersion = 2`, equityHistory ghi 1 điểm mới
- Lệnh OPEN hiện tại được giữ nguyên (không bị reset)

**`PREV_INITIAL_CAPITAL = 1000`** vẫn export làm reference cho ROI legacy.

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

- **v2.1** (2026-04-28): Doc sync với code — cập nhật capital $5000, full Preset interface (gồm stackPerSideSpacingMin/cooldownMin/stoch/srProx/srLookback), thêm section Better Entry Mode + Capital Migration v4.7.20 + Leader/Follower
- **v2.0** (2026-04-27): Phase 2 sweep — 3 preset re-tuned via 81-run one-at-a-time sweep. WHALE +109% NET, EAGLE +62% NET & -35% DD, TURTLE -20% DD. New knobs exposed in Preset interface (cooldown, stoch, srProx, srLookback)
- **v1.0** (2026-04-27): Initial doc với 3 preset SAFE/BALANCED/AGGRESSIVE từ 11-variant sweep

### Code-level milestones (cho cross-reference)
- **v4.7.27**: `stackBetterEntryMode` field thêm vào Preset, logic "vs-last/vs-best/vs-avg" trong `tryEntry5mBar` (currently `"off"` cả 3 preset)
- **v4.7.20**: `INITIAL_CAPITAL` 1000 → 5000 + auto-migration via `capitalVersion`
- **v4.7.1**: Phase 2 sweep apply — 3 preset hoàn chỉnh với 9 knob (TP, SL, stack, dist, spacing, cooldown, stoch×2, srProx, srLookback)
- **v4.5.3**: Follower pull 60s → 120s, leader push debounce 10s → 20s
