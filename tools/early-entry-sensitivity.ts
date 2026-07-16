export function signalGapAllowed(signalIndex: number, lastSignalIndex: number, minimumGapBars: number): boolean {
  return lastSignalIndex < 0 || signalIndex - lastSignalIndex >= minimumGapBars;
}
