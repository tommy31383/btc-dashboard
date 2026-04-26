/**
 * gistSync.ts — sync state lên repo `tommy31383/btc-dashboard` branch `paper-data`
 * QUA Cloudflare Worker proxy (anh Tommy chốt PA B v4.4.2+).
 *
 * Worker giữ GitHub PAT ở env var Cloudflare Secret → app KHÔNG cần PAT trên client.
 * App chỉ cần URL Worker → Tommy không phải nhập gì.
 *
 * Worker code: cloudflare-worker/worker.js
 * Worker endpoints:
 *   GET  /file?path=X[&ref=Y]
 *   PUT  /file?path=X  body: {message, content, sha?, branch?}
 *   GET  /ref?ref=heads/X
 *   POST /ref          body: {ref, sha}
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { PaperTrade } from "./paperTrader";

// ⚠️ Anh Tommy: nếu đổi worker URL thì sửa ở đây + build lại app.
const WORKER_URL = "https://cold-breeze-441e.tuantommy83.workers.dev";

const PAT_KEY = "@gist_pat";       // legacy — giữ để UI cũ không vỡ; KHÔNG dùng nữa
const LAST_SYNC_KEY = "@gist_last_sync";

const BRANCH = "paper-data";
const BASE_BRANCH = "master";
const FILE_PATH = "paper_trades.json";

export interface GistConfig {
  pat: string | null;
  /** Kept for backwards-compat with UI; always null in worker mode. */
  gistId: string | null;
  lastSyncMs: number;
}

export interface GistPayload {
  version: 1;
  updatedAt: number;
  trades: PaperTrade[];
}

export async function getGistConfig(): Promise<GistConfig> {
  const [pat, lastStr] = await Promise.all([
    AsyncStorage.getItem(PAT_KEY),
    AsyncStorage.getItem(LAST_SYNC_KEY),
  ]);
  return {
    // Trong worker mode pat luôn được coi là "có" (worker holds real PAT).
    // Vẫn return saved value để legacy UI hiện được.
    pat: pat || "worker-managed",
    gistId: null,
    lastSyncMs: lastStr ? parseInt(lastStr, 10) || 0 : 0,
  };
}

export async function setGistConfig(pat: string, _gistId?: string): Promise<void> {
  await AsyncStorage.setItem(PAT_KEY, pat.trim());
}

export async function clearGistConfig(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(PAT_KEY),
    AsyncStorage.removeItem(LAST_SYNC_KEY),
  ]);
}

async function markSynced(ms: number) {
  await AsyncStorage.setItem(LAST_SYNC_KEY, String(ms));
}

function sanitizeForLog(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : v instanceof Error ? v.message : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_PAT]")
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]")
    .replace(/token\s+[A-Za-z0-9_\-.]+/gi, "token [REDACTED]");
}

export async function createNewGist(_pat: string): Promise<string> {
  return `worker:${WORKER_URL}`;
}

interface ContentsResponse {
  content: string;   // base64
  sha: string;
}

function b64encode(str: string): string {
  if (typeof btoa !== "undefined") return btoa(unescape(encodeURIComponent(str)));
  return Buffer.from(str, "utf8").toString("base64");
}

function b64decode(b64: string): string {
  const cleaned = b64.replace(/\s/g, "");
  if (typeof atob !== "undefined") return decodeURIComponent(escape(atob(cleaned)));
  return Buffer.from(cleaned, "base64").toString("utf8");
}

function isGistPayload(v: unknown): v is GistPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === "number" &&
    typeof o.updatedAt === "number" &&
    Array.isArray(o.trades)
  );
}

// ─── Worker helpers ─────────────────────────────────────────────────────────

const fileUrl = (path: string, ref?: string) =>
  `${WORKER_URL}/file?path=${encodeURIComponent(path)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
const refUrl = (ref?: string) =>
  `${WORKER_URL}/ref${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

async function ghGetFile(path: string): Promise<{ status: number; json: ContentsResponse | null; text: string }> {
  const res = await fetch(fileUrl(path, BRANCH));
  const text = await res.text();
  let json: ContentsResponse | null = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function ghPutFile(path: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(fileUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Pull / Push ───────────────────────────────────────────────────────────

export async function pullFromGist(): Promise<GistPayload | null> {
  try {
    const { status, json } = await ghGetFile(FILE_PATH);
    if (status === 404) return { version: 1, updatedAt: 0, trades: [] };
    if (status !== 200 || !json) return null;
    if (!json.content) return { version: 1, updatedAt: 0, trades: [] };
    const text = b64decode(json.content);
    const raw: unknown = JSON.parse(text);
    if (!isGistPayload(raw)) {
      console.warn("[repoSync] pullFromGist: invalid payload shape — rejected");
      return null;
    }
    return raw;
  } catch (e) {
    console.warn("[repoSync] pull failed:", sanitizeForLog(e));
    return null;
  }
}

/** Đảm bảo branch `paper-data` tồn tại — nếu chưa thì tạo từ HEAD master. */
async function ensureBranch(): Promise<boolean> {
  try {
    const checkRes = await fetch(refUrl(`heads/${BRANCH}`));
    if (checkRes.ok) return true;
    if (checkRes.status !== 404) {
      console.warn("[repoSync] ensureBranch check fail:", checkRes.status);
      return false;
    }
    const baseRes = await fetch(refUrl(`heads/${BASE_BRANCH}`));
    if (!baseRes.ok) throw new Error(`Get base ref fail: ${baseRes.status}`);
    const baseJson = await baseRes.json();
    const baseSha = baseJson.object?.sha;
    if (!baseSha) throw new Error("Base ref thiếu sha");
    const createRes = await fetch(refUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: baseSha }),
    });
    if (!createRes.ok) throw new Error(`Create branch fail: ${createRes.status} ${await createRes.text()}`);
    return true;
  } catch (e) {
    console.warn("[repoSync] ensureBranch error:", sanitizeForLog(e));
    return false;
  }
}

async function getFileSha(path: string): Promise<string | null> {
  try {
    const { status, json } = await ghGetFile(path);
    if (status === 404) return null;
    if (status !== 200 || !json) return null;
    return json.sha || null;
  } catch {
    return null;
  }
}

/** PUT contents with auto-retry on SHA mismatch (concurrent writes from 2 devices). */
async function putContentsWithRetry(
  path: string,
  buildBody: (sha: string | null) => Record<string, unknown>,
  errLabel: string,
  maxRetries = 3,
): Promise<Response> {
  let sha = await getFileSha(path);
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await ghPutFile(path, buildBody(sha));
    if (res.ok) return res;
    if ((res.status === 409 || res.status === 422) && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      sha = await getFileSha(path);
      lastRes = res;
      continue;
    }
    lastRes = res;
    break;
  }
  const text = lastRes ? await lastRes.text() : "no response";
  throw new Error(`${errLabel} fail: ${lastRes?.status ?? "?"} ${text}`);
}

export async function pushToGist(trades: PaperTrade[]): Promise<boolean> {
  const payload: GistPayload = { version: 1, updatedAt: Date.now(), trades };
  try {
    await ensureBranch();
    await putContentsWithRetry(
      FILE_PATH,
      (sha) => {
        const body: any = {
          message: `data: paper trades · ${trades.length} lệnh · ${new Date(payload.updatedAt).toISOString()}`,
          content: b64encode(JSON.stringify(payload, null, 2)),
          branch: BRANCH,
        };
        if (sha) body.sha = sha;
        return body;
      },
      "Push",
    );
    await markSynced(payload.updatedAt);
    return true;
  } catch (e) {
    console.warn("[repoSync] push failed:", sanitizeForLog(e));
    return false;
  }
}

export function mergeTrades(local: PaperTrade[], remote: PaperTrade[]): PaperTrade[] {
  const byId = new Map<string, PaperTrade>();
  for (const t of remote) byId.set(t.id, t);
  for (const t of local) {
    const r = byId.get(t.id);
    if (!r) {
      byId.set(t.id, t);
    } else {
      const localClosed = t.status !== "OPEN";
      const remoteClosed = r.status !== "OPEN";
      if (localClosed && !remoteClosed) byId.set(t.id, t);
      else if (remoteClosed && !localClosed) byId.set(t.id, r);
      else if (t.openedMs > r.openedMs) byId.set(t.id, t);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.openedMs - a.openedMs);
}

// ─── Generic file sync ─────────────────────────────────────────────────────

export async function pullFile<T>(
  path: string,
  validate?: (raw: unknown) => raw is T,
): Promise<T | null> {
  try {
    const { status, json } = await ghGetFile(path);
    if (status === 404) return null;
    if (status !== 200 || !json) return null;
    if (!json.content) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(b64decode(json.content));
    } catch (parseErr) {
      console.warn(`[repoSync] pullFile ${path} parse error:`, sanitizeForLog(parseErr));
      return null;
    }
    if (validate && !validate(parsed)) {
      console.warn(`[repoSync] pullFile ${path} schema validation failed — payload rejected`);
      return null;
    }
    return parsed as T;
  } catch (e) {
    console.warn(`[repoSync] pullFile ${path} failed:`, sanitizeForLog(e));
    return null;
  }
}

export async function pushFile<T>(path: string, data: T, commitMsg: string): Promise<boolean> {
  try {
    await ensureBranch();
    await putContentsWithRetry(
      path,
      (sha) => {
        const body: any = {
          message: commitMsg,
          content: b64encode(JSON.stringify(data, null, 2)),
          branch: BRANCH,
        };
        if (sha) body.sha = sha;
        return body;
      },
      `pushFile ${path}`,
    );
    await markSynced(Date.now());
    return true;
  } catch (e) {
    console.warn(`[repoSync] pushFile ${path} failed:`, sanitizeForLog(e));
    return false;
  }
}

export async function deleteFile(path: string, commitMsg: string): Promise<boolean> {
  const sha = await getFileSha(path);
  if (!sha) return true;
  try {
    const res = await fetch(fileUrl(path), {
      method: "PUT", // Worker không expose DELETE; dùng PUT với empty content
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: commitMsg,
        content: b64encode("{}"),
        sha,
        branch: BRANCH,
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn(`[repoSync] deleteFile ${path} failed:`, sanitizeForLog(e));
    return false;
  }
}

// ─── Debounced push helpers ────────────────────────────────────────────────
let pushTimer: ReturnType<typeof setTimeout> | null = null;
const PUSH_DEBOUNCE_MS = 20000;

export function schedulePush(getTrades: () => Promise<PaperTrade[]>): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try { await pushToGist(await getTrades()); } catch {}
  }, PUSH_DEBOUNCE_MS);
}

const customPushTimers: Record<string, ReturnType<typeof setTimeout>> = {};
export function scheduleFilePush<T>(
  path: string,
  getData: () => Promise<T>,
  commitMsg: () => string,
  debounceMs = PUSH_DEBOUNCE_MS,
): void {
  if (customPushTimers[path]) clearTimeout(customPushTimers[path]);
  customPushTimers[path] = setTimeout(async () => {
    delete customPushTimers[path];
    try { await pushFile(path, await getData(), commitMsg()); } catch {}
  }, debounceMs);
}
