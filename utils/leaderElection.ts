/**
 * leaderElection.ts — Single-leader lock cho LIVE auto-trade.
 *
 * PA B (anh Tommy chọn v4.3.96+):
 *   - Heartbeat 15s + jitter ±2s (tránh 2 device push collision → SHA conflict)
 *   - Mọi device check leader 20s
 *   - Leader timeout 45s = 3-strike rule (miss 3 lần heartbeat → declare chết)
 *
 * Leader info trên gist (file `live_leader.json`):
 *   - deviceId / deviceLabel (user-set name) / deviceType (auto-detect)
 *   - ip / country / city (cached 1h)
 *   - lastBeatMs
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { pullFile, pushFile } from "./gistSync";

const DEVICE_ID_KEY = "@device_id";
const DEVICE_LABEL_KEY = "@device_label";
const IP_LOC_CACHE_KEY = "@ip_loc_cache";
const LEADER_FILE = "live_leader.json";

// PA B timing
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_JITTER_MS = 2_000;
export const LEADER_CHECK_INTERVAL_MS = 20_000;
export const LEADER_TIMEOUT_MS = 45_000; // 3-strike: leader phải miss 3 lần heartbeat 15s mới declare chết

const IP_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export interface IpLocation {
  ip: string;
  country: string;     // vd "VN", "US"
  city: string;        // vd "Ho Chi Minh"
}

export interface LeaderInfo {
  deviceId: string;
  deviceLabel: string;     // user-set name (vd "MacBook Tommy")
  deviceType: string;      // auto-detect (Mac/iPhone/Android/Windows/Linux)
  lastBeatMs: number;
  ip?: string;
  country?: string;
  city?: string;
}

function isLeaderInfo(v: unknown): v is LeaderInfo {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.deviceId === "string"
    && typeof o.deviceLabel === "string"
    && typeof o.lastBeatMs === "number";
}

/** UUID-ish random — đủ unique cho personal use. */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

let cachedDeviceId: string | null = null;
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = randomId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  cachedDeviceId = id;
  return id;
}

/** Auto-detect platform từ userAgent. */
export function autoDeviceType(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    const ua = navigator.userAgent;
    if (/iPhone|iPad/.test(ua)) return "iPhone/iPad";
    if (/Android/.test(ua)) return "Android";
    if (/Macintosh/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux/.test(ua)) return "Linux";
  }
  return "Unknown";
}

/** Backward-compat alias. */
export function autoDeviceLabel(): string { return autoDeviceType(); }

/** User-set device label (default = auto type). Lưu local. */
export async function getDeviceLabel(): Promise<string> {
  const saved = await AsyncStorage.getItem(DEVICE_LABEL_KEY);
  return saved || autoDeviceType();
}

export async function setDeviceLabel(label: string): Promise<void> {
  const trimmed = label.trim();
  if (trimmed) await AsyncStorage.setItem(DEVICE_LABEL_KEY, trimmed);
  else await AsyncStorage.removeItem(DEVICE_LABEL_KEY);
}

/** Fetch IP + location với 3 fallback APIs (tránh single point of failure). Cache 1h. */
export async function fetchIpLocation(): Promise<IpLocation | null> {
  // Try cache trước
  try {
    const raw = await AsyncStorage.getItem(IP_LOC_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { savedMs: number; loc: IpLocation };
      if (Date.now() - parsed.savedMs < IP_CACHE_TTL_MS) return parsed.loc;
    }
  } catch {}

  // Provider 1: ipapi.co (1000/day free, CORS-enabled, đầy đủ city+country)
  try {
    const res = await fetch("https://ipapi.co/json/");
    if (res.ok) {
      const j = await res.json() as any;
      if (j && j.ip && !j.error) {
        const loc: IpLocation = {
          ip: String(j.ip),
          country: String(j.country_code || j.country || "?"),
          city: String(j.city || "?"),
        };
        await AsyncStorage.setItem(IP_LOC_CACHE_KEY, JSON.stringify({ savedMs: Date.now(), loc }));
        return loc;
      }
    }
  } catch { /* try next */ }

  // Provider 2: ipwho.is (no auth, no rate limit announced, full data)
  try {
    const res = await fetch("https://ipwho.is/");
    if (res.ok) {
      const j = await res.json() as any;
      if (j && j.success && j.ip) {
        const loc: IpLocation = {
          ip: String(j.ip),
          country: String(j.country_code || j.country || "?"),
          city: String(j.city || "?"),
        };
        await AsyncStorage.setItem(IP_LOC_CACHE_KEY, JSON.stringify({ savedMs: Date.now(), loc }));
        return loc;
      }
    }
  } catch { /* try next */ }

  // Provider 3: ipify (only IP — location null)
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    if (res.ok) {
      const j = await res.json() as any;
      if (j && j.ip) {
        const loc: IpLocation = { ip: String(j.ip), country: "?", city: "?" };
        await AsyncStorage.setItem(IP_LOC_CACHE_KEY, JSON.stringify({ savedMs: Date.now(), loc }));
        return loc;
      }
    }
  } catch { /* give up */ }

  return null;
}

export async function getLeaderInfo(): Promise<LeaderInfo | null> {
  return await pullFile<LeaderInfo>(LEADER_FILE, isLeaderInfo);
}

/**
 * Push lock file với info đầy đủ. Caller PHẢI verify lại bằng getLeaderInfo() sau ~1s
 * để chắc chắn không bị race (2 device cùng claim).
 */
export async function pushLeader(
  deviceId: string,
  deviceLabel: string,
  loc: IpLocation | null = null,
): Promise<boolean> {
  const info: LeaderInfo = {
    deviceId,
    deviceLabel,
    deviceType: autoDeviceType(),
    lastBeatMs: Date.now(),
    ip: loc?.ip,
    country: loc?.country,
    city: loc?.city,
  };
  return await pushFile(LEADER_FILE, info, `live: leader heartbeat (${deviceLabel})`);
}

/** Cho phép claim không? true nếu file rỗng / leader cũ chết / mình đã là leader. */
export function canClaim(info: LeaderInfo | null, myDeviceId: string, nowMs: number): boolean {
  if (!info) return true;
  if (info.deviceId === myDeviceId) return true;
  return nowMs - info.lastBeatMs > LEADER_TIMEOUT_MS;
}

/** Random jitter ±2s cho heartbeat — tránh 2 device push cùng lúc. */
export function nextHeartbeatDelayMs(): number {
  const jitter = (Math.random() * 2 - 1) * HEARTBEAT_JITTER_MS;
  return HEARTBEAT_INTERVAL_MS + jitter;
}

export type LiveRole = "DISCONNECTED" | "BOOTING" | "LEADER" | "FOLLOWER";
