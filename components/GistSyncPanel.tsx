/**
 * GistSyncPanel — UI để setup GitHub Gist sync cho paper trade journal.
 *
 * Default collapsed. User nhập PAT (scope `gist`) + Gist ID (hoặc bấm
 * "Tạo Gist mới" để app tự tạo). Sau đó mỗi lần paper trade thay đổi sẽ
 * tự push lên gist (debounce 3s). Bấm "Pull ngay" để kéo về thủ công.
 */
import React, { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { P } from "../utils/v2Theme";
import {
  getGistConfig, setGistConfig, clearGistConfig,
  pullFromGist, pushToGist, mergeTrades,
} from "../utils/gistSync";
import { loadTrades, replaceTrades } from "../utils/paperTrader";

interface Props {
  /** Callback when local trades got updated by a Pull (so parent can refresh UI). */
  onTradesReplaced?: () => void;
}

export default function GistSyncPanel({ onTradesReplaced }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [pat, setPat] = useState("");
  const [lastSyncMs, setLastSyncMs] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      const c = await getGistConfig();
      if (c.pat) setPat(c.pat);
      setLastSyncMs(c.lastSyncMs);
    })();
  }, []);

  const isConfigured = pat.length > 0;

  async function handleSave() {
    if (!pat.trim()) {
      setMsg({ text: "Cần PAT", ok: false });
      return;
    }
    await setGistConfig(pat.trim());
    setMsg({ text: "Đã lưu PAT ✓", ok: true });
  }

  async function handlePush() {
    setBusy("push");
    setMsg(null);
    try {
      const trades = await loadTrades();
      const ok = await pushToGist(trades);
      if (ok) {
        const c = await getGistConfig();
        setLastSyncMs(c.lastSyncMs);
        setMsg({ text: `Push ${trades.length} lệnh ✓`, ok: true });
      } else {
        setMsg({ text: "Push fail (xem console)", ok: false });
      }
    } finally {
      setBusy(null);
    }
  }

  async function handlePull() {
    setBusy("pull");
    setMsg(null);
    try {
      const remote = await pullFromGist();
      if (!remote) {
        setMsg({ text: "Pull fail (xem console)", ok: false });
        return;
      }
      const local = await loadTrades();
      const merged = mergeTrades(local, remote.trades || []);
      await replaceTrades(merged);
      onTradesReplaced?.();
      setMsg({ text: `Pull ${remote.trades?.length || 0} lệnh, merge → ${merged.length} ✓`, ok: true });
    } finally {
      setBusy(null);
    }
  }

  function handleClear() {
    if (typeof window !== "undefined" && !window.confirm("Xoá PAT khỏi máy?")) return;
    clearGistConfig().then(() => {
      setPat("");
      setLastSyncMs(0);
      setMsg({ text: "Đã xoá PAT", ok: true });
    });
  }

  const lastSyncText = lastSyncMs
    ? new Date(lastSyncMs).toLocaleString("vi-VN", { hour12: false })
    : "—";

  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={() => setCollapsed((v) => !v)} style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>☁️ REPO SYNC · PAPER JOURNAL</Text>
          <Text style={styles.subtitle}>
            {isConfigured ? `Connected · last ${lastSyncText}` : "Chưa setup — bấm để dán PAT"}
          </Text>
        </View>
        <Text style={styles.chevron}>{collapsed ? "▾" : "▴"}</Text>
      </TouchableOpacity>

      {!collapsed && (
        <View style={styles.body}>
          <Text style={styles.help}>
            Lưu lịch sử paper trade thẳng vào file{" "}
            <Text style={styles.code}>data/paper_trades.json</Text> trong repo
            project. Cần PAT scope{" "}
            <Text style={styles.code}>Contents: read+write</Text> (fine-grained,
            tạo tại github.com/settings/tokens?type=beta). App tự push mỗi 5s
            sau khi trade thay đổi.
          </Text>

          <Text style={styles.label}>GitHub PAT</Text>
          <TextInput
            value={pat}
            onChangeText={setPat}
            placeholder="github_pat_..."
            placeholderTextColor={P.dim}
            style={styles.input}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={styles.btnRow}>
            <Btn label="Lưu PAT" onPress={handleSave} disabled={!pat.trim()} />
          </View>
          <View style={styles.btnRow}>
            <Btn
              label={busy === "pull" ? "..." : "Pull ngay"}
              onPress={handlePull}
              disabled={!!busy || !isConfigured}
              accent={P.green}
            />
            <Btn
              label={busy === "push" ? "..." : "Push ngay"}
              onPress={handlePush}
              disabled={!!busy || !isConfigured}
              accent={P.bitcoinOrange}
            />
            <Btn label="Xoá" onPress={handleClear} accent={P.error} />
          </View>

          {msg && (
            <Text style={[styles.msg, { color: msg.ok ? P.green : P.error }]}>
              {msg.text}
            </Text>
          )}

          <Text style={styles.note}>
            Last sync: <Text style={styles.code}>{lastSyncText}</Text>
            {"\n"}File: <Text style={styles.code}>tommy31383/btc-dashboard:data/paper_trades.json</Text>
          </Text>
        </View>
      )}
    </View>
  );
}

function Btn({ label, onPress, disabled, accent }: {
  label: string; onPress: () => void; disabled?: boolean; accent?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.btn,
        accent ? { borderColor: accent } : null,
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      <Text style={[styles.btnText, accent ? { color: accent } : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.elevated, borderRadius: 2, marginBottom: 10 },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 12, paddingHorizontal: 14,
  },
  title: {
    color: P.text, fontSize: 12, fontWeight: "700", letterSpacing: 1.2,
    fontFamily: "SpaceGrotesk_700Bold", marginBottom: 3,
  },
  subtitle: {
    color: P.dim, fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
  },
  chevron: { color: P.dim, fontSize: 14, marginLeft: 8 },
  body: {
    padding: 14, paddingTop: 0,
    borderTopWidth: 1, borderTopColor: P.highest,
  },
  help: {
    color: P.text2, fontSize: 11, lineHeight: 16,
    fontFamily: "Inter_400Regular", marginVertical: 10,
  },
  code: {
    color: P.bitcoinOrange,
    fontFamily: "JetBrainsMono_500Medium", fontSize: 10,
  },
  label: {
    color: P.dim, fontSize: 9, fontWeight: "700", letterSpacing: 1.5,
    textTransform: "uppercase", fontFamily: "SpaceGrotesk_700Bold",
    marginTop: 8, marginBottom: 4,
  },
  input: {
    backgroundColor: P.surface, color: P.text,
    borderRadius: 2, paddingHorizontal: 10, paddingVertical: 8,
    fontSize: 12, fontFamily: "JetBrainsMono_500Medium",
    borderWidth: 1, borderColor: P.highest,
  },
  btnRow: {
    flexDirection: "row", gap: 6, marginTop: 8,
  },
  btn: {
    flex: 1, borderWidth: 1, borderColor: P.highest,
    borderRadius: 2, paddingVertical: 8, alignItems: "center",
  },
  btnText: {
    color: P.text, fontSize: 11, fontWeight: "700", letterSpacing: 0.5,
    fontFamily: "SpaceGrotesk_700Bold",
  },
  msg: {
    fontSize: 11, fontWeight: "700", marginTop: 8,
    fontFamily: "JetBrainsMono_500Medium",
  },
  note: {
    color: P.dim, fontSize: 9, marginTop: 10, lineHeight: 14,
    fontFamily: "JetBrainsMono_500Medium",
  },
});
