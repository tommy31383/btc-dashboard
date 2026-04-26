/**
 * PanelBoundary — wrap quanh từng panel để 1 panel crash KHÔNG nuke whole app.
 * Khác với ErrorBoundary top-level (nuke toàn UI), PanelBoundary chỉ render
 * fallback compact ở chỗ panel đó, các panel khác vẫn hoạt động.
 */
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";

interface Props {
  /** Tên panel để hiển thị trong fallback (vd "BinanceChart", "TradingRulesPanel") */
  name: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

class PanelBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error(`[Panel:${this.props.name}] crash:`, error, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.fallback}>
        <Text style={styles.title}>⚠️ {this.props.name} bị lỗi</Text>
        <Text style={styles.msg} numberOfLines={3}>
          {this.state.error.name}: {this.state.error.message}
        </Text>
        <TouchableOpacity onPress={this.reset} style={styles.btn}>
          <Text style={styles.btnText}>↻ Thử lại panel này</Text>
        </TouchableOpacity>
        <Text style={styles.note}>Các panel khác không bị ảnh hưởng.</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: P.errorContainer + "22",
    borderWidth: 1,
    borderColor: P.error,
    borderLeftWidth: 4,
    borderLeftColor: P.error,
    borderRadius: 4,
    padding: 12,
    marginBottom: 12,
  },
  title: { color: P.error, fontFamily: "monospace", fontSize: 12, fontWeight: "800", marginBottom: 6 },
  msg: { color: P.text, fontFamily: "monospace", fontSize: 11, marginBottom: 8, lineHeight: 14 },
  btn: { alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: P.error, borderRadius: 4 },
  btnText: { color: P.error, fontFamily: "monospace", fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  note: { color: P.dim, fontFamily: "monospace", fontSize: 9, marginTop: 8 },
});

export default PanelBoundary;
