# LIVE TRADING ENGINE — Rule vào lệnh & Flow đầy đủ

**Version:** v4.8.19 (last updated 2026-04-28)
**Server engine:** btc-trader-server v0.2.0 (E-T15-NoTP S50 step trail)

---

## 🆕 v0.2.0 — E-T15-NoTP S50 STEP TRAIL (15m only)

Backtest 3y (2023-04 → 2026-04) đã confirm: **S50 step trail trên 15m TF, NO TP cap** là cấu hình tốt nhất qua mọi metric (NET / Win% / Sharpe / DD).

### Logic

Áp dụng **CHỈ cho tracked position có `tfKey === "15m"`**. HTF (1h/4h/1d/1w) + manual import giữ nguyên fixed TP/SL.

```
tpDist = |tpPrice − entryPrice|         (raw từ rule, KHÔNG đổi)
movedDist = (LONG)  markPrice − entryPrice
            (SHORT) entryPrice − markPrice
currentStep = min(10, floor(movedDist / tpDist / 0.5))

if (currentStep > lastTrailStep && currentStep ≥ 1):
  newSL = (LONG)  entryPrice + currentStep × 0.5 × tpDist
          (SHORT) entryPrice − currentStep × 0.5 × tpDist
  pos.slPrice = newSL
  pos.lastTrailStep = currentStep
```

### Step table (S50, 10 levels)

| Step | Price moved (× tpDist) | New SL position | Lock profit |
|------|------------------------|-----------------|-------------|
| 1    | 0.5×                   | entry + 0.5×TP  | break-even rough |
| 2    | 1.0×                   | entry + 1.0×TP  | +50% TP locked |
| 3    | 1.5×                   | entry + 1.5×TP  | +100% TP |
| 4    | 2.0×                   | entry + 2.0×TP  | +150% TP |
| 5    | 2.5×                   | entry + 2.5×TP  | +200% TP |
| 6    | 3.0×                   | entry + 3.0×TP  | +250% TP |
| 7    | 3.5×                   | entry + 3.5×TP  | +300% TP |
| 8    | 4.0×                   | entry + 4.0×TP  | +350% TP |
| 9    | 4.5×                   | entry + 4.5×TP  | +400% TP |
| 10   | 5.0×                   | entry + 5.0×TP  | +450% TP (cap) |

### Trigger check (15m)

- **NO TP exit** — `tpPrice` chỉ dùng để compute `tpDist`. Position chỉ close khi giá hit `slPrice` (SL trail).
- HTF (1h/4h/1d/1w) + manual: TP + SL fixed như cũ.

### Backtest 3y kết quả

| Mode | NET % | DD % | Win % | Notes |
|------|-------|------|-------|-------|
| E0 (fixed TP/SL) | +937k% | 30% | 51 | baseline (Mode E disable 5m:1) |
| E-T15 (fixed TP, 50% activation 70% lock) | +890k% | 28% | 53 | trailing nhẹ |
| **E-T15-NoTP S50** | **+1.4M%** | **27%** | **54** | **production** |
| E-T15-NoTP S60 | +1.32M% | 28% | 53 | nhỏ hơn |
| E-T15-NoTP S70 | +1.18M% | 29% | 52 | step quá lớn |

### Implementation files

- `src/engine/trader.ts` — `TrackedPosition` thêm `tfKey?: string`, `lastTrailStep?: number`
- `executeAction` seed `tfKey: alert.tfKey, lastTrailStep: 0` khi push tracked
- `monitorTrackedPositions` apply step-trail trước trigger check, NO TP exit cho tfKey="15m"
- `buildImport` (manual reconcile) → `tfKey: "manual"` (không trail, fixed TP/SL)

---

## 🗺 SƠ ĐỒ FLOW (v4.7.24 — full)

```
╔════════════════════════════════════════════════════════════════════════════╗
║       LIVE ENGINE — HTF RULE FLOW                                          ║
╚════════════════════════════════════════════════════════════════════════════╝

  ┌────────────────────────────┐         ┌──────────────────────────┐
  │ useRuleAlerts (1h/4h/1d/1w)│         │  5m ALL ENGINE MODE      │
  │   eval mỗi tick rawKlines  │         │  (mỗi cây 5m close)      │
  │   → activeAlerts[]         │         │   eval Stoch + S/R 15m   │
  └─────────────┬──────────────┘         │   per active preset      │
                │                        └─────────────┬────────────┘
                │ (HTF rule fire)                      │ (5m signal)
                ▼                                      ▼
        ┌───────────────────────────────────────────────────┐
        │           decideEntry(alert, ctx)                 │
        │  ┌─────────────────────────────────────────────┐  │
        │  │ 8 GATES (BLOCK nếu không pass)              │  │
        │  │  1. autoEnabled                              │  │
        │  │  2. excludedTfs.includes(tfKey)              │  │
        │  │  3. pausedUntilMs > now (cooldown/DD pause) │  │
        │  │  4. dailyPnl <= dailyLossCapUsd              │  │
        │  │  5. openCount >= maxOpen                     │  │
        │  │  6. firedIds[id] < 10m (per-rule cooldown)   │  │
        │  │  7. pendingAlerts has same id+side           │  │
        │  │  8. checkStackGate (per-side: max/spacing/   │  │
        │  │     dist/notional cap)                       │  │
        │  └─────────────────────────────────────────────┘  │
        │                       │                           │
        │                       ▼                           │
        │       ┌───────────────────────────────┐           │
        │       │  isHtfRuleForLtfConfirm(tfKey)│           │
        │       │   true: 1h/4h/1d/1w           │           │
        │       │   false: 5m/15m/5mall         │           │
        │       └───┬───────────────────────┬───┘           │
        │           │                       │               │
        │           │ HTF (1h+)             │ LTF (5m/15m/  │
        │           ▼                       ▼  5mall)       │
        │   ┌───────────────┐       ┌──────────────────┐    │
        │   │ return PENDING│       │ return ENTRY ngay │    │
        │   │ (chờ LTF      │       │ (PA A2 skip)     │    │
        │   │  confirm)     │       │                  │    │
        │   └───────┬───────┘       └────────┬─────────┘    │
        └───────────┼────────────────────────┼──────────────┘
                    │                        │
                    ▼                        │
        ┌──────────────────────┐             │
        │ addToPending()       │             │
        │ pendingAlerts.push   │             │
        │  { tpPct, slPct,     │             │
        │    htfEntryPrice }   │             │
        └──────────┬───────────┘             │
                   │                         │
                   ▼ (mỗi tick price + LTF)  │
        ┌──────────────────────────────┐     │
        │ confirmPending(stoch5m, S/R) │     │
        │  ─ rule còn fire?            │     │
        │  ─ LONG: K<20 OR ≤support15m │     │
        │           ×(1+0.4%)          │     │
        │  ─ SHORT: K>80 OR ≥resist    │     │
        │           ×(1-0.4%)          │     │
        │  ─ recheck 4 gates (cooldown,│     │
        │     maxOpen, dailyPnl, stack)│     │
        └──────────┬───────────────────┘     │
                   │ confirmed               │
                   ▼                         │
        ┌──────────────────────┐             │
        │ recalc TP/SL theo    │             │
        │ current price        │             │
        └──────────┬───────────┘             │
                   │                         │
                   └────────┬────────────────┘
                            │
                            ▼
            ┌───────────────────────────────┐
            │ executeAction(ENTRY)          │
            │  ─ placeMarketOrder MARKET    │
            │     positionSide=LONG/SHORT   │
            │  ─ trackedPositions.push({    │
            │     id, side, qty, entry,     │
            │     tpPrice, slPrice, ms })   │
            │  ─ firedIds[id] = now         │
            │  ─ lastTrackedMutationMs=now  │
            │  ─ playEntry() + notify()     │
            └──────────┬────────────────────┘
                       │
                       ▼
            ┌──────────────────────────────────┐
            │ Plan B monitor (mỗi tick mark)   │
            │  loop trackedPositions:          │
            │    LONG: mark>=tp →TP, mark<=sl  │
            │      →SL                         │
            │    SHORT: mark<=tp →TP, mark>=sl │
            │      →SL                         │
            │  hit → MARKET reduceOnly         │
            │       qty=entry.qty              │
            │       → partial close net pos    │
            │  log CLOSE (trigger=TP/SL)       │
            │  beep + notify                   │
            └──────────────────────────────────┘
```

```
╔════════════════════════════════════════════════════════════════════════════╗
║       SYNC LOOP — 30s POLL (v4.7.17 optimized)                              ║
╚════════════════════════════════════════════════════════════════════════════╝

  ┌─────────────────────────────────────────────────────────────────────┐
  │ Poll Binance mỗi 30s (LEADER only)                                  │
  │   getAccount + getPositions + getDailyPnl + getOpenOrders +         │
  │   getRecentTrades + getDualSidePosition (parallel)                  │
  └────────────────┬────────────────────────────────────────────────────┘
                   ▼
  ┌────────────────────────────────────────────────┐
  │ trimFiredIds (loại entries > 24h)              │
  └────────────────┬───────────────────────────────┘
                   ▼
  ┌────────────────────────────────────────────────────────┐
  │ reconcileTrackedPositions(state, binancePositions)     │
  │ ┌────────────────────────────────────────────────────┐ │
  │ │ Tính qty + avgEntry per side (Binance vs App)      │ │
  │ │ tolerance 0.0005 BTC                               │ │
  │ └────────────┬───────────────────────────────────────┘ │
  │              │                                         │
  │   ┌──────────┴──────────┐                              │
  │   ▼                     ▼                              │
  │ App > Binance       Binance > App                      │
  │ (user closed         (user mở lệnh manual              │
  │  manual)             trên Binance)                     │
  │   ▼                     ▼                              │
  │ ┌──────────┐         ┌─────────────────────────────┐   │
  │ │SMART DROP│         │ AUTO-IMPORT                 │   │
  │ │1.Single: │         │ - Race guard < 15s? skip    │   │
  │ │  qty≈diff│         │ - Reverse-derive entry:     │   │
  │ │2.Multi:  │         │   (binanceQty×binAvg −       │   │
  │ │  greedy  │         │    appQty×appAvg)/debt      │   │
  │ │  oldest  │         │ - Preset fallback BALANCED  │   │
  │ └──────────┘         │ - Split nếu debt > 1.5×     │   │
  │                      │   typical qty               │   │
  │                      │ - Tạo tracked entry với     │   │
  │                      │   id="manual:<ts>-<side>-   │   │
  │                      │       <idx>-<nonce5>"       │   │
  │                      │ - TP/SL từ active preset    │   │
  │                      │   (@all5m_preset_v1)        │   │
  │                      └─────────────────────────────┘   │
  │              ▼                                         │
  │ ┌────────────────────────────────────────┐             │
  │ │ Drift detect: avg entry post-drop vs   │             │
  │ │ Binance avg lệch >$50 → warn           │             │
  │ │ "có thể edited TP/SL trên Binance"     │             │
  │ └────────────────────────────────────────┘             │
  │              ▼                                         │
  │ ┌────────────────────────────────────────┐             │
  │ │ Set lastTrackedMutationMs (BEFORE save)│             │
  │ │ saveState + log to journal             │             │
  │ └────────────────────────────────────────┘             │
  └────────────────────────────────────────────────────────┘
                   │
                   ▼
  ┌────────────────────────────────────────────────┐
  │ maybeTriggerCooldown (daily PnL cap hit?)      │
  │  → pause autoTrade cooldownMinutes (240m)      │
  └────────────────┬───────────────────────────────┘
                   ▼
  ┌────────────────────────────────────────────────┐
  │ maybeTriggerEquityDdProtection                 │
  │  - track peak equity (wallet+upnl)             │
  │  - drop >= equityDdPausePct (30%) → pause      │
  │    equityDdPauseHours (4h)                     │
  └────────────────────────────────────────────────┘
                   │
                   ▼
              save + push gist (debounce 12s)
                   │
                   ▼
              FOLLOWER pull mỗi 45s từ gist mirror
```

```
╔════════════════════════════════════════════════════════════════════════════╗
║       MUTEX & SAFEGUARDS                                                    ║
╚════════════════════════════════════════════════════════════════════════════╝

  use5mAllEngineMode toggle ←─── MUTEX 1-chiều ───→ excludedTfs ⊃ "5m"
  (LIVE evaluates 5m bars)        (bật 1 → tắt cái kia)  (block 5m HTF rules)

  AUTO ON  → all gates active           AUTO OFF → block all entries
  DRY RUN  → chỉ log (no Binance)       REAL    → POST /fapi/v1/order MARKET

  PASSWORD 30318384 cho:
    ✕ CLOSE 1 lệnh
    ✏ EDIT TP/SL
    🚀 BULK CLOSE (PROFIT/LOSS/OLD/ALL)
```

**3 PATH CHÍNH:**

| Path | Trigger | Phase 2 LTF? | Source ID |
|---|---|---|---|
| **HTF rule** (1h/4h/1d/1w) | Rule fire qua useRuleAlerts | ✅ qua confirmPending | `1h:24`, `4h:42`, etc. |
| **LTF rule** (5m/15m từ hard_rules.json) | Rule fire | ❌ skip (PA A2) | `5m:1`, `15m:22`, etc. |
| **5m ALL Engine** | Mỗi cây 5m close, eval Stoch+S/R per preset | ❌ skip (PA A2) | `5mall:<bar5mTime>` |

Mọi path share: `trackedPositions[]` ledger + Plan B monitor + SMART reconcile + circuit breakers.

---
**Files:** `utils/liveTraderEngine.ts`, `hooks/useBinanceLive.ts`, `utils/leaderElection.ts`, `utils/binanceLive.ts`, `utils/gistSync.ts`

---

## ⚡ 5m ALL ENGINE MODE (v4.7.8 — anh Tommy Apr 2026)

**Default OFF.** Khi bật trong LIVE SETTINGS card → toggle "✓ 5m ALL ENGINE: ON":

- Mỗi cây 5m close → LIVE evaluate signal **giống engine 5m ALL paper**:
  - Stoch5m K < `preset.stochLongLevel` → LONG
  - Stoch5m K > `preset.stochShortLevel` → SHORT
  - Else fallback S/R 15m: close ≤ support × (1 + `srProximityPct`) → LONG, etc.
- Active preset đọc từ `@all5m_preset_v1` (đồng bộ tab 5m ALL — đổi preset 1 chỗ, cả paper + LIVE đều áp)
- Entry MARKET thật → `decideEntry()` → `executeAction()` (vẫn check circuit breakers, equity DD, stack gates)
- TF key alert = `"5mall"` để bypass `excludedTfs: ["5m"]` (cố ý — distinct entry path)
- Skip Phase 2 LTF confirm (vì đã là 5m close-bar evaluate)
- Margin/leverage từ LIVE settings (`marginUsd × leverage`)
- Stack gates: LIVE settings (`stackMaxPerSide`, `stackMinEntryDistPct`, etc.) — KHÔNG dùng preset's stack
- HTF rules (1h/4h/1d/1w) **vẫn chạy SONG SONG** — entry từ cả 2 nguồn share `trackedPositions[]`

**Why "5mall" tfKey:** distinct từ "5m" để dedup riêng + bypass `excludedTfs` filter (vẫn block rule HTF 5m từ hard_rules.json nếu user muốn).

**Dedup:** `firedIds["5mall:<bar5mTime>"]` — mỗi cây 5m chỉ eval 1 lần (kể cả không có signal).

---

## 🔑 HEDGE MODE & STACK ARCHITECTURE (CỐT LÕI)

**Binance Futures Hedge Mode chỉ cho phép 1 net LONG + 1 net SHORT per symbol.**
App vượt giới hạn này bằng kiến trúc 2 lớp:

| Lớp | Vai trò |
|---|---|
| **Binance** | Gộp tất cả MARKET cùng `positionSide` → **1 net LONG position + 1 net SHORT position** (avg entry, sum qty) |
| **App ledger** (`trackedPositions[]`) | Maintain **N "logical stack entries" độc lập** — mỗi entry: `id, side, qty, entryPrice, tpPrice, slPrice, entryMs` |

### Plan B monitor (mỗi tick markPrice — `monitorTrackedPositions`):

- Loop từng tracked entry → check `markPrice >= tpPrice` (LONG) hoặc `<= tpPrice` (SHORT)
- Hit TP/SL → gửi `MARKET reduceOnly qty=entry.qty` → **partial close net position trên Binance đúng size lệnh đó**
- **KHÔNG dùng STOP_MARKET / TAKE_PROFIT_MARKET** của Binance (Binance không support nhiều TP/SL trên cùng 1 net position)

### Stack tunable (qua LIVE SETTINGS card):

| Setting | Default (PRESET B) | Range |
|---|---|---|
| `stackMaxPerSide` | **50** | 15 / 30 / 50 (sweet spot từ backtest) |
| `stackMaxNotionalUsd` | **$200,000** | cap chống liquidation |
| `stackMinEntryDistPct` | **0%** | bỏ gate khoảng cách price (0.3% trong PRESET A) |
| `stackPerSideSpacingMin` | **0 phút** | bỏ gate spacing time |

### SMART Reconcile (v4.7.13 — anh Tommy):

- So tổng `trackedPositions.qty` cùng side vs Binance `positionAmt` (cùng `positionSide`)
- Tolerance: 0.0005 BTC (~$30)
- Nếu Binance < app (user close manual):
  - **Step 1 (single-drop):** tìm tracked entry có `qty ≈ debt` (≤ 0.0005 BTC) → drop chính xác lệnh đó. Nếu nhiều candidate → chọn cái khi drop làm `avg entry post-drop` gần nhất với Binance `entryPrice`
  - **Step 2 (multi-drop greedy):** fallback nếu single-drop không khớp → drop từ cũ nhất tới khi sum qty đủ debt
- **Avg entry drift detection:** sau drop, so `app post-drop avgEntry` vs Binance `entryPrice`. Nếu lệch > $50 → log warning "có thể anh edited TP/SL trên Binance hoặc có lệnh manual mở"
- **AUTO-IMPORT (v4.7.14):** khi Binance > app (user mở lệnh manual qua Binance app):
  - Tự động tạo tracked entry mới: `{ id: "manual:<ts>-<side>-<idx>", qty: debt, entryPrice: Binance avgEntry, entryMs: now }`
  - TP/SL lấy từ **active 5m ALL preset** (`@all5m_preset_v1` — đồng bộ với engine 5m ALL)
  - Plan B monitor lệnh imported giống lệnh app tự mở → tự close khi hit TP/SL
  - Log warning "✅ Auto-imported N lệnh manual"

### Hard timeout:

- Tracked position quá **72h** → log ERROR + drop khỏi monitor (price feed có thể chết)
- User cần check Binance manually để close nếu position còn

---

## 🏗 Architecture overview

3 engine song song trong app, LIVE là 1 trong 3:

| Engine | File | Account | Mục đích |
|---|---|---|---|
| `use5mAllTrader` | `hooks/use5mAllTrader.ts` | Paper $1000 (local + sync gist) | Test SMART STACK 5m, mỗi 5m close → entry |
| `useAutoTrader` (RULE) | `hooks/useAutoTrader.ts` | Paper $1000 (sync gist) | Subscribe rule HTF fire, paper |
| **`useBinanceLive` (LIVE)** | `hooks/useBinanceLive.ts` | **Binance Futures REAL** | Subscribe rule HTF fire → tiền thật |

LIVE engine có **single-leader lock** (PA B): chỉ 1 device chạy, khác devices = follower mirror.

---

## 🔥 FLOW: Rule fire → vào lệnh → close

```
RULE FIRE (rawKlines/60s) → activeAlerts
    ↓
PHASE 0: role === LEADER?  (FOLLOWER mirror, không xử lý)
    ↓
PHASE 1: filter fresh alert (id chưa thấy)
    ↓
PHASE 2: decideEntry() — 8 GATES (xem bảng dưới)
    ↓ pass
    ┌─────────────────────────────────┐
    │  TF nào?                         │
    │  • 5m / 15m → ENTRY MARKET ngay  │  ← v4.6.7 PA A2
    │  • 1h+      → PENDING (Phase 2)  │
    └─────────────────────────────────┘
    ↓ (1h+)
PENDING: push vào pendingAlerts[]  (CHƯA VÀO LỆNH)
    ↓
PHASE 3: confirmPending() — chờ LTF confirm (mỗi tick price)
    ↓ confirmed
PHASE 4: RECHECK gates (per-rule cooldown, maxOpen, dailyPnl, SMART STACK)
    ↓ pass
PHASE 5: executeAction(ENTRY)
    - Tính qty = margin × leverage / currentPrice
    - Tính tpPrice/slPrice từ rule.cfg.targetPct/stopPct
    - dryRun? → log only
    - else: placeMarketOrder MARKET + push trackedPositions + notify + beep
    ↓
PHASE 6: monitorTrackedPositions() — Plan B monitor TP/SL (mỗi tick mark price)
    - Hit TP → close reduceOnly + chime + notify TP
    - Hit SL → close reduceOnly + 3 beep loud + notify SL URGENT
    ↓
PHASE 7: Reconcile (mỗi 60s poll Binance) — sum qty vs trackedPositions
    - Mismatch > 0.0005 BTC → drop tracked entries dư + warning
    ↓
PHASE 8: Equity DD Protection (v4.6.9)
    - Track peak equity (wallet + uPnL)
    - Drop ≥ 30% từ peak → pause auto-trade 4h
```

---

## 🚨 DECIDE ENTRY — 8 GATES (Phase 2)

**Function:** `decideEntry(state, alert, ctx)` in `utils/liveTraderEngine.ts`

| # | Gate | Block reason |
|---|------|--------------|
| 1 | **AUTO OFF** | `autoEnabled === false` |
| 2 | **TF excluded** | `settings.excludedTfs.includes(alert.tfKey)` (default `["5m"]`) |
| 3 | **Đang cooldown** | `now < pausedUntilMs` (daily-cap OR equity-DD pause) |
| 4 | **Daily loss cap** | `dailyPnl ≤ dailyLossCapUsd` (default -50$) |
| 5 | **Max open** | `openCount ≥ settings.maxOpen` (default 100) |
| 6 | **Per-rule cooldown 10 phút** | `firedIds[alert.id]` lệnh trước < 10m |
| 7 | **Đã pending cùng id+side** | tránh dup |
| 8 | **SMART STACK gate** | `checkStackGate()` — 4 sub-checks |

### 8a-d SMART STACK sub-gates:

| 8x | Sub-gate | Default | Block khi |
|----|----------|---------|-----------|
| 8a | Stack count per side | **50** | `sameSide.length >= stackMaxPerSide` |
| 8b | Notional cap per side | **$200,000** | sum notional + new order > cap |
| 8c | Spacing per side | **0 phút** | `nowMs - lastSame.entryMs < spacingMs` |
| 8d | Min entry distance | **0%** | dist nhỏ hơn ngưỡng |

→ v4.6.8 PRESET B: relaxed gates 8c/8d (0 phút, 0%) cho phép nhồi entries nhanh trong 1 vùng giá.

### Sau khi pass 8 gates:
- **5m / 15m TF**: trả ENTRY action ngay (entry MARKET tại HTF close, **skip Phase 2 LTF confirm**) — v4.6.7 PA A2
- **1h / 4h / 1d / 1w TF**: trả PENDING action → vào Phase 3

---

## ⏳ CONFIRM PENDING — Phase 2 LTF (Phase 3) — CHỈ HTF rules

**Function:** `confirmPending(state, ctx)` in `utils/liveTraderEngine.ts`
**Áp dụng**: chỉ rule TF ∈ {1h, 4h, 1d, 1w}

### Discard conditions:
- Rule không còn trong `activeAlerts` → `DISCARD: rule no longer firing`
- Pending > 24h → `DISCARD: pending expired`

### Confirm conditions:

**LONG:**
- ✅ `Stoch5m K < confirmStochOsLevel` (default 20)
- ✅ HOẶC `currentPrice ≤ support15m × (1 + confirmSrProximityPct%)` (default 0.4%)

**SHORT:**
- ✅ `Stoch5m K > confirmStochObLevel` (default 80)
- ✅ HOẶC `currentPrice ≥ resistance15m × (1 - confirmSrProximityPct%)`

### Recheck trước khi execute:
- Per-rule cooldown 10m
- maxOpen
- dailyPnl
- SMART STACK gate (8a-d)

---

## 🛡 EQUITY DD PROTECTION — Phase 8 (v4.6.9 NEW)

**Function:** `maybeTriggerEquityDdProtection(state, currentEquityUsd)`

### Logic:
1. App track **peak equity** (wallet + uPnL) qua mỗi poll Binance
2. Compute current DD % = (peak - current) / peak × 100
3. Drop ≥ `equityDdPausePct` (default 30%) → trigger pause
4. Pause `equityDdPauseHours` (default 4h) → cho thị trường ổn định
5. Hết pause → auto resume bình thường, peak vẫn giữ

### State mới:
- `peakEquityUsd?: number` — track peak từ trước
- `pauseReason?: "daily-cap" | "equity-dd" | null` — distinguish lý do

### UI hiển thị:
- **PEAK EQ** pill (xanh): peak equity USD
- **CUR DD%** pill: drop hiện tại từ peak (xám → cam → đỏ khi sắp trigger)
- **DD-PAUSED** pill (đỏ): khi trigger, vs **PAUSED** (cam) khi daily-cap
- LastError banner: `🛑 EQUITY DD PROTECTION — drop X% từ peak $Y. Pause Nh.`

---

## ⚡ EXECUTE ACTION (Phase 5)

```typescript
qty = notionalToQty(marginUsd × leverage, entryPrice)
// Default: $1 × 100 = $100 notional / $60000 = 0.001 BTC

tpPrice = side === LONG ? entry × (1 + tpPct/100) : entry × (1 - tpPct/100)
slPrice = side === LONG ? entry × (1 - slPct/100) : entry × (1 + slPct/100)
```

### Execution:
- `dryRun === true`: chỉ log journal kind `ENTRY`
- `dryRun === false`:
  1. `placeMarketOrder(MARKET, qty, posSide)` — TIỀN THẬT
  2. Push `trackedPositions[]`
  3. Notify `🔔 ENTRY ${side} ${ruleId}` + sound `playEntry()` (1 beep)
  4. Log journal `kind: ENTRY` với `confirmedBy` field (LTF confirm reason hoặc `"<tf> skip-LTF (entry HTF close)"`)

### Error handling:
- `explainBinanceError()` map mã lỗi tiếng Việt: -4161, -2015, -1021, -2019, ...

---

## 📡 PLAN B MONITOR TP/SL (Phase 6)

**Function:** `monitorTrackedPositions(state, markPrice)`

App **KHÔNG đặt STOP_MARKET / TAKE_PROFIT_MARKET trên Binance** — tự monitor để tránh stop bị quét + linh hoạt SMART STACK.

### Logic mỗi tick mark price (chỉ LEADER):
```
for pos in trackedPositions:
    if now - pos.entryMs > 72h: drop + log ERROR
    if hit TP/SL trigger:
        placeMarketOrder(reduceOnly=true, qty=pos.qty)
        log CLOSE kind:trigger
        if SL: playSlHit() (3 beep loud) + notify URGENT
        else: playTpHit() (chime) + notify
```

---

## 🔁 RECONCILE (Phase 7)

Mỗi 60s poll Binance, so sum qty per side với trackedPositions:
- `tracked qty - binance qty > 0.0005 BTC` → có lệnh closed manually trên Binance
- → Drop tracked entries CŨ NHẤT cho đến khi sum match
- Log warning `⚠️ Reconcile: ... dropped`

---

## ⚙️ SETTINGS — DEFAULTS HIỆN TẠI (v4.6.9 PRESET B)

**Type:** `LiveSettings` in `utils/liveTraderEngine.ts`
**UI:** LiveTab → SETTINGS card (collapsible)

| Setting | Default v4.6.9 | Default cũ | Range hợp lý | Ghi chú |
|---|---|---|---|---|
| `symbol` | `"BTCUSDT"` | (giống) | locked | chỉ trade BTC |
| `leverage` | 100 | (giống) | 10-125 | info only, set thủ công Binance |
| `marginUsd` | 1 | (giống) | 1-50 | margin/lệnh |
| `maxOpen` | **100** | 30 | 1-200 | tăng để stack 50/side LONG + 50/side SHORT |
| `dailyLossCapUsd` | **-50** | -15 | -100..-5 | tăng cap để không hit liên tục |
| `cooldownMinutes` | **240** | 60 | 60-480 | 4h pause sau cap hit (vs 1h) |
| `excludedTfs` | `["5m"]` | (giống) | array | TF không vào lệnh |
| `confirmStochOsLevel` | 20 | (giống) | 5-30 | LONG LTF confirm |
| `confirmStochObLevel` | 80 | (giống) | 70-95 | SHORT LTF confirm |
| `confirmSrProximityPct` | 0.4 | (giống) | 0.1-1.0 | gần S/R 15m % |
| `stackMaxPerSide` | **50** | 15 | 5-100 | sweet spot từ backtest 3y |
| `stackPerSideSpacingMin` | **0** | 10 | 0-30 | RELAXED — bottleneck chính |
| `stackMinEntryDistPct` | **0** | 0.3 | 0-1.0 | RELAXED — bottleneck thật sự |
| `stackMaxNotionalUsd` | **200000** | 50000 | 10k-500k | tăng cho phép stack 50 |
| `equityDdPausePct` | **30** | (NEW) | 10-50 | drop từ peak → pause |
| `equityDdPauseHours` | **4** | (NEW) | 1-24 | pause sau trigger |

---

## 📊 BACKTEST 3Y RESULTS (v4.6.9 final)

### Setup:
- 3 năm BTC data (5m, 15m, 1h, 4h, 1d, 1w candles)
- 41 rules truly profitable (đã move 13 losers, restore 2 flipped)
- LIVE engine logic: PA A2 (5m+15m skip LTF) + PRESET B + DD 30/4h

### Aggregate stats (COMBO mode):
- **34,922 trades** trong 3 năm (~32 trades/ngày)
- **WR 38.7%, PF 1.54**
- **NET +937,030%** với leverage 100x = ~310x return / năm
- **MaxDD -46,096%** (giảm 11% so với không DD protection)
- **DD pause triggers**: 26 lần / 3 năm

### Top 5 SOLO performers:
1. **15m:8 SHORT** — NET 33,584%, WR 50.3%, 902T
2. **15m:9 SHORT** — NET 33,584%, WR 50.3%, 902T
3. **15m:11 SHORT** — NET 31,844%, WR 52.1%, 775T
4. **15m:12 SHORT** — NET 31,844%, WR 52.1%, 775T
5. **15m:22 SHORT** — NET 31,507%, WR 48.0%, 987T (FLIPPED từ losing!)

→ Top tier toàn 15m SHORT (sau khi áp PA A2 skip LTF cho 15m).

### So sánh NORMAL vs LIVE strategy (39 rules subset):
| Strategy | Trades | NET | WR |
|---|---|---|---|
| NORMAL (entry HTF close, no LTF confirm) | 10,224 | +221,769% | 41.1% |
| **LIVE (Phase 2 LTF confirm cho 1h+)** | 9,968 | **+288,850%** | 38.4% |
| Δ LIVE - NORMAL | -256 | **+67,081% (+30%)** | -2.71pp |

→ **Phase 2 LTF confirm BOOST NET +30%** mặc dù WR thấp hơn 2.71pp.

---

## 🛡 SINGLE-LEADER LOCK (multi-device)

**Files:** `utils/leaderElection.ts`, `hooks/useBinanceLive.ts`

### Roles:
- **LEADER** 👑: full quyền (vào lệnh, đổi settings, manual close)
- **FOLLOWER** 👁: read-only (mirror state từ gist)
- **DISCONNECTED** ⛔: chưa nhập API key, không tham gia election
- **BOOTING** ⏳: đang verify claim (count down)

### Election (PA B v4.5.3 timing):

| Param | Value | Ghi chú |
|---|---|---|
| Heartbeat | 60s ± 8s jitter | LEADER push `live_leader.json` |
| Check leader (normal) | 80s | mọi device pull leader info |
| Check leader (burst sau role change) | 10s × 60s | adaptive — phát hiện claim sớm |
| Timeout (declare chết) | 180s | 3-strike: miss 3 heartbeat 60s |
| Verify after claim | 12s | đợi gist propagate rồi verify |

### Hard-roll claim:
- Bấm `🔒 CLAIM LEADER` → prompt password `30318384` → confirm → push leader file
- Device cũ tự demote trong tối đa 80s

### State sync (mọi device CONNECT):

| File | Push debounce | Pull interval | Nguồn truth |
|---|---|---|---|
| `live_trading.json` (state) | 12s | 120s (follower) | Leader |
| `live_leader.json` (lock) | 60s heartbeat | 80s (10s burst) | Leader |
| `all5m_account.json` | 20s | 120s (follower) | Leader |
| `paper_trades.json` | 20s | (manual) | Leader (RULE tab) |

### Sync qua Cloudflare Worker:
- App KHÔNG có PAT trên client
- Worker URL: `https://cold-breeze-441e.tuantommy83.workers.dev`
- Worker giữ PAT trong env var Cloudflare Secret
- Repo: `tommy31383/btc-dashboard` branch `paper-data`

---

## 🔔 NOTIFICATIONS + SOUND

**File:** `utils/liveAlerts.ts`

### Web Notification API (browser):
- `ENTRY` → `🔔 ENTRY {side} {ruleId} · qty X @ $Y → TP $Z / SL $W`
- `TP HIT` → `✅ TP HIT — {side} {ruleId}`
- `SL HIT` → `🚨 SL HIT — {side} {ruleId}` (urgent, requireInteraction)

### Web Audio API (sound):
- `playEntry()` — 1 beep 440Hz ngắn
- `playTpHit()` — 2 beep chime (660Hz + 880Hz)
- `playSlHit()` — 3 beep loud 880Hz (urgent)

---

## 🔐 SECURITY

| Item | Cách bảo vệ |
|---|---|
| Binance API key + secret | AsyncStorage `@live_trader_secret_v1` (LOCAL only, KHÔNG sync) |
| GitHub PAT | Cloudflare Worker env var Secret |
| HMAC SHA-256 sign | Web Crypto API, recvWindow 5000ms |
| CORS Worker | Chỉ allow `https://tommy31383.github.io` + localhost dev |
| Withdrawal | API key DISABLE quyền Withdrawal (chỉ Futures + Trading) |

---

## 📁 RULES MANAGEMENT

### Hiện tại:
- **`assets/hard_rules.json`**: 41 rules production (truly profitable trong backtest 3y)
- **`assets/losers_live_3y.json`**: 13 rules losing (đã move ra, restore dễ)
- **`assets/hard_rules.json.bak`**: backup tự động trước mỗi lần move

### Tools:
- `tools/move-losing-rules-live.ts` — move rules NET<threshold sang losers file
  - `npx tsx tools/move-losing-rules-live.ts` — move với threshold 0
  - `npx tsx tools/move-losing-rules-live.ts --threshold=-500` — chỉ move loss > 500%
  - `npx tsx tools/move-losing-rules-live.ts --restore` — khôi phục hết
  - `--dry` để preview

### Lifecycle 1 rule:
1. Generate qua scan tools (vd `tools/scan-tpsl.ts`)
2. Inject qua `tools/inject-verified-rules.ts`
3. Backtest active 3y → check stats
4. Backtest LIVE 3y → check fit với LIVE engine logic
5. Promote lên `hard_rules.json` hoặc move sang losers
6. Live monitor + adjust

---

## 🧪 BACKTEST TOOLS

### `tools/backtest-live-rules.ts` — backtest LIVE engine logic 3y

**CLI args đầy đủ:**
```bash
npx tsx tools/backtest-live-rules.ts \
  --years=3 --fee=0.05 --maxHold=200 --confirmWindow=60 \
  --stackMax=50 --stackSpacing=0 --stackDist=0 --stackNotional=200000 \
  --ddPause=30 --ddHours=4 \
  --atrFilter=0 --corrLimit=0 --corrWindow=60 \
  --includeAll  # default skip 5m rules (excluded TFs)
```

**Output:**
- `assets/live_backtest_3y.json` — raw stats per rule
- `assets/live_backtest_3y_report.html` — sortable HTML + sparkline per rule

### `tools/backtest-compare-3y.ts` — compare NORMAL vs LIVE

```bash
npx tsx tools/backtest-compare-3y.ts
```

So sánh 2 strategies side-by-side cho cùng rules:
- NORMAL: entry HTF close, no Phase 2 LTF confirm
- LIVE: Phase 2 LTF confirm

Output: `assets/backtest_compare_3y.json` + `report.html`

### `tools/backtest-active-3y.ts` — backtest legacy logic
- Entry HTF close, không qua Phase 2 LTF confirm
- Output regenerate `rule.stats` trong hard_rules

---

## 📊 IMPROVEMENT BACKLOG

### ✅ Đã làm (v4.6.x):
- [x] PA A2: skip Phase 2 LTF cho 5m + 15m (boost NET +30k%)
- [x] PRESET B: relaxed SMART STACK gates (NET 122k → 937k, +6.8x)
- [x] Equity DD Protection (drop 30% → pause 4h, NET +25k MaxDD -11%)
- [x] Move 13 losers (NET <0) sang file riêng, 2 rules flipped khi rerun
- [x] Backup auto `hard_rules.json.bak` trước mọi move
- [x] Cloudflare Worker proxy (PAT không lộ trên client)
- [x] Single-leader lock với 4 timing levels (heartbeat, check, timeout, verify)
- [x] Reconcile trackedPositions vs Binance position thực
- [x] Notification + Sound alerts (Web API)

### ⚠️ Đã test, KHÔNG adopt (kết quả không tốt):
- [-] **ATR volatility filter**: cắt 3-17k candidates → NET giảm 16-43% nhưng MaxDD KHÔNG giảm
- [-] **Correlation gate** (max N entries cùng side per 60m): cắt 5-21k candidates → NET giảm 13-36%, MaxDD chỉ giảm 0-2k
- → Root cause MaxDD không phải volatility hay cluster, mà là **specific moments + 41 rules đa số SHORT MACD = directional bias**

### 🔴 Còn cần làm:
- [ ] **Diversify rules**: add LONG rules để cân với SHORT (giảm directional risk)
- [ ] **Per-rule SL dynamic**: SL theo ATR thay fixed % (vd 1.5×ATR thay 10%)
- [ ] **Walk-forward optimization**: rolling window, disable rule khi recent perf tệ
- [ ] **Hedging logic**: khi 30 LONG mở, mở 5 SHORT hedge mass move
- [ ] **Per-rule cooldown band-aware**: cho phép cùng rule ở giá khác (vd ±0.5% band)
- [ ] **Trail stop loss**: SL tự dời theo giá khi profit
- [ ] **Partial close**: TP1 đóng 50%, TP2 đóng 50%
- [ ] **WebSocket Binance**: thay polling 60s → real-time positions/orders

### 🟡 Nice to have:
- [ ] Pending alert timeout khi rule stop firing (vd >1h)
- [ ] API key encrypt native keychain (thay AsyncStorage plain text)
- [ ] PAT rotation reminder (90 days)

---

## 🗂️ JOURNAL STORAGE (3-tier rolling, anh Tommy 2026-04-28)

**Constraint:** giữ 7 ngày · cap entries · tối ưu RAM/disk/bandwidth.

### Tier 1 — RAM (server + client) · cap **100 entries**
- Server `state.journal[]` cap 100 entries gần nhất → broadcast WS realtime
- Client `_cache.journal` cap 100 (constant `CLIENT_JOURNAL_CAP`)
- RAM footprint: ~10 KB mỗi tier

### Tier 2 — Disk (server) · 7 file rolling daily
```
logs/journal-2026-04-22.jsonl    ← cũ nhất (sẽ bị xoá)
logs/journal-2026-04-23.jsonl
...
logs/journal-2026-04-28.jsonl    ← hôm nay (đang ghi)
```
- 1 file/ngày, append-only (`fs.appendFileSync`)
- Cap **1000 entries/file** (tránh runaway)
- Cron daily 00:05 UTC: `find logs -name "journal-*.jsonl" -mtime +7 -delete`
- Disk total: ~7000 entries × 80 bytes = **~560 KB cố định**

### Tier 3 — Client lazy load · KHÔNG cache vào state
- UI mặc định show 100 entries (RAM)
- "Xem thêm" → gọi `useBackendLive().loadJournalHistory(date)` → trả về data, **caller tự manage memory** (mount-scoped, KHÔNG vào `_cache`)
- `loadJournalDays()` list ngày có data: `["2026-04-22",...,"2026-04-28"]`

### Schema compact (1 entry ~70-90 bytes)
```jsonl
{"t":1714294800000,"a":"C","r":"5m:1","s":"L","p":63565.8,"x":"TP","pnl":11.45}
```
| Key | Type | Mô tả |
|---|---|---|
| `t` | int ms | timestamp |
| `a` | "E"\|"C"\|"S" | Entry / Close / Skip |
| `r` | string | ruleId compact (`tf:rank`) |
| `s` | "L"\|"S" | side |
| `p` | float | price (entry hoặc close) |
| `x` | "TP"\|"SL"\|"MAN" | trigger (chỉ cho CLOSE) |
| `pnl` | float | PnL net USD (chỉ CLOSE) |

### WebSocket broadcast — DELTA (không full state)
| Event type | Payload | Khi nào |
|---|---|---|
| `state` | `{ state }` | thay đổi auto/dryRun/settings (không thay đổi journal) |
| `journal_append` | `{ entry }` ~150B | khi 1 entry mới được log (E/C/S) |
| `journal_snapshot` | `{ entries: [] }` | khi client reconnect (sync lại) |

Client dedup theo key `${ts}|${ruleId}|${actionKind}` để tránh nhân đôi entry khi WS retry.

### Bandwidth tiết kiệm
| Channel | Trước | Sau | Giảm |
|---|---|---|---|
| `/api/live/state` | ~75 KB (embed journal 500) | ~5 KB | -93% |
| `/api/live/journal?limit=100` | ~75 KB (500) | ~8 KB (100 cap) | -89% |
| WS event journal | full state ~80 KB | delta ~150B | -99.8% |
| History (lazy) | N/A | ~80 KB/ngày on-demand | — |

Polling 30s × 24h: **~1 GB/day → ~14 MB/day** (-98.6%).

### API endpoints (server `tommybtc.duckdns.org`)
| Endpoint | Mô tả |
|---|---|
| `GET /api/live/journal?limit=100` | RAM rolling, default 100 |
| `GET /api/live/journal/history?date=YYYY-MM-DD` | Load 1 file ngày từ disk (lazy) |
| `GET /api/live/journal/days` | List ngày có data (max 7) |

### Server-side implementation (anh Tommy push)
```js
const DAILY_FILE_CAP = 1000;
const RAM_CAP = 100;
const DAYS_KEEP = 7;

function appendJournal(entry) {
  state.journal.unshift(entry);
  if (state.journal.length > RAM_CAP) state.journal.length = RAM_CAP;

  const day = new Date(entry.t).toISOString().slice(0, 10);
  const file = `logs/journal-${day}.jsonl`;
  if (countLines(file) < DAILY_FILE_CAP) {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  }

  broadcastWs({ type: "journal_append", entry });
}

// Cron 00:05 UTC daily
function rotateLogs() {
  for (const f of fs.readdirSync("logs/")) {
    if (!f.startsWith("journal-")) continue;
    const day = f.slice(8, 18);
    if ((Date.now() - Date.parse(day)) / 86400_000 > DAYS_KEEP) {
      fs.unlinkSync(`logs/${f}`);
    }
  }
}
```

### Client-side (đã apply trong repo này)
- `utils/backendApi.ts`: `journalHistory(date)`, `journalDays()`
- `hooks/useBackendLive.ts`:
  - `CLIENT_JOURNAL_CAP = 100` cap RAM
  - WS handler `journal_append` (delta) + `journal_snapshot` (reconnect)
  - Dedup `journalKey()` theo `ts|ruleId|actionKind`
  - `loadJournalHistory(date)` + `loadJournalDays()` lazy, KHÔNG cache vào `_cache`

---

## 📜 VERSION HISTORY

| Version | Change |
|---|---|
| v4.3.83 | Per-rule cooldown 10m + Phase 2 LTF confirm |
| v4.3.87 | SMART STACK (max 15/side, spacing 10m, dist 0.3%) |
| v4.3.89 | Single-leader lock (PA A initial) |
| v4.3.96 | PA B (heartbeat 15s + jitter, 3-strike timeout 45s) |
| v4.4.2 | Cloudflare Worker proxy (no PAT trên client) |
| v4.4.5 | Sync binance snapshot + 5m smart stack giữa devices |
| v4.4.8 | stackMaxNotionalUsd cap + reconcile + Web Notification + sound |
| v4.5.3 | Tăng x4 timing sync (heartbeat 60s, check 80s, timeout 180s) |
| v4.6.7 | **PA A2: skip LTF confirm cho 5m + 15m** (NET +32k% backtest) |
| v4.6.8 | **PRESET B: max stack 50, relaxed gates, dailyCap -50, cooldown 4h** |
| **v4.6.9** | **Equity DD Protection (drop 30% → pause 4h)** |

---

## 🎯 KEY INSIGHTS

1. **15+ điểm có thể BLOCK** 1 rule fire → không phải fire = vào lệnh
2. **5m/15m rules**: skip Phase 2 LTF confirm (entry HTF close ngay) — backtest cho thấy LTF confirm tệ hơn cho TF nhỏ
3. **1h+ rules**: Phase 2 LTF confirm BOOST NET +30% (chờ Stoch5m / S/R 15m)
4. **Bottleneck SMART STACK**: dist 0.3% + spacing 10m chặn nhiều entries hợp lệ → relaxed về 0
5. **MaxDD nguyên nhân**: specific moments thị trường + directional bias (đa số SHORT MACD) — KHÔNG phải volatility hay cluster
6. **DD Protection**: drop 30% → pause 4h, giảm DD 11% mà NET tăng nhẹ +25k%
7. **Single-leader lock**: 1 device chạy auto, các device khác mirror → tránh duplicate entries
8. **Cloudflare Worker proxy**: PAT an toàn, mọi device dùng app không cần config
