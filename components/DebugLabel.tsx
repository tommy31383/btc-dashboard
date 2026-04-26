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
  /** Không floating — render inline ở đầu panel (dùng khi parent có overflow:hidden) */
  inline?: boolean;
}

export default function DebugLabel({ name, inline }: Props) {
  const enabled = useDebugLabelsEnabled();
  if (!enabled) return null;
  return (
    <View style={inline ? styles.inline : styles.floating} pointerEvents="none">
      <Text style={styles.text}>[{name}]</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  floating: {
    position: "absolute",
    top: 2,
    left: 4,
    zIndex: 999,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  inline: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(0,0,0,0.4)",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    marginBottom: 2,
  },
  text: {
    color: "#ffd166",
    fontSize: 9,
    fontFamily: "monospace",
    letterSpacing: 0.5,
  },
});
