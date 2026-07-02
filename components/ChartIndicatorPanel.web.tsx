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
  // The trigger button's DOM node, so the outside-click listener can
  // exclude it — without this, clicking the trigger to CLOSE an open
  // popover fires `mousedown` (closes it here) then `click` (the trigger's
  // own onPress toggles it back open), so it never actually closes.
  triggerNode?: HTMLElement | null;
}

// Absolutely-positioned popover anchored under the trigger button, with a
// dismiss-on-outside-click listener (web-only — uses DOM APIs directly,
// which is why this lives in the .web.tsx split rather than the shared
// content component).
export default function ChartIndicatorPanelWeb({ visible, onClose, enabled, onToggle, onReset, triggerNode }: Props) {
  const wrapperRef = useRef<View>(null);

  useEffect(() => {
    if (!visible) return;
    const handleClickOutside = (e: MouseEvent) => {
      const node = wrapperRef.current as unknown as HTMLElement | null;
      const target = e.target as Node;
      if (node && node.contains(target)) return;
      if (triggerNode && triggerNode.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [visible, onClose, triggerNode]);

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
