# PROJECT HANDOFF — BTC Trading Bot

**Date written:** 2026-04-28 (last sync v4.8.23)
**Frontend:** v4.8.23 (`tommy31383/btc-dashboard`, public, master branch)
**Server:** v0.2.2 (`tommy31383/btc-trader-server`, private, main branch)
**Owner:** Tommy (tuantommy83@gmail.com) — speaks Vietnamese, prefers terse Việt-Anh mix

---

## 0. TL;DR cho Claude kế tiếp

1. **2 repos, 1 hệ thống.** Frontend là Expo web tab UI (chart, rule list, settings, monitoring). Server là cloud bot 24/7 chạy trade thật trên Binance Futures BTCUSDT.
2. **Server-only mode locked.** Frontend KHÔNG tự vào lệnh nữa. `useBinanceLive` có hard-kill `SERVER_OWNS_TRADING = true` block 3 effect (entry firing / 5m engine / Plan B monitor). Mọi trade phải qua server.
3. **Server hosting:** DigitalOcean Singapore VPS `159.223.90.60`, HTTPS via DuckDNS `tommybtc.duckdns.org`. PM2 manage process. SQLite persist state.
4. **Production rule preset:** Mode E + E-T15-NoTP S50 (xem section 5).
5. **Build/deploy chỉ khi Tommy gõ "build"** — KHÔNG được tự build APK / web / push prod.
6. **Bump version 3 chỗ mỗi lần build:** `App.tsx APP_VERSION` + `App.tsx BUILD_DATE` + `app.json expo.version`. Server bump `package.json version` + `src/index.ts root response version`.

---

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│ FRONTEND (Expo web)                                         │
│ btc-dashboard, public repo                                  │
│ Hosted on GitHub Pages: tommy31383.github.io/btc-dashboard  │
│                                                             │
│ Tabs: RULE / LIVE / 5m ALL / SERVER                         │
│  - RULE: 43 rules eval + chart + UnifiedTradesPanel         │
│  - LIVE: legacy Binance UI, hard-killed (read-only)         │
│  - 5m ALL: PAPER engine 3 presets (WHALE/EAGLE/TURTLE)      │
│  - SERVER: login + control cloud bot + view state           │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS + WS
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ SERVER (Node.js + Express + WS)                             │
│ btc-trader-server, private repo                             │
│ Deployed on DigitalOcean Singapore                          │
│ https://tommybtc.duckdns.org → nginx → :3000                │
│                                                             │
│ PM2: btc-trader-server (cluster mode)                       │
│ SQLite: /var/lib/btc-trader/state.db (WAL)                  │
│ Env: /etc/btc-trader/env                                    │
│                                                             │
│ Engine loops:                                               │
│  - poll 30s × multiplier (account + positions + dailyPnl)   │
│  - tick 5s × multiplier (markPrice → Plan B monitor)        │
│  - klines 60s × multiplier (rebuild rule eval data)         │
│  - rule 60s × multiplier (eval 43 rules → decideEntry)      │
│  - markPrice WS @1s (low-latency Plan B trigger)            │
│  - Adaptive multiplier 0.5/1.0/2.0 dựa trên volume HIGH/MED/LOW │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTPS REST + WS
                              ▼
                   ┌──────────────────────┐
                   │ Binance Futures API  │
                   │ BTCUSDT only         │
                   │ Hedge mode (LONG +   │
                   │  SHORT đồng thời)    │
                   └──────────────────────┘
```

---

## 2. Repo structure

### `/Users/lap16116/BTC_PC/btc-dashboard/` (frontend)

```
App.tsx                    # Tab routing, version constants, ErrorBoundary
app.json                   # Expo config + version sync
CLAUDE.md                  # User instructions (priority overrides global)
LIVE_TRADING_RULES.md      # Live engine spec (LATEST: section v0.2.0 step trail)
5MALL_TRADING_RULES.md     # 5m ALL engine 3 preset spec
PROJECT_HANDOFF.md         # ← BẠN ĐANG ĐỌC ĐÂY
GPT_BACKTEST_SPEC.md       # GPT rule backtest convention
CODEX_REVIEW_NOTES.md      # Code review notes from Codex agent

components/                # 30+ React Native components
  ServerTab.tsx            # ★ SERVER tab UI — login + control + view bot state
  LiveTab.tsx              # LIVE tab — locked, banner shows SERVER_OWNS
  All5mPanel.tsx           # 5m ALL paper trader 3-preset switcher
  UnifiedTradesPanel.tsx   # Combined trade list (LIVE + 5m ALL)
  LiveActionItems.tsx      # Action snapshot (stack bars + EQ DD + zones)
  TradingRulesPanel.tsx    # 43 rule list with stats sparkline
  BinanceChart.tsx         # Chart with entry/exit markers + S/R overlay
  RuleAlertBanner.tsx      # Top banner showing live FIRED rules

hooks/
  useBackendLive.ts        # ★ Backend client (REST + WS). Module-level _cache
                           # singleton → instant tab switching (no remount)
  useBinanceLive.ts        # ★ Legacy LIVE engine. SERVER_OWNS_TRADING=true blocks
  useRuleAlerts.ts         # Rule eval engine (1h/4h/1d/1w + 5m baseline)
  use5mAllTrader.ts        # 5m ALL paper engine
  useBinanceKlines.ts      # Multi-TF kline fetcher (1m..1w)
  useBinancePrice.ts       # Current price ticker

utils/
  backendApi.ts            # ★ REST/WS client. SERVER_URL=tommybtc.duckdns.org
  liveTraderEngine.ts      # Legacy LIVE engine (frontend version, locked)
  binanceLive.ts           # Binance API wrapper (signed REST)
  all5mAccount.ts          # 5m ALL state + 3 PRESETS (WHALE/EAGLE/TURTLE)
  autoAccount.ts           # Legacy paper account (deprecated)

assets/
  hard_rules.json          # ★ 43 rule definitions + stats + equityCurve
  scan_tpsl_*.json         # Scanner outputs

tools/                     # 30+ standalone backtest scripts (run via tsx)
  backtest-live-fulltf-5mall-3y.ts    # Mode A/B/C/D/E/F sweep
  backtest-step-trail-no-tp-3y.ts     # E-T15 vs E-T15-NoTP
  backtest-step-trail-sizes-3y.ts     # S50/S60/S70/S80/S90 sweep
  backtest-active-3y.ts               # Per-rule equity curve regen

docs/app/                  # ★ GitHub Pages output (committed to repo)
                           # `npx expo export -p web` → copy dist/ → docs/app/
                           # baseUrl in app.json = "/btc-dashboard/app"
```

### `/Users/lap16116/BTC_PC/btc-trader-server/` (server, private)

```
package.json               # version + deps
tsconfig.json
ecosystem.config.cjs       # PM2 config (NOT used directly — PM2 args manual)

src/
  index.ts                 # ★ Bootstrap. Express + WS upgrade + graceful shutdown
                           # SIGTERM/SIGINT → flushSaveState before exit
  config.ts                # Loads env from /etc/btc-trader/env (prod) or .env (dev)
  auth.ts                  # bcrypt verify + JWT issue/verify + revocation list
  db.ts                    # SQLite (better-sqlite3) — kv + journal + sessions, WAL

  middleware/auth.ts       # Bearer JWT guard for /api/* (except health)

  routes/
    health.ts              # GET / (root) + /api/health
    auth.ts                # POST /api/auth/login + /logout + /verify
    binance.ts             # GET /api/binance/snapshot (cached account+positions)
    live.ts                # ★ Main control endpoints (state/journal/alerts/auto/
                           #    settings/close/edit-tp-sl/bulk-close/alert/
                           #    tracked-rules/dry-run)

  engine/
    trader.ts              # ★★★ Core engine ~1100 lines (port from frontend
                           #     liveTraderEngine.ts). decideEntry, executeAction,
                           #     confirmPending, monitorTrackedPositions (Plan B
                           #     + step trail), reconcileTrackedPositions (SMART
                           #     reconcile + auto-import), bulk close, edit TP/SL.
    state.ts               # ★ Singleton state with consolidateDuplicateImports
                           #   migration. publicState() strips secrets for WS.
    scheduler.ts           # ★ 4 loops + adaptive interval restart
    markPriceStream.ts     # WS subscriber wss://fstream.binance.com/ws/btcusdt@markPrice
    adaptive.ts            # Volume → multiplier 0.5/1.0/2.0
    binance.ts             # REST API wrapper (signed HMAC-SHA256)
    klines.ts              # Multi-TF kline fetcher (server-side)
    indicators.ts          # Stoch/RSI/SMA/Bollinger/etc
    ruleAlerts.ts          # Port from useRuleAlerts.ts (module-level refs)
    hardRules.ts           # Load assets/hard_rules.json with multi-path fallback
    backtester.ts          # In-process backtest runner (for tools)

  assets/
    hard_rules.json        # COPY from frontend (deploy-time sync)
```

---

## 3. Three engines history

App từng có 3 engine song song (3 trigger source khác nhau):

| Engine                | File                              | Trigger                          | Account     | Status (v4.8.19)     |
|-----------------------|-----------------------------------|----------------------------------|-------------|----------------------|
| `useBinanceLive`      | `hooks/useBinanceLive.ts`         | Rule HTF (1h+) + Phase 2 confirm | Binance real| **LOCKED** (server owns) |
| `useAutoTrader`       | `hooks/useAutoTrader.ts`          | Rule fire (any TF)               | Paper $1k   | DEPRECATED           |
| `use5mAllTrader`      | `hooks/use5mAllTrader.ts`         | Mỗi cây 5m close + Stoch         | Paper $1k   | Active (paper only)  |

Server engine (`btc-trader-server/src/engine/trader.ts`) là **port của `useBinanceLive` + thêm tính năng**:
- SMART reconcile + auto-import lệnh manual
- Step trail S50 (15m only, NO TP cap)
- Available USDT gate (avail < marginUsd → BLOCK)
- Equity DD protection
- Daily loss cap → cooldown
- Multi-tier circuit breakers

---

## 4. Server-only lockdown (CRITICAL)

`hooks/useBinanceLive.ts`:
```typescript
const SERVER_OWNS_TRADING = true;  // ← HARD KILL

// Effect 1: rule alerts → entry firing  → blocked if true
// Effect 2: 5m ALL engine inside LIVE   → blocked if true
// Effect 3: Plan B monitor (TP/SL exit) → blocked if true
```

`utils/liveTraderEngine.ts` còn nguyên code nhưng **không bao giờ chạy**. Giữ lại để:
1. Test/backtest tools còn import được
2. Phòng case rollback khẩn cấp

**KHÔNG** xoá frontend engine khi refactor — phải giữ symbol để backtest.

---

## 5. Production trading rules (E-T15-NoTP S50)

### Mode E baseline (rule selection)
- Full TF (5m/15m/1h/4h/1d/1w) **trừ rule `5m:1` baseline disabled**
  - File: `assets/hard_rules.json` → rule `5m:1` có `cfg.disabled = true`
  - Backtest 3y: Mode E NET +937k% (3.2× Mode A baseline)
- Phase 2 LTF confirm cho HTF rules (1h/4h/1d/1w):
  - LONG confirm: Stoch5m K<20 OR price ≤ support15m × 1.004
  - SHORT confirm: Stoch5m K>80 OR price ≥ resistance15m × 0.996
- 5m + 15m rules **skip** Phase 2 → entry MARKET ngay (PA A2)
- Per-rule cooldown 10m sau ENTRY

### Stack gate (PRESET B)
- `maxStackPerSide`: 50 (pre lockdown 15)
- `minDistPct`: 0% (off — let stack)
- `spacingMs`: 0
- `notionalCapUsd`: 200,000

### E-T15-NoTP S50 step trail (15m only — server v0.2.0+)
Áp dụng CHỈ cho `tracked.tfKey === "15m"`:
```
tpDist = |tpPrice − entryPrice|
movedDist = (LONG)  markPrice − entryPrice
            (SHORT) entryPrice − markPrice
currentStep = min(10, floor(movedDist / tpDist / 0.5))

if (currentStep > lastTrailStep && currentStep ≥ 1):
  newSL = entry ± currentStep × 0.5 × tpDist
  pos.slPrice = newSL
  pos.lastTrailStep = currentStep

# Trigger check 15m: ONLY SL exit (NO TP cap, để winner chạy)
```
Backtest 3y: NET +1.4M% (vs E0 fixed +937k%).

HTF (1h/4h/1d/1w) + manual import giữ fixed TP/SL như cũ.

### Available USDT gate (server v0.2.1+)
```
if availableBalance < marginUsd → BLOCK
```
Áp dụng cả `decideEntry` (block hẳn) + `confirmPending` (giữ pending, retry tick sau).

### Circuit breakers
- `dailyLossCapUsd`: triggered → cooldown `cooldownMinutes` (240m default)
- `equityDdPausePct`: equity drop > 30% từ peak → pause `equityDdPauseHours` (4h)
- `pauseReason`: `"daily-cap" | "equity-dd" | null` (UI distinguish)

---

## 6. Plan B monitor (TP/SL self-managed)

Server **KHÔNG** gửi STOP_MARKET / TP_MARKET orders lên Binance. Lý do:
- Hedge mode + multi-stack: Binance gộp 1 net LONG + 1 net SHORT, không thể đặt N STOP riêng
- Tracking N tracked entries với TP/SL độc lập trong app

Cách hoạt động:
1. Entry → `placeMarketOrder` MARKET-only → push vào `trackedPositions[]` với `{tpPrice, slPrice, tfKey, lastTrailStep:0}`
2. Mỗi tick (5s + markPrice WS @1s): `monitorTrackedPositions(state, markPrice)`
   - Loop tracked, check `markPrice >= tpPrice` (LONG TP) / `<= slPrice` (LONG SL) etc
   - Hit → gửi `placeMarketOrder` MARKET reduceOnly với `posSide: LONG/SHORT` (hedge)
   - Log CLOSE + notify + remove from tracked
3. 15m positions: skip TP check, chỉ SL trigger (step trail)

**Hard timeout 72h:** position quá 72h không trigger → auto-drop khỏi monitor (giả định markPrice feed lỗi or app restart mất state). User cần check Binance manual để close.

---

## 7. SMART reconcile + auto-import

`reconcileTrackedPositions(state, binancePositions)`:

App tracked vs Binance position thực tế có thể lệch (manual close, manual open, app restart). Strategy:

```
For each side (LONG, SHORT):
  trackedQty = sum(trackedPositions[side].qty)
  binanceQty = abs(positionAmt[side])
  tolerance  = 0.0005 BTC

  if trackedQty - binanceQty > tol → DROP greedy (oldest first)
  if binanceQty - trackedQty > tol → IMPORT 1 entry với:
    qty = debt
    entryPrice = derived from net avg (deriveManualEntry)
    tpPrice/slPrice = active 5m preset's targetPct/stopPct
    tfKey = "manual"  (skip step trail)
    lastTrailStep = 0
```

**Race window protection:** nếu `lastTrackedMutationMs < 30s` → SKIP import (tránh race với Plan B/entry chưa kịp update Binance state).

**Bug history:**
- v0.1.x: import split N copies cùng entry/TP/SL → 64 dup entries. Fix v0.2: 1 net = 1 entry. Migration `consolidateDuplicateImports` group entries by side+entry rounded $1.

---

## 8. Frontend ↔ Server protocol

### Backend client (`utils/backendApi.ts`)

```typescript
SERVER_URL = "https://tommybtc.duckdns.org"  // hardcoded default
getServerUrl() / setServerUrl()  // override for dev
```

### Auth flow
```
POST /api/auth/login {password: "30318384"} → {token: JWT}
Subsequent: Authorization: Bearer <token>
WS upgrade: connect with ?token=<JWT>
```

Single-user system, password = `30318384` (bcrypt hashed in `/etc/btc-trader/env`).

### Cache architecture (instant tab switch)

`hooks/useBackendLive.ts` uses **module-level singleton**:
```typescript
const _cache = {
  authed, state, scheduler, alerts, journal,
  lastUpdateMs, initialized,
};
let _wsStarted = false;
const _stateSubscribers = new Set<() => void>();
```

Effect: chuyển tab SERVER → instant render từ cache, không re-fetch / re-WS connect. Update qua subscriber pattern.

### WS message types
Server broadcasts:
- `{ type: "state", state: publicState }` — slim state (no secrets, no journal, no openOrders)
- `{ type: "alert", alert: {...} }` — rule fire event
- `{ type: "scheduler", ... }` — adaptive multiplier change

`publicState()` strips: `apiKey`, `apiSecret`, `journal` (count only), `binanceSnapshot.openOrders`, `binanceSnapshot.recentTrades`.

Broadcast throttle: 500ms + dedup via `JSON.stringify` compare.

---

## 9. Deploy pipelines

### Frontend → GitHub Pages

```bash
cd /Users/lap16116/BTC_PC/btc-dashboard
# 1. Bump version (App.tsx APP_VERSION + BUILD_DATE + app.json expo.version)
# 2. Build:
npx expo export -p web
# 3. Deploy:
rm -rf docs/app
cp -r dist docs/app
git add docs/app
git commit -m "deploy: v4.8.x"
git push origin master
```

GitHub Pages auto-serve từ `docs/` folder. URL: `https://tommy31383.github.io/btc-dashboard/app/`

### Server → DigitalOcean

```bash
cd /Users/lap16116/BTC_PC/btc-trader-server
# 1. Bump version (package.json + src/index.ts)
# 2. Build:
npm run build
# 3. Rsync dist + package.json:
rsync -avz --delete dist/ root@159.223.90.60:/opt/btc-trader-server/dist/
scp package.json root@159.223.90.60:/opt/btc-trader-server/package.json
# 4. Restart PM2:
ssh root@159.223.90.60 "pm2 restart btc-trader-server --update-env"
# 5. Verify:
curl https://tommybtc.duckdns.org/  # → {"version":"x.y.z"}
```

PM2 auto-restart on crash (max 16 restarts/min). Logs: `/root/.pm2/logs/btc-trader-server-{out,error}.log`.

### Repo-based data sync (state file backup)

Frontend uses `paper-data` branch on GitHub for non-Pages-rebuild syncing (paper trades, auto account state). NOT used for live server state — server has own SQLite.

---

## 10. VPS infrastructure

```
Provider:    DigitalOcean Singapore (SGP1)
IP:          159.223.90.60
Domain:      tommybtc.duckdns.org (DuckDNS dynamic DNS)
SSH:         ssh root@159.223.90.60 (key auth, no password)
RAM:         2GB (was 1GB, upgraded)
Node:        v22.22.2

Layers:
  Internet → Cloudflare? NO, direct DNS
           → DuckDNS A record → 159.223.90.60
           → nginx :443 (Let's Encrypt cert via certbot, auto-renew)
           → proxy_pass http://127.0.0.1:3000
           → btc-trader-server (Node.js, PM2 cluster mode)
           → SQLite /var/lib/btc-trader/state.db (WAL)
           → Binance Futures REST + WS (HMAC-SHA256 signed)

Files on VPS:
  /opt/btc-trader-server/        # app code (dist/ + package.json + node_modules)
  /etc/btc-trader/env            # secrets (chmod 600 root:root)
                                  # APP_PASSWORD_HASH, JWT_SECRET, BINANCE_API_KEY,
                                  # BINANCE_API_SECRET, PORT=3000, NODE_ENV=production
  /var/lib/btc-trader/state.db   # SQLite persistent state
  /etc/nginx/sites-available/btc # nginx config
  /etc/letsencrypt/              # cert
```

### Common VPS commands
```bash
# Status
ssh root@159.223.90.60 "pm2 list"
ssh root@159.223.90.60 "pm2 show btc-trader-server"

# Logs (snapshot)
ssh root@159.223.90.60 "pm2 logs btc-trader-server --nostream --lines 50 --raw"

# Logs (filtered)
ssh root@159.223.90.60 "pm2 logs btc-trader-server --nostream --lines 500 --raw" \
  | grep -E "ENTRY|CLOSE|SL HIT|TP HIT|ERROR|reconcile"

# Live tail
ssh root@159.223.90.60 "pm2 logs btc-trader-server --raw"  # Ctrl+C to exit

# Restart
ssh root@159.223.90.60 "pm2 restart btc-trader-server --update-env"

# Inspect state DB (read-only)
ssh root@159.223.90.60 "sqlite3 /var/lib/btc-trader/state.db 'SELECT * FROM kv WHERE k=\"live_state\"' | jq ."

# Health check
curl https://tommybtc.duckdns.org/api/health
```

---

## 11. Important gotchas

### Hedge mode requirement
- Binance account MUST be in **Hedge Mode** (LONG + SHORT positions can coexist)
- Engine detects via `/fapi/v1/positionSide/dual` → `s.hedgeMode = true/false`
- All `placeMarketOrder` calls pass `positionSide: LONG/SHORT` (skip if oneway)
- One-way mode WILL break engine (can't have both long+short trackedPositions)

### Leverage frozen
- App **NEVER** calls `setLeverage` (avoid -4161 error: "leverage decrease blocked when position open in isolated margin")
- User must set leverage manually on Binance: `BTCUSDT Futures → close all → change lev`
- App reads current leverage but doesn't enforce — uses whatever Binance reports

### Race conditions
- `lastTrackedMutationMs`: bump on entry/close/edit/import. Reconcile checks `< 30s` → skip import (avoid race with Plan B closing position before reconcile sees it)
- Step trail mutates `slPrice` + `lastTrailStep` but does NOT bump `lastTrackedMutationMs` (avoid false-positive)

### Better-entry mode (REMOVED)
- Backtest tested 4 modes (off/vs-last/vs-best/vs-avg) — ALL hurt performance
- UI removed in v4.8.x. Default OFF for both 5m ALL preset + LIVE settings
- DO NOT re-add without backtest evidence

### `tfKey` default value (backward compat)
- Old tracked positions in DB don't have `tfKey` field → `undefined`
- Step trail check: `if (pos.tfKey === "15m")` → undefined skips → fixed TP/SL (safe)
- Manual import: hardcoded `tfKey: "manual"` → skip trail
- Only NEW entries via `executeAction` get `tfKey: alert.tfKey` (5m/15m/1h/4h/1d/1w)

### Adaptive intervals
- Volume HIGH (>1.5×) → multiplier 0.5 (faster polling, more API calls)
- Volume LOW (<0.5×) → multiplier 2.0 (slower, save quota)
- Switch logs every change → noise in journal. Filter out when reading logs.

### Notional limits
- Binance min notional BTCUSDT: ~$5
- App min: `marginUsd × leverage` (vd $30 × 100 = $3000 ≫ $5 OK)
- Max stack: `notionalCapUsd` per side (default $200k → ~3 BTC at $66k)

---

## 12. Testing & backtesting

### Run backtest tools
```bash
cd /Users/lap16116/BTC_PC/btc-dashboard
npx tsx tools/backtest-live-fulltf-5mall-3y.ts        # Mode A-F sweep
npx tsx tools/backtest-step-trail-no-tp-3y.ts         # E-T15 vs E-T15-NoTP
npx tsx tools/backtest-step-trail-sizes-3y.ts         # S50/S60/S70/S80/S90
```

Output JSON to `assets/backtest_*.json` + HTML report to `assets/backtest_*_report.html`.

### Equity curve convention (BẮT BUỘC)
Every per-rule backtest MUST emit:
- `equityCurve`: array of cumulative NET PnL %, max 100 points (downsample if >100 trades)
- `equityTrend`: `"UP" | "FLAT" | "DOWN"` — slope of last 30% trades
- `maxDrawdownPct`: max DD from peak

`tools/sync-rules-from-backtest.ts` copies these into `assets/hard_rules.json` → rendered as sparkline + UP/DOWN badge in `TradingRulesPanel`.

### Per-rule stats already in `hard_rules.json`
- `avgWinPct` / `avgLossPct` are **already × leverage** (from `leveragedPnlPct`)
- UI renders raw, DO NOT multiply by leverage again

---

## 13. Frontend tab map (v4.8.19)

| Tab     | Component         | Purpose                                            |
|---------|-------------------|----------------------------------------------------|
| RULE    | App.tsx dashboard | Rule list + chart + UnifiedTradesPanel + alert    |
| LIVE    | LiveTab           | LOCKED — banner shows SERVER_OWNS, read-only Bin  |
| 5m ALL  | All5mPanel        | Paper engine, 3 preset switch (PC only)           |
| SERVER  | ServerTab         | Cloud bot control + state view + sync check       |

**SERVER tab features (v0.2.0):**
- Login form (password gate)
- BINANCE POSITIONS card (USDT + BTC format)
- STATUS KPIs: WALLET / AVAIL / uPnL / DAILY / LONG / SHORT
- SYNC CHECK card (inline trong TRACKED): app virtual vs Binance actual, warn on mismatch
- Chart with entry/exit markers, auto-height
- TRACKED list split LONG/SHORT, sortable, with STT + uPnL$ + uPnL% + sizeUSDT + datetime
- Action buttons: AUTO ON/OFF, DRY RUN toggle, edit TP/SL inline, manual close, bulk close (PROFIT/LOSS/OLD/ALL — password gate "30318384")

---

## 14. Common workflows

### Adding a new rule
1. Edit `assets/hard_rules.json` → add `{id, tfKey, side, cfg, stats}`
2. Run `npx tsx tools/backtest-active-3y.ts` to gen stats + equityCurve
3. Run `npx tsx tools/sync-rules-from-backtest.ts` to write back stats
4. Frontend: `useRuleAlerts` auto-picks up new rules
5. Server: copy `assets/hard_rules.json` to `btc-trader-server/src/assets/`, redeploy

### Tweaking a setting
- Frontend: SETTINGS card in SERVER tab → POST `/api/live/settings`
- Server persists via `setState` → SQLite kv

### Investigating a missed entry
1. Check journal: `curl https://tommybtc.duckdns.org/api/live/journal | jq '.entries[-20:]'`
2. Look for BLOCK reasons in last 1h
3. Common BLOCKs: auto OFF / paused / max open / per-rule cooldown / pending duplicate / stack gate / **avail < margin** (v0.2.1+)

### Force-close everything
- UI: SERVER tab → bulk close ALL with password
- API: `POST /api/live/bulk-close {filter: "ALL", password: "30318384"}`
- Manual: SSH + sqlite3 edit (last resort, NOT recommended)

---

## 15. Tommy's preferences (from CLAUDE.md + conversation history)

**Communication:**
- Xưng "em" / "anh Tommy", thẳng thắn, không vòng vo
- Khi chưa rõ → hỏi lại, không tự suy đoán
- Mix Việt-Anh OK, không cần dịch technical terms

**Workflow:**
- KHÔNG tự build APK / web / push prod — chờ "build" command
- Bump version 3 chỗ mỗi lần build (frontend) hoặc 2 chỗ (server)
- Show HTML preview trước khi build UI changes
- Backtest data > intuition. Mọi rule change phải có backtest evidence.
- Hardcode defaults > expose config Tommy không cần vary

**Code style:**
- Comment "anh Tommy v0.x" trước fix → trace history
- Vietnamese comments OK, English code identifiers
- Module-level singletons cho state shared cross-component
- AsyncStorage key prefix `@btc_*` or `@live_*` etc

---

## 16. Recent decision log (last sprint)

- **v4.8.23 (frontend):** 5 PRESETS từ stack-sweep 12-combo backtest 3y
  - EAGLE bỏ luôn (dominated bởi WHALE/TOMI ở mọi stack size)
  - 5 winner: WHALE_MAX(200) / WHALE_MID(100) / TOMI_MAX(200) / **TOMI_MID(100) ★default** / TOMI_MIN(50)
  - Migration legacy keys: AGGRESSIVE→WHALE_MID, BALANCED→TOMI_MID, TURTLE/TOMI→TOMI_MIN
  - TOMI-75 anomaly debunked: DD% 2.0% chỉ là artifact timing (DD peak xảy ra 3 tháng đầu khi capital base $94k)
  - Tools: `backtest-5mall-stack-sweep-3y.ts` + `diag-tomi-stack-dd.ts`
- **v0.2.2 (server):** 3-tier rolling journal (closes mismatch with frontend commit `4b5fa02`)
  - Tier 1 RAM cap 100 entries (trader.logAction slices newest)
  - Tier 2 disk JSONL files `/var/lib/btc-trader/journal/journal-YYYY-MM-DD.jsonl`, keep 7 days, auto cleanup 00:05 UTC
  - Tier 3 client lazy fetch via `/journal/history?date=...` (no cache)
  - 2 new endpoints: `GET /api/live/journal/days`, `GET /api/live/journal/history?date=YYYY-MM-DD`
  - WS broadcast `journal_append` (delta ~150B) + `journal_snapshot` on connect (sync after reconnect)
  - Bandwidth -99.8% per journal write vs full state push
- **v0.2.1:** Available USDT < marginUsd → BLOCK gate (decideEntry + confirmPending)
- **v0.2.0:** E-T15-NoTP S50 step trail (15m only, NO TP cap, 10 steps × 50% TP dist)
  - Backtest 3y: NET +1.4M% (vs E0 +937k%, vs E-T15 fixed +890k%)
- **v0.1.0:** Initial server cloud build, server-only lockdown, SMART reconcile, auto-import
- **v4.8.x frontend:** SERVER tab + module-level cache + sync check card + lockdown banner
- **Mode E adopted:** disable rule `5m:1` baseline → +937k% NET (vs Mode A baseline)
- **Better-entry REMOVED:** 4 modes tested all hurt → UI deleted, default OFF

---

## 17. Quick reference

```
Frontend repo:  github.com/tommy31383/btc-dashboard (public, master)
Server repo:    github.com/tommy31383/btc-trader-server (private, main)
Frontend URL:   tommy31383.github.io/btc-dashboard/app/
Server URL:     https://tommybtc.duckdns.org/
SSH:            ssh root@159.223.90.60
PM2 process:    btc-trader-server (id 0, cluster mode)
SQLite:         /var/lib/btc-trader/state.db (WAL)
Env file:       /etc/btc-trader/env
Symbol:         BTCUSDT only
Mode:           Hedge (LONG + SHORT independent)
Password:       30318384 (single user, both UI gate + bulk-close confirm)

Production rule set: Mode E (disable 5m:1 baseline) + E-T15-NoTP S50 step trail (15m)
Production preset:   B (maxStack 50, dist 0%, spacing 0, cap $200k notional)
Available gate:      avail < marginUsd → BLOCK (v0.2.1+)
Journal tiers:       RAM 100 / disk 7-day JSONL / client lazy per-day (v0.2.2+)
5m ALL presets:      WHALE_MAX/WHALE_MID/TOMI_MAX/TOMI_MID★/TOMI_MIN (v4.8.23+)
```
