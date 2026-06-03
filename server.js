#!/usr/bin/env node
// server.js — X Bookmark Explorer (with Claude fact-check)
// Zero dependencies. Requires Node 18+ (built-in fetch, crypto, http, fs).
//
// Run:
//   X_CLIENT_ID="..." ANTHROPIC_API_KEY="sk-ant-..." node server.js
// Then open http://localhost:3000
//
// What it does:
//   - One-time X login via OAuth 2.0 PKCE; tokens saved locally (chmod 600) and auto-refreshed.
//   - Lists all your bookmarked posts.
//   - Each post has a "verify" button -> asks before sending the post to Claude,
//     which web-searches to assess the post's factual correctness and returns feedback.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ===================== CONFIG (via env) =====================
const CLIENT_ID = process.env.X_CLIENT_ID || "";
const CLIENT_SECRET = process.env.X_CLIENT_SECRET || ""; // only for confidential clients
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANALYZE_MODEL = process.env.ANALYZE_MODEL || "claude-sonnet-4-6";
const ANALYZE_MAX_SEARCHES = Number(process.env.ANALYZE_MAX_SEARCHES || 3); // lower = cheaper
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3000/callback";
const PORT = Number(process.env.PORT || 3000);
const SCOPES = "tweet.read users.read bookmark.read offline.access";
const MAX_BOOKMARKS = Number(process.env.MAX_BOOKMARKS || 800); // safety cap on pagination
const TOKEN_FILE =
  process.env.TOKEN_FILE || path.join(os.homedir(), ".x-bookmark-explorer-tokens.json");
const SAVE_FILE = process.env.SAVE_FILE || path.join(__dirname, "saved-bookmarks.txt");
// ============================================================

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

if (!CLIENT_ID) {
  console.error("Missing X_CLIENT_ID. Run: X_CLIENT_ID=... ANTHROPIC_API_KEY=... node server.js");
  process.exit(1);
}

let pendingAuth = null; // { verifier, state }

// ---------- token storage ----------
function saveTokens(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
}
function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch (_) { return null; }
}

// ---------- X OAuth token exchange / refresh ----------
function tokenAuthHeaders() {
  const h = { "Content-Type": "application/x-www-form-urlencoded" };
  if (CLIENT_SECRET) {
    h["Authorization"] = "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
  }
  return h;
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const r = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST", headers: tokenAuthHeaders(), body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error("Token exchange failed: " + JSON.stringify(data));
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 7200) * 1000,
  };
}

async function refresh(tokens) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: CLIENT_ID,
  });
  const r = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST", headers: tokenAuthHeaders(), body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error("Refresh failed: " + JSON.stringify(data));
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token, // X may rotate it
    expires_at: Date.now() + (data.expires_in || 7200) * 1000,
  };
  saveTokens(next);
  return next;
}

async function getAccessToken() {
  let t = loadTokens();
  if (!t) { const e = new Error("not_authed"); e.code = "NOAUTH"; throw e; }
  if (Date.now() > t.expires_at - 60000) t = await refresh(t);
  return t.access_token;
}

// ---------- X data ----------
let cachedUserId = null;
async function getUserId(accessToken) {
  if (cachedUserId) return cachedUserId;
  const r = await fetch("https://api.x.com/2/users/me", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  const data = await r.json();
  if (!r.ok) throw new Error("users/me failed: " + JSON.stringify(data));
  cachedUserId = data.data.id;
  return cachedUserId;
}

async function fetchAllBookmarks(accessToken, userId) {
  const out = [];
  let nextToken = null;
  while (out.length < MAX_BOOKMARKS) {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "created_at,public_metrics,author_id,note_tweet",
      expansions: "author_id",
      "user.fields": "name,username",
    });
    if (nextToken) params.set("pagination_token", nextToken);
    const r = await fetch(
      `https://api.x.com/2/users/${userId}/bookmarks?` + params.toString(),
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    const data = await r.json();
    if (!r.ok) throw new Error("bookmarks failed: " + JSON.stringify(data));
    const users = {};
    (data.includes?.users || []).forEach((u) => (users[u.id] = u));
    (data.data || []).forEach((tw) => {
      const u = users[tw.author_id] || {};
      out.push({
        id: tw.id,
        text: tw.note_tweet?.text || tw.text,
        created_at: tw.created_at,
        author_name: u.name || "",
        author_username: u.username || "",
        url: u.username ? `https://x.com/${u.username}/status/${tw.id}` : `https://x.com/i/web/status/${tw.id}`,
        metrics: tw.public_metrics || {},
      });
    });
    nextToken = data.meta?.next_token;
    if (!nextToken) break;
  }
  return out;
}

// ---------- Claude fact-check ----------
async function analyzePost(post, mode) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  const deep = mode !== "quick";
  const verifyLine = deep
    ? "- Use web search to verify specific, checkable, or time-sensitive claims (numbers, dates, events, quotes, current status). Be economical: only search for the claims that genuinely need it, and prefer one combined search over several."
    : "- Do NOT use any tools. Assess based only on your own knowledge, and clearly flag any claim you cannot verify without live data (prices, recent events, current status, etc.).";
  const prompt =
`You are fact-checking a single post from X (Twitter). Assess how factually correct it is.

Post author: @${post.author_username || "unknown"}
Post text:
"""
${post.text}
"""

Instructions:
${verifyLine}
- Be even-handed. Separate what is accurate, what is misleading or false, and what cannot be verified.
- If the post is opinion or a prediction rather than a factual claim, say so.
- End with a one-line overall verdict.
- Keep it concise (a few short paragraphs). Plain text, light use of dashes for lists is fine.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANALYZE_MODEL,
      max_tokens: 1024,
      ...(deep
        ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: ANALYZE_MAX_SEARCHES }] }
        : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error("Anthropic API error: " + JSON.stringify(data));
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const usage = data.usage || {};
  return {
    analysis: text || "(No text returned.)",
    mode: deep ? "deep" : "quick",
    searches: usage.server_tool_use?.web_search_requests || 0,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
  };
}

async function summarizePost(post) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  const prompt =
`Summarize the following post from X (Twitter) in 2-3 tight sentences, capturing its main point and any key specifics. No preamble, no tools.

Post by @${post.author_username || "unknown"}:
"""
${post.text}
"""`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANALYZE_MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error("Anthropic API error: " + JSON.stringify(data));
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const usage = data.usage || {};
  return {
    summary: text || "(No text returned.)",
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
  };
}

// ---------- tiny HTTP helpers ----------
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (u.pathname === "/" && req.method === "GET") {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8"), "text/html");
    }

    if (u.pathname === "/login" && req.method === "GET") {
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const state = b64url(crypto.randomBytes(16));
      pendingAuth = { verifier, state };
      const authUrl = "https://x.com/i/oauth2/authorize?" + new URLSearchParams({
        response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
        scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256",
      });
      res.writeHead(302, { Location: authUrl });
      return res.end();
    }

    if (u.pathname === "/callback" && req.method === "GET") {
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!pendingAuth || state !== pendingAuth.state) return send(res, 400, "State mismatch. Restart login.", "text/plain");
      const tokens = await exchangeCode(code, pendingAuth.verifier);
      pendingAuth = null;
      saveTokens(tokens);
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (u.pathname === "/api/status" && req.method === "GET") {
      return send(res, 200, { authed: !!loadTokens(), analyzeEnabled: !!ANTHROPIC_API_KEY });
    }

    if (u.pathname === "/api/logout" && req.method === "POST") {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
      cachedUserId = null;
      return send(res, 200, { ok: true });
    }

    if (u.pathname === "/api/bookmarks" && req.method === "GET") {
      const at = await getAccessToken();
      const uid = await getUserId(at);
      const bookmarks = await fetchAllBookmarks(at, uid);
      return send(res, 200, { bookmarks });
    }

    if (u.pathname === "/api/save" && req.method === "POST") {
      const post = await readJson(req);
      if (!post.text) return send(res, 400, { error: "Missing post text." });
      const who =
        "@" + (post.author_username || "unknown") +
        (post.author_name ? ` (${post.author_name})` : "");
      const block =
        `${who}  ·  saved ${new Date().toISOString()}\n` +
        `${post.text}\n` +
        (post.url ? `${post.url}\n` : "") +
        "-".repeat(60) + "\n\n";
      fs.appendFileSync(SAVE_FILE, block);
      return send(res, 200, { ok: true, file: SAVE_FILE });
    }

    if (u.pathname === "/api/summarize" && req.method === "POST") {
      const post = await readJson(req);
      if (!post.text) return send(res, 400, { error: "Missing post text." });
      const result = await summarizePost(post);
      return send(res, 200, result);
    }

    if (u.pathname === "/api/analyze" && req.method === "POST") {
      const post = await readJson(req);
      if (!post.text) return send(res, 400, { error: "Missing post text." });
      const result = await analyzePost(post, post.mode);
      return send(res, 200, result);
    }

    return send(res, 404, "Not found", "text/plain");
  } catch (e) {
    if (e.code === "NOAUTH") return send(res, 401, { error: "not_authed" });
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\nX Bookmark Explorer running at http://localhost:${PORT}`);
  console.log(loadTokens() ? "Status: already authorized." : "Status: open the page and click Connect.");
  if (!ANTHROPIC_API_KEY) console.log("Note: ANTHROPIC_API_KEY not set — the verify/fact-check button will be disabled.");
  console.log("Saved posts will be appended to: " + SAVE_FILE);
});
