# Bookmark Explorer

A personal, single-user app that lists your X (Twitter) bookmarks and lets you
**save**, **summarize**, and **fact-check** any of them with Claude. Runs locally
on your machine. Zero npm dependencies.

## Features

- **Bookmarks reader** — your saved posts as a clean, scrollable list, with full
  text even for X's long-form posts (which the API otherwise truncates).
- **Search, filter & sort** — search by text or author, filter to a single
  account, and sort by newest, oldest, most liked, or most reposted. Runs
  instantly in the browser.
- **Save** — appends a post's text, author, and link to one growing `.txt` file.
- **Summarize** — a cheap, no-web-search TL;DR from Claude. Good for long threads.
- **Verify** — Claude assesses how factually correct a post is. Two modes:
  - **Quick** — no web search; Claude reasons from its own knowledge and flags
    anything it can't confirm. Cheapest.
  - **Deep** — Claude web-searches to verify time-sensitive or specific claims.
    Most accurate; costs more.
  - Every check prints its actual cost (searches + token counts).

## Requirements

- **Node 18+** (`node -v`)
- An **X app** set up for OAuth 2.0 — Native App (Public client), **Read**
  permission, callback `http://localhost:3000/callback`. You'll need its
  **OAuth 2.0 Client ID**.
- An **Anthropic API key** (only for Summarize/Verify) from
  https://console.anthropic.com → API keys. Bookmarks work without it.

## Setup

### 1. Smoke-test auth first (recommended)

Some new pay-per-use X apps aren't enrolled correctly on X's backend, which makes
user-context auth return `403`. Before building on it, run the included
`x-smoke-test.js` — if it prints `HTTP 200`, you're good. If `403`, that's a
platform issue, not your setup.

### 2. Configure the X app

In the X developer console (you'll be on Pay-Per-Use):

1. Create an app and move it to the **Production** environment (dev apps don't
   support these endpoints).
2. In **User authentication settings**:
   - App permissions: **Read**
   - Type of App: **Native App (Public client)**
   - Callback URI: `http://localhost:3000/callback`
3. Copy the **OAuth 2.0 Client ID** from **Keys and tokens**.
4. Add a small credit balance under **Billing → Credits**.

## Run

From inside this folder:

```bash
X_CLIENT_ID="your_x_client_id" \
ANTHROPIC_API_KEY="sk-ant-..." \
node server.js
```

Then open http://localhost:3000 and click **Connect X account** once.

- **Confidential client?** If you chose Web App instead of Native, also pass
  `X_CLIENT_SECRET="..."`.
- **Using 127.0.0.1?** If your callback is registered as `127.0.0.1`, pass
  `REDIRECT_URI="http://127.0.0.1:3000/callback"` and open that address.

## How it works

- **Login** — OAuth 2.0 with PKCE, one time. Tokens are saved to
  `~/.x-bookmark-explorer-tokens.json` (permissions `600`) and refreshed
  automatically, so you don't log in again. **Disconnect** deletes that file.
- **Bookmarks** — paginated via `GET /2/users/:id/bookmarks` (cheap "owned
  reads"), requesting the `note_tweet` field so long posts come back in full.
- **Save** — appends to `saved-bookmarks.txt` (created next to `server.js`).
- **Summarize / Verify** — the **backend** (never the browser) calls the
  Anthropic Messages API, so your API key stays server-side. Verify enables the
  web-search tool in Deep mode.

## Configuration (optional env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `X_CLIENT_ID` | — (required) | Your X OAuth 2.0 Client ID |
| `ANTHROPIC_API_KEY` | — | Enables Summarize/Verify |
| `X_CLIENT_SECRET` | — | Only for Confidential (Web App) clients |
| `REDIRECT_URI` | `http://localhost:3000/callback` | Must match the X console exactly |
| `ANALYZE_MODEL` | `claude-sonnet-4-6` | e.g. `claude-haiku-4-5-20251001` (cheaper) or `claude-opus-4-8` (deeper) |
| `ANALYZE_MAX_SEARCHES` | `3` | Cap on web searches per Deep check; lower = cheaper |
| `MAX_BOOKMARKS` | `800` | Pagination safety cap |
| `SAVE_FILE` | `./saved-bookmarks.txt` | Where Save appends |
| `TOKEN_FILE` | `~/.x-bookmark-explorer-tokens.json` | Where tokens are cached |
| `PORT` | `3000` | Server port |

## Costs

**X charges per API call, not for running the app** — idle time is free.

- **Bookmark loads:** one call per 100 saved posts at ~$0.001 each, on each page
  load/refresh. A few hundred bookmarks is a fraction of a cent per load.
- **Save:** local file write — free.
- **Summarize:** Anthropic tokens only (no web search) — cheap.
- **Verify (Deep):** Anthropic tokens **plus** web search at ~$0.01/search;
  search-result pages also add input tokens. Typically a few cents per check.
- **Verify (Quick):** Anthropic tokens only — far cheaper than Deep.

X's pay-per-use rates can change — check your developer-console billing/usage
page for the source of truth.

## Security & good manners

- Keep your Client ID, Anthropic key, and the token file **out of version
  control.** Add a `.gitignore` with `saved-bookmarks.txt` and `*tokens*.json`.
- The token file grants access to your bookmarks until you disconnect or revoke
  the app in your X account settings.
- This is a **personal, single-user tool** — it reads your own account and shows
  data only to you. Don't redistribute others' posts; stay within X's terms.
- An AI fact-check is a **starting point, not a verdict.** Nothing here is
  financial advice.

  ## Note

Built with the help of Claude (Anthropic) for development, debugging, and
documentation. All setup, testing, and decisions are my own.
