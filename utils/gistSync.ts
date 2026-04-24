/**
 * gistSync — sync paper trades lên GitHub Gist private.
 *
 * Setup 1 lần: user nhập GitHub PAT (scope `gist`) + Gist ID trong panel.
 * Sau đó mỗi save trades → tự động push (debounce 3s) lên gist.
 * Khi mở app → pull từ gist → merge với local (gist override local theo id).
 *
 * Lưu ý security: PAT lưu trong AsyncStorage (web = localStorage, lộ trong
 * DevTools nhưng app này chỉ user dùng). PAT scope `gist` chỉ access gist,
 * không touch repo.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { PaperTrade } from "./paperTrader";

const PAT_KEY = "@gist_pat";
const GIST_ID_KEY = "@gist_id";
const LAST_SYNC_KEY = "@gist_last_sync";
const FILE_NAME = "btc_paper_trades.json";
const GH_API = "https://api.github.com";

export interface GistConfig {
  pat: string | null;
  gistId: string | null;
  lastSyncMs: number;
}

export interface GistPayload {
  version: 1;
  updatedAt: number;
  trades: PaperTrade[];
}

export async function getGistConfig(): Promise<GistConfig> {
  const [pat, gistId, lastStr] = await Promise.all([
    AsyncStorage.getItem(PAT_KEY),
    AsyncStorage.getItem(GIST_ID_KEY),
    AsyncStorage.getItem(LAST_SYNC_KEY),
  ]);
  return {
    pat: pat || null,
    gistId: gistId || null,
    lastSyncMs: lastStr ? parseInt(lastStr, 10) || 0 : 0,
  };
}

export async function setGistConfig(pat: string, gistId: string): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(PAT_KEY, pat.trim()),
    AsyncStorage.setItem(GIST_ID_KEY, gistId.trim()),
  ]);
}

export async function clearGistConfig(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(PAT_KEY),
    AsyncStorage.removeItem(GIST_ID_KEY),
    AsyncStorage.removeItem(LAST_SYNC_KEY),
  ]);
}

async function markSynced(ms: number) {
  await AsyncStorage.setItem(LAST_SYNC_KEY, String(ms));
}

/** Tạo gist mới (private). Trả về gist ID để user lưu. */
export async function createNewGist(pat: string): Promise<string> {
  const res = await fetch(`${GH_API}/gists`, {
    method: "POST",
    headers: {
      "Authorization": `token ${pat.trim()}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: "BTC Dashboard — paper trade journal",
      public: false,
      files: {
        [FILE_NAME]: {
          content: JSON.stringify({ version: 1, updatedAt: Date.now(), trades: [] }, null, 2),
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Tạo gist fail: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.id) throw new Error("Gist response thiếu id");
  return json.id as string;
}

/** Pull từ gist. Trả về null nếu chưa setup hoặc lỗi. */
export async function pullFromGist(): Promise<GistPayload | null> {
  const cfg = await getGistConfig();
  if (!cfg.pat || !cfg.gistId) return null;
  try {
    const res = await fetch(`${GH_API}/gists/${cfg.gistId}`, {
      headers: {
        "Authorization": `token ${cfg.pat}`,
        "Accept": "application/vnd.github+json",
      },
    });
    if (!res.ok) throw new Error(`Pull fail: ${res.status}`);
    const json = await res.json();
    const file = json.files?.[FILE_NAME];
    if (!file?.content) return { version: 1, updatedAt: 0, trades: [] };
    const payload = JSON.parse(file.content) as GistPayload;
    return payload;
  } catch (e) {
    console.warn("[gistSync] pull failed:", e);
    return null;
  }
}

/** Push lên gist. Trả về true nếu thành công. */
export async function pushToGist(trades: PaperTrade[]): Promise<boolean> {
  const cfg = await getGistConfig();
  if (!cfg.pat || !cfg.gistId) return false;
  const payload: GistPayload = { version: 1, updatedAt: Date.now(), trades };
  try {
    const res = await fetch(`${GH_API}/gists/${cfg.gistId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `token ${cfg.pat}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: { [FILE_NAME]: { content: JSON.stringify(payload, null, 2) } },
      }),
    });
    if (!res.ok) throw new Error(`Push fail: ${res.status} ${await res.text()}`);
    await markSynced(payload.updatedAt);
    return true;
  } catch (e) {
    console.warn("[gistSync] push failed:", e);
    return false;
  }
}

/** Merge gist trades + local trades. Gist trades override local theo id;
 *  trades chỉ có ở local (mới hơn) được giữ lại. */
export function mergeTrades(local: PaperTrade[], remote: PaperTrade[]): PaperTrade[] {
  const byId = new Map<string, PaperTrade>();
  for (const t of remote) byId.set(t.id, t);
  for (const t of local) {
    const r = byId.get(t.id);
    if (!r) {
      byId.set(t.id, t);
    } else {
      // Khi cả 2 đều có: ưu tiên trade đã CLOSED (status !== OPEN) hoặc bản nào openedMs lớn hơn
      const localClosed = t.status !== "OPEN";
      const remoteClosed = r.status !== "OPEN";
      if (localClosed && !remoteClosed) byId.set(t.id, t);
      else if (remoteClosed && !localClosed) byId.set(t.id, r);
      else if (t.openedMs > r.openedMs) byId.set(t.id, t);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.openedMs - a.openedMs);
}

// ─── Debounced push helper ─────────────────────────────────────────────────
let pushTimer: ReturnType<typeof setTimeout> | null = null;
const PUSH_DEBOUNCE_MS = 3000;

/** Schedule a debounced push. Multiple calls within 3s coalesce into 1 push. */
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
