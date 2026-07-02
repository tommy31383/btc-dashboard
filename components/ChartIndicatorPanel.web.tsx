import React, { useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import ChartIndicatorPanel from "./ChartIndicatorPanelContent";
import { IndicatorKey } from "../utils/chartIndicators";

interface Props {
  visible: boolean;
  onClose: () => void;
  enabled: IndicatorKey[];
  onToggle: (key: IndicatorKey) => void;
  onReset: () => void;
}

// Absolutely-positioned popover anchored under the trigger button, with a
// dismiss-on-outside-click listener (web-only — uses DOM APIs directly,
// which is why this lives in the .web.tsx split rather than the shared
// content component).
export default function ChartIndicatorPanelWeb({ visible, onClose, enabled, onToggle, onReset }: Props) {
  const wrapperRef = useRef<View>(null);

  useEffect(() => {
    if (!visible) return;
    const handleClickOutside = (e: MouseEvent) => {
      const node = wrapperRef.current as unknown as HTMLElement | null;
      if (node && !node.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <View ref={wrapperRef} style={styles.popover}>
      <ChartIndicatorPanel enabled={enabled} onToggle={onToggle} onReset={onReset} />
    </View>
  );
}

const styles = StyleSheet.create({
  popover: {
    position: "absolute",
    top: 40,
    right: 8,
    zIndex: 50,
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  },
});
