# Claude Design Prompts v4 — BTC Dashboard (Material You Warm)

**Reference:** Design Stitch RiskRadar đã duyệt — palette warm amber + Space Grotesk + Inter + Material Symbols Outlined + `border-l-4` accent + `rounded-sm` (sharp 2px).

**Cách dùng:**
1. Mở `stitch.withgoogle.com` (hoặc `claude.ai/design`)
2. Copy từng prompt dưới, paste vào chat
3. Screenshot/export HTML mỗi màn → gửi Claude Code để mirror 1:1 sang React Native

---

## 🎨 SHARED DESIGN TOKENS (dùng chung 5 prompt)

```
PALETTE — Material You warm, dark:
  surface-container-lowest: #0e0e0e
  background / surface:     #131313
  surface-container-low:    #1c1b1b (card bg)
  surface-container:        #201f1f
  surface-container-high:   #2a2a2a (table header)
  surface-container-highest: #353534 (pills)
  primary:                  #ffb874 (warm peach)
  primary-container:        #f7931a (Bitcoin orange · accent bar)
  on-surface:               #e5e2e1
  on-surface-variant:       #dbc2ae (warm beige — labels)
  outline:                  #a38d7b
  outline-variant:          #554335
  error:                    #ffb4ab (soft coral)
  emerald-500:              #10b981 (safe / pass)
  zinc-500/600:             #71717a / #52525b (muted)

TYPOGRAPHY:
  Headline & labels: Space Grotesk 300–700
  Body:              Inter 400–700
  Icons:             Material Symbols Outlined (FILL 0–1, wght 400)
  UPPERCASE + tracking-[0.2em] for micro labels
  font-mono-style class = Space Grotesk (mono feel but prettier)

RADIUS:
  rounded-sm = 2px (default for cards, pills, table)
  rounded-full = 12px (max — rarely used)
  NO large rounded corners. Sharp edges are signature.

SIGNATURE PATTERNS:
  - border-l-4 colored accent bar on every card (primary-container / error / primary / emerald-500/60 / outline-variant/30)
  - Cards: bg-surface-container-low + p-4/5 + border-l-4 + rounded-sm
  - Pills: bg-surface-container-highest + px-2 py-1 + rounded-sm + text-[10px] font-mono-style
  - Sticky TopAppBar h-16 bg #1C1B1B (back | centered TITLE orange | settings)
  - Fixed BottomNavBar h-16 bg #1C1B1B border-t + 4 tabs (RADAR · TRADES · ASSETS · PROFILE) Material Symbols
  - Emoji inline ONLY for section titles (💎 🔍 📡 🔥 ⚠️ 📊)
  - Everything else uses Material Symbols Outlined

FRAME: 390px × 884px (iPhone 14 Pro). Scrollable main content. Sticky top + fixed bottom nav.
```

---

## 🎯 PROMPT 1 — DASHBOARD MAIN SCREEN (overview)

```
Design a full "DASHBOARD" mobile screen for a BTC crypto trading app (Vietnamese locale),
390px wide, 884px tall, dark mode, in Material You warm aesthetic.

APPLY SHARED DESIGN TOKENS (Material You warm, Space Grotesk + Inter, Material Symbols,
border-l-4 accents, rounded-sm 2px).

Top-to-bottom layout:

1. STICKY TOP APP BAR (h-16, bg #1C1B1B):
   Left: menu icon (material: menu) · app name "₿ BTC DASHBOARD" (Space Grotesk bold,
         tracking-tight, primary-container orange #f7931a, uppercase)
   Right: notifications_active badge (red dot) · settings icon

2. PRICE HERO CARD (bg surface-container-low, border-l-4 primary-container, p-5):
   - Top row: Bitcoin coin icon (32px, gradient orange→amber) + "BTC / USDT"
              (Space Grotesk 16px bold) + live badge (emerald dot pulse + "LIVE" uppercase
              tracking-widest 10px)
   - Main row: price "95,328.50" Space Grotesk 36px bold tracking-tighter +
              small change pill "▲ +2.14% · +$1,998" (emerald bg 12% alpha, rounded-sm,
              font-mono-style 12px)
   - Right: 90x44 sparkline SVG (emerald line + area fill)
   - Bottom 3-col grid (divide by outline-variant/20 hairline):
       24H HIGH · 96,100     |  24H LOW · 93,200   |  24H VOL · 18.2K
       (labels: Space Grotesk 10px on-surface-variant uppercase)
       (values: font-mono-style 14px on-surface)

3. RULE FIRING BANNER (bg gradient primary-container/8→error/4, border primary-container/25, p-0):
   Header strip (p-3, divider below): "🔥 RULE FIRING NOW" (Space Grotesk 12px primary-container
   uppercase tracking-wider) + badge "2 SIGNALS" (bg primary-container/18, primary-container text)
   Body (p-3, stack of signal rows):
   - Signal row (bg surface-container-high, border-l-4 error, rounded-sm, p-3):
     [SHORT tag bg error/15 px-2.5] · "Top Reversal" + [1H pill outline-variant] ·
     meta "RSI 73.8 · MACD ↓ · 3/3 ✓" · right: "74%" font-mono-style 15px bold error +
     "WIN RATE" 9px on-surface-variant
   - Signal row (border-l-4 emerald):
     [LONG tag bg emerald/15] · "Bounce Oversold" + [15M pill] · "RSI 29.4 · StochK ↑ · 3/3 ✓" ·
     "68%" emerald

4. CRITICAL ALERTS CARD (bg surface-container-low, border-l-4 error, p-4):
   Header: warning icon + "Critical Alerts" Space Grotesk 12px bold + right counter pill
           "2" bg error/15 error text rounded-full px-2
   List (each row bg surface-container, p-3, rounded-sm, mb-2):
     - Material icon "trending_up" error · "RSI 4H quá mua" Inter 12px bold ·
       detail below 11px on-surface-variant "RSI = 78.2 · vượt ngưỡng 75"
     - Material icon "trending_down" · "Phân kỳ bearish 1H" · "Price HH · RSI LH · tín hiệu đảo chiều"

5. LIVE INDICATORS SECTION:
   Section title (outside card): "📡 LIVE INDICATORS" Space Grotesk 13px bold uppercase +
   right: "TIMEFRAME 1H" on-surface-variant 10px font-mono-style
   Card (bg surface-container-low, p-4):
   3x2 grid gap-2 of FS cells (each bg surface-container, rounded-sm, p-3, border-l-2
   colored):
     RSI · 68.4 · "Strong bull" (emerald accent, up arrow circle emerald/15)
     MACD H · +12.3 · "Momentum up" (emerald)
     ATR% · 0.82% · "Normal vol" (primary warm)
     EMA Δ · +1.2% · "Above EMA50" (emerald)
     HTF 4H · "UP TREND" · "Aligned" (emerald)
     HTF 1D · "UP TREND" · "Aligned" (emerald)

6. LIVE RULES SUMMARY CARD (bg surface-container-low, p-4):
   Header "Rules Summary" + "18 tracked" on-surface-variant
   5-col stat grid (gap-px bg outline-variant/10 rounded-sm):
     FIRED · 2 (error)  | ARMED · 4 (primary)  | HTF BLK · 6 (outline)
     FEAT BLK · 3 (outline)  | OFF · 3 (on-surface-variant fade)
   Each cell bg surface-container-high, p-3, border-l-2 when active
   WAITING ON box below (bg primary-container/6, border-l-2 primary-container, p-3):
     "WAITING ON" Space Grotesk 10px primary-container uppercase
     "· 4 rules waiting HTF 4H = UP" (bold HTF tag primary-container)
     "· 3 rules waiting RSI < 32"
     "· 2 rules waiting ATR < 0.5%"

7. FOOTER (p-4, centered, on-surface-variant text):
   "Updated 10:42:18 · Auto 30s" (font-mono-style)
   "Data: Binance · Pull to refresh"
   Version pill: "v4.3.20 · Build 2026-04-21" bg surface-container rounded-full

8. FIXED BOTTOM NAV BAR (h-16, bg #1C1B1B, border-t #353534):
   Active tab RADAR (primary-container orange + top border): icon "radar" + label
   Inactive: TRADES (swap_vert), ASSETS (account_balance_wallet), PROFILE (person)
   All labels Inter 10px medium uppercase tracking-[0.05em]

Realistic BTC data. Tight monospace numbers. Material Symbols everywhere except section emojis.
```

---

## 🎯 PROMPT 2 — SIGNAL CLUSTER (Price hero + Rule Firing + Alerts)

```
Design 3 stacked cards that form the TOP of a BTC trading dashboard mobile screen, 390px wide,
dark Material You warm theme.

APPLY SHARED DESIGN TOKENS.

CARD A — PRICE HERO:
- Dimensions: full width, p-5, bg surface-container-low, border-l-4 primary-container rounded-sm
- Top row flex-between:
  * Left: circular 32px Bitcoin logo (gradient #f7931a→#fdb94a) + column {
      "BTC/USDT" Space Grotesk 15px bold · "/USDT" dim
    }
  * Right: "LIVE" pill (emerald/12 bg, emerald text, 5px emerald dot pulse, rounded-full px-2.5)
- Main row flex items-end justify-between mt-3:
  * Left column:
    - Price "95,328.50" Space Grotesk 34px bold, leading-none, tracking-[-1px]
    - Change pill mt-2 inline-flex (emerald/12, rounded-sm, px-2.5 py-1):
        "▲ +2.14%  ·  +$1,998" font-mono-style 12px
  * Right: SVG sparkline 90x44 (emerald polyline stroke 2.2 + linear-gradient area 18% alpha)
- Stats grid mt-4: 3 columns, 1px divider between (outline-variant/20 bg), rounded-sm overflow:
    24H HIGH · 96,100      24H LOW · 93,200      24H VOL · 18.2K
  Labels: 10px Space Grotesk on-surface-variant uppercase tracking-[0.3em]
  Values: font-mono-style 13px on-surface bold

CARD B — RULE FIRING (HERO):
- bg: linear-gradient 135deg from primary-container/10 to error/5
- border primary-container/25, rounded-sm, shadow inner top highlight
- Header strip (p-3 px-4, border-b divider):
  * Left flex gap-2: material-symbols "local_fire_department" primary-container 14px (with
    drop-shadow glow) + "Rule Firing Now" Space Grotesk 12px bold primary-container
    uppercase tracking-wider
  * Right pill: "2 signals" bg primary-container/18 primary-container rounded-full px-2.5
- Body (p-3):
  * Signal row 1 (bg surface-container-high, border surface-container-highest,
    border-l-4 error, rounded-sm, p-3 mb-2, flex gap-3):
      [SHORT side tag] — bg error/15 error text Space Grotesk 11px extrabold tracking-wider,
        rounded-sm, min-w-[56px] px-2.5 py-1 text-center
      [Info column flex-1]:
        - Title row: "Top Reversal" Inter 12px semibold + small pill [1H] bg
          surface-container-highest on-surface-variant 9px uppercase
        - Meta row (flex gap-2.5 on-surface-variant 11px):
            "RSI <span mono>73.8</span>" · "MACD ↓" · "3/3 ✓"
      [WR column right]:
        "74%" font-mono-style 15px bold error · "WIN RATE" 9px on-surface-variant
        uppercase tracking-wider
  * Signal row 2 (same pattern, border-l-4 emerald-500, LONG green tag, "Bounce Oversold",
    68% emerald)

CARD C — CRITICAL ALERTS:
- bg surface-container-low, border-l-4 error rounded-sm p-4
- Header flex items-center gap-2 mb-3:
  material "warning" error 16px + "Critical Alerts" Space Grotesk 12px bold on-surface +
  ml-auto counter pill "2" bg error/15 error Space Grotesk 10px bold rounded-full px-2
- Alert items (each bg surface-container, rounded-sm, p-3, mb-1.5):
  * Icon row: material "trending_up" error (for overbought) · "RSI 4H quá mua" Inter 12px semibold
  * Detail row (pl-6 on-surface-variant 11px): "RSI = <mono>78.2</mono> · vượt ngưỡng <mono>75</mono>"
  * Second alert: material "swap_vert" + "Phân kỳ bearish 1H" · "Price HH · RSI LH · tín hiệu đảo chiều"

Show this cluster as top of a scrollable screen (hint: fade bottom).
Show it in TWO states: A) active with firing; B) quiet (no firing, only 1 low-priority alert).
```

---

## 🎯 PROMPT 3 — RULE TRACKER + OVERALL VERDICT (middle cluster)

```
Design a Rule Tracker panel + OverallVerdict card for BTC trading app, 390px wide,
Material You warm dark.

APPLY SHARED DESIGN TOKENS.

SECTION A — RULE TRACKER:
- Section header (outside card): "Active Rules" Space Grotesk 14px bold + right
  "18 rules" on-surface-variant 11px font-mono-style
- Timeframe tab strip (bg surface pill-container p-1 rounded-sm flex, gap 2):
  7 tabs: 5M · 15M · 1H · 4H · 1D · 1W · 1MO
  Each tab: flex-1 py-2 text-center Space Grotesk 11px semibold font-mono-style
  Active = bg primary-container (#f7931a) text-[#0b0e11] extrabold
  Inactive = on-surface-variant
- Rule cards stack (each bg surface-container-low border border-outline-variant/20
  rounded-sm p-3 mb-2, border-l-4 colored):
  * Rule 1 (FIRING — border-l-4 error):
    Row 1 flex-between:
      Left flex gap-2: "#1" font-mono-style 11px on-surface-variant · "Short Top Reversal"
        Inter 13px semibold · pill "FIRING" bg error/12 error border error/25 extrabold
        rounded-sm px-2 py-0.5 text-[10px] uppercase
      Right: "74%" font-mono-style 13px extrabold primary-container
    Row 2 flex-wrap gap-1.5:
      chips (font-mono-style 10px medium px-2 py-0.5 rounded-sm, bg surface-container-high,
      on-surface-variant border outline-variant/20):
        "RSI > 73" emerald-tinted (passed)
        "MACD ↓" emerald-tinted
        "ATR 1.2%" emerald-tinted
        "HTF 4H ✓" on-surface-variant
  * Rule 2 (border-l-4 emerald-500):
    "#2 · Long Bounce Oversold · 68%"
    chips: "RSI < 32" emerald · "StochK < 5" emerald · "EMA50 +0.8%" muted grey
  * Rule 3 (border-l-4 outline-variant/30):
    "#3 · Trend Continuation · 61%"
    chips: "RSI 55" muted · "MACD H+" emerald · "HTF 1D ?" muted

SECTION B — OVERALL VERDICT CARD (main content card, bg surface-container-low border-l-4
primary-container p-5 rounded-sm mt-6):
- Top TF chip row (horizontal scroll): label "KHUNG PHÂN TÍCH" on-surface-variant 10px
  uppercase tracking-[0.2em] · below 7 chips (bg surface-container rounded-sm px-3 py-1.5
  font-mono-style 11px), active = primary-container/25 bg + primary-container text + border
- Big verdict block (centered, py-4 my-2):
    Icon "sentiment_neutral" material 36px primary (warm amber)
    "TRUNG TÍNH" Space Grotesk 20px extrabold tracking-[2px] primary
- Conclusion box (bg primary/8, border border-primary/25, rounded-sm p-3 mb-3):
    small label "💡 KẾT LUẬN" Space Grotesk 10px bold primary uppercase
    "Backtest 1D cho edge -34.2% → KHÔNG nên vào lệnh. Chờ tín hiệu rõ hơn."
    (Inter 11px on-surface text-center leading-relaxed)
- Trust box (bg error/6 border-l-2 error p-3 mb-3):
    header: material "info" error + "TIN CẬY THẤP" Space Grotesk 11px bold error uppercase
    row: "WR 0%  ·  N=0  ·  Edge −34.2%" font-mono-style 12px error
    hint italic on-surface-variant 9px "WR = tỉ lệ thắng · N = số lần · Edge = lãi/lỗ trung bình"
    footer 8px "Backtest 1W · TP 6% / SL 3% · fallback 1D"
- LÝ DO box (bg surface-container, border-l-2 outline-variant, p-3 mb-3):
    "LÝ DO" Space Grotesk 10px on-surface-variant uppercase tracking-[0.2em]
    ul bullet list (on-surface 11px, each with italic hint muted below):
      • Khung phân tích: 1W (HTF: 1M+1M)
      • Multi-TF Score LONG = 28/123
      • Phân Kỳ Giảm: 1MO
      • HTF trend — 1M:UP · 1M:UP
- 8 COUNTER BADGES grid (2 rows x 4 cols, gap-1.5):
    Each badge: bg surface-container-high border-l-2 colored rounded-sm p-2 text-center
    Active (count > 0): border-l error/primary/emerald + value color
    Row 1: [0/7 RSI QM] [0/7 RSI QB] [1/7 Stoch QM · error] [2/7 Stoch QB · emerald]
    Row 2: [0/7 PK Tăng] [1/7 PK Giảm · error] [0/6 Kề QM] [0/6 Kề QB]
    Value Space Grotesk 16px bold + label 8px uppercase on-surface-variant
    Below grid: italic 9px legend "QM=Quá Mua · QB=Quá Bán · PK=Phân Kỳ · Kề=2 khung kề nhau"
- 📝 TÓM TẮT box (bg emerald/6, border-l-2 emerald, p-3):
    "📝 TÓM TẮT" 10px bold emerald uppercase
    Line green: "✅ Tín hiệu LONG: 2 khung Stoch quá bán"
    Line red:   "⚠️ Tín hiệu SHORT: 1 khung Stoch quá mua · 1 khung phân kỳ giảm"

Show TWO states: A) Neutral (amber, as above) · B) PREFER LONG (all green trust box "WR 64% · N=47 · Edge +12.3%").
Realistic tight mobile layout.
```

---

## 🎯 PROMPT 4 — CHART + MULTI-TF TABLE + ALERT LOG

```
Design a candlestick chart card + multi-timeframe scan table + alert history log for a BTC
mobile app, 390px wide, dark Material You warm.

APPLY SHARED DESIGN TOKENS.

CARD A — CHART:
- bg surface-container-low, p-0 rounded-sm, border-l-4 primary-container
- Chart bar (p-3, border-b outline-variant/20 flex-between):
  * Left: coin icon 22px + "BTC/USDT" Inter 13px bold + "·" + "95,328.50" font-mono-style emerald
  * Right flex gap-1.5: tool buttons 28x28 (material icons: "add", "remove", "fullscreen")
- Timeframe tabs row (same pill-container as Prompt 3, active 1H)
- Main candle chart (h-240, relative):
    Dark bg + grid lines (48px vertical / 56px horizontal hairline, outline-variant/15)
    30 candlesticks: emerald bull, error red bear, wick 1px
    Overlays:
      EMA9 (blue #3c7aea line 1.5px)
      EMA21 (purple #8b62ff line 1.5px)
      EMA50 (primary-container orange 1.5px)
      Bollinger Band: gray translucent ribbon upper/middle/lower
      Support line: dashed primary (warm amber) "S1 · 88,200" label right
      Resistance line: dashed primary "R1 · 94,500"
    Right side price axis: 6 ticks font-mono-style 9px on-surface-variant
    Bottom time axis: "12:00, 16:00, 20:00, 00:00"
- Indicator toggle chip row below chart (flex-wrap gap-1.5 p-3):
    chips 10px font-mono-style uppercase rounded-sm px-2 py-1
    active = primary-container/25 bg + colored text + border primary-container/40
    list: [EMA9 blue] [EMA21 purple] [EMA50 orange] [BB gray] [SR amber] [RSI] [Stoch] [MACD]
- RSI subpanel (h-90 p-2 border-t outline-variant/20):
    line chart 0-100 primary-container color, badge top-right "RSI 58.3" font-mono-style,
    dashed lines at 30 (emerald) and 70 (error)
- StochRSI subpanel: K line primary + D line outline, bands at 20/80
- MACD subpanel: histogram bars emerald/error + MACD line white + signal amber

CARD B — MULTI-TF SCAN TABLE:
- Section header "📊 MULTI-TF SCAN" Space Grotesk 13px bold uppercase
- Card bg surface-container-low, rounded-sm, border-l-4 primary-container, p-0 overflow-hidden:
  Table header (bg surface-container-high p-3 divide-x border-b outline-variant/20):
    Cols: TF(50px) · RSI · StochK · STATE(90px) · caret(32px)
    labels Space Grotesk 10px on-surface-variant uppercase tracking-[0.3em]
  Table rows (bg surface-container-low p-3 border-b outline-variant/10, grid 5 cols same widths):
    Row TF cell: font-mono-style 12px bold primary-container
    Cells: font-mono-style 12px center
    STATE cell: pill (bg colored/12 colored text Inter 10px bold rounded-full px-2 py-0.5)
    Rows:
      5M · 52.3 · 48.2 · [NEUTRAL outline-variant] · ›
      15M · 72.1 primary · 95.3 error · [🔥 HOT primary/15] · ›
      1H · 68.4 · 82.1 · [BULL emerald/12] · ›
      4H · 62.0 · 71.5 · [BULL emerald] · ›
      1D · 58.3 · 62.0 · [BULL emerald] · ›
      1W · 55.1 · 58.4 · [NEUTRAL] · ›
      1MO · 49.8 · 51.2 · [NEUTRAL] · ›

CARD C — ALERT HISTORY LOG:
- Section header "🕐 HISTORY" + right count pill "24 alerts" outline-variant/20
- Card bg surface-container-low rounded-sm, border-l-4 outline-variant/30, p-0 overflow-hidden:
  Log rows (flex items-center gap-3 p-3 border-b outline-variant/10):
    [Material icon 16px colored] [message Inter 12px on-surface-variant flex-1]
    [timestamp font-mono-style 10px on-surface-variant tracking-wider]
  Rows:
    - "warning" error · "RSI 4H quá mua (78.2)" · 10:42:18
    - "water_drop" primary-container · "StochRSI 15M quá bán" · 10:35:02
    - "trending_up" emerald · "Phân kỳ bullish 1H" · 10:12:55
    - "emergency" error · "2 khung kề nhau quá mua" · 09:58:31
    - "schedule" outline-variant · "30s auto-refresh" · 09:55:00
    - "check_circle" emerald · "Rule #7 tracking enabled" · 09:42:18

Show all three cards stacked (scrollable). Tight monospace numbers throughout.
```

---

## 🎯 PROMPT 5 — SETTINGS PANEL + TOP APP BAR + BOTTOM NAV

```
Design a Settings panel + Top App Bar + Bottom Nav Bar components for BTC crypto app,
390px wide, Material You warm dark.

APPLY SHARED DESIGN TOKENS.

COMPONENT A — TOP APP BAR (sticky h-16 bg #1C1B1B):
- Left (flex gap-3 active:opacity-80):
    material icon "menu" · text "DASHBOARD" Space Grotesk 14px bold primary-container uppercase
    tracking-tight
- Center: title bold: "SETTINGS" primary-container Space Grotesk 18px tracking-tighter
- Right: material icon "more_vert"
- Bottom border: outline-variant/20 hairline

COMPONENT B — SETTINGS PANEL (main content):

Section 1: "🔔 NOTIFICATIONS" Space Grotesk 11px bold primary-container uppercase
           tracking-[0.2em] mb-3 mt-4
  Card (bg surface-container-low rounded-sm border-l-4 primary-container p-4 divide-y divide-outline-variant/20):
    Each toggle row (flex justify-between items-center py-3):
      Left column:
        - Material icon 20px on-surface-variant
        - title Inter 13px semibold on-surface
        - desc Inter 11px on-surface-variant mt-0.5
      Right: Material You switch (42x24 track rounded-full + 18px thumb, primary-container
             when ON, outline when OFF)
    Rows:
      [vibration] Rung khi cảnh báo · "Rung điện thoại khi có alert mới" · ON
      [trending_up] RSI Overbought · "Cảnh báo khi RSI > ngưỡng" · ON
      [trending_down] RSI Oversold · "Cảnh báo khi RSI < ngưỡng" · ON
      [swap_vert] Divergence · "Phân kỳ giá vs RSI" · OFF
      [stack_star] Multi-TF · "≥2 khung cùng quá mua/bán" · ON

Section 2: "📨 PUSH NOTIFICATIONS" Space Grotesk 11px primary-container uppercase:
  Card (same pattern):
    [notifications_active] Tín hiệu vào lệnh · "Push khi LONG/SHORT mới" · ON
    [flag] Kết quả tín hiệu · "Push khi WIN/LOSS/EXPIRE" · ON

  Input cluster (flex gap-3 mt-4):
    Input group:
      label Space Grotesk 10px on-surface-variant uppercase tracking-widest "MIN SCORE (1-5)"
      input bg surface + border outline-variant rounded-sm p-2.5 text-center
        font-mono-style 14px bold value "3"
    Input group:
      label "CURRENT FILTER"
      static div "Alert ≥ 3/5" font-mono-style primary-container 14px center

Section 3: "📊 RSI THRESHOLDS" primary-container uppercase:
  Card (p-4):
    2 input groups flex gap-3:
      OVERBOUGHT (50-100) · input value 75
      OVERSOLD (1-50) · input value 25
    Slider preview below: horizontal bar 0-100 with markers at 25 and 75

Section 4: "🔗 DATA SOURCE" uppercase:
  Card (p-4, rows flex-between py-2):
    - "Exchange" · pill "Binance" bg primary-container/12 primary-container rounded-full px-3
    - "Refresh" · pill "30 seconds"
    - "Websocket" · pill "Connected" emerald + green dot pulse

Section 5: "ℹ️ APP INFO":
  Card:
    - Version: v4.3.20
    - Build: 2026-04-21
    - Footer buttons flex gap-2: [View Source] [Export Logs] (outlined buttons
      border-outline-variant rounded-sm p-2 Space Grotesk 11px uppercase)

COMPONENT C — BOTTOM NAV BAR (fixed bottom h-16 bg #1C1B1B border-t #353534 shadow-t):
- 4 tabs, flex justify-around:
    Each tab flex-col items-center active:scale-95 pt-2 pb-1:
      Material icon (24px) · label Inter 10px medium uppercase tracking-[0.05em]
    Tab 1 ACTIVE: "radar" primary-container + top border-t-2 primary-container + "RADAR" label
    Tab 2: "swap_vert" zinc-500 · "TRADES"
    Tab 3: "account_balance_wallet" · "ASSETS"
    Tab 4: "person" · "PROFILE"

Show full settings screen: TopAppBar on top + scrollable settings content + BottomNav
fixed bottom. Use realistic labels + data. Tight monospace numbers in inputs.
```

---

## 📋 WORKFLOW

| Step | Action |
|------|--------|
| 1 | Paste **Prompt 1** (Dashboard Main overview) vào Stitch trước — để có structure chính |
| 2 | Refine theo thứ tự **Prompt 2 → 3 → 4 → 5** (cluster từng cụm) |
| 3 | Screenshot mỗi màn sau khi tinh chỉnh · HOẶC Export HTML |
| 4 | Lưu vào `assets/claude_design_ref/` (tạo folder nếu chưa có) |
| 5 | Em code RN component mirror đúng visual (giữ logic/data cũ, chỉ đổi style) |

**Ưu tiên thứ tự apply vào code:**
1. **Prompt 2** (Signal cluster) — impact cao nhất, user nhìn đầu tiên
2. **Prompt 3** (Rule Tracker + Verdict) — logic trading chính
3. **Prompt 4** (Chart + Table + Log)
4. **Prompt 5** (Settings + TopAppBar + BottomNav)
5. **Prompt 1** dùng để verify overall
