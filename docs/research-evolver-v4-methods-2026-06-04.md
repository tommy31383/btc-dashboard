# Research: Evolver v4 Methods — 2026-06-04

Deep-research (110 agents, 27 sources, 93 claims extracted, 25 verified) cho 4 chủ đề v4.

---

## 1. MAP-Elites (Quality-Diversity)

### Confirmed (high confidence)
- **Cơ chế**: uniform random bin selection, 1 fittest individual per bin, diversity passively acquired
- **Proven advantage**: (1−1/e)-approximation polynomial expected time trên NP-hard problems (submodular maximization, set cover) — standard (µ+1)-EA cần exponential time trên cùng instances
- Sources: Mouret & Clune 2016 (Frontiers Robotics AI); Doerr & Qu IJCAI 2024 (arXiv:2401.10539)

### Gap quan trọng
- Không có paper nào apply MAP-Elites cho **full trading rule genome** (gene-level OHLCV signal search)
- QD-finance papers tìm được: (1) CVT-MAP-Elites portfolio optimization — refuted (0-3); (2) MAP-Elites trade execution scheduling — refuted (1-2) trên specific quantitative claims
- **Conclusion**: Evolver v4 là first-of-kind application. Lý thuyết solid, nhưng behavioral descriptor design phải tự thiết kế + validate

### Refuted claims (đừng dùng)
- "MAP-Elites có trong QD bibliography 262 papers nhưng không có finance" — refuted (0-3)
- "MAP-Elites kém standard GA trên simple domains" — refuted (0-3)
- Trade execution MAP-Elites specific numbers (+10.3%, -30.2%) — refuted (0-3)

---

## 2. NSGA-II Multi-Objective

### Confirmed (high confidence)
- **Bi-objective pair tốt nhất**: {Sharpe Ratio maximize, MaxDD minimize}
- NSGA-II + Sharpe+MaxDD outperforms SOO kể cả khi pick 1 nghiệm từ Pareto front — validated KS+Friedman tests, 110 stocks, 10 international markets
- NSGA-II: crowding distance diversity → tốt cho 2 objectives
- NSGA-III: reference-point selection → tốt hơn cho 3+ objectives
- Sources: AI Review 2025 (Essex repo); Computational Economics 2024 (Vivek et al.); TechScience IASC v32n3

### Refuted claims
- "NSGA-II chỉ effective cho 2 objectives" — refuted (0-3). Vẫn work với 3, NSGA-III chỉ tốt hơn ở high-dim
- "Objective set tốt nhất là {total return, expected rate of return, risk}" — refuted (1-2). Sharpe+MaxDD compound metrics trực tiếp hơn

### GT-Score (robustness composite)
- **Design confirmed (3-0)**: performance + statistical significance + consistency + downside risk
- **Magnitude refuted (1-2)**: claim "+98% generalization ratio" không verified
- Source: arXiv:2602.00080 (2026)
- **Recommendation**: dùng GT-Score như fitness thay Calmar — direction sound, đừng tin số cụ thể

---

## 3. Purged + Embargoed Walk-Forward CV

### Critical gap
- **Zero confirmed claim** về purged/embargoed CV applied to trading strategy evolution trong surveyed literature
- Dominant methodology trong papers: rolling-window 2y train + 1y test (Computational Economics 2024)
- Claim "strict information-set discipline thay purge/embargo" — refuted (0-3)
- Claim "34 independent OOS periods là rigorous anti-leakage" — refuted (0-3)

### Implementation theo López de Prado AFML (blog sources — practitioner level)
- **Purging**: loại training samples có label overlap với test window (label = forward return window)
- **Embargo**: thêm gap buffer sau purge — tránh leakage qua serial correlation
- **Embargo gap cho BTC 4h**: ~42 bars (~1 tuần) là reasonable starting point — không có empirical benchmark trên crypto
- **CPCV** (Combinatorial Purged CV): generate nhiều train/test splits hơn standard WF → more statistically valid
- Sources: blog.quantinsti.com; towardsai.net; quantbeckman.com; risklab.ai

### Recommendation
Implement purged-WF với embargo 42 bars 4h. Calibrate embargo size bằng cách measure serial correlation của BTC 4h returns — embargo ≈ 2× decorrelation lag.

---

## 4. Primitive Library Design

### Vectorial GP (medium confidence)
- VGP với vector size 21 (21 trading days ≈ 4 tuần context) outperforms scalar GP
- "Scalar GP performed poorly overall; strongly-typed VGP was consistently best"
- Source: arXiv:2504.05418 (preprint April 2025, vote 2-1)
- **Application**: primitive nên nhận vector of bars, không chỉ scalar hiện tại

### BTC primitive-level edge evidence
- Không có confirmed paper ablate từng primitive trên BTC 7y backtest
- **Must-do**: Phase A self-screen từng primitive độc lập trên 7y data

### Screening checklist (từ research synthesis)
1. Screen từng primitive **độc lập** — không kết hợp trước khi có solo edge
2. Minimum n ≥ 150 lệnh / 7 năm để có statistical significance
3. Walk-forward stability: ≥ 5/7 năm dương
4. Primitive pass → vào kho; fail → loại, không bao giờ revisit
5. Sau khi có kho primitive sạch → mới cho GA ghép

---

## Open Questions (cần giải quyết khi build)
1. Behavior descriptor dimensions tốt nhất cho trading rule MAP-Elites: trades/yr × avg-hold × regime? Hay cần dims khác?
2. Embargo gap optimal cho BTC 4h — cần đo serial correlation thực tế
3. GT-Score có cải thiện generalization hay không — cần benchmark trên evolver v3 data trước khi commit
4. Vectorial primitive (21-bar) vs scalar — áp dụng cho ADX/DI/Donchian như thế nào (time-series vs rolling indicator?)

---

## Stats
- Agents: 110 | Sources fetched: 27 | Claims extracted: 93 | Verified: 25
- Confirmed: 9 | Killed: 16 | After synthesis: 5
- Duration: ~14 phút
