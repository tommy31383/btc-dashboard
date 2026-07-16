export function settleLong(entryPrice: number, exitPrice: number, feeRate: number, slippageRate: number): number {
  const filledEntry = entryPrice * (1 + slippageRate);
  const filledExit = exitPrice * (1 - slippageRate);
  const gross = (exitPrice - entryPrice) / entryPrice;
  const slippage = ((filledEntry - entryPrice) + (exitPrice - filledExit)) / entryPrice;
  const fees = (filledEntry + filledExit) * feeRate / entryPrice;
  return gross - slippage - fees;
}
