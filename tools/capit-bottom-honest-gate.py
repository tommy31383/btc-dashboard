#!/usr/bin/env python3
"""
capit-bottom-honest-gate.py — Nhóm C (Tommy): vùng đáy/capitulation bottom qua HONEST-GATE đầy đủ.

Rule (daily close, từ capitulation-bottom-7y.py cons=4 = config tốt nhất):
  ENTRY: down day + chuỗi giảm >=CONS + lowWick>=WICK% + sâu <=DEPTH% dưới đỉnh 20d
  EXIT : stop entry-SL*ATR | trail peakClose-TR*ATR | time MAXHOLD ngày

Gate honest (judge DOLLARS/return NET):
  1. drop-top-20%   — bỏ 20% trade lãi nhất, sum còn dương? (âm = fat-tail mirage)
  2. cross-asset    — BTC + ETH (7y) + SOL (3y); phải dương đa-asset
  3. random-null    — N entry ngẫu nhiên CÙNG số lệnh + CÙNG hold-dist, p-value vs edge thật
  4. vs buy&hold    — so beta: edge/ngày-deployed có > B&H/ngày cùng kỳ không? (then là alpha thật)
  5. walk-forward   — train 2019-22 / test 2023-26 unseen, test phải cùng dấu + dương
"""
import json, datetime as dt, statistics as st, sys, random

CONS=4; WICK=35; DEPTH=-8; SL=2.0; TR=2.5; MAXHOLD=20
FEE=0.0008
random.seed(42)

FILES={
 'BTC':'/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json',
 'ETH':'/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json',
 'SOL':'/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-sol-5m-3y.json',
}

def agg(b5,h=24):
    out=[];span=h*3600*1000;cur=None
    for b in b5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur=dict(time=bk,open=b["open"],high=b["high"],low=b["low"],close=b["close"])
        else:
            cur["high"]=max(cur["high"],b["high"]);cur["low"]=min(cur["low"],b["low"]);cur["close"]=b["close"]
    if cur:out.append(cur)
    return out

def atr(D,p=14):
    n=len(D);tr=[0.0]*n
    for i in range(1,n):tr[i]=max(D[i]["high"]-D[i]["low"],abs(D[i]["high"]-D[i-1]["close"]),abs(D[i]["low"]-D[i-1]["close"]))
    o=[None]*n
    if n<=p:return o
    a=sum(tr[1:p+1])/p;o[p]=a
    for i in range(p+1,n):a=(a*(p-1)+tr[i])/p;o[i]=a
    return o

def exit_from(D,i,entry,A,sl,tr,maxhold):
    """Mô phỏng exit từ bar i (entry tại close bar i). Trả (ret, hold_bars)."""
    n=len(D);stop=entry - sl*A[i];peak=entry
    for k in range(i+1, min(i+1+maxhold,n)):
        if D[k]["low"]<=stop: return (stop/entry-1)-FEE, k-i
        if D[k]["close"]>peak:peak=D[k]["close"]
        trail=peak - tr*A[i]
        if D[k]["close"]<=trail and D[k]["close"]>entry*0.5:
            return (D[k]["close"]/entry-1)-FEE, k-i
    k_ex=min(i+maxhold,n-1)
    return (D[k_ex]["close"]/entry-1)-FEE, k_ex-i

def backtest(D,cons=CONS,wick=WICK,depth=DEPTH,sl=SL,tr=TR,maxhold=MAXHOLD,lo=20,hi=None):
    n=len(D);A=atr(D);trades=[];i=max(20,lo);hi=hi or (n-1)
    while i<hi:
        if A[i] is None:i+=1;continue
        o,c,h,l=D[i]["open"],D[i]["close"],D[i]["high"],D[i]["low"]
        streak=0;j=i
        while j>0 and D[j]["close"]<D[j-1]["close"]:streak+=1;j-=1
        rngbar=h-l or 1; loww=(min(o,c)-l)/rngbar*100
        hh20=max(D[k]["high"] for k in range(i-20,i+1)); dep=(c/hh20-1)*100
        if c<o and streak>=cons and loww>=wick and dep<=depth:
            ret,hold=exit_from(D,i,c,A,sl,tr,maxhold)
            trades.append(dict(t=D[i]["time"],ret=ret,hold=hold,i=i))
            i+=hold+1
        else:i+=1
    return trades,A

def yr(ts):return dt.datetime.utcfromtimestamp(ts/1000).year

def summ(trades):
    if not trades:return dict(n=0)
    rets=[t["ret"] for t in trades];n=len(rets)
    eq=1.0
    for r in rets:eq*=(1+r)
    w=sum(1 for r in rets if r>0)
    # drop-top-20%
    srt=sorted(rets,reverse=True);cut=int(n*0.2)
    drop20=sum(srt[cut:])
    years={}
    for t in trades:years.setdefault(yr(t["t"]),[]).append(t["ret"])
    posY=sum(1 for y in years if sum(years[y])>0)
    return dict(n=n,wr=round(w/n*100),comp=round((eq-1)*100,1),sumret=round(sum(rets)*100,1),
                drop20=round(drop20*100,1),posY=f"{posY}/{len(years)}",
                avghold=round(st.mean([t['hold'] for t in trades]),1))

def random_null(D,A,n_entries,holds,sl,tr,maxhold,iters=400):
    """N entry ngẫu nhiên (cùng số lệnh, sample hold-dist từ entry thật) → phân phối sumret."""
    n=len(D);valid=[i for i in range(20,n-1) if A[i] is not None]
    out=[]
    for _ in range(iters):
        s=0.0
        for _ in range(n_entries):
            i=random.choice(valid)
            ret,_=exit_from(D,i,D[i]["close"],A,sl,tr,maxhold)
            s+=ret
        out.append(s)
    return out

def buyhold_per_day(D):
    """B&H return/ngày trên toàn kỳ (beta baseline)."""
    days=len(D)
    total=D[-1]["close"]/D[0]["close"]-1
    return total/days, total

print("="*70)
print("NHÓM C — CAPITULATION/VÙNG-ĐÁY honest-gate (cons>=4, wick>=35%, depth<=-8%)")
print("="*70)

results={}
for sym in ('BTC','ETH','SOL'):
    D=agg(json.load(open(FILES[sym])))
    trades,A=backtest(D)
    s=summ(trades)
    bh_day,bh_tot=buyhold_per_day(D)
    if s['n']>0:
        days_deployed=sum(t['hold'] for t in trades)
        edge_per_day=sum(t['ret'] for t in trades)/days_deployed if days_deployed else 0
        # random-null
        null=random_null(D,A,s['n'],None,SL,TR,MAXHOLD)
        edge=sum(t['ret'] for t in trades)
        p=sum(1 for x in null if x>=edge)/len(null)
        null_med=st.median(null)*100
        print(f"\n[{sym}] {len(D)}d | n={s['n']} WR={s['wr']}% sumret={s['sumret']}% comp={s['comp']}% "
              f"drop20={s['drop20']}% posY={s['posY']} avghold={s['avghold']}d")
        print(f"      vs-B&H/ngày: rule={edge_per_day*100:+.3f}%/d  B&H={bh_day*100:+.3f}%/d  (B&H tổng kỳ {bh_tot*100:+.0f}%)")
        print(f"      random-null: edge={edge*100:+.1f}%  null-median={null_med:+.1f}%  p={p:.3f} {'<<< qua' if p<0.05 else 'KHONG qua'}")
        results[sym]=dict(s=s,edge_per_day=edge_per_day,bh_day=bh_day,p=p)
    else:
        print(f"\n[{sym}] 0 trades")

# walk-forward BTC
print("\n--- WALK-FORWARD BTC (train 2019-22 / test 2023-26 unseen) ---")
D=agg(json.load(open(FILES['BTC'])))
split=None
for idx,b in enumerate(D):
    if yr(b['time'])>=2023:split=idx;break
trn,_=backtest(D,hi=split); tst,_=backtest(D,lo=split)
print(f"  TRAIN: {summ(trn)}")
print(f"  TEST : {summ(tst)}")

print("\n" + "="*70)
print("KẾT LUẬN GATE:")
for sym,r in results.items():
    alpha = r['edge_per_day'] > r['bh_day']   # rule/ngày > B&H/ngày = alpha thật, không chỉ beta
    g_drop = r['s']['drop20']>0
    g_p = r['p']<0.05
    verdict = "ALPHA" if (alpha and g_drop and g_p) else ("BETA/MIRAGE" if not alpha else "MARGINAL")
    print(f"  {sym}: drop20{'+' if g_drop else '-'} | p={'qua' if g_p else 'truot'} | "
          f"vs-B&H {'>beta' if alpha else '<=beta'} → {verdict}")
print("="*70)
