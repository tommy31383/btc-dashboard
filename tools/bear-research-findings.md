# Bear-research 3 trục (2026-06-30) — faithful champion + honest-gate

Baseline parity (no flags): **NET $472.01 / n1748 / WR 39.5% / maxDD −$80.05 / drop-top20 −$837.03**

## Trục 2 — Chỉ báo predict forward-vol/DD? (stat-test OOS, H=14d)
samples total=2482, IS(≤2022)=1241, OOS(≥2023)=1241

| feature | IS rho(vol) | OOS rho(vol) | IS rho(DD) | OOS rho(DD) |
|---|---|---|---|---|
| trail_vol (BASELINE) | 0.320 | 0.249 | 0.139 | 0.067 |
| trail_vol30 | 0.268 | 0.264 | 0.164 | 0.088 |
| atr_pct | 0.353 | **0.293** | 0.171 | **0.163** |
| adx | 0.062 | 0.082 | 0.022 | 0.013 |
| rsi | 0.009 | −0.086 | −0.011 | −0.099 |
| ema20_dist | −0.017 | −0.075 | −0.036 | −0.096 |
| ema200_dist | 0.159 | 0.065 | 0.055 | 0.058 |
| below_ema200 | 0.006 | −0.102 | 0.049 | 0.027 |
| ret5 | 0.006 | −0.051 | −0.014 | −0.078 |
| ret20 | −0.009 | −0.078 | −0.026 | −0.087 |

**Verdict:** chỉ họ-vol (trail_vol/trail_vol30/atr_pct) predict forward-vol. Mọi chỉ báo trend/momentum ~0 hoặc âm OOS. atr_pct nhỉnh hơn close-stdev nhưng = cùng vol-clustering family (đã có trong volScale). KHÔNG có chỉ báo mới beat volScale.

## Trục 1 — Chỉ báo = risk-control bear (siết exit/SL khi bear)
| variant | NET | maxDD | drop20 | n | WR |
|---|---|---|---|---|---|
| baseline | $472.01 | −$80.05 | −$837 | 1748 | 39.5% |
| COND bear ema10 | $447.42 | −$79.59 | −$875 | 1839 | 39.7% |
| COND bear ema5 | $455.03 | −$79.46 | −$892 | 1913 | 40.1% |
| COND rng+bear ema10 | $405.75 | **−$75.73** | −$925 | 2085 | 40.5% |
| COND bear ema15 | $470.72 | −$80.05 | −$856 | 1781 | 39.5% |
| SL tight 1.2 | $367.88 | −$90.31 | −$882 | 1888 | 34.3% |
| SL wide 2.0 | $460.19 | −$78.79 | −$847 | 1679 | 42.1% |

**Verdict:** KHÔNG variant nào beat NET baseline. Best DD (rng+bear −$75.73, −5%) đổi bằng NET −$66 (−14%). SL siết = xấu cả hai. Cắt sớm winner phá fat-tail → khớp champion-edge-anatomy (exit/SL đã gần tối ưu).

## Trục 3 — Gate sit-out (EMA200d-band) có gần tối ưu?
| gate | NET | maxDD | drop20 | n | WR |
|---|---|---|---|---|---|
| skip-BEAR regime | $335.74 | −$84.34 | −$726 | 1408 | 36.8% |
| bg 1.00 (strict) | $366.19 | −$84.66 | −$783 | 1520 | 37.2% |
| bg 0.90 | $402.09 | −$80.05 | −$845 | 1687 | 38.6% |
| **bg 0.80 (LIVE)** | **$472.01** | −$80.05 | −$837 | 1748 | 39.5% |
| bg 0.70 (loose) | $446.53 | −$80.05 | −$880 | 1829 | 38.4% |
| bg 0.50 (vloose) | $440.74 | −$80.05 | −$889 | 1844 | 38.3% |

**Verdict:** bg=0.80 (LIVE) là ĐỈNH NET — cả siết (skip-BEAR/bg1.0) lẫn nới (bg0.70) đều giảm NET. Gate hiện tại tuned tốt, không có cải thiện.

### Trục 3 walk-forward (chọn bg trên IS → kiểm OOS) — split thật:
| bg | IS 2019-22 | OOS 2023-26 |
|---|---|---|
| 0.70 | $246.67 | $199.90 |
| **0.80 LIVE** | **$274.03** | $198.03 |
| 0.90 | $242.38 | $159.75 |

Chọn-bg-trên-IS = 0.80 → OOS $198 ≈ đồng-đỉnh 0.70 ($200), >> 0.90 ($160). **bg=0.80 generalize OOS, KHÔNG full-period mirage.** bg∈[0.70,0.80]=plateau robust; ≥0.90 hại OOS.

### Codex-requested regime duration/slope (Q5 lead) — stat-test:
| feature | OOS rho(vol) | OOS rho(DD) |
|---|---|---|
| ema200_slope | 0.115 | 0.116 |
| days_below200 | −0.096 | −0.001 |
| dd_from_ath | 0.009 (sign-flip IS−0.143) | −0.184 (unstable) |

→ ema200_slope tín hiệu forward-vol NHẸ nhưng < trail_vol(0.249); days_below null; dd_from_ath sign-unstable. **KHÔNG beat baseline.** Territory cạn.

## TỔNG (Codex cross-audit PASS, no rubber-stamp):
- **Trục 1 = KILL** (risk-control siết exit/SL: best đổi $4.32 DD lấy $66 NET = $15 NET/$1 DD; tệ kể cả ví lớn).
- **Trục 2 = trend/momentum/duration/slope NULL** (chỉ họ-vol predict; ema200_slope nhẹ nhưng < baseline). 1 lead chưa-NET: `atr_pct` (forward-DD OOS 0.163 > close-stdev 0.067) = **vol-estimator candidate, KHÔNG phải indicator alpha** → bank cho vol-target overlay (capital-gated ví ≥$2-3k, SHELVED) khi reactivate; KHÔNG live-change bây giờ.
- **Trục 3 = VALIDATED** bg=0.80 live ở plateau robust (WF generalize OOS), KHÔNG overclaim exact-optimum.
- **Khuyến nghị Codex: STOP bear-indicator search.** Champion ở local-optimum cả 3 trục (exit/sizing-signal/gate). Không deploy gì.

---
## ENTRY-MAKER fill-model (2026-06-30, Grok-idea + Codex-endorsed lead) — flag CHAMP_MAKER_ENTRY (parity off=byte-exact $472.01/n1748)
Post-only limit rest OFFSET dưới next-open; fill (maker 0.02%, no-slip) iff entry-bar LOW≤limit; else taker-fallback/miss. MAKER_ADVERSE = queue/adverse-selection tax.

| config | NET | vs$472 | maxDD | drop20 | IS | OOS |
|---|---|---|---|---|---|---|
| baseline taker | 472.01 | — | −80 | −837 | 274.0 | 198.0 |
| fb 0.05 adv0 (CEILING) | 507.04 | +35.0 | −75 | −809 | 276.6 | 230.3 |
| fb 0.05 adv0.03% | 472.08 | +0.07 | −79 | −832 | 271.7 | 200.3 |
| fb 0.05 adv0.05% | 450.41 | −21.6 | −80 | −845 | 267.5 | 182.9 |
| pure0.03 adv0.03% | 480.21 | +8.2 | −75 | −821 | 262.1 | 218.1 |

**Verdict: ceiling +$35 (no-adverse) ăn sạch bởi 0.03% adverse-tax → break-even.** Structural: champion=trend/breakout cần taker-IMMEDIACY; maker rest-below hoặc MISS winner (giá chạy) hoặc fill ADVERSE (giá khựng→ngược). Momentum-entry trả spread by nature. KILL-for-this-champion (break-even, immaterial $109). Flag giữ env-gated off (evidence anchor).
