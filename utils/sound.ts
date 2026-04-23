import { Vibration, Platform } from "react-native";

export type AlertSoundType = "danger" | "bullish" | "warning";

// Vibration patterns: [wait, vibrate, wait, vibrate, ...]
const VIBRATION_PATTERNS: Record<AlertSoundType, number[]> = {
  danger: Platform.OS === "android" ? [0, 200, 100, 200, 100, 400] : [200, 100, 200, 100, 400],
  bullish: Platform.OS === "android" ? [0, 150, 80, 150] : [150, 80, 150],
  warning: Platform.OS === "android" ? [0, 100, 50, 100, 50, 100] : [100, 50, 100, 50, 100],
};

export function playAlertSound(type: AlertSoundType): void {
  try {
    const pattern = VIBRATION_PATTERNS[type];
    Vibration.vibrate(pattern);
  } catch {
    // Silently fail
  }
}
