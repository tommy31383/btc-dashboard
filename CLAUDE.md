# Quy tắc làm việc — Anh Tommy (BTC Dashboard)

**Skill bắt buộc load đầu tiên:** `anthropic-skills:tommy-workflow`

---

## 🚫 CẤM TỰ Ý BUILD APK

- **KHÔNG bao giờ** tự chạy `./gradlew assembleRelease` hoặc build APK
- **CHỈ** khi anh Tommy gõ **"build"**, **"build apk"**, **"ok build"** mới được build
- Sau khi code xong mà chưa có lệnh build → **đứng yên, chờ anh Tommy duyệt**

## 📦 APK OUTPUT PATH — LƯU CỐ ĐỊNH

Sau khi `./gradlew assembleRelease` xong, **LUÔN copy APK** về đúng chỗ:

```bash
cp android/app/build/outputs/apk/release/app-release.apk ../btc-dashboard-v<VERSION>.apk
```

- Path chuẩn: `E:\AI\BTC\btc-dashboard-v<MAJOR.MINOR.PATCH>.apk` (folder CHA của btc-dashboard)
- Version lấy từ `app.json` hoặc từ `APP_VERSION` constant trong `App.tsx`
- **KHÔNG** để APK nằm mỗi build 1 chỗ khác — anh Tommy cần 1 pattern duy nhất để tìm
- Các version cũ giữ nguyên (không xóa) để Tommy rollback khi cần

## 📺 LUÔN SHOW HTML TRÊN BROWSER TRƯỚC KHI BUILD

- Mỗi lần thay đổi UI (RuleAlertBanner, TradingRulesPanel, BinanceChart, v.v.):
  1. Update/tạo file HTML preview trong `assets/` (ví dụ: `alert_banner_final_preview.html`, `sr_preview.html`)
  2. Mở file HTML bằng `start "" "path\to\preview.html"` để anh Tommy xem trên browser
  3. Chờ anh Tommy confirm "ok" → rồi mới build APK khi anh Tommy ra lệnh
- Không skip bước preview — anh Tommy cần nhìn trực tiếp UI trước

## 🔄 Quy trình chuẩn khi nhận task UI

1. **Research** — đọc code hiện tại, hiểu logic
2. **Giải thích** — trình bày em hiểu task như nào
3. **Đề xuất phương án** — nêu 1-3 phương án, ưu/nhược điểm
4. **Chờ anh Tommy duyệt phương án** → KHÔNG tự quyết
5. **Code** — implement theo phương án đã duyệt
6. **Update HTML preview** — tạo/sửa file HTML tương ứng
7. **Mở HTML** cho anh Tommy xem trên browser
8. **Chờ anh Tommy nói "ok"** hoặc feedback
9. **Nếu anh Tommy gõ "build"** → build APK
10. **Update lesson learn** sau khi task xong

## 🎨 Xưng hô

- **"dạ anh Tommy"**, **"em"** — luôn luôn
- Thẳng thắn, không vòng vo, không bịa data
- Khi chưa rõ → hỏi lại, không tự suy đoán

## 📁 Files quan trọng

- `assets/hard_rules.json` — rule set production, NẶNG, chỉ regen khi anh Tommy duyệt
- `assets/scan_tpsl_*.json` + `scan_tpsl_htf_*.json` — output của scan tools
- `components/RuleAlertBanner.tsx` — banner signal live (top của app)
- `components/TradingRulesPanel.tsx` — danh sách rule theo dõi (dưới banner, default collapsed)
- `components/BinanceChart.tsx` — chart có S/R overlay
- `hooks/useRuleAlerts.ts` — logic eval rule match live
- `tools/scan-tpsl.ts` + `scan-tpsl-htf.ts` — scan combo TP/SL (track avgHoldBars)
- `tools/inject-verified-rules.ts` — inject rule vào hard_rules.json

## ⚙️ Lưu ý kỹ thuật

- `avgWinPct` / `avgLossPct` trong `hard_rules.json` **ĐÃ** nhân leverage (từ `leveragedPnlPct`)
  → UI render THẲNG, KHÔNG nhân `× lev` nữa
- `cfg.targetPct` / `cfg.stopPct` là raw price % → UI cần nhân `× lev` để show PnL
- Rule **không** bắt buộc `stochExtreme` (K>95/K<5) — chỉ hiển thị StochK hiện tại cho user tham khảo
- Default scan period = 10,000 candles (realistic, không survivorship bias)
- TradingRulesPanel default `collapsed = true` — user tự bấm mở
