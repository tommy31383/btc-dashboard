/**
 * leaderElection.ts — Single-leader lock cho LIVE auto-trade.
 *
 * Vấn đề: nhiều device cùng chạy app → cùng nghe rule fire → cùng vào lệnh trên Binance.
 * Giải pháp: chỉ 1 device được phép `decideEntry` / `executeAction` / `closeTracked`.
 *   - Leader: heartbeat mỗi 15s vào file `live_leader.json` trên gist.
 *   - Follower: pull file đó mỗi 20s. Nếu leader hiện tại không beat trong 30s → claim.
 *
 * Race: 2 device cùng claim → SHA conflict trong gist (đã có retry trong putContentsWithRetry).
 * Sau claim, device verify lại bằng pull (read-after-write); nếu deviceId không khớp → revert follower.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { pullFile, pushFile } from "./gistSync";

const DEVICE_ID_KEY = "@device_id";
const LEADER_FILE = "live_leader.json";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const LEADER_CHECK_INTERVAL_MS = 20_000;
export const LEADER_TIMEOUT_MS = 30_000; // không heartbeat > 30s → coi như chết

export interface LeaderInfo {
  deviceId: string;
  deviceLabel: string;     // tự đặt, vd "MacBook Pro" — info hiển thị
  lastBeatMs: number;
}

function isLeaderInfo(v: unknown): v is LeaderInfo {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.deviceId === "string"
    && typeof o.deviceLabel === "string"
    && typeof o.lastBeatMs === "number";
}

/** UUID-ish random — đủ unique cho personal use (không cần crypto-grade). */
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

/** Default device label = userAgent platform — user có thể override sau (chưa làm UI). */
export function autoDeviceLabel(): string {
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

export async function getLeaderInfo(): Promise<LeaderInfo | null> {
  return await pullFile<LeaderInfo>(LEADER_FILE, isLeaderInfo);
}

/**
 * Push lock file với deviceId hiện tại. Caller PHẢI verify lại bằng getLeaderInfo()
 * sau ít nhất 1s để chắc chắn không bị race (2 device cùng claim).
 */
export async function pushLeader(deviceId: string, deviceLabel: string): Promise<boolean> {
  const info: LeaderInfo = { deviceId, deviceLabel, lastBeatMs: Date.now() };
  return await pushFile(LEADER_FILE, info, `live: leader heartbeat (${deviceLabel})`);
}

/** Cho phép claim không? true nếu file rỗng / leader cũ chết / mình đã là leader. */
export function canClaim(info: LeaderInfo | null, myDeviceId: string, nowMs: number): boolean {
  if (!info) return true;
  if (info.deviceId === myDeviceId) return true;
  return nowMs - info.lastBeatMs > LEADER_TIMEOUT_MS;
}

export type LiveRole = "BOOTING" | "LEADER" | "FOLLOWER";
