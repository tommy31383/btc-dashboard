export interface EpisodeState {
  active: boolean;
  entered: boolean;
}

export function isOversoldEpisodeStart(
  previousK: number | null,
  currentK: number | null,
  threshold: number,
): boolean {
  return previousK !== null && currentK !== null && previousK >= threshold && currentK < threshold;
}

export function pullbackZoneTouched(low: number, high: number, zone: number): boolean {
  return low <= zone && high >= zone;
}

export function shouldFireEpisodeEntry(state: EpisodeState, triggerReady: boolean): boolean {
  return state.active && !state.entered && triggerReady;
}

export function shouldFireMacroBackedEntry(
  state: EpisodeState,
  macroBullish: boolean,
  triggerReady: boolean,
): boolean {
  return shouldFireEpisodeEntry(state, macroBullish && triggerReady);
}

export function higherLowReclaim(
  previousLow: number,
  previousHigh: number,
  currentLow: number,
  currentHigh: number,
): boolean {
  return currentLow > previousLow && currentHigh > previousHigh;
}
