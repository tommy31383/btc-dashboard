#!/bin/bash
cd /Users/lap16116/BTC_PC/btc-dashboard
R=0
while true; do
  if [ -f tools/evolver-WATCHDOG-STOP ]; then
    echo "$(date '+%F %T') watchdog: stop requested, exit (restarts=$R)" >> tools/evolver-watchdog.log
    rm -f tools/evolver-WATCHDOG-STOP; break
  fi
  if ! pgrep -f "general-rule-evolver-v3.py" >/dev/null 2>&1; then
    if [ -f tools/evolver-STOP ]; then sleep 20; continue; fi
    R=$((R+1))
    echo "$(date '+%F %T') watchdog: daemon down -> restart #$R" >> tools/evolver-watchdog.log
    POP=24 WORKERS=5 nohup python3 tools/general-rule-evolver-v3.py >> tools/evolver-v2-live.log 2>&1 &
    sleep 60
  fi
  sleep 45
done
