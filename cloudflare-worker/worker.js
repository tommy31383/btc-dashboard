/**
 * btc-sync — Cloudflare Worker proxy giữa app BTC Dashboard và GitHub Contents API.
 *
 * Mục đích: Tommy không phải nhập PAT trong app. PAT lưu ở env var Worker (Cloudflare secret),
 * không lộ trong bundle JS public.
 *
 * Deploy:
 *   1. https://dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. Paste file này vào editor → Save and Deploy
 *   3. Settings → Variables and Secrets → thêm:
 *      - GH_PAT       (Secret) → PAT của anh, scope: Contents read+write
 *      - GH_OWNER     (Variable) → "tommy31383"
 *      - GH_REPO      (Variable) → "btc-dashboard"
 *      - GH_BRANCH    (Variable) → "paper-data"
 *   4. Copy URL worker (vd https://btc-sync.tommy.workers.dev)
 *   5. Paste URL vào utils/gistSync.ts → const WORKER_URL = "..."
 *
 * Endpoints:
 *   GET  /file?path=X                    → pull file content (returns GitHub Contents JSON)
 *   PUT  /file?path=X  body: {message, content, sha?, branch?} → push file
 *   GET  /ref?ref=heads/X                → read ref (check branch tồn tại)
 *   POST /ref          body: {ref, sha}  → create new ref (init branch)
 *
 * CORS: chỉ accept request từ allowed origins (Pages domain + localhost dev).
 */

const ALLOWED_ORIGINS = [
  "https://tommy31383.github.io",
  "http://localhost:8081",
  "http://localhost:19006",
  "http://127.0.0.1:8081",
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function isSafePath(p) {
  // Allow alphanum, /, _, -, ., không cho .. và absolute
  return typeof p === "string" && /^[a-zA-Z0-9_./-]+$/.test(p) && !p.includes("..");
}

async function proxyToGithub(url, init, env) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `token ${env.GH_PAT}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "btc-sync-worker");
  return fetch(url, { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!env.GH_PAT || !env.GH_OWNER || !env.GH_REPO) {
      return new Response("Worker chưa setup env vars (GH_PAT/GH_OWNER/GH_REPO).", {
        status: 500, headers: cors,
      });
    }

    const ghBase = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}`;
    const path = url.pathname;

    // GET /file?path=X[&ref=branch]
    // PUT /file?path=X body=raw GitHub PUT body
    if (path === "/file") {
      const filePath = url.searchParams.get("path");
      if (!isSafePath(filePath)) {
        return new Response("bad path", { status: 400, headers: cors });
      }
      if (request.method === "GET") {
        const branch = url.searchParams.get("ref") || env.GH_BRANCH || "master";
        const r = await proxyToGithub(`${ghBase}/contents/${filePath}?ref=${branch}`, { method: "GET" }, env);
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      if (request.method === "PUT") {
        const body = await request.text();
        const r = await proxyToGithub(`${ghBase}/contents/${filePath}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        }, env);
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    // GET /ref?ref=heads/paper-data
    // POST /ref body={ref, sha}  (create branch)
    if (path === "/ref") {
      if (request.method === "GET") {
        const ref = url.searchParams.get("ref");
        if (!ref || !/^heads\/[a-zA-Z0-9_./-]+$/.test(ref)) {
          return new Response("bad ref", { status: 400, headers: cors });
        }
        const r = await proxyToGithub(`${ghBase}/git/ref/${ref}`, { method: "GET" }, env);
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      if (request.method === "POST") {
        const body = await request.text();
        const r = await proxyToGithub(`${ghBase}/git/refs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }, env);
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    // Health check / info
    if (path === "/" || path === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        owner: env.GH_OWNER,
        repo: env.GH_REPO,
        branch: env.GH_BRANCH,
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};
