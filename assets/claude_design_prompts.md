# Claude Design Prompts — BTC Dashboard (v4.3.18)

**Cách dùng:**
1. Mở https://claude.ai/design
2. Copy prompt bên dưới, paste vào chat
3. Chỉnh sliders/colors/layout trên canvas bên phải
4. Screenshot kết quả → gửi Claude Code em code lại RN component

**Design tokens cố định (dùng cho tất cả prompts):**
```
Background: #0a0a1a (deep navy)
Card: #0d1117 (dark slate)
Bitcoin accent: #f7931a (orange)
Bull green: #2ed573
Bear red: #ff4757
Warning amber: #ffa502
Text: #ffffff
Text dim: #aaaaaa
Text muted: #666666
Font: monospace (SF Mono / JetBrains Mono)
Mobile frame: 390px wide (iPhone 14 Pro)
Border radius: 12px cards, 8px small, 6px chips
```

---

## 🎯 PROMPT 1 — OverallVerdict Card (màn chính)

```
Design a dark-mode BTC crypto trading verdict card for a React Native mobile app, 390px wide.

Color tokens:
- Background: #0a0a1a · Card: #0d1117
- Accent orange (Bitcoin): #f7931a
- Bull green: #2ed573 · Bear red: #ff4757 · Warning amber: #ffa502
- Text: #ffffff · Dim: #aaaaaa · Muted: #666666
Font: monospace throughout. Card padding 16px, border-radius 12px.

Layout top-to-bottom inside ONE card:

1. TIMEFRAME TABS row (horizontal scroll):
   Label "KHUNG PHÂN TÍCH" (tiny muted, letter-spaced), below it 7 chips:
   5m · 15m · 1h · 4h · 1d · 1w · 1M
   Active chip = orange background #f7931a25, orange border, orange text.
   Inactive = translucent white #ffffff08 bg, dim text.

2. BIG VERDICT DISPLAY (centered):
   Large 36px icon (⏸️ pause emoji)
   Big text "TRUNG TÍNH" — 18px, weight 900, letterSpacing 2, amber color.

3. 💡 KẾT LUẬN BOX (tinted rounded box):
   Small label "💡 KẾT LUẬN" (10px, weight 900) in yellow/red/green
   One-sentence analysis below (11px, centered, line-height 16):
   "Backtest 1D cho edge -34.2% (âm) → KHÔNG nên vào lệnh. Chờ tín hiệu rõ hơn."
   Border tinted red rgba(255,71,87,0.4), background rgba(255,71,87,0.08)

4. 📊 TRUST BOX (red tinted):
   Header "📊 TIN CẬY THẤP" (red, 11px 900 letter-spaced)
   Big stats row "WR 0%  ·  N=0  ·  Edge -34.2%" (12px red)
   Italic hint below (8px muted):
     "WR = tỉ lệ thắng · N = số lần xuất hiện · Edge = lãi/lỗ trung bình mỗi lệnh"
   Footer note (8px muted):
     "Backtest 1W · TP 6% / SL 3% / 30 bars · Cần WR ≥ 34.2% mới hoà vốn
      (fallback sang 1d — TF 1w chưa đủ mẫu)"

5. LÝ DO BOX (subtle left border):
   Title "LÝ DO:" (9px muted letter-spaced)
   Bullet list with italic hint under each:
   • Khung phân tích: 1W (HTF: 1M+1M)
       (khung bạn đang xem, kèm 2 khung lớn hơn để đối chiếu)
   • Multi-TF Score LONG = 28/123
       (≥60: mua mạnh · 30-60: trung bình · <30: yếu)
   • Phân Kỳ Giảm: 1MO
       (momentum yếu dần — cảnh giác pullback)
   • HTF trend — 1M:UP · 1M:UP
       (UP/DOWN = trend rõ · FLAT = không trend)

6. 8 COUNTER BADGES (2 rows × 4 cols grid, gap 6px):
   Row 1: [0/7 RSI QM] [0/7 RSI QB] [1/7 Stoch QM (red border)] [2/7 Stoch QB (green border)]
   Row 2: [0/7 PK Tăng] [1/7 PK Giảm (red)] [0/6 Kề QM] [0/6 Kề QB]
   Active badge = colored tint bg + colored border + colored text
   Above the grid: tiny italic legend "QM=Quá Mua · QB=Quá Bán · PK=Phân Kỳ · Kề=2 khung kề nhau cùng cực trị"

7. 📝 TÓM TẮT BOX (bottom, tinted by dominant sentiment):
   Label "📝 TÓM TẮT" (10px weight 900)
   Line 1 (green): "✅ Tín hiệu LONG: 2 khung Stoch quá bán"
   Line 2 (red): "⚠️ Tín hiệu SHORT / cảnh báo: 1 khung Stoch quá mua · 1 khung phân kỳ giảm"

Show TWO states side by side:
A) TRUNG TÍNH (as above, amber accent)
B) ƯU TIÊN LONG (green conclusion, green trust box showing "TIN CẬY CAO · WR 64% · N=47 · Edge +12.3%")

Use subtle dividers, tight spacing. No emojis in body text except the ones mentioned.
```

---

## 🎯 PROMPT 2 — RiskRadar Screen (tab Risk Radar)

```
Design a full-screen "RISK RADAR" dashboard for a BTC crypto mobile app. 390px wide.

Color tokens (same as above):
Background: #0a0a1a · Card: #0d1117
Bitcoin orange: #f7931a · Bull green: #2ed573 · Bear red: #ff4757 · Warning amber: #ffa502
Text #ffffff · Dim #aaaaaa · Muted #666666
Font: monospace. Cards 12px radius, 14px padding.

Top-to-bottom layout:

1. HEADER BAR:
   Left: back button "← Dashboard" (chip style, muted)
   Center: title "🎯 RISK RADAR" (orange, 18px, weight 900, letterSpacing 2)
   Subtitle below (muted 11px centered): "Lesson learn từ 20K entry scan (2.7 năm)"

2. MARKET SCORE CARD (big, bordered):
   Verdict text centered "ƯU TIÊN LONG" (16px weight 900 letter-spaced, green)
   Two columns side by side:
   - LONG SAFETY: stars ★★★★★ 4/5 (orange stars, muted unfilled)
   - SHORT SAFETY: stars ★★★☆☆ 2/3

3. 💎 CƠ HỘI VÀNG SECTION:
   Section title "💎 CƠ HỘI VÀNG" (orange 13px 900)
   Subtitle (muted 10px): "Rule đỉnh từ scan-features TP+5/SL-2 — firing = vào lệnh ngay"
   Golden cards (stacked):
   - Card A (FIRING — orange border 2px, orange tint bg):
     Header: "💎 Triple Bounce LONG" + badge "WR 72%" (right)
     Sub: "TP+5% / SL-2% · 3/3 điều kiện ✓"
     3 condition rows (green ✓): "RSI 1h < 40 · 38.2", "Stoch 4h < 20 · 16", "ATR% 1h < 0.3 · 0.24%"
     Fire badge at bottom: "🔥 FIRING NOW — vào lệnh LONG" (orange)
   - Card B (pending — gray border):
     "⏸ MACD Reversal SHORT · WR 58% · 1/3 điều kiện ✓"
     3 rows with × and ✓ mix

4. 🔍 CHECKLIST LONG section (green title):
   Title "🔍 CHECKLIST LONG — 5 dấu hiệu KHÔNG nên mua"
   Sub: "⚠️ 2/5 dấu hiệu xấu đang xuất hiện → cân nhắc kỹ trước khi LONG" (amber)
   5 warning rows (each has left border 3px colored):
   - 🔴 "RSI quá mua (>75)" | "RSI 1h = 78.2 · lesson: WR long 32%"
   - 🟡 "EMA50 xa quá (>2%)" | "1h EMA Δ = +3.1% · lesson: WR long 41%"
   - 🟢 "Bollinger Upper touch" | "Chưa touch · lesson: WR long 55%"
   - 🟢 "Volume spike" | "Normal · WR 62%"
   - 🟢 "HTF 4h DOWN" | "HTF 4h = UP · WR 64%"

5. 🔍 CHECKLIST SHORT section (red title, 3 items):
   Similar structure, 3 rows.

6. 📡 INDICATOR LIVE — PHÂN TÍCH (table card):
   Each row = 3 columns: [Label 100px] [Value right-aligned 60px] [Italic hint flex]
   - "1h RSI" | "58.3" | "mạnh · nghiêng mua" (green italic)
   - "1h MACD Hist" | "12.4" | "bull momentum" (green)
   - "1h ATR%" | "0.24%" | "rất thấp · golden zone" (orange)
   - "4h ATR%" | "0.65%" | "bình thường" (white)
   - "15m ATR%" | "0.92%" | "cao · biến động mạnh" (amber)
   - "1h EMA50 Δ" | "+0.85%" | "xa vừa · trên EMA" (green)
   - "4h EMA50 Δ" | "+2.45%" | "xa quá · coi chừng pullback" (amber)
   - "HTF 4h state" | "UP" (green bold) | "trend UP rõ" (green)
   Row dividers: #ffffff08. Hint column font-style italic.

Show realistic data, tight mobile spacing. Use scroll-view if needed.
```

---

## 🎯 PROMPT 3 — BinanceChart Card (candlestick + indicators)

```
Design a professional candlestick chart card for BTC/USDT in a dark-mode mobile app, 390px wide.

Colors: bg #0a0a1a · card #0d1117 · orange #f7931a · green #2ed573 · red #ff4757 · blue #3498db · purple #9b59b6
Font: monospace.

Layout:

1. HEADER ROW:
   Left: "BTCUSDT · 1H" (orange bold 12px)
   Right: live price "$92,450.32" (big 16px) + change badge "+2.4%" (green)

2. TIMEFRAME TABS (horizontal scroll chips):
   5m · 15m · 1h · 4h · 1d · 1w · 1M
   Active chip = orange bg + orange text

3. INDICATOR TOGGLE CHIPS (wrap row):
   [EMA9] [EMA21] [EMA50] [BB] [SR] [RSI] [Stoch] [MACD]
   Active = colored (EMA9 blue, EMA21 purple, EMA50 orange, BB gray, SR amber, RSI/Stoch/MACD white)
   Inactive = outlined muted

4. MAIN CANDLE CHART (280px height):
   Dark bg with subtle grid lines
   30 candlesticks: green bull, red bear, wick lines
   Overlays:
   - EMA9 blue line
   - EMA21 purple line
   - EMA50 orange line
   - Bollinger Band: gray translucent ribbon (upper/middle/lower)
   - Support line: dashed amber at $88,200 with label "S1 · $88,200"
   - Resistance line: dashed amber at $94,500 with label "R1 · $94,500"
   Right side price axis: $85k–$95k, 6 ticks, muted
   Bottom time axis: "12:00, 16:00, 20:00, 00:00" muted

5. RSI SUB-PANEL (90px below main):
   Line chart 0–100, current value badge "RSI 58.3" top-right
   Horizontal dashed lines at 30 and 70 (red/green tint)

6. STOCHRSI SUB-PANEL (90px):
   Two lines: K (orange) and D (blue), bands at 20/80

7. MACD SUB-PANEL (90px):
   Histogram bars (green when positive, red when negative)
   MACD line (white) and signal line (amber) overlay

8. VOLUME STRIP (50px bottom):
   Bars tinted green/red matching candle direction

Pan/zoom indicators (pinch hint icon bottom-right).
Show realistic candle data with volatility. Professional trading-app feel.
```

---

## 🎯 PROMPT 4 — FULL APP WIREFRAME (tổng hợp)

```
Design a complete dark-mode BTC crypto trading dashboard mobile app, 390px × 844px (iPhone 14 Pro).
Show TWO screens side-by-side: "Dashboard" tab and "Risk Radar" tab.

Color system:
Background #0a0a1a · Card #0d1117 · Accent orange #f7931a (Bitcoin)
Bull green #2ed573 · Bear red #ff4757 · Warning amber #ffa502
Text white · Dim #aaaaaa · Muted #666666
Font: monospace.

═══ SCREEN 1: DASHBOARD ═══

Top-to-bottom scroll:

1. Status bar + header: "₿ BTC DASHBOARD" (orange, letter-spaced)
   Top-right icons: 🔔 alert · ⚙️ settings · 🎯 Risk Radar button

2. RULE ALERT BANNER (if active):
   Orange tinted strip: "🔥 FIRING: Triple Bounce LONG @1h · WR 72% — tap để xem"

3. OVERALL VERDICT CARD (see Prompt 1 layout, full)

4. TIMEFRAME TABLE (PHÂN TÍCH ĐA KHUNG THỜI GIAN):
   Title centered orange
   Table 7 rows (5m–1M) × 6 cols:
     [TF] [RSI bar + value] [StochRSI K/D + label QM/QB] [MACD TĂNG/GIẢM] [Trạng thái] [P.Kỳ]
   Below table: 4 info cards stacked (EMA, Bollinger, MACD, Khối lượng) with key values

5. BINANCE CHART CARD (see Prompt 3)

6. TRADING RULES PANEL (collapsed by default):
   Header "📡 RULE TRADING" + "🟢 3 rule bật" + ▶ collapse icon
   When expanded: TF tabs (15m · 1h · 4h) + rule list cards
   Auto-sync note if global TF ≠ panel TF:
     "ℹ️ TF 5m chưa có rule — đang hiển thị rule 15m (gần nhất)"
   Sync-back button "🔗 Sync lại với TF 1H global" (when user override)

7. ALERT LOG (NHẬT KÝ CẢNH BÁO):
   Scrollable list of recent alerts with timestamp

═══ SCREEN 2: RISK RADAR ═══

(see Prompt 2 layout, full)

STYLING RULES:
- Cards: 12px radius, 14-16px padding, 12px margin between
- Dividers: #ffffff10 subtle
- Icons: emoji inline (🔥 ⚠️ 💎 🎯 📊 📡 ⏸)
- Tight monospace typography, letter-spacing for headers
- All interactive elements visible affordance (borders, hover states)
- Professional Bloomberg-terminal-meets-Robinhood vibe
- Data must be realistic (actual BTC price ranges, realistic WR/edge numbers)

Deliver both screens as interactive prototypes I can tweak via sliders (spacing, radius, accent hue, density).
```

---

## 📋 Workflow đề xuất

| Step | Action |
|------|--------|
| 1 | Paste **Prompt 4** (full wireframe) vào `claude.ai/design` trước để có overall layout |
| 2 | Nếu cần refine 1 màn → paste Prompt 1/2/3 tương ứng |
| 3 | Trên canvas, chỉnh: spacing density · accent hue · card radius · font weight |
| 4 | Screenshot kết quả (mỗi màn 1 ảnh) + export design tokens |
| 5 | Gửi em → em code lại RN component bám theo design (giữ logic/data cũ, chỉ đổi visual) |

**Ưu tiên thử Prompt 4 trước** — Claude Design sẽ cho wireframe tổng thể, rồi mình zoom vào từng màn sau.
