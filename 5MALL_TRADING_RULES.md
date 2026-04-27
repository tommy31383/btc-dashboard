# 5m ALL TRADING ENGINE — Rule & Preset

**Version:** v1.0 (last updated 2026-04-27)
**Engine:** `utils/all5mAccount.ts` + `hooks/use5mAllTrader.ts`
**Backtest:** `tools/backtest-5mall-3y.ts` + `tools/sweep-5mall-improve.ts`
**Account:** Paper $1000 (local AsyncStorage `@all5m_data_v1`, KHÔNG sync git)

---

## 🔑 ENGINE CƠ BẢN

### Trigger (mỗi cây 5m close):

1. **Stoch5m K < 10** → LONG (`stoch_long`)
2. **Stoch5m K > 90** → SHORT (`stoch_short`)
3. **Fallback S/R 15m** (nếu stoch không trigger):
   - `close ≤ support15m × (1 + 0.3%)` → LONG (`sr_long`)
   - `close ≥ resistance15m × (1 - 0.3%)` → SHORT (`sr_short`)

### Hedge mode + Plan B (giống LIVE engine):

- LONG và SHORT là **2 stack độc lập**, có thể coexist
- Mỗi entry có TP/SL riêng (Plan B monitor mỗi cây 5m → first hit TP/SL → close)
- Stack max tunable per side
- Distance gate giữa các entry cùng side
- Cooldown all-side sau mỗi trade
- Margin $30 × leverage 100x = notional $3000, fee 0.05%

### Block gates (theo thứ tự):

1. **Cooldown** (default 10m all-side sau trade gần nhất)
2. **Stack full** (≥ stackMax cùng side)
3. **Spacing** (min phút giữa 2 entry cùng side)
4. **Distance** (entry mới phải xa entry gần nhất cùng side ≥ N%)

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

### Apply preset programmatically (utils/all5mAccount.ts):

```typescript
// SAFE
{ stackMaxPerSide: 15, stackMinEntryDistPct: 0.3, tpPct: 5, slPct: 2.5 }

// BALANCED
{ stackMaxPerSide: 30, stackMinEntryDistPct: 0.2, tpPct: 4, slPct: 2 }

// AGGRESSIVE (= LIVE PRESET B)
{ stackMaxPerSide: 50, stackMinEntryDistPct: 0, tpPct: 4, slPct: 2 }
```

---

## 📝 CHANGELOG

- **v1.0** (2026-04-27): Initial doc với 3 preset SAFE/BALANCED/AGGRESSIVE từ 11-variant sweep
