# LIVE TRADING ENGINE — Rule vào lệnh & Flow đầy đủ

**Version:** v4.6.9 (last updated 2026-04-27)
**Files:** `utils/liveTraderEngine.ts`, `hooks/useBinanceLive.ts`, `utils/leaderElection.ts`, `utils/binanceLive.ts`, `utils/gistSync.ts`

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
