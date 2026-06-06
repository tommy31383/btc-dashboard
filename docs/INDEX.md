# 📚 MASTER INDEX — Research & Lesson-learn (BTC bot)

Cập nhật 2026-06-04. Catalog toàn bộ doc 2 repo (`btc-dashboard/docs/` + `btc-trader-server/docs/`).
Phân loại: 🧭 Method/Framework · 🔬 Research · 📊 Rule-dev · 🐻 Bear/Regime · 🔁 Loop · 🛠️ Audit/Deploy · 📅 Session.
**[D]** = btc-dashboard/docs · **[S]** = btc-trader-server/docs.

---

## 🧭 METHOD / FRAMEWORK (lesson-learn cốt lõi — đọc trước)
| Doc | Nội dung |
|---|---|
| [D] `general-trend-method-framework.md` | **6 nguyên tắc GENERAL** validated: direction follow trend đa-TF (ADX king), regime-gate, risk=CẮT ATR (nguồn alpha), winner asymmetry TP rộng, reverse confirmed, diversify + judge Sharpe/$. Anti-patterns + checklist. |
| [D] `auto-rule-evolution-methodology.md` | Pipeline 5 bước auto-gen rule: GEN→BACKTEST honest→AUDIT 3-cổng→IMPROVE→MỞ RỘNG. Guard-rails. |
| [S] `backtest-reference.md` | Reference pipeline backtest + dataset 7y. |

## 🔬 RESEARCH (deep-research / điều tra)
| Doc | Nội dung |
|---|---|
| [D] `research-signal-entry-execution-2026-06-04.md` | **Thế giới vào lệnh sau signal**: probe→react/scale-in CÓ THẬT, pyramiding KHÔNG free-alpha, fractional Kelly ½-⅓, judge matched-DD. |
| [S] `research-macro-ai-2026-05.md` | 4 đề xuất macro-AI đã screen 7y — **ĐỀU FAIL/KILL**, validate design đơn giản. |
| [D] `rci-indicator-research-2026-06-03.md` | RCI reversal oscillator research. |
| [D] `rci-v4-research-2026-06-03.md` | RCI v4 research. |
| [D] `frequency-improvement-research-2026-06-03.md` | Research tăng tần suất lệnh. |
| [D] `hedge05-turtle-research-2026-06-02.md` | Turtle alpha discovery (ATR-cut edge). |

## 📊 RULE-DEV (phát triển + backtest rule)
| Doc | Nội dung |
|---|---|
| [D] `backtest-live-rules-7y-2026-06-04.md` | **Backtest 7y 3 rule LIVE** (hedge01/turtle/champion) tách năm+tháng+n. |
| [D] `probe-react-backtest-2026-06-04.md` | Probe→react validate: matched-DD +9.4% vs baseline, cấm tune K/W. |
| [D] `general-rule-g14-g16-evolver-2026-06-04.md` | G14→G16 + evolver. KPI 8/8 ARTIFACT, honest single-account. |
| [D] `general-rule-multiasset-book-2026-06-02.md` | General rule multi-asset {BTC,SOL} + turtle, risk-parity. |
| [D] `general-rule-multiasset-r38-r44-2026-06-03.md` | Autoloop r38-r44 multi-asset. |
| [D] `general-rule-G8-2026-06-03.md` | General rule G8. |
| [D] `rci-trend-master-summary-2026-06-03.md` | RCI trend master summary. |
| [D] `trend-backtest-iter1-3-2026-06-03.md` | Trend backtest iter 1-3. |
| [D] `rci-integration-iter1..8-2026-06-03.md` | RCI integration loop 8 iter (trend≠reversal lesson, funding>0.05%=64% top). Gộp về dashboard. |

## 🐻 BEAR / REGIME
| Doc | Nội dung |
|---|---|
| [S] `bear-short-strict-filter-2026-06-03.md` | BEAR-short strict filter — no edge. |
| [S] `bear-short-retest-2026-06-03.md` | BEAR-short retest — KILL (đã test 2 lần). |
| [S] `regime-classifier-upgrade-2026-06-03.md` | Regime classifier upgrade. |

## 🔁 LOOP ITERATIONS (autoloop journals — ĐÃ ARCHIVE)
| Doc | Nội dung |
|---|---|
| [S] `archive/loop/loop-iteration-2..7-2026-06-03.md` | Autoloop iteration journals 2-7 (archived). |
| [S] `archive/loop/loop-iter9..13-2026-06-03.md` | Loop iter 9-13: coverage-gaps · sol-validation · execution-risk · portfolio-sizing · crossasset-leadlag (archived). |
| | 11 file gộp vào `btc-trader-server/docs/archive/loop/` — insight chính đã lên MEMORY.md. |

## 🛠️ AUDIT / DEPLOY
| Doc | Nội dung |
|---|---|
| [S] `live-audit-2026-06-04-v0482.md` | **Audit live kỹ** — fix bug logger dedup index→time, champion skip-BEAR. |
| [S] `audit-deploy-2026-06-04.md` | Audit production + deploy v0.4.79 turtle funding-gate. |
| [S] `live-rules-audit-loop-2026-06-03.md` | Audit rule live loop. |
| [S] `code-quality-audit-2026-06-03.md` | Code quality audit. |
| [S] `hedge05-audit-package.md` · `session-2026-06-02-hedge05-fidelity.md` | hedge05 audit + fidelity (RA lookahead-inflated → faithful −$417). |
| [D] `memory-audit-2026-06-03.md` | Memory audit. |

## 📅 SESSION SUMMARIES
| Doc | Nội dung |
|---|---|
| [D] `session-2026-06-04-summary.md` | Marathon G13→G16→evolver→forward-test→audit→probe→react. |
| [S] `session-summary-2026-06-03.md` · `session-2026-06-02-knowledge.md` · `session-2026-06-02-autoloop-journal.md` · `session-2026-05-29-lessons.md` | Session journals các ngày. |

---

## 🔑 LESSON-LEARN CỐT LÕI (cũng ở auto-memory MEMORY.md)
- **Judge bằng DOLLARS, không RA%** khi size thay đổi (pyramid/DCA).
- **CẮT thắng CỨU** — xử lý lệnh lỗ không tạo edge; expectancy ở ENTRY.
- **BEAR-short không có edge** — đã test 2 lần, ngồi cash đúng.
- **Verify trên harness live-faithful** trước khi port backtest→live.
- **Multi-sleeve KPI thổi phồng** — phải re-sim single-account margin-cap.
- **Filter overfit risk** — n<20/yr red flag; structural filter safe, data-scan filter risky.
- **Backtest validate 7y full-cycle** — train/test chronological + per-year ≥5/8.
- **Report backtest**: tách năm+tháng+n lệnh, đủ mọi rule.
