export function oversoldThreshold(mode: string): number {
  if (mode.startsWith("K5")) return 5;
  if (mode.startsWith("K10")) return 10;
  if (mode.startsWith("K30")) return 30;
  return 20;
}
