/**
 * repoSync (alias gistSync.ts) — sync paper trades lên file `data/paper_trades.json`
 * trong project repo `tommy31383/btc-dashboard` thông qua GitHub Contents API.
 *
 * v4.3.39: thay vì Gist riêng, dùng luôn repo project — user chỉ cần dán PAT,
 * khỏi tạo gist mới + khỏi nhớ gist ID.
 *
 * Security:
 *   - PAT lưu localStorage (lộ trong DevTools nhưng app này chỉ user dùng)
 *   - Khuyến nghị fine-grained PAT scope "Contents: read+write" CHỈ cho repo này
 *   - Mỗi save = 1 commit trong repo, hiển thị trong git activity
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { PaperTrade } from "./paperTrader";

const PAT_KEY = "@gist_pat";       // giữ key cũ để user không phải nhập lại
const LAST_SYNC_KEY = "@gist_last_sync";

const REPO_OWNER = "tommy31383";
const REPO_NAME = "btc-dashboard";
/** v4.3.40: branch riêng cho data → KHÔNG trigger GitHub Pages rebuild. */
const BRANCH = "paper-data";
const BASE_BRANCH = "master"; // chỉ dùng khi cần tạo `paper-data` lần đầu
const FILE_PATH = "paper_trades.json";
const GH_API = "https://api.github.com";

export interface GistConfig {
  pat: string | null;
  /** Kept for backwards-compat with UI; always null in repo mode. */
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
    pat: pat || null,
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

/** Stub — không cần tạo gist nữa, file path đã cố định trong repo. */
export async function createNewGist(_pat: string): Promise<string> {
  return `${REPO_OWNER}/${REPO_NAME}:${FILE_PATH}`;
}

const contentsUrl = () =>
  `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`;

interface ContentsResponse {
  content: string;   // base64
  sha: string;
}

function b64encode(str: string): string {
  if (typeof btoa !== "undefined") {
    return btoa(unescape(encodeURIComponent(str)));
  }
  // RN fallback
  return Buffer.from(str, "utf8").toString("base64");
}

function b64decode(b64: string): string {
  const cleaned = b64.replace(/\s/g, "");
  if (typeof atob !== "undefined") {
    return decodeURIComponent(escape(atob(cleaned)));
  }
  return Buffer.from(cleaned, "base64").toString("utf8");
}

/** Pull file content + sha. Returns null if not configured / file not found. */
export async function pullFromGist(): Promise<GistPayload | null> {
  const cfg = await getGistConfig();
  if (!cfg.pat) return null;
  try {
    const res = await fetch(contentsUrl(), {
      headers: {
        "Authorization": `token ${cfg.pat}`,
        "Accept": "application/vnd.github+json",
      },
    });
    if (res.status === 404) {
      // File chưa tồn tại — coi như payload rỗng
      return { version: 1, updatedAt: 0, trades: [] };
    }
    if (!res.ok) throw new Error(`Pull fail: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as ContentsResponse;
    if (!json.content) return { version: 1, updatedAt: 0, trades: [] };
    const text = b64decode(json.content);
    const payload = JSON.parse(text) as GistPayload;
    return payload;
  } catch (e) {
    console.warn("[repoSync] pull failed:", e);
    return null;
  }
}

/** Đảm bảo branch `paper-data` tồn tại — nếu chưa thì tạo từ HEAD của master.
 *  Trả về true nếu branch đã (hoặc vừa) tồn tại. */
async function ensureBranch(pat: string): Promise<boolean> {
  try {
    // 1. Check branch tồn tại?
    const checkRes = await fetch(
      `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BRANCH}`,
      { headers: { "Authorization": `token ${pat}`, "Accept": "application/vnd.github+json" } },
    );
    if (checkRes.ok) return true;
    if (checkRes.status !== 404) {
      console.warn("[repoSync] ensureBranch check fail:", checkRes.status);
      return false;
    }
    // 2. Lấy SHA của HEAD master
    const baseRes = await fetch(
      `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`,
      { headers: { "Authorization": `token ${pat}`, "Accept": "application/vnd.github+json" } },
    );
    if (!baseRes.ok) throw new Error(`Get base ref fail: ${baseRes.status}`);
    const baseJson = await baseRes.json();
    const baseSha = baseJson.object?.sha;
    if (!baseSha) throw new Error("Base ref thiếu sha");
    // 3. Tạo ref mới
    const createRes = await fetch(
      `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`,
      {
        method: "POST",
        headers: {
          "Authorization": `token ${pat}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: baseSha }),
      },
    );
    if (!createRes.ok) throw new Error(`Create branch fail: ${createRes.status} ${await createRes.text()}`);
    return true;
  } catch (e) {
    console.warn("[repoSync] ensureBranch error:", e);
    return false;
  }
}

/** Get current file SHA (cần để PUT update). null = file chưa tồn tại. */
async function getFileSha(pat: string): Promise<string | null> {
  try {
    const res = await fetch(contentsUrl(), {
      headers: {
        "Authorization": `token ${pat}`,
        "Accept": "application/vnd.github+json",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Get sha fail: ${res.status}`);
    const json = (await res.json()) as ContentsResponse;
    return json.sha || null;
  } catch {
    return null;
  }
}

/** Push lên repo (PUT contents API). Tự fetch sha trước. */
export async function pushToGist(trades: PaperTrade[]): Promise<boolean> {
  const cfg = await getGistConfig();
  if (!cfg.pat) return false;
  const payload: GistPayload = { version: 1, updatedAt: Date.now(), trades };
  try {
    await ensureBranch(cfg.pat);
    const sha = await getFileSha(cfg.pat);
    const body: any = {
      message: `data: paper trades · ${trades.length} lệnh · ${new Date(payload.updatedAt).toISOString()}`,
      content: b64encode(JSON.stringify(payload, null, 2)),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, {
      method: "PUT",
      headers: {
        "Authorization": `token ${cfg.pat}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Push fail: ${res.status} ${await res.text()}`);
    await markSynced(payload.updatedAt);
    return true;
  } catch (e) {
    console.warn("[repoSync] push failed:", e);
    return false;
  }
}

/** Merge gist trades + local trades (gist override local theo id; closed trade luôn ưu tiên). */
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

// ─── Generic file sync (used by auto-trader account state) ────────────────
function fileContentsUrl(path: string) {
  return `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}`;
}

export async function pullFile<T>(path: string): Promise<T | null> {
  const cfg = await getGistConfig();
  if (!cfg.pat) return null;
  try {
    const res = await fetch(fileContentsUrl(path), {
      headers: { "Authorization": `token ${cfg.pat}`, "Accept": "application/vnd.github+json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`pullFile ${path} fail: ${res.status}`);
    const json = (await res.json()) as ContentsResponse;
    if (!json.content) return null;
    return JSON.parse(b64decode(json.content)) as T;
  } catch (e) {
    console.warn(`[repoSync] pullFile ${path} failed:`, e);
    return null;
  }
}

async function getFileShaAt(pat: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(fileContentsUrl(path), {
      headers: { "Authorization": `token ${pat}`, "Accept": "application/vnd.github+json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const json = (await res.json()) as ContentsResponse;
    return json.sha || null;
  } catch {
    return null;
  }
}

export async function pushFile<T>(path: string, data: T, commitMsg: string): Promise<boolean> {
  const cfg = await getGistConfig();
  if (!cfg.pat) return false;
  try {
    await ensureBranch(cfg.pat);
    const sha = await getFileShaAt(cfg.pat, path);
    const body: any = {
      message: commitMsg,
      content: b64encode(JSON.stringify(data, null, 2)),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
      method: "PUT",
      headers: {
        "Authorization": `token ${cfg.pat}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`pushFile ${path} fail: ${res.status} ${await res.text()}`);
    await markSynced(Date.now());
    return true;
  } catch (e) {
    console.warn(`[repoSync] pushFile ${path} failed:`, e);
    return false;
  }
}

/** Delete file (used by reset). */
export async function deleteFile(path: string, commitMsg: string): Promise<boolean> {
  const cfg = await getGistConfig();
  if (!cfg.pat) return false;
  const sha = await getFileShaAt(cfg.pat, path);
  if (!sha) return true; // already gone
  try {
    const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
      method: "DELETE",
      headers: {
        "Authorization": `token ${cfg.pat}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: commitMsg, sha, branch: BRANCH }),
    });
    return res.ok;
  } catch (e) {
    console.warn(`[repoSync] deleteFile ${path} failed:`, e);
    return false;
  }
}

// ─── Debounced push helper ─────────────────────────────────────────────────
let pushTimer: ReturnType<typeof setTimeout> | null = null;
const PUSH_DEBOUNCE_MS = 5000; // tăng lên 5s để gom nhiều thay đổi vào 1 commit

export function schedulePush(getTrades: () => Promise<PaperTrade[]>): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const trades = await getTrades();
      await pushToGist(trades);
    } catch {}
  }, PUSH_DEBOUNCE_MS);
}

/** Generic debounced pusher for arbitrary file (used by auto-trader). */
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
    try {
      const data = await getData();
      await pushFile(path, data, commitMsg());
    } catch {}
  }, debounceMs);
}
