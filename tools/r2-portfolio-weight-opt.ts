/**
 * r2-portfolio-weight-opt.ts — Portfolio weight optimization BTC vs ETH.
 *
 * Uses existing monthly PnL series từ audit_eth_v046_deep_3y.json (BTC + ETH baseline).
 * Sweep weights 0-100% BTC. Compute portfolio ROI/DD/RA/Sharpe.
 * Find optimal: max RA, max Sharpe, min DD, risk-parity (inverse vol).
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface SymbolAudit {
  symbol: string;
  byMonth: Record<string, { closes: number; wins: number; pnl: number }>;
  overall: any;
  stats: any;
}

function monthlyArrFromAudit(s: SymbolAudit, allMonths: string[]): number[] {
  return allMonths.map(m => s.byMonth[m]?.pnl ?? 0);
}

function calcStats(monthly: number[], initialCapital: number) {
  let equity = initialCapital, peak = initialCapital, trough = initialCapital;
  let cumulative = 0;
  const equityCurve: number[] = [];
  for (const p of monthly) {
    cumulative += p;
    equity = initialCapital + cumulative;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    if (equity < trough) trough = equity;
  }
  const finalROI = (equity - initialCapital) / initialCapital * 100;
  const maxDD = (peak - trough) / peak * 100;
  const ra = maxDD > 0 ? finalROI / maxDD : (finalROI > 0 ? 999 : 0);
  // Monthly returns
  const monthlyReturns = monthly.map(p => p / initialCapital * 100);
  const meanM = monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length;
  const stdM = Math.sqrt(monthlyReturns.reduce((s, v) => s + (v - meanM) ** 2, 0) / Math.max(1, monthlyReturns.length - 1));
  const sharpe = stdM > 0 ? (meanM / stdM) * Math.sqrt(12) : 0;  // annualized
  // Sortino (downside dev)
  const downside = monthlyReturns.filter(r => r < 0);
  const downStd = downside.length > 0 ? Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / downside.length) : 0;
  const sortino = downStd > 0 ? (meanM / downStd) * Math.sqrt(12) : 0;
  // Max consecutive losing months
  let curLoss = 0, maxLoss = 0;
  for (const r of monthlyReturns) { if (r < 0) { curLoss++; if (curLoss > maxLoss) maxLoss = curLoss; } else curLoss = 0; }

  return {
    finalROI: +finalROI.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(3),
    sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2),
    monthlyVol: +stdM.toFixed(3), maxConsecLossMonths: maxLoss,
    posMonths: monthlyReturns.filter(r => r > 0).length,
    negMonths: monthlyReturns.filter(r => r < 0).length,
    bestMonth: +Math.max(...monthlyReturns).toFixed(2),
    worstMonth: +Math.min(...monthlyReturns).toFixed(2),
  };
}

function main() {
  console.log("[r2-weight-opt] Loading audit data...");
  const audit = JSON.parse(readFileSync(join(__dirname, "..", "assets", "audit_eth_v046_deep_3y.json"), "utf8"));
  const btc = audit.btc as SymbolAudit;
  const eth = audit.eth as SymbolAudit;

  // Collect all months
  const allMonths = Array.from(new Set([...Object.keys(btc.byMonth), ...Object.keys(eth.byMonth)])).sort();
  const btcMonthly = monthlyArrFromAudit(btc, allMonths);
  const ethMonthly = monthlyArrFromAudit(eth, allMonths);
  console.log(`  Months: ${allMonths.length} (${allMonths[0]} → ${allMonths[allMonths.length - 1]})`);

  const INIT = 100_000;
  const btcStats = calcStats(btcMonthly, INIT);
  const ethStats = calcStats(ethMonthly, INIT);
  console.log(`\nBTC standalone: ROI ${btcStats.finalROI}% DD ${btcStats.maxDD}% RA ${btcStats.ra} Sharpe ${btcStats.sharpe}`);
  console.log(`ETH standalone: ROI ${ethStats.finalROI}% DD ${ethStats.maxDD}% RA ${ethStats.ra} Sharpe ${ethStats.sharpe}`);

  // Correlation BTC vs ETH monthly
  const meanBTC = btcMonthly.reduce((a, b) => a + b, 0) / btcMonthly.length;
  const meanETH = ethMonthly.reduce((a, b) => a + b, 0) / ethMonthly.length;
  let cov = 0, varBTC = 0, varETH = 0;
  for (let i = 0; i < btcMonthly.length; i++) {
    cov += (btcMonthly[i] - meanBTC) * (ethMonthly[i] - meanETH);
    varBTC += (btcMonthly[i] - meanBTC) ** 2;
    varETH += (ethMonthly[i] - meanETH) ** 2;
  }
  const correlation = cov / Math.sqrt(varBTC * varETH);
  console.log(`\n📊 BTC vs ETH monthly correlation: ${correlation.toFixed(3)}`);

  // Weight sweep
  console.log("\n=== WEIGHT SWEEP (BTC %) ===");
  console.log("BTC% | ETH% | ROI%  | DD%  | RA    | Sharpe | Sortino | MonthlyVol | PosM/Neg | MaxConsecL | Best%  | Worst%");
  console.log("-".repeat(120));
  const sweepResults: any[] = [];
  for (let pct = 0; pct <= 100; pct += 10) {
    const wBTC = pct / 100, wETH = 1 - wBTC;
    const portMonthly = btcMonthly.map((b, i) => wBTC * b + wETH * ethMonthly[i]);
    const s = calcStats(portMonthly, INIT);
    sweepResults.push({ btcPct: pct, ...s });
    console.log(
      `${String(pct).padStart(3)}  | ${String(100 - pct).padStart(3)}  | ${String(s.finalROI).padStart(5)} | ${String(s.maxDD).padStart(4)} | ${String(s.ra).padStart(5)} | ${String(s.sharpe).padStart(6)} | ${String(s.sortino).padStart(7)} | ${String(s.monthlyVol).padStart(10)} | ${String(s.posMonths)}/${String(s.negMonths)} | ${String(s.maxConsecLossMonths).padStart(10)} | ${String(s.bestMonth).padStart(6)} | ${String(s.worstMonth).padStart(6)}`
    );
  }

  // Risk parity: weight inversely proportional to vol
  const wBTCRP = (1 / btcStats.monthlyVol) / (1 / btcStats.monthlyVol + 1 / ethStats.monthlyVol);
  const wETHRP = 1 - wBTCRP;
  const portRP = btcMonthly.map((b, i) => wBTCRP * b + wETHRP * ethMonthly[i]);
  const rpStats = calcStats(portRP, INIT);
  console.log(`\n📐 RISK PARITY (inverse vol): BTC ${(wBTCRP * 100).toFixed(1)}% / ETH ${(wETHRP * 100).toFixed(1)}%`);
  console.log(`  ROI ${rpStats.finalROI}% DD ${rpStats.maxDD}% RA ${rpStats.ra} Sharpe ${rpStats.sharpe} Sortino ${rpStats.sortino}`);

  // Sharpe parity: weight proportional to Sharpe
  const sBTC = Math.max(0, btcStats.sharpe);
  const sETH = Math.max(0, ethStats.sharpe);
  const wBTCSP = sBTC / (sBTC + sETH);
  const wETHSP = 1 - wBTCSP;
  const portSP = btcMonthly.map((b, i) => wBTCSP * b + wETHSP * ethMonthly[i]);
  const spStats = calcStats(portSP, INIT);
  console.log(`\n📐 SHARPE-WEIGHTED: BTC ${(wBTCSP * 100).toFixed(1)}% / ETH ${(wETHSP * 100).toFixed(1)}%`);
  console.log(`  ROI ${spStats.finalROI}% DD ${spStats.maxDD}% RA ${spStats.ra} Sharpe ${spStats.sharpe} Sortino ${spStats.sortino}`);

  // Find optima
  const byRA = [...sweepResults].sort((a, b) => b.ra - a.ra);
  const bySharpe = [...sweepResults].sort((a, b) => b.sharpe - a.sharpe);
  const bySortino = [...sweepResults].sort((a, b) => b.sortino - a.sortino);
  const byMinDD = [...sweepResults].sort((a, b) => a.maxDD - b.maxDD);
  console.log("\n🏆 OPTIMA");
  console.log(`  Max RA:      BTC ${byRA[0].btcPct}% / ETH ${100 - byRA[0].btcPct}% → RA ${byRA[0].ra}, ROI ${byRA[0].finalROI}%, DD ${byRA[0].maxDD}%`);
  console.log(`  Max Sharpe:  BTC ${bySharpe[0].btcPct}% / ETH ${100 - bySharpe[0].btcPct}% → Sharpe ${bySharpe[0].sharpe}, ROI ${bySharpe[0].finalROI}%`);
  console.log(`  Max Sortino: BTC ${bySortino[0].btcPct}% / ETH ${100 - bySortino[0].btcPct}% → Sortino ${bySortino[0].sortino}`);
  console.log(`  Min DD:      BTC ${byMinDD[0].btcPct}% / ETH ${100 - byMinDD[0].btcPct}% → DD ${byMinDD[0].maxDD}%, ROI ${byMinDD[0].finalROI}%`);

  // Per-year breakdown for top 3 weights
  console.log("\n=== TOP 3 WEIGHTS BY RA — Per-year ===");
  const monthYearMap: Record<string, string[]> = {};
  for (const m of allMonths) { const y = m.slice(0, 4); monthYearMap[y] = monthYearMap[y] ?? []; monthYearMap[y].push(m); }
  for (const top of byRA.slice(0, 3)) {
    const w = top.btcPct / 100;
    const port = btcMonthly.map((b, i) => w * b + (1 - w) * ethMonthly[i]);
    let cum = 0;
    const yearPnL: Record<string, number> = {};
    for (let i = 0; i < allMonths.length; i++) {
      const y = allMonths[i].slice(0, 4);
      yearPnL[y] = (yearPnL[y] ?? 0) + port[i];
    }
    const years = Object.entries(yearPnL).sort().map(([y, p]) => `${y}=${p >= 0 ? '+' : ''}${p.toFixed(0)}`).join(' ');
    console.log(`BTC ${top.btcPct}%/ETH ${100 - top.btcPct}% (RA ${top.ra}): ${years}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "r2_portfolio_weight_opt.json"), JSON.stringify({
    btcStats, ethStats, correlation: +correlation.toFixed(3),
    sweepResults,
    riskParity: { wBTC: +(wBTCRP * 100).toFixed(1), wETH: +(wETHRP * 100).toFixed(1), ...rpStats },
    sharpeWeighted: { wBTC: +(wBTCSP * 100).toFixed(1), wETH: +(wETHSP * 100).toFixed(1), ...spStats },
    optima: { byRA: byRA[0], bySharpe: bySharpe[0], bySortino: bySortino[0], byMinDD: byMinDD[0] },
  }, null, 2));
  console.log("\nWritten assets/r2_portfolio_weight_opt.json");
}

main();
