import React, { useState } from "react";
import { View, Text, StyleSheet, Switch, TextInput } from "react-native";
import { COLORS, Settings } from "../utils/constants";
import { P } from "../utils/v2Theme";
import DebugLabel, { getDebugLabelsEnabled, setDebugLabelsEnabled } from "./DebugLabel";

interface Props {
  visible: boolean;
  settings: Settings;
  onUpdate: (settings: Settings) => void;
}

interface ToggleRowProps {
  label: string;
  value: boolean;
  onToggle: (v: boolean) => void;
  desc?: string;
}

function ToggleRow({ label, value, onToggle, desc }: ToggleRowProps) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleInfo}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {desc && <Text style={styles.toggleDesc}>{desc}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: P.border, true: P.orange + "66" }}
        thumbColor={value ? P.orange : P.dim}
      />
    </View>
  );
}

export default function SettingsPanel({ visible, settings, onUpdate }: Props) {
  const [obText, setObText] = useState(String(settings.overboughtLevel));
  const [osText, setOsText] = useState(String(settings.oversoldLevel));
  const [minScoreText, setMinScoreText] = useState(String(settings.notifyMinScore));
  const [debugLabels, setDebugLabels] = useState(getDebugLabelsEnabled());

  if (!visible) return null;

  const update = (key: keyof Settings, value: any) => {
    onUpdate({ ...settings, [key]: value });
  };

  const validateAndSetOB = (text: string) => {
    setObText(text);
    const n = parseInt(text, 10);
    if (!isNaN(n) && n >= 50 && n <= 100) update("overboughtLevel", n);
  };

  const validateAndSetOS = (text: string) => {
    setOsText(text);
    const n = parseInt(text, 10);
    if (!isNaN(n) && n >= 1 && n <= 50) update("oversoldLevel", n);
  };

  const validateAndSetMinScore = (text: string) => {
    setMinScoreText(text);
    const n = parseInt(text, 10);
    if (!isNaN(n) && n >= 1 && n <= 5) update("notifyMinScore", n);
  };

  return (
    <View style={styles.container}>
      <DebugLabel name="SettingsPanel" />
      <Text style={styles.title}>CÀI ĐẶT</Text>

      <View style={styles.grid}>
        <ToggleRow
          label="🏷️ Hiện label component"
          value={debugLabels}
          onToggle={(v) => { setDebugLabels(v); setDebugLabelsEnabled(v); }}
          desc="Badge nhỏ góc trên-trái mỗi panel để biết tên file/component"
        />
      </View>
      <View style={styles.divider} />

      <View style={styles.grid}>
        <ToggleRow
          label="📳 Rung"
          value={settings.soundEnabled}
          onToggle={(v) => update("soundEnabled", v)}
          desc="Rung điện thoại khi có cảnh báo mới"
        />
        <ToggleRow
          label="🔥 RSI Quá Mua"
          value={settings.overboughtAlert}
          onToggle={(v) => update("overboughtAlert", v)}
          desc="Cảnh báo khi RSI > ngưỡng quá mua"
        />
        <ToggleRow
          label="💎 RSI Quá Bán"
          value={settings.oversoldAlert}
          onToggle={(v) => update("oversoldAlert", v)}
          desc="Cảnh báo khi RSI < ngưỡng quá bán"
        />
        <ToggleRow
          label="⚠️ Phân kỳ"
          value={settings.divergenceAlert}
          onToggle={(v) => update("divergenceAlert", v)}
          desc="Phân kỳ giá vs RSI (tín hiệu đảo chiều)"
        />
        <ToggleRow
          label="🚨 Đa khung RSI"
          value={settings.multiTfAlert}
          onToggle={(v) => update("multiTfAlert", v)}
          desc="≥2 khung thời gian cùng quá mua/quá bán"
        />
        <ToggleRow
          label="📈 StochRSI"
          value={settings.stochRsiAlert}
          onToggle={(v) => update("stochRsiAlert", v)}
          desc="Cảnh báo StochRSI > 80 hoặc < 20"
        />
        <ToggleRow
          label="⚡ StochRSI kề nhau"
          value={settings.stochRsiAdjacentAlert}
          onToggle={(v) => update("stochRsiAdjacentAlert", v)}
          desc="2 khung KỀ NHAU cùng > 80 hoặc < 20 → Quay đầu"
        />
      </View>

      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>🔔 THÔNG BÁO PUSH</Text>

      <View style={styles.grid}>
        <ToggleRow
          label="🔔 Tín hiệu vào lệnh"
          value={settings.notifyEntrySignal}
          onToggle={(v) => update("notifyEntrySignal", v)}
          desc="Push notification khi có tín hiệu LONG/SHORT mới"
        />
      </View>

      <View style={styles.inputRow}>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Score tối thiểu để báo (1-5)</Text>
          <TextInput
            style={[styles.input, minScoreText !== "" && (parseInt(minScoreText, 10) < 1 || parseInt(minScoreText, 10) > 5) && styles.inputError]}
            value={minScoreText}
            onChangeText={validateAndSetMinScore}
            onBlur={() => setMinScoreText(String(settings.notifyMinScore))}
            keyboardType="numeric"
            maxLength={1}
            placeholderTextColor={COLORS.textMuted}
          />
        </View>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Score hiện tại</Text>
          <View style={[styles.input, styles.scoreHint]}>
            <Text style={styles.scoreHintText}>
              Chỉ báo tín hiệu ≥ {settings.notifyMinScore}/5
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>📊 NGƯỠNG RSI</Text>

      <View style={styles.inputRow}>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Ngưỡng Quá Mua (50-100)</Text>
          <TextInput
            style={[styles.input, obText !== "" && (parseInt(obText, 10) < 50 || parseInt(obText, 10) > 100) && styles.inputError]}
            value={obText}
            onChangeText={validateAndSetOB}
            onBlur={() => setObText(String(settings.overboughtLevel))}
            keyboardType="numeric"
            maxLength={3}
            placeholderTextColor={COLORS.textMuted}
          />
        </View>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Ngưỡng Quá Bán (1-50)</Text>
          <TextInput
            style={[styles.input, osText !== "" && (parseInt(osText, 10) < 1 || parseInt(osText, 10) > 50) && styles.inputError]}
            value={osText}
            onChangeText={validateAndSetOS}
            onBlur={() => setOsText(String(settings.oversoldLevel))}
            keyboardType="numeric"
            maxLength={2}
            placeholderTextColor={COLORS.textMuted}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: P.card,
    borderRadius: 2,
    padding: 14,
    paddingLeft: 18,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: P.primaryContainer,
  },
  title: {
    color: P.text,
    fontSize: 12,
    fontWeight: "700",
    fontFamily: "SpaceGrotesk_700Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  grid: {
    gap: 2,
  },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: P.borderSoft,
  },
  toggleInfo: {
    flex: 1,
    marginRight: 8,
  },
  toggleLabel: {
    color: P.text,
    fontSize: 12,
    fontFamily: "monospace",
  },
  toggleDesc: {
    color: P.dim,
    fontSize: 9,
    fontFamily: "monospace",
    marginTop: 1,
  },
  inputRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
  },
  inputGroup: {
    flex: 1,
  },
  inputLabel: {
    color: P.dim,
    fontSize: 9,
    fontFamily: "monospace",
    letterSpacing: 1,
    marginBottom: 4,
  },
  input: {
    backgroundColor: P.surface,
    color: P.text,
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 0,
    padding: 10,
    fontSize: 14,
    fontFamily: "monospace",
    fontWeight: "700",
    textAlign: "center",
  },
  inputError: {
    borderColor: P.red,
    backgroundColor: P.red + "10",
  },
  divider: {
    height: 1,
    backgroundColor: P.border,
    marginTop: 14,
    marginBottom: 10,
  },
  sectionTitle: {
    color: P.primaryContainer,
    fontSize: 10,
    fontWeight: "700",
    fontFamily: "SpaceGrotesk_700Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  scoreHint: {
    justifyContent: "center",
    alignItems: "center",
  },
  scoreHintText: {
    color: P.dim,
    fontSize: 10,
    fontFamily: "monospace",
    textAlign: "center",
  },
});
