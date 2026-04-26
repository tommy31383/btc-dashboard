# LIVE TRADING ENGINE — Rule vào lệnh & Flow đầy đủ

**Version:** v4.6.2 (last updated 2026-04-26)
**Files:** `utils/liveTraderEngine.ts`, `hooks/useBinanceLive.ts`, `utils/leaderElection.ts`, `utils/binanceLive.ts`, `utils/gistSync.ts`

---

## 🏗 Architecture overview

3 engine song song trong app, LIVE là 1 trong 3:

| Engine | File | Account | Mục đích |
|---|---|---|---|
| `use5mAllTrader` | `hooks/use5mAllTrader.ts` | Paper $1000 (local + sync gist) | Test SMART STACK 5m, mỗi 5m close → entry |
| `useAutoTrader` (CLAUDE) | `hooks/useAutoTrader.ts` | Paper $1000 (sync gist) | Subscribe rule HTF fire, paper |
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
PHASE 7: Reconcile (mỗi 30s poll Binance) — sum qty vs trackedPositions
    - Mismatch > 0.0005 BTC → drop tracked entries dư + warning
```

---

## 🚨 DECIDE ENTRY — 8 GATES (Phase 2)

**Function:** `decideEntry(state, alert, ctx)` in `utils/liveTraderEngine.ts:233`

Tất cả phải PASS thì mới chuyển sang PENDING. Fail bất kỳ → BLOCK với reason rõ.

| # | Gate | Block reason | Code reference |
|---|------|--------------|----------------|
| 1 | **AUTO OFF** | `autoEnabled === false` | `liveTraderEngine.ts:240` |
| 2 | **TF excluded** | `settings.excludedTfs.includes(alert.tfKey)` | line 241 |
| 3 | **Đang cooldown sau daily-cap hit** | `now < pausedUntilMs` | line 242 |
| 4 | **Daily loss cap** | `dailyPnl ≤ dailyLossCapUsd` | line 246 |
| 5 | **Max open** | `openCount ≥ settings.maxOpen` | line 249 |
| 6 | **Per-rule cooldown 10 phút** | `firedIds[alert.id]` lệnh trước < 10m | line 252-258 |
| 7 | **Đã pending cùng id+side** | tránh dup | line 260 |
| 8 | **SMART STACK gate** (4 sub-checks) | `checkStackGate(state, side, entryPrice, now)` | line 196-227 |

### 8a-d SMART STACK sub-gates:

| 8x | Sub-gate | Block khi |
|----|----------|-----------|
| 8a | Stack count per side | `sameSide.length >= stackMaxPerSide` (default 15) |
| 8b | **Notional cap** ⭐ | `currentNotional + newOrderNotional > stackMaxNotionalUsd` (default $50k) |
| 8c | Spacing | `nowMs - lastSame.entryMs < spacingMs` (default 10 phút giữa 2 entry CÙNG side) |
| 8d | Min entry distance | `Math.abs(entryPrice - lastSame.entryPrice) / lastSame.entryPrice * 100 < stackMinEntryDistPct` (default 0.3%) |

---

## ⏳ CONFIRM PENDING — Phase 2 LTF (Phase 3)

**Function:** `confirmPending(state, ctx)` in `utils/liveTraderEngine.ts:340`

Pending alert đợi LTF (Lower-TimeFrame) confirm trước khi vào MARKET.

### Discard conditions:
- Rule không còn trong `activeAlerts` → `DISCARD: rule no longer firing`
- Pending > 24h (`PENDING_MAX_AGE_MS`) → `DISCARD: pending expired`

### Confirm conditions:

**LONG:**
- ✅ `Stoch5m K < confirmStochOsLevel` (default 20)
- ✅ HOẶC `currentPrice ≤ support15m × (1 + confirmSrProximityPct%)` (default 0.4%)

**SHORT:**
- ✅ `Stoch5m K > confirmStochObLevel` (default 80)
- ✅ HOẶC `currentPrice ≥ resistance15m × (1 - confirmSrProximityPct%)`

### Recheck trước khi execute (state có thể đổi trong lúc chờ):
- Per-rule cooldown 10m
- maxOpen
- dailyPnl
- SMART STACK gate (8a-d)

---

## ⚡ EXECUTE ACTION (Phase 5)

**Function:** `executeAction(state, alert, action)` in `utils/liveTraderEngine.ts:480`

```typescript
qty = notionalToQty(marginUsd × leverage, entryPrice)
// Vd: marginUsd $1 × lev 100 = $100 notional / $60000 = 0.001 BTC

tpPrice = side === LONG ? entry × (1 + tpPct/100) : entry × (1 - tpPct/100)
slPrice = side === LONG ? entry × (1 - slPct/100) : entry × (1 + slPct/100)
// tpPct/slPct lấy từ rule.config.targetPct / stopPct
```

### Nếu `dryRun === true`:
→ chỉ log journal kind `ENTRY` (no API call)

### Nếu `dryRun === false`:
1. `placeMarketOrder(symbol, BUY/SELL, qty, posSide)` — TIỀN THẬT
2. Push vào `trackedPositions[]` với `{id, side, qty, entryPrice, tpPrice, slPrice, entryMs}`
3. Notify `🔔 ENTRY ${side} ${ruleId}` + sound `playEntry()` (1 beep)
4. Log journal `kind: ENTRY`

### Error handling:
- Catch error từ Binance → log `kind: ERROR` + `explainBinanceError(msg)` (mapping mã lỗi tiếng Việt)
- Common errors: `-4161` (leverage isolated), `-2015` (IP whitelist), `-1021` (timestamp), `-2019` (margin), ...

---

## 📡 PLAN B MONITOR TP/SL (Phase 6)

**Function:** `monitorTrackedPositions(state, markPrice)` in `utils/liveTraderEngine.ts:585`

App **KHÔNG đặt STOP_MARKET / TAKE_PROFIT_MARKET trên Binance** — tự monitor để tránh stop bị quét + linh hoạt SMART STACK (mỗi virtual lệnh có TP/SL riêng dù Binance gộp position).

### Logic mỗi tick mark price:

```
for pos in trackedPositions:
    if now - pos.entryMs > 72h:  # auto-drop stale
        log ERROR "tracked position expired, check Binance manually"
        skip

    if pos.side === LONG:
        if markPrice >= pos.tpPrice → trigger = "TP"
        elif markPrice <= pos.slPrice → trigger = "SL"
    else (SHORT):
        if markPrice <= pos.tpPrice → trigger = "TP"
        elif markPrice >= pos.slPrice → trigger = "SL"

    if trigger:
        placeMarketOrder(reduceOnly=true, qty=pos.qty)  # đóng đúng qty của lệnh đó
        log CLOSE kind:trigger
        if SL: playSlHit() (3 beep loud) + notify URGENT
        else (TP): playTpHit() (chime) + notify
        remove from trackedPositions
```

### Edge cases:
- API fail khi close → giữ trong remaining để retry tick sau
- mark price feed chết → no close (TP/SL bypass) → reconcile + 72h timeout cứu

---

## 🔁 RECONCILE (Phase 7)

**Function:** `reconcileTrackedPositions(state, binancePositions)` in `utils/liveTraderEngine.ts:530`

Mỗi 30s khi poll Binance, so sum qty:

```
binanceLong = sum(positions where side=LONG, abs(positionAmt))
binanceShort = sum(positions where side=SHORT, abs(positionAmt))
trackedLong = sum(trackedPositions where side=LONG, qty)
trackedShort = sum(trackedPositions where side=SHORT, qty)

if (trackedLong - binanceLong > 0.0005 BTC) → có lệnh đã close manually trên Binance
   → drop tracked entries CŨ NHẤT cho đến khi sum match
   → setLastError "⚠️ Reconcile: ... dropped"
```

Bảo vệ data integrity sau crash / close ngoài app.

---

## ⚙️ SETTINGS — defaults + range hợp lý

**Type:** `LiveSettings` in `utils/liveTraderEngine.ts:21`
**UI:** LiveTab → SETTINGS card (collapsible)

| Setting | Default | Range hợp lý | Ghi chú |
|---|---|---|---|
| `symbol` | `"BTCUSDT"` | locked | chỉ trade BTC |
| `leverage` | 100 | 10-125 | info only, set thủ công trên Binance |
| `marginUsd` | 1 | 1-50 | margin/lệnh, USDT |
| `maxOpen` | 30 | 1-50 | max position cùng lúc |
| `dailyLossCapUsd` | -15 | -100..-5 | hit cap → pause cooldown |
| `cooldownMinutes` | 60 | 15-240 | thời gian pause sau cap |
| `excludedTfs` | `["5m"]` | array | TF không vào lệnh |
| `confirmStochOsLevel` | 20 | 5-30 | LONG: K < N → confirm |
| `confirmStochObLevel` | 80 | 70-95 | SHORT: K > N → confirm |
| `confirmSrProximityPct` | 0.4 | 0.1-1.0 | gần S/R 15m % → confirm |
| `stackMaxPerSide` | 15 | 1-30 | max lệnh cùng side |
| `stackPerSideSpacingMin` | 10 | 1-60 | spacing giữa 2 entry CÙNG side |
| `stackMinEntryDistPct` | 0.3 | 0.1-2.0 | min dist giữa 2 entry CÙNG side |
| `stackMaxNotionalUsd` | 50000 | 1k-500k | tổng notional cap CÙNG side (chống liquidation) |

---

## 🛡 SINGLE-LEADER LOCK (multi-device)

**Files:** `utils/leaderElection.ts`, `hooks/useBinanceLive.ts`

Vấn đề: nhiều device cùng auto → cùng vào lệnh → trùng lặp. Solution: chỉ 1 device là LEADER.

### Roles:
- **LEADER** 👑: full quyền (vào lệnh, đổi settings, manual close)
- **FOLLOWER** 👁: read-only (mirror state từ gist)
- **DISCONNECTED** ⛔: chưa nhập API key, không tham gia election
- **BOOTING** ⏳: đang verify claim (count down)

### Election (PA B):

| Param | Value | Ghi chú |
|---|---|---|
| Heartbeat | 60s ± 8s jitter | LEADER push `live_leader.json` |
| Check leader (normal) | 80s | mọi device pull leader info |
| Check leader (burst sau role change) | 10s × 60s | adaptive — phát hiện claim sớm |
| Timeout (declare chết) | 180s | 3-strike: miss 3 heartbeat 60s |
| Verify after claim | 6s | đợi gist propagate rồi verify |
| Read-after-write | 4s | check race condition |

### Hard-roll claim:
- Device follower bấm `🔒 CLAIM LEADER` → prompt password `30318384` → confirm → push leader file
- Device cũ tự demote trong tối đa 80s (hoặc 10s nếu burst window)

### State sync (mọi device CONNECT đều dùng):

| File | Push debounce | Pull interval | Nguồn truth |
|---|---|---|---|
| `live_trading.json` (state) | 12s | 60s (follower) | Leader |
| `live_leader.json` (lock) | 60s heartbeat | 80s (10s burst) | Leader |
| `all5m_account.json` | 20s | 60s (follower) | Leader |
| `paper_trades.json` | 20s | (manual) | Leader (CLAUDE tab) |

### Sync qua Cloudflare Worker:
- App KHÔNG có PAT trên client
- Worker URL: `https://cold-breeze-441e.tuantommy83.workers.dev`
- Worker giữ PAT trong env var Cloudflare Secret
- 4 endpoints: `GET /file?path=X`, `PUT /file?path=X`, `GET /ref?ref=X`, `POST /ref`
- Repo: `tommy31383/btc-dashboard` branch `paper-data`

---

## 🔔 NOTIFICATIONS + SOUND

**File:** `utils/liveAlerts.ts`

### Web Notification API (browser):
- `ENTRY` → `🔔 ENTRY {side} {ruleId} · qty X @ $Y → TP $Z / SL $W`
- `TP HIT` → `✅ TP HIT — {side} {ruleId}`
- `SL HIT` → `🚨 SL HIT — {side} {ruleId}` (urgent, requireInteraction)
- Permission requested khi LEADER boot

### Web Audio API (sound):
- `playEntry()` — 1 beep 440Hz ngắn
- `playTpHit()` — 2 beep chime (660Hz + 880Hz)
- `playSlHit()` — 3 beep loud 880Hz (urgent)

Lưu ý: browser cần user gesture lần đầu để Audio Context start (click bất kỳ chỗ trong app là OK).

---

## 🔐 SECURITY

| Item | Cách bảo vệ |
|---|---|
| Binance API key + secret | AsyncStorage `@live_trader_secret_v1` (LOCAL only, KHÔNG sync) |
| GitHub PAT | Cloudflare Worker env var Secret (không có trong bundle JS) |
| HMAC SHA-256 sign | Web Crypto API, recvWindow 5000ms |
| CORS Worker | Chỉ allow `https://tommy31383.github.io` + localhost dev |
| Path validation Worker | Chặn `..`, regex `[a-zA-Z0-9_./-]` |
| Withdrawal | API key DISABLE quyền Withdrawal (chỉ Futures + Trading) |

---

## 📊 IMPROVEMENT BACKLOG

### 🔴 Cần làm sớm:
- [ ] **Per-rule cooldown band-aware** — hiện block cùng `ruleId` 10m. Nên cho phép cùng rule ở giá khác nhau (vd ±0.5% band)
- [ ] **Trail stop loss** — SL tự dời theo giá khi profit (vd +0.5% → dời SL theo)
- [ ] **Partial close** — TP1 đóng 50%, TP2 đóng 50% còn lại
- [ ] **WebSocket Binance** thay polling 30s → real-time positions/orders

### 🟡 Nice to have:
- [ ] **Pending alert timeout khi rule stop firing** (vd rule OFF >1h → auto-discard)
- [ ] **API key encrypt** native keychain (thay AsyncStorage plain text)
- [ ] **Per-device CORS** tighten Worker (chỉ allow Pages domain, bỏ localhost)
- [ ] **PAT rotation reminder** (90 days)

### 🟢 Polish:
- [ ] Equity sparkline target lớn hơn cho mobile
- [ ] Compare 2-3 rule cạnh nhau (split view)
- [ ] Pin favorite rules ⭐ trong TradingRulesPanel

---

## 📜 VERSION HISTORY (gates + features)

| Version | Date | Change |
|---|---|---|
| v4.3.x | apr-23 | Original LIVE engine, simple decideEntry, basic gates |
| v4.3.74 | apr-25 | Plan B self-monitor TP/SL (no STOP_MARKET) |
| v4.3.83 | apr-25 | Per-rule cooldown 10m + LTF confirm before entry |
| v4.3.87 | apr-26 | SMART STACK (max 15 per side, spacing 10m, min dist 0.3%) |
| v4.3.89 | apr-26 | Single-leader lock (PA A initial) |
| v4.3.96 | apr-26 | PA B (heartbeat 15s + jitter, 3-strike timeout 45s) |
| v4.4.0 | apr-26 | Auto-poll PAT 30s + RECHECK button |
| v4.4.2 | apr-26 | Cloudflare Worker proxy (no PAT trên client) |
| v4.4.5 | apr-26 | Sync binance snapshot + 5m smart stack giữa devices |
| v4.4.7 | apr-26 | Báo lỗi rõ khi push leader fail (PAT thiếu quyền) |
| v4.4.8 | apr-26 | stackMaxNotionalUsd cap + reconcile + Web Notification + sound |
| v4.4.9 | apr-26 | Siết role rights: follower chỉ XEM, leader full control |
| v4.5.1 | apr-26 | Follower vẫn được nhập + save + test API key |
| v4.5.3 | apr-26 | Tăng x4 timing sync (heartbeat 60s, check 80s, timeout 180s) |
| v4.5.5 | apr-26 | LIVE: collapsible 3 cards (CONTROLS, CREDENTIALS, SETTINGS) với memory |
| v4.6.0 | apr-26 | LIVE redesign theo Stitch (Top KPI 3-col, toggle switch, Material icons) |
| v4.6.1 | apr-26 | Burst-mode adaptive leader-check (10s × 60s sau role change) |
| v4.6.2 | apr-26 | Tab CLAUDE → RULE, LiveRulesSummary collapsible |

---

## 🎯 KEY INSIGHTS

1. **15+ điểm có thể BLOCK** 1 rule fire → không phải fire = vào lệnh
2. **PENDING là phase trung gian** — pass basic gates nhưng chưa vào, chờ LTF
3. **Plan B monitor TP/SL trong app** → tránh stop bị quét + flexible SMART STACK
4. **trackedPositions[]** là source of truth của app, reconcile với Binance mỗi 30s
5. **Single-leader lock** đảm bảo 1 device duy nhất vào lệnh, các device khác mirror
6. **Cloudflare Worker proxy** để giữ PAT an toàn (không lộ trong bundle public)
7. **Burst-mode adaptive** — sync nhanh khi cần (sau claim), tiết kiệm khi ổn định
