# Loss-gate M=3 — DECISIVE random-run-null test (2026-06-29)

## Harness: backtest-live-7y.ts (faithful, parity flag-off = $472.01/n1748 byte-exact)
Flags added (env-gated, off=parity): CHAMP_SKIP_LOSS (skip M new-entries after losing close, += semantics),
CHAMP_SKIP_HOT5_RET, CHAMP_SKIP_RAND_P (per-signal), CHAMP_RANDRUN_M+RATE (run-structured random null).

## Arc
1. TRADE-LIST filter (xóa lệnh khỏi dump): skip-loss → $472→$816, WR56% → MIRAGE (path-dependent, không replay re-entry).
2. FAITHFUL CHAMP_SKIP_LOSS: M=1 $486 / M=2 $494 / M=3 $519(=M)/$496.55(+=) / M=4 $435(cliff) / M=5 $436. Peak M=3, knife-edge M=4. maxDD: =M −$70(tốt), += −$84(tệ hơn base −$80). Sensitive tới semantics+M.
3. HOT5 one-shot: +$2.5/7y NULL (while-version self-locks).

## DECISIVE: run-structured random null (fair)
Per-signal random-skip (CHAMP_SKIP_RAND_P) KHÔNG phải null đúng — skip 1 lệnh → champion re-enter ngay bar sau → n đứng 1747, NET ~base. Loss-gate skip theo RUN (M liên tiếp) nên giữ flat qua cụm.
→ Null đúng = CHAMP_RANDRUN_M=3 RATE=0.60: trên mỗi CLOSE, prob 0.60 (=tần suất loss, WR40%) thì skipEntriesLeft+=3. Cùng cấu trúc loss-gate nhưng trigger NGẪU NHIÊN.

12 seeds random-run NET (n≈1530, WR40-41%, maxDD/drop20 ~ loss-gate):
$423.36 435.81 442.03 453.65 457.28 463.29 471.64 477.16 480.12 483.24 495.76 500.00
mean ~$465, max $500.

LOSS-GATE M=3 (+=): NET $496.55, n1524.
→ seed10 ($495.76) + seed12 ($500.00) KHỚP/VƯỢT loss-gate. M=3 ở ~83rd-pct của null, 2/12 random vượt.

## VERDICT
Loss-gate M=3 KHÔNG phân biệt được với random-run-null cùng duty-cycle. Tín hiệu loss KHÔNG thêm edge ngoài "participate-less trong cụm" (mà random tái tạo). = MIRAGE/duty-cycle artifact. KHÔNG deploy.
Champion chạm trần honest ví $109; lever thật còn lại = capital-gated (vol-target/sub-account).
