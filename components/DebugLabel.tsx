/**
 * DebugLabel — small badge ở góc trên-trái của panel hiển thị tên component.
 * Mục đích: Tommy nhìn vào màn hình là biết tên file/component → chỉ rõ "sửa cái nào".
 *
 * Toggle ON/OFF qua AsyncStorage key `@show_debug_labels` (default ON).
 * Module-level cache + subscribe → đổi setting là tất cả label re-render đồng bộ.
 */
import React, { useEffect, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@show_debug_labels";

let cachedEnabled = true;        // optimistic default — hiện ngay từ mount đầu
let hydrated = false;
const listeners = new Set<(v: boolean) => void>();

export async function hydrateDebugLabels(): Promise<void> {
  if (hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw !== null) cachedEnabled = raw === "1";
  } catch { /* keep default */ }
  hydrated = true;
  listeners.forEach((fn) => fn(cachedEnabled));
}

export function getDebugLabelsEnabled(): boolean { return cachedEnabled; }

export async function setDebugLabelsEnabled(v: boolean): Promise<void> {
  cachedEnabled = v;
  try { await AsyncStorage.setItem(KEY, v ? "1" : "0"); } catch {}
  listeners.forEach((fn) => fn(v));
}

function useDebugLabelsEnabled(): boolean {
  const [v, setV] = useState(cachedEnabled);
  useEffect(() => {
    if (!hydrated) hydrateDebugLabels();
    const fn = (next: boolean) => setV(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return v;
}

interface Props {
  /** Tên component / file để Tommy chỉ rõ — vd "RuleAlertBanner", "LiveTab > SettingsCard" */
  name: string;
}

/**
 * Render inline ở đầu panel — đẩy content xuống một chút thay vì floating đè title.
 * Style: tag nhỏ, alignSelf flex-start, không chiếm full width.
 */
export default function DebugLabel({ name }: Props) {
  const enabled = useDebugLabelsEnabled();
  if (!enabled) return null;
  return (
    <View style={styles.tag} pointerEvents="none">
      <Text style={styles.text}>[{name}]</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    marginBottom: 4,
  },
  text: {
    color: "#ffd166",
    fontSize: 9,
    fontFamily: "monospace",
    letterSpacing: 0.5,
  },
});
