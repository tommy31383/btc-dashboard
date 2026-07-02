# Vol-target overlay lên champion — findings cần CROSS-AUDIT địch-thủ

## Nguồn
- trade dump byte-exact: champ-trades-byteexact.json (n=1748, sum net $472.01, qty0.001 BTC, ĐÃ gồm fee/slip, sleeve BTC4h, fields entryTime/exitTime/entryPx/exitPx/net/reason)
- daily vol từ binance-1h-7y.json → daily close → trailing stdev daily-return.
- scripts: champ-overlay-test.py (raw + gate), champ-overlay-neutral.py (exposure-neutral), champ-overlay-robust.py (N-sweep).

## Overlay
multiplier m_i = clamp( targetVol / trailingVol_i , LO, HI ), trailingVol_i = stdev của N daily returns NGAY TRƯỚC ngày entry (i-1 trở về, strictly past). targetVol = median(trailingVol) CHỈ trên IS (2019-2022). EXPOSURE-NEUTRAL: chia m_i cho mean(m) → mean multiplier=1 (cùng size trung bình, KHÔNG net leverage). scaled_net_i = net_i × (m_i/mean).

## Kết quả (clamp[0.33,3.0], N=14)
            tot     maxDD   ret/DD
BASE  ALL  $472.0   $80.1   5.90
VT    ALL  $502.9   $67.2   7.49
BASE  IS   $274.0   $54.1   5.06
VT    IS   $249.4   $43.8   5.69
BASE  OOS  $198.0   $80.1   2.47
VT    OOS  $258.5   $57.7   4.48   <-- OOS ret/DD +81%, OOS maxDD −28%
Robust N=7/14/21/30: OOS ret/DD 4.44-4.94, OOS maxDD $56-60 (đều cải thiện).

## Claim cần đập
1. ret/DD scale-invariant → cải thiện thuần timing-of-size, KHÔNG leverage, KHÔNG normalization-lookahead.
2. trailingVol chỉ dùng data TRƯỚC entry → no lookahead.
3. Robust mọi N → không overfit param.
4. = risk-control (cắt maxDD), không alpha mới.

## Cost/vol-GATE (đã loại): bucket net theo vol-tercile lật IS↔OOS (LOW lời OOS, HIGH lời IS), mid −$12 → null.
