import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { COLORS, DEFAULT_SETTINGS, Settings, TimeframeKey } from "./utils/constants";
import { P } from "./utils/v2Theme";
import { useBinancePrice } from "./hooks/useBinancePrice";
import { useBinanceKlines } from "./hooks/useBinanceKlines";
import { useAlerts } from "./hooks/useAlerts";
import { useTrackedRules } from "./hooks/useTrackedRules";
import { useRuleAlerts } from "./hooks/useRuleAlerts";
import { useCalibration } from "./hooks/useCalibration";
import { initNotifications } from "./utils/notifications";
import { hydrateDebugLabels } from "./components/DebugLabel";

import PriceHeader from "./components/PriceHeader";
import BinanceChart from "./components/BinanceChart";
import SettingsPanel from "./components/SettingsPanel";
import AlertBanner from "./components/AlertBanner";
import TimeframeTable from "./components/TimeframeTable";
import ConfluenceScore from "./components/ConfluenceScore";
import AlertLog from "./components/AlertLog";
import OverallVerdict from "./components/OverallVerdict";
import TradingRulesPanel from "./components/TradingRulesPanel";
import RuleAlertBanner from "./components/RuleAlertBanner";
import LiveFeatureSnapshot from "./components/LiveFeatureSnapshot";
import LiveRulesSummary from "./components/LiveRulesSummary";
import RiskRadar from "./components/RiskRadar";
import GptRuleScreen from "./components/GptRuleScreen";
import { useRiskRadar } from "./hooks/useRiskRadar";
import { GoldenFiringBanner } from "./components/GoldenFiringBanner";
// PaperTradeJournal removed (trùng với LIVE journal + 5m ALL panel)
import AutoTraderPanel from "./components/AutoTraderPanel";
// LiveTradingPanel moved to dedicated LiveTab
import HistoryScreen from "./components/HistoryScreen";
import LiveTab from "./components/LiveTab";
import All5mPanel from "./components/All5mPanel";
import { useAutoTrader } from "./hooks/useAutoTrader";
import { useBinanceLive } from "./hooks/useBinanceLive";
// import { use15mAllTrader } from "./hooks/use15mAllTrader"; // disabled — replaced by LIVE tab
import { use5mAllTrader } from "./hooks/use5mAllTrader";
import { pullFromGist, mergeTrades } from "./utils/gistSync";
import { loadTrades, replaceTrades } from "./utils/paperTrader";
import { TopAppBar } from "./components/v2/TopAppBar";
import { BottomNavBar, NavTab } from "./components/v2/BottomNavBar";
import { useAppFonts } from "./components/v2/useAppFonts";

const SETTINGS_KEY = "@btc_dashboard_settings";
const CACHE_KEYS = [
  "@btc_klines_cache",
  "@btc_backtest_results",
  "@btc_opt_by_tf",
  "@btc_backtest_candles",
  "@btc_config_source_by_tf",
];
const APP_VERSION = "4.3.97";
const BUILD_DATE = "2026-04-26";

/**
 * Catches React render crashes and shows a friendly error screen with the
 * message + stack, plus a "Xóa cache & reload" button. Without this, a crash
 * makes the whole page go blank and we can't tell what happened.
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; info: string }
> {
  state = { error: null as Error | null, info: "" };
  static getDerivedStateFromError(error: Error) {
    return { error, info: "" };
  }
  componentDidCatch(error: Error, info: { componentStack: string }) {
    // eslint-disable-next-line no-console
    console.error("[BTC Dashboard crash]", error, info);
    this.setState({ error, info: info.componentStack || "" });
  }
  clearAndReload = async () => {
    try {
      await AsyncStorage.multiRemove(CACHE_KEYS);
    } catch {}
    if (typeof window !== "undefined" && window.location) {
      window.location.reload();
    }
  };
  render() {
    if (!this.state.error) return this.props.children as any;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.bg, padding: 20, paddingTop: 60 }}>
        <Text style={{ color: COLORS.bear, fontSize: 18, fontWeight: "900", fontFamily: "monospace", marginBottom: 12 }}>
          ❌ App bị crash
        </Text>
        <Text style={{ color: COLORS.text, fontSize: 12, fontFamily: "monospace", marginBottom: 8 }}>
          {this.state.error.name}: {this.state.error.message}
        </Text>
        <ScrollView style={{ maxHeight: 240, backgroundColor: "#000", padding: 8, borderRadius: 6, marginBottom: 12 }}>
          <Text style={{ color: COLORS.textDim, fontSize: 10, fontFamily: "monospace" }}>
            {(this.state.error.stack || "") + "\n\n" + this.state.info}
          </Text>
        </ScrollView>
        <TouchableOpacity
          onPress={this.clearAndReload}
          style={{ backgroundColor: COLORS.bitcoin + "30", padding: 14, borderRadius: 8, alignItems: "center", borderWidth: 1, borderColor: COLORS.bitcoin }}
        >
          <Text style={{ color: COLORS.bitcoin, fontSize: 13, fontWeight: "900", fontFamily: "monospace" }}>
            🗑 XÓA CACHE & RELOAD
          </Text>
        </TouchableOpacity>
        <Text style={{ color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", marginTop: 12, textAlign: "center" }}>
          Cache cũ có thể không tương thích với phiên bản mới. Bấm nút trên để xóa và load lại.
        </Text>
      </SafeAreaView>
    );
  }
}

export default function App() {
  const fontsReady = useAppFonts();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"dashboard" | "risk" | "gptRule" | "history" | "live" | "all5m">("dashboard");
  const [navTab, setNavTab] = useState<NavTab>("radar");
  const [selectedTF, setSelectedTF] = useState<TimeframeKey>("1h");

  // Load saved settings + init notifications
  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((val) => {
      if (val) {
        try {
          setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(val) });
        } catch {}
      }
    });
    initNotifications().catch(() => {});
    hydrateDebugLabels();
  }, []);

  const updateSettings = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
  }, []);

  // Data hooks — only price + multi-TF data + general alerts.
  // Backtest/optimizer/GA were removed in v4.0 (offline-generated rules now).
  const { priceData, priceHistory, connectionStatus, error: priceError } = useBinancePrice();
  const { tfData, rawKlines, loading, lastUpdate, error: klineError, refetch } = useBinanceKlines();
  const { criticalAlerts, normalAlerts, verdict } = useAlerts(tfData, settings, selectedTF);

  // Tracked rules + live alerts: re-evaluates on every klines update (~60s)
  const tracked = useTrackedRules();
  const { activeAlerts, ruleStatus, ruleMatchDetails, liveConditions } = useRuleAlerts(rawKlines, tracked.trackedIds, {
    notifyEnabled: settings.notifyEntrySignal,
    notifyMinScore: settings.notifyMinScore,
  });

  // Learner + Paper Trader: log mỗi rule fire, resolve khi giá hit SL/TP/timeout
  const calib = useCalibration(activeAlerts, priceData?.price ?? null);

  // v4.3.41 — Auto Trader: tự động vào lệnh khi rule fire (paper account
  // 1000 USD, margin 30/lệnh, lev 100x, limit ±0.1% chờ tối đa 5p).
  const autoTrader = useAutoTrader(activeAlerts, priceData?.price ?? null);

  // v4.3.52 — Binance Live; v4.3.82 — pass LTF context (stoch5m + S/R 15m) cho confirm
  const ltfCtx = (() => {
    const stoch5m = tfData.find((t) => t.key === "5m")?.stochK ?? null;
    const klines15m = rawKlines["15m"];
    let support15m: number | null = null;
    let resistance15m: number | null = null;
    if (klines15m && klines15m.length > 51) {
      const tail = klines15m.slice(-51, -1);
      let lo = Infinity, hi = -Infinity;
      for (const c of tail) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
      if (lo !== Infinity) support15m = lo;
      if (hi !== -Infinity) resistance15m = hi;
    }
    return { stoch5m, support15m, resistance15m };
  })();
  const live = useBinanceLive(activeAlerts, priceData?.price ?? null, ltfCtx);

  // v4.3.44 — 15m All trader: PC-only, local AsyncStorage, LONG every closed 15m bar
  // 15m All trader disabled — replaced by LIVE tab
  // const all15m = use15mAllTrader(rawKlines, tfData, priceData?.price ?? null, activeTab === "all15m");

  // v4.3.47 — 5m All trader: chạy nền liên tục để tích luỹ history (không gate theo tab)
  const all5m = use5mAllTrader(rawKlines, tfData, priceData?.price ?? null, true);

  // v4.3.37 — Auto-pull paper trades từ Gist khi app mount (best-effort).
  useEffect(() => {
    (async () => {
      try {
        const remote = await pullFromGist();
        if (!remote || !remote.trades) return;
        const local = await loadTrades();
        const merged = mergeTrades(local, remote.trades);
        if (merged.length !== local.length) await replaceTrades(merged);
      } catch {}
    })();
  }, []);

  // Risk Radar — compute lesson-learn warnings + golden opportunities from rawKlines
  const riskState = useRiskRadar(rawKlines);
  const firingGoldensCount = riskState.goldens.filter((g) => g.allPass).length;

  // Highlight state — when user taps an alert in the banner, we scroll to the
  // matching rule card in TradingRulesPanel and auto-expand it.
  const [highlightedRuleId, setHighlightedRuleId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const tradingPanelYRef = useRef<number>(0);

  const handleAlertTap = useCallback((ruleId: string) => {
    setHighlightedRuleId(ruleId);
    // Scroll to the trading panel position
    if (scrollRef.current && tradingPanelYRef.current > 0) {
      scrollRef.current.scrollTo({ y: Math.max(0, tradingPanelYRef.current - 20), animated: true });
    }
    // Clear highlight after a few seconds so user can re-tap to re-highlight
    setTimeout(() => setHighlightedRuleId(null), 5000);
  }, []);

  const error = priceError || klineError;

  const handleNavSelect = useCallback((t: NavTab) => {
    setNavTab(t);
    if (t === "trades") setActiveTab("risk");
    else if (t === "gptRule") setActiveTab("gptRule");
    else if (t === "history") setActiveTab("history");
    else if (t === "live") setActiveTab("live");
    else if (t === "all5m") setActiveTab("all5m");
    else setActiveTab("dashboard");
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);


  // Font loading splash — keep bg matched so there's no flash
  if (!fontsReady) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={P.primaryContainer} />
        </View>
      </SafeAreaView>
    );
  }

  // Risk Radar screen — mounted under TRADES tab (v4.3.20)
  if (activeTab === "risk") {
    return (
      <ErrorBoundary>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <TopAppBar
            title="BTC DASHBOARD"
            version={APP_VERSION}
            buildDate={BUILD_DATE}
            lastUpdate={lastUpdate}
            onNotifications={() => {}}
            onSettings={() => setShowSettings(true)}
          />
          <RiskRadar state={riskState} />
          <SettingsPanel
            visible={showSettings}
            settings={settings}
            onUpdate={updateSettings}
          />
          <BottomNavBar
            active={navTab}
            tradesBadge={firingGoldensCount}
            onSelect={handleNavSelect}
          />
        </SafeAreaView>
      </ErrorBoundary>
    );
  }

  if (activeTab === "history") {
    return (
      <ErrorBoundary>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <TopAppBar
            title="BTC DASHBOARD"
            version={APP_VERSION}
            buildDate={BUILD_DATE}
            lastUpdate={lastUpdate}
            onNotifications={() => {}}
            onSettings={() => setShowSettings(true)}
          />
          <HistoryScreen account={autoTrader.account} summary={autoTrader.summary} />
          <SettingsPanel visible={showSettings} settings={settings} onUpdate={updateSettings} />
          <BottomNavBar
            active={navTab}
            tradesBadge={firingGoldensCount}
            onSelect={handleNavSelect}
          />
        </SafeAreaView>
      </ErrorBoundary>
    );
  }

  if (activeTab === "all5m") {
    return (
      <ErrorBoundary>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <TopAppBar
            title="BTC DASHBOARD"
            version={APP_VERSION}
            buildDate={BUILD_DATE}
            lastUpdate={lastUpdate}
            onNotifications={() => {}}
            onSettings={() => setShowSettings(true)}
          />
          <All5mPanel
            account={all5m.account}
            summary={all5m.summary}
            currentPrice={priceData?.price ?? null}
            stoch5mK={tfData.find((t) => t.key === "5m")?.stochK ?? null}
            onReset={all5m.reset}
            onCloseManual={all5m.closeManual}
          />
          <SettingsPanel visible={showSettings} settings={settings} onUpdate={updateSettings} />
          <BottomNavBar
            active={navTab}
            tradesBadge={firingGoldensCount}
            onSelect={handleNavSelect}
          />
        </SafeAreaView>
      </ErrorBoundary>
    );
  }

  if (activeTab === "live") {
    return (
      <ErrorBoundary>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <TopAppBar
            title="BTC DASHBOARD"
            version={APP_VERSION}
            buildDate={BUILD_DATE}
            lastUpdate={lastUpdate}
            onNotifications={() => {}}
            onSettings={() => setShowSettings(true)}
          />
          <LiveTab live={live} />
          <SettingsPanel visible={showSettings} settings={settings} onUpdate={updateSettings} />
          <BottomNavBar
            active={navTab}
            tradesBadge={firingGoldensCount}
            onSelect={handleNavSelect}
          />
        </SafeAreaView>
      </ErrorBoundary>
    );
  }

  if (activeTab === "gptRule") {
    return (
      <ErrorBoundary>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <TopAppBar
            title="BTC DASHBOARD"
            version={APP_VERSION}
            buildDate={BUILD_DATE}
            lastUpdate={lastUpdate}
            onNotifications={() => {}}
            onSettings={() => setShowSettings(true)}
          />
          <GptRuleScreen />
          <SettingsPanel
            visible={showSettings}
            settings={settings}
            onUpdate={updateSettings}
          />
          <BottomNavBar
            active={navTab}
            tradesBadge={firingGoldensCount}
            onSelect={handleNavSelect}
          />
        </SafeAreaView>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <TopAppBar
        title="BTC DASHBOARD"
        version={APP_VERSION}
        buildDate={BUILD_DATE}
        lastUpdate={lastUpdate}
        onNotifications={() => {}}
        onSettings={() => setShowSettings((v) => !v)}
      />
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.bitcoin}
            colors={[COLORS.bitcoin]}
            progressBackgroundColor={COLORS.bgCard}
          />
        }
      >
        {/* Error banner */}
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={onRefresh} style={styles.retryBtn}>
              <Text style={styles.retryText}>Thử lại</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Price Header */}
        <PriceHeader
          priceData={priceData}
          priceHistory={priceHistory}
          connectionStatus={connectionStatus}
        />

        {/* Settings */}
        <SettingsPanel
          visible={showSettings}
          settings={settings}
          onUpdate={updateSettings}
        />

        {/* RULE FIRE banner — TOP PRIORITY when any tracked rule matches */}
        <RuleAlertBanner
          alerts={activeAlerts}
          liveConditions={liveConditions}
          ruleMatchDetails={ruleMatchDetails}
          onAlertTap={handleAlertTap}
        />

        {/* GOLDEN FIRING banner — verified rule từ scan 2.3Y đang match ngay bây giờ */}
        <GoldenFiringBanner
          goldens={riskState.goldens}
          onPress={() => {
            setNavTab("trades");
            setActiveTab("risk");
          }}
        />

        {/* Critical Alerts */}
        <AlertBanner alerts={criticalAlerts} />

        {/* v4.3.16 — Live feature snapshot (B): show current RSI/MACD/ATR/EMA Dist/HTF */}
        <LiveFeatureSnapshot
          tfData={tfData}
          trackedIds={tracked.trackedIds}
          ruleStatus={ruleStatus}
          ruleMatchDetails={ruleMatchDetails}
        />

        {/* v4.3.16 — Live rules aggregate summary (C) */}
        <LiveRulesSummary
          trackedIds={tracked.trackedIds}
          ruleStatus={ruleStatus}
          ruleMatchDetails={ruleMatchDetails}
          tfData={tfData}
        />

        {/* LIVE TRADING moved to dedicated tab (BottomNav → LIVE) */}

        {/* v4.3.41 — AUTO TRADER: tự động vào lệnh khi rule fire (1000U cap, 30U margin, 100x lev) */}
        <AutoTraderPanel
          account={autoTrader.account}
          summary={autoTrader.summary}
          currentPrice={priceData?.price ?? null}
          onReset={autoTrader.reset}
        />

        {/* PAPER TRADE JOURNAL moved into 5m ALL tab footer */}

        {/* RULE TRADING — main interaction. User picks which pre-baked rules
            to track; app monitors live and alerts when conditions match. */}
        <View
          onLayout={(e) => { tradingPanelYRef.current = e.nativeEvent.layout.y; }}
        >
          <TradingRulesPanel
            tfFilter={["5m", "15m", "1h", "4h"]}
            ruleStatus={ruleStatus}
            ruleMatchDetails={ruleMatchDetails}
            highlightedRuleId={highlightedRuleId}
            globalTF={selectedTF}
          />
        </View>

        {/* Loading */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.bitcoin} />
            <Text style={styles.loadingText}>Đang tải dữ liệu...</Text>
          </View>
        ) : (
          <>
            {/* Chart */}
            <BinanceChart rawKlines={rawKlines} selectedTF={selectedTF} onSelectTF={setSelectedTF} />

            {/* v4.3.43 — Multi-TF gộp thành 1 confluence score (-100..+100) */}
            <ConfluenceScore tfData={tfData} />

            {/* Verdict */}
            <OverallVerdict
              verdict={verdict}
              selectedTF={selectedTF}
              onSelectTF={setSelectedTF}
              tfData={tfData}
              rawKlines={rawKlines}
              price={priceData?.price ?? 0}
              change24hPct={priceData?.changePct24h ?? 0}
            />

            {/* Alert Log */}
            <AlertLog alerts={normalAlerts} />
          </>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Cập nhật:{" "}
            {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "—"}
          </Text>
          <Text style={styles.footerText}>Dữ liệu: Binance · Tự động: 30s · Kéo xuống để làm mới</Text>
          <Text style={styles.versionText}>v{APP_VERSION} · Build {BUILD_DATE}</Text>
        </View>
      </ScrollView>
      <BottomNavBar
        active={navTab}
        tradesBadge={firingGoldensCount}
        onSelect={handleNavSelect}
      />
    </SafeAreaView>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: P.bg },
  scroll: { flex: 1 },
  content: { padding: 12, paddingTop: 12, paddingBottom: 80 },
  errorBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: P.red + "15", borderWidth: 1, borderColor: P.red, borderRadius: 0, padding: 12, marginBottom: 12 },
  errorText: { color: P.red, fontSize: 11, fontFamily: "monospace", flex: 1 },
  retryBtn: { backgroundColor: P.red + "30", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 0, marginLeft: 8, borderWidth: 1, borderColor: P.red },
  retryText: { color: P.red, fontSize: 11, fontWeight: "700", fontFamily: "monospace" },
  loadingContainer: { alignItems: "center", paddingVertical: 40 },
  loadingText: { color: P.dim, fontSize: 12, fontFamily: "monospace", marginTop: 12 },
  footer: { alignItems: "center", paddingTop: 12, borderTopWidth: 1, borderTopColor: P.border },
  footerText: { color: P.dim, fontSize: 10, fontFamily: "monospace", marginBottom: 2 },
  versionText: { color: P.fade, fontSize: 9, fontFamily: "monospace", marginTop: 4, letterSpacing: 1 },
});
