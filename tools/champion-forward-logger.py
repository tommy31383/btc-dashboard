#!/usr/bin/env python3
"""
champion-forward-logger.py — PAPER forward-test cho Evolver v2 champion (Calmar 7.16).
Chay dinh ky (cron moi gio). Fetch Binance live -> build 4h+1h bars -> eval champion
entry/exit tren bar MOI dong -> maintain paper book (equity-fraction, margin cap) -> ghi jsonl.
PAPER ONLY, khong order that. State persist giua cac lan chay.

Champion (f_funding=OFF, f_rsi=OFF -> chi can ADX/DI/EMA/ATR):
  BTC4h: ADX>18 DI+>DI-*0.9 px>EMA200(4h) px>=EMA200d*0.8 | SL1.6 TP12 hold70 cool2 pos7
  BTC1h: ADX>16 DI+>DI-*1.05 px>EMA200(1h) +4h-trend px>=EMA200d*0.8 | SL2.0 TP8 hold24 cool1 pos4
  ETH4h: ADX>18 DI+>DI-*1.3 px>EMA200(4h) ratio[0.85,1.1] | SL1.4 TP12 hold60 cool2 pos5
  risk=0.04/lenh equity-fraction, margin cap 1.0x, LEV 10
Usage: python3 champion-forward-logger.py
"""
import json, os, time, urllib.request, bisect, datetime, ssl
_SSL=ssl.create_default_context(); _SSL.check_hostname=False; _SSL.verify_mode=ssl.CERT_NONE
TOOLS=os.path.dirname(os.path.abspath(__file__))
STATE=os.path.join(TOOLS,"champion-forward-state.json")
LOG=os.path.join(TOOLS,"champion-forward-SIGNALS.jsonl")
BASE="https://fapi.binance.com"
LEV=10; RISK=0.04; CAP=1.0

def klines(sym,interval,limit=500):
    url=f"{BASE}/fapi/v1/klines?symbol={sym}&interval={interval}&limit={limit}"
    with urllib.request.urlopen(url,timeout=20,context=_SSL) as r: d=json.load(r)
    # [openTime, o,h,l,c,v, closeTime, ...]; chi lay bar DA DONG (bo bar cuoi dang chay)
    return [{"t":int(k[0]),"o":float(k[1]),"h":float(k[2]),"l":float(k[3]),"c":float(k[4])} for k in d[:-1]]

def ema(xs,p):
    k=2/(p+1); o=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); o[i]=e
    return o
def atr_s(bars,p=14):
    n=len(bars); o=[None]*n
    trs=[max(bars[i]["h"]-bars[i]["l"],abs(bars[i]["h"]-bars[i-1]["c"]),abs(bars[i]["l"]-bars[i-1]["c"])) for i in range(1,n)]
    if len(trs)<p: return o
    a=sum(trs[:p])/p; o[p]=a
    for i in range(p,len(trs)): a=(a*(p-1)+trs[i])/p; o[i+1]=a
    return o
def adx_di(bars,p=14):
    n=len(bars); ax=[None]*n; pd=[None]*n; md=[None]*n
    if n<p*3: return ax,pd,md
    tr=[];pdm=[];mdm=[]
    for i in range(1,n):
        h,l,pc=bars[i]["h"],bars[i]["l"],bars[i-1]["c"]
        tr.append(max(h-l,abs(h-pc),abs(l-pc)))
        up=h-bars[i-1]["h"]; dn=bars[i-1]["l"]-l
        pdm.append(up if up>dn and up>0 else 0); mdm.append(dn if dn>up and dn>0 else 0)
    def sm(xs):
        out=[None]*len(xs)
        if len(xs)<p: return out
        s=sum(xs[:p]); out[p-1]=s
        for i in range(p,len(xs)): out[i]=out[i-1]-out[i-1]/p+xs[i]
        return out
    a=sm(tr); ps=sm(pdm); ms=sm(mdm); dx=[None]*len(tr); pl=[None]*len(tr); ml=[None]*len(tr)
    for i in range(p-1,len(tr)):
        if a[i] and a[i]>0:
            pdi=100*ps[i]/a[i]; mdi=100*ms[i]/a[i]; pl[i]=pdi; ml[i]=mdi
            dx[i]=100*abs(pdi-mdi)/(pdi+mdi) if (pdi+mdi)>0 else 0
    av=[None]*len(dx); st=None
    for i in range(len(dx)):
        if dx[i] is not None:
            if st is None: st=i
            if i-st+1==p: av[i]=sum(v for v in dx[st:i+1] if v is not None)/p
            elif i>st+p-1 and av[i-1] is not None: av[i]=(av[i-1]*(p-1)+dx[i])/p
    for i in range(len(dx)): ax[i+1]=av[i]; pd[i+1]=pl[i]; md[i+1]=ml[i]
    return ax,pd,md

def atr_pctile(atr, i, lb=200):
    w=[x for x in atr[i-lb:i] if x is not None]
    if w and atr[i]: return sum(1 for x in w if x<atr[i])/len(w)
    return 0.5

def log_event(ev): 
    with open(LOG,"a") as f: f.write(json.dumps(ev)+"\n")

def main():
    now=int(time.time()*1000)
    # fetch
    b4=klines("BTCUSDT","4h",500); b1=klines("BTCUSDT","1h",1000)
    e4=klines("ETHUSDT","4h",500)
    bd=klines("BTCUSDT","1d",400); ed=klines("ETHUSDT","1d",400)
    # indicators
    def prep(bars):
        c=[x["c"] for x in bars]
        return dict(bars=bars,c=c,e200=ema(c,200),e20=ema(c,20),atr=atr_s(bars,14),
                    adx=adx_di(bars,14))
    P4=prep(b4); P1=prep(b1); PE=prep(e4)
    e200d_btc=ema([x["c"] for x in bd],200); td_btc=[x["t"] for x in bd]
    e200d_eth=ema([x["c"] for x in ed],200); td_eth=[x["t"] for x in ed]
    def e200d_at(tlist,evals,t): j=bisect.bisect_right(tlist,t)-1; return evals[j] if 0<=j<len(evals) else None

    fresh = not os.path.exists(STATE)
    if fresh:
        # forward-test bat dau tu NOW: set last = bar moi nhat, KHONG backfill lich su
        last0={"b4":b4[-1]["t"],"b1":b1[-1]["t"],"e4":e4[-1]["t"]}
        st=dict(equity=100000.0,positions=[],last=last0)
        log_event(dict(event="START",time=now,equity=100000.0,note="forward-test paper start, champion Calmar 7.16"))
    else:
        st=json.load(open(STATE))
    eq=st["equity"]; pos=st["positions"]; last=st["last"]
    margin_used=sum(p["margin"] for p in pos)

    def process_sleeve(P, key, sleeve, last_key, exit_check, entry_check, daily_t, daily_e):
        nonlocal eq, margin_used
        bars=P["bars"]; adx,pd,md=P["adx"]
        for i in range(200,len(bars)):
            t=bars[i]["t"]
            if t<=last[last_key]: continue
            # EXITS: check open positions of this sleeve on this new bar
            still=[]
            for p in pos:
                if p["sleeve"]!=sleeve: still.append(p); continue
                px=bars[i]["c"]; done=False; why=""
                if bars[i]["l"]<=p["sl"]: px=p["sl"]; done=True; why="SL"
                elif bars[i]["h"]>=p["tp"]: px=p["tp"]; done=True; why="TP"
                elif P["e20"][i] and bars[i]["c"]<P["e20"][i] and (i-p["ebar"])>=p["minhold"]: done=True; why="EMA20"
                elif (i-p["ebar"])>=p["maxhold"]: done=True; why="HOLD"
                if done:
                    pnl=(px-p["epx"])/p["epx"]*p["margin"]*LEV-0.0006*p["margin"]
                    eq+=pnl; margin_used-=p["margin"]
                    log_event(dict(event="EXIT",sleeve=sleeve,time=t,exitPx=px,why=why,pnlUsd=round(pnl,2),equity=round(eq,2)))
                else: still.append(p)
            pos[:]=still
            # ENTRY
            fire,detail=entry_check(P,i,daily_t,daily_e)
            if fire:
                npos=sum(1 for p in pos if p["sleeve"]==sleeve)
                lastentry=max([p["ebar"] for p in pos if p["sleeve"]==sleeve and p.get("_bk")==key],default=-999)
                if npos<detail["maxpos"]:
                    vs=max(0.3,1.0-atr_pctile(P["atr"],i))
                    margin=RISK*eq*vs
                    if margin_used+margin<=CAP*eq and margin>0:
                        px=bars[i]["c"]; at=P["atr"][i]
                        p=dict(sleeve=sleeve,_bk=key,epx=px,sl=px-detail["sl"]*at,tp=px+detail["tp"]*at,
                               ebar=i,minhold=detail["minhold"],maxhold=detail["maxhold"],margin=margin)
                        pos.append(p); margin_used+=margin
                        log_event(dict(event="ENTRY",sleeve=sleeve,time=t,entryPx=round(px,2),
                                       sl=round(p["sl"],2),tp=round(p["tp"],2),marginUsd=round(margin,2),equity=round(eq,2)))
            last[last_key]=t

    # entry checks
    def btc4_entry(P,i,td,te):
        a,pp,mm=P["adx"][0][i],P["adx"][1][i],P["adx"][2][i]; e2=P["e200"][i]; at=P["atr"][i]; px=P["c"][i]
        if None in (a,pp,mm,e2,at): return False,{}
        e2d=e200d_at(td,te,P["bars"][i]["t"])
        if e2d is None: return False,{}
        ok=a>18 and pp>mm*0.9 and px>e2 and px>=e2d*0.8
        return ok,dict(maxpos=7,sl=1.6,tp=12,minhold=10,maxhold=70)
    def eth_entry(P,i,td,te):
        a,pp,mm=P["adx"][0][i],P["adx"][1][i],P["adx"][2][i]; e2=P["e200"][i]; at=P["atr"][i]; px=P["c"][i]
        if None in (a,pp,mm,e2,at): return False,{}
        e2d=e200d_at(td,te,P["bars"][i]["t"])
        if e2d is None: return False,{}
        ratio=px/e2d
        ok=a>18 and pp>mm*1.3 and px>e2 and 0.85<=ratio<=1.1
        return ok,dict(maxpos=5,sl=1.4,tp=12,minhold=10,maxhold=60)
    def btc1_entry(P,i,td,te):
        a,pp,mm=P["adx"][0][i],P["adx"][1][i],P["adx"][2][i]; e2=P["e200"][i]; at=P["atr"][i]; px=P["c"][i]
        if None in (a,pp,mm,e2,at): return False,{}
        e2d=e200d_at(td,te,P["bars"][i]["t"])
        if e2d is None: return False,{}
        # 4h trend active gate
        t4=[x["t"] for x in P4["bars"]]; j=bisect.bisect_right(t4,P["bars"][i]["t"])-1
        if j<0 or P4["adx"][0][j] is None: return False,{}
        if not(P4["adx"][0][j]>18 and P4["adx"][1][j]>P4["adx"][2][j]*0.95 and P4["c"][j]>P4["e200"][j]): return False,{}
        ok=a>16 and pp>mm*1.05 and px>e2 and px>=e2d*0.8
        return ok,dict(maxpos=4,sl=2.0,tp=8,minhold=4,maxhold=24)

    process_sleeve(P4,"b4","BTC4h","b4",None,btc4_entry,td_btc,e200d_btc)
    process_sleeve(PE,"e4","ETH4h","e4",None,eth_entry,td_eth,e200d_eth)
    process_sleeve(P1,"b1","BTC1h","b1",None,btc1_entry,td_btc,e200d_btc)

    st=dict(equity=eq,positions=pos,last=last,updated=now)
    json.dump(st,open(STATE,"w"),indent=1)
    log_event(dict(event="HEARTBEAT",time=now,equity=round(eq,2),openPos=len(pos),marginUsed=round(margin_used,2)))
    print(f"[{datetime.datetime.fromtimestamp(now/1000,datetime.UTC):%Y-%m-%d %H:%M}] equity=${eq:,.0f} openPos={len(pos)} margin=${margin_used:,.0f}")

if __name__=="__main__": main()
