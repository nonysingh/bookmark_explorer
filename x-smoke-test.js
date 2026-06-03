#!/usr/bin/env node
// x-smoke-test.js
// Minimal OAuth 2.0 PKCE smoke test for the X (Twitter) API.
// Goal: confirm whether USER-CONTEXT auth works on your account by calling GET /2/users/me.
// If this passes (HTTP 200), the bookmarks endpoint will work too.
// Requires Node 18+ (uses built-in fetch, crypto, http). No `npm install` needed.

const http = require("http");
const crypto = require("crypto");

// ============ FILL THIS IN ============
const CLIENT_ID = process.env.X_CLIENT_ID || "PASTE_YOUR_CLIENT_ID_HERE";
// Only set this if you created a "Confidential client". Leave "" for a "Public client".
const CLIENT_SECRET = process.env.X_CLIENT_SECRET || "";
// Must EXACTLY match the Callback URI you register in the X developer console.
const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const SCOPES = "tweet.read users.read bookmark.read offline.access";
const PORT = 3000;
// ======================================

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const codeVerifier = b64url(crypto.randomBytes(32));
const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
const state = b64url(crypto.randomBytes(16));

const authUrl =
  "https://x.com/i/oauth2/authorize?" +
  new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

console.log("\n1) Open this URL in your browser and click Authorize:\n");
console.log(authUrl + "\n");
console.log("Waiting for the redirect back to " + REDIRECT_URI + " ...\n");

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Authorization error: " + err + " - check the terminal.");
    console.error("\nX Authorization denied or failed: " + err);
    return server.close();
  }
  if (returnedState !== state) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("State mismatch - possible CSRF. Check the terminal.");
    console.error("\nX State mismatch. Aborting.");
    return server.close();
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Got the code. You can close this tab and return to the terminal.");

  try {
    // ----- Exchange the authorization code for an access token -----
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    });

    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (CLIENT_SECRET) {
      // Confidential client: authenticate with HTTP Basic
      const basic = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
      headers["Authorization"] = "Basic " + basic;
    }

    const tokenResp = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers,
      body,
    });
    const tokenText = await tokenResp.text();
    console.log("\n--- Token exchange ---");
    console.log("HTTP " + tokenResp.status);
    console.log(tokenText);

    let accessToken;
    try {
      accessToken = JSON.parse(tokenText).access_token;
    } catch (_) {}

    if (!accessToken) {
      console.error("\nX No access token returned. Stopping before /2/users/me.");
      return server.close();
    }

    // ----- The actual smoke test: call /2/users/me -----
    const meResp = await fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    const meText = await meResp.text();

    console.log("\n=== SMOKE TEST: GET /2/users/me ===");
    console.log("HTTP " + meResp.status);
    console.log(meText);

    if (meResp.status === 200) {
      console.log("\nPASS - user-context auth works. Bookmarks should be buildable.");
    } else if (meResp.status === 403) {
      console.log("\n403 FORBIDDEN - matches the known Pay-Per-Use enrollment bug.");
      console.log("User-context auth (and therefore bookmarks) won't work until X fixes it.");
    } else if (meResp.status === 401) {
      console.log("\n401 UNAUTHORIZED - usually a credential/Client ID problem. Re-check setup.");
    } else if (meResp.status === 402) {
      console.log("\n402 - add a small credit balance to the app, then retry.");
    } else {
      console.log("\nUnexpected status - see the body above.");
    }
  } catch (e) {
    console.error("\nX Request failed:", e);
  } finally {
    server.close();
  }
});

server.listen(PORT);
