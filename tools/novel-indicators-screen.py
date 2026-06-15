#!/usr/bin/env python3
"""
novel-indicators-screen.py — CHẾ ~30 indicator MỚI từ OHLCV (không phải chuẩn),
đo sức dự báo: forward-Nbar return ở top-quintile vs bottom-quintile + consistency
theo năm. Lọc indicator có tín hiệu thật để backtest sâu.
"""
import json,math,statistics as st,datetime as dt
from collections import defaultdict
FWD=5  # forward bars để đo dự báo
def agg(b5,h=24):
    out=[];span=h*3600*1000;cur=None
    for b in b5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur=dict(time=bk,open=b["open"],high=b["high"],low=b["low"],close=b["close"],vol=b.get("volume",0))
        else:cur["high"]=max(cur["high"],b["high"]);cur["low"]=min(cur["low"],b["low"]);cur["close"]=b["close"];cur["vol"]+=b.get("volume",0)
    if cur:out.append(cur)
    return out
D=agg(json.load(open(".cache/binance-5m-7y.json")))
n=len(D);C=[b["close"] for b in D];O=[b["open"] for b in D];Hh=[b["high"] for b in D];Ll=[b["low"] for b in D];V=[b["vol"] for b in D]
ret=[0.0]+[C[i]/C[i-1]-1 for i in range(1,n)]
def win(arr,i,w):return arr[max(0,i-w+1):i+1]
IND={}  # name -> array (causal)
def reg(name,fn,w0=30):
    a=[None]*n
    for i in range(w0,n):
        try:v=fn(i)
        except:v=None
        a[i]=v if (v is not None and math.isfinite(v)) else None
    IND[name]=a

# ── ~30 indicator MỚI ──
def slope(seg):  # linear slope (log)
    m=len(seg);xs=list(range(m));mx=sum(xs)/m;my=sum(seg)/m
    den=sum((x-mx)**2 for x in xs) or 1
    return sum((xs[k]-mx)*(seg[k]-my) for k in range(m))/den
def r2(seg):
    m=len(seg);xs=list(range(m));mx=sum(xs)/m;my=sum(seg)/m
    sxx=sum((x-mx)**2 for x in xs) or 1;syy=sum((y-my)**2 for y in seg) or 1e-12
    sxy=sum((xs[k]-mx)*(seg[k]-my) for k in range(m))
    return sxy*sxy/(sxx*syy)
reg("trendR2_20", lambda i: r2([math.log(x) for x in win(C,i,20)]))
reg("trendR2_50", lambda i: r2([math.log(x) for x in win(C,i,50)]))
reg("efficiency_20", lambda i: abs(C[i]-C[i-20])/(sum(abs(C[j]-C[j-1]) for j in range(i-19,i+1)) or 1e-9))  # Kaufman
reg("choppiness_20", lambda i: math.log10((sum(max(Hh[j]-Ll[j],abs(Hh[j]-C[j-1]),abs(Ll[j]-C[j-1])) for j in range(i-19,i+1)))/((max(Hh[i-19:i+1])-min(Ll[i-19:i+1])) or 1e-9))/math.log10(20))
reg("hurst_rs_30", lambda i: (lambda seg:(lambda mean,dev:(math.log((max(__import__('itertools').accumulate(dev)) or 1e-9)-(min(__import__('itertools').accumulate(dev)) or 0)+1e-9)) )(sum(seg)/len(seg),[x-sum(seg)/len(seg) for x in seg]))([math.log(C[j]/C[j-1]) for j in range(i-29,i+1)]))
reg("autocorr1_20", lambda i: (lambda r:(lambda m:(sum((r[k]-m)*(r[k-1]-m) for k in range(1,len(r)))/((sum((x-m)**2 for x in r)) or 1e-12)))(sum(r)/len(r)))([ret[j] for j in range(i-19,i+1)]))
reg("skew_20", lambda i:(lambda r:(lambda m,s:(sum(((x-m)/s)**3 for x in r)/len(r)) if s>1e-9 else 0)(sum(r)/len(r),(sum((x-sum(r)/len(r))**2 for x in r)/len(r))**0.5))([ret[j] for j in range(i-19,i+1)]))
reg("kurt_20", lambda i:(lambda r:(lambda m,s:(sum(((x-m)/s)**4 for x in r)/len(r)-3) if s>1e-9 else 0)(sum(r)/len(r),(sum((x-sum(r)/len(r))**2 for x in r)/len(r))**0.5))([ret[j] for j in range(i-19,i+1)]))
reg("volOfVol_20", lambda i:(lambda v:st.pstdev(v) if len(v)>1 else 0)([abs(ret[j]) for j in range(i-19,i+1)]))
reg("atrRatio_5_30", lambda i:(sum(max(Hh[j]-Ll[j],abs(Hh[j]-C[j-1]),abs(Ll[j]-C[j-1])) for j in range(i-4,i+1))/5)/((sum(max(Hh[j]-Ll[j],abs(Hh[j]-C[j-1]),abs(Ll[j]-C[j-1])) for j in range(i-29,i+1))/30) or 1e-9))
reg("wickImbal_20", lambda i:sum((Hh[j]-max(O[j],C[j]))-(min(O[j],C[j])-Ll[j]) for j in range(i-19,i+1))/(sum(Hh[j]-Ll[j] for j in range(i-19,i+1)) or 1e-9))
reg("bodyDom_20", lambda i:sum(abs(C[j]-O[j]) for j in range(i-19,i+1))/(sum(Hh[j]-Ll[j] for j in range(i-19,i+1)) or 1e-9))
reg("closePos_10", lambda i:sum((C[j]-Ll[j])/((Hh[j]-Ll[j]) or 1) for j in range(i-9,i+1))/10)
reg("upDayFrac_20", lambda i:sum(1 for j in range(i-19,i+1) if C[j]>C[j-1])/20)
reg("effortResult_10", lambda i:(V[i]/(sum(V[i-9:i+1])/10 or 1e-9))/((Hh[i]-Ll[i])/((sum(Hh[j]-Ll[j] for j in range(i-9,i+1))/10) or 1e-9) or 1e-9))
reg("velVolAdj_5", lambda i:(C[i]/C[i-5]-1)/((sum(max(Hh[j]-Ll[j],abs(Hh[j]-C[j-1]),abs(Ll[j]-C[j-1])) for j in range(i-13,i+1))/14)/C[i] or 1e-9))
reg("rangeExpand", lambda i:(Hh[i]-Ll[i])/((sum(Hh[j]-Ll[j] for j in range(i-19,i+1))/20) or 1e-9))
reg("compression_20", lambda i:(min(Hh[j]-Ll[j] for j in range(i-19,i+1)))/((max(Hh[j]-Ll[j] for j in range(i-19,i+1))) or 1e-9))
reg("timeSinceHigh_30", lambda i:(i-max(range(i-29,i+1),key=lambda j:Hh[j]))/30)
reg("timeSinceLow_30", lambda i:(i-min(range(i-29,i+1),key=lambda j:Ll[j]))/30)
reg("hhll_struct_10", lambda i:sum(1 if Hh[j]>Hh[j-1] and Ll[j]>Ll[j-1] else (-1 if Hh[j]<Hh[j-1] and Ll[j]<Ll[j-1] else 0) for j in range(i-9,i+1))/10)
reg("gapBehavior_10", lambda i:sum((O[j]-C[j-1])/((Hh[j]-Ll[j]) or 1) for j in range(i-9,i+1))/10)
reg("bullBearPower", lambda i:((Hh[i]-(sum(C[i-12:i+1])/13))+(Ll[i]-(sum(C[i-12:i+1])/13)))/C[i])
reg("drawupDown_20", lambda i:((max(C[i-19:i+1])-C[i-20 if i>=20 else 0])/((C[i-20 if i>=20 else 0]-min(C[i-19:i+1])) or 1e-9)))
reg("volZ_20", lambda i:(V[i]-(sum(V[i-19:i+1])/20))/((st.pstdev(V[i-19:i+1]) or 1e-9)))
reg("retEntropy_20", lambda i:(lambda r:(lambda bins:-sum((c/len(r))*math.log(c/len(r)+1e-12) for c in bins if c>0))([sum(1 for x in r if lo<=x<lo+0.01) for lo in [k*0.01-0.05 for k in range(11)]]))([ret[j] for j in range(i-19,i+1)]))
reg("medianDev_20", lambda i:(C[i]-st.median(C[i-19:i+1]))/((st.pstdev(C[i-19:i+1]) or 1e-9)))
reg("reversalPress_20", lambda i:sum(1 for j in range(i-19,i+1) if (min(O[j],C[j])-Ll[j])/((Hh[j]-Ll[j]) or 1)>0.5)/20)
reg("accel_ema", lambda i:(lambda e:(e[-1]-2*e[-2]+e[-3]) if len(e)>=3 else 0)([sum(C[max(0,k-9):k+1])/min(10,k+1) for k in range(i-2,i+1)])/C[i])
reg("volPriceCorr_20", lambda i:(lambda a,b:(lambda ma,mb:(sum((a[k]-ma)*(b[k]-mb) for k in range(len(a)))/((sum((x-ma)**2 for x in a)*sum((y-mb)**2 for y in b))**0.5 or 1e-12)))(sum(a)/len(a),sum(b)/len(b)))([V[j] for j in range(i-19,i+1)],[abs(ret[j]) for j in range(i-19,i+1)]))

# ── BATCH 2: improve timeSinceHigh family + ~20 indicator MỚI ──
for W in [20,40,50,60]:
    reg(f"timeSinceHigh_{W}", (lambda W: lambda i:(i-max(range(i-W+1,i+1),key=lambda j:Hh[j]))/W)(W), w0=W+5)
    reg(f"timeSinceLow_{W}",  (lambda W: lambda i:(i-min(range(i-W+1,i+1),key=lambda j:Ll[j]))/W)(W), w0=W+5)
reg("newHighFreq_30", lambda i:sum(1 for j in range(i-29,i+1) if Hh[j]>=max(Hh[max(0,j-29):j+1]))/30)
reg("pullbackDepth_40", lambda i:(max(Hh[i-39:i+1])-C[i])/(max(Hh[i-39:i+1]) or 1))
reg("upVolDownVol_20", lambda i:(sum(V[j] for j in range(i-19,i+1) if C[j]>C[j-1])+1)/(sum(V[j] for j in range(i-19,i+1) if C[j]<C[j-1])+1))
reg("rsiSlope_5", lambda i:(lambda r:(r[-1]-r[-6]) if len(r)>=6 and None not in r[-6:] else 0)([ (lambda s:(lambda g,l:100-100/(1+(g/14)/((l/14) or 1e-9)))(sum(max(C[m]-C[m-1],0) for m in range(k-13,k+1)),sum(max(C[m-1]-C[m],0) for m in range(k-13,k+1)))) (k) for k in range(i-5,i+1)]))
reg("closeAccel_5", lambda i:((C[i]-C[i-5])-(C[i-5]-C[i-10]))/C[i] if i>=10 else 0)
reg("higherLow_20", lambda i:sum(1 for j in range(i-19,i+1) if Ll[j]>Ll[j-1])/20)
reg("rangeContract_streak", lambda i:(lambda c:c)(next((m for m in range(1,15) if not (Hh[i-m+1]-Ll[i-m+1])<(Hh[i-m]-Ll[i-m])), 0)))
reg("momQuality_30", lambda i:(C[i]/C[i-30]-1)*r2([math.log(x) for x in win(C,i,30)]))
reg("volRegimeShift", lambda i:(sum(abs(ret[j]) for j in range(i-9,i+1))/10)/((sum(abs(ret[j]) for j in range(i-49,i-9)) /40) or 1e-9))
reg("trendAge_50", lambda i:(lambda e50:(i-next((j for j in range(i,i-50,-1) if j>0 and ((C[j]>e50[j])!=(C[i]>e50[i]))), i-50))/50)([sum(C[max(0,k-49):k+1])/min(50,k+1) for k in range(n)]) if False else (lambda em: (i-next((j for j in range(i,max(i-50,1),-1) if (C[j-1]>(sum(C[max(0,j-50):j])/min(50,j)) ) != (C[i]>em)), max(i-50,1)))/50)(sum(C[max(0,i-49):i+1])/min(50,i+1)))
reg("demandSupply_20", lambda i:sum((C[j]-O[j])*V[j] for j in range(i-19,i+1))/(sum(V[j] for j in range(i-19,i+1)) or 1)/((sum(Hh[j]-Ll[j] for j in range(i-19,i+1))/20) or 1e-9))
reg("retSkewSign_30", lambda i:sum(1 for j in range(i-29,i+1) if ret[j]>0)/30 - sum(abs(ret[j]) for j in range(i-29,i+1) if ret[j]<0)/(sum(abs(ret[j]) for j in range(i-29,i+1)) or 1e-9))
reg("rangeMomentum_10", lambda i:((Hh[i]-Ll[i])-(sum(Hh[j]-Ll[j] for j in range(i-9,i+1))/10))/((sum(Hh[j]-Ll[j] for j in range(i-9,i+1))/10) or 1e-9))
reg("closeStrength_20", lambda i:sum((C[j]-O[j])/((Hh[j]-Ll[j]) or 1) for j in range(i-19,i+1))/20)
reg("dipFromHigh_streak", lambda i:next((m for m in range(0,30) if i-m>=0 and Hh[i-m]>=max(Hh[max(0,i-m-29):i-m+1])), 30)/30)
reg("accelVol_20", lambda i:(sum(abs(ret[j]) for j in range(i-4,i+1))/5)-(sum(abs(ret[j]) for j in range(i-19,i+1))/20))
reg("priceZreversal_30", lambda i:(lambda seg:(lambda m,s:-(C[i]-m)/s if s>1e-9 else 0)(sum(seg)/len(seg),(sum((x-sum(seg)/len(seg))**2 for x in seg)/len(seg))**0.5))(C[i-29:i+1]))

# ── screen: forward-Nbar return spread top-quintile vs bottom-quintile + consistency ──
def fwd(i):return C[i+FWD]/C[i]-1 if i+FWD<n else None
def yr(i):return dt.datetime.utcfromtimestamp(D[i]["time"]/1000).year
rows=[]
for name,arr in IND.items():
    pairs=[(arr[i],fwd(i),yr(i)) for i in range(50,n-FWD) if arr[i] is not None and fwd(i) is not None]
    if len(pairs)<500:continue
    pairs.sort(key=lambda x:x[0])
    q=len(pairs)//5
    bot=pairs[:q];top=pairs[-q:]
    sb=sum(p[1] for p in bot)/len(bot);str_=sum(p[1] for p in top)/len(top)
    spread=(str_-sb)*100  # top quintile − bottom quintile forward return %
    # consistency: dấu spread theo năm
    yb=defaultdict(list);yt=defaultdict(list)
    for v,f,y in bot:yb[y].append(f)
    for v,f,y in top:yt[y].append(f)
    yrs=sorted(set(yb)&set(yt))
    cons=[ (sum(yt[y])/len(yt[y]) - sum(yb[y])/len(yb[y])) for y in yrs if yb[y] and yt[y]]
    same=sum(1 for c in cons if (c>0)==(spread>0))
    rows.append((abs(spread),spread,name,f"{same}/{len(cons)}",round(str_*100,2),round(sb*100,2)))
rows.sort(reverse=True)
print(f"=== ~{len(IND)} indicator MỚI · forward-{FWD}bar spread (top-quintile − bottom-quintile) BTC daily ===")
print(f"{'spread':>8} {'consist':>8} {'topRet':>7} {'botRet':>7}  indicator")
for a,sp,name,cons,tr,br in rows[:20]:
    print(f"{sp:>+7.2f}% {cons:>8} {tr:>+6.2f}% {br:>+6.2f}%  {name}")
print(f"\nspread = chênh lệch forward-{FWD}bar return giữa top 20% vs bottom 20% giá trị indicator.")
print("consist = số năm cùng dấu spread. |spread| lớn + consist cao = indicator có sức dự báo.")
