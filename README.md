# instagram-mcp-server

[![npm version](https://img.shields.io/npm/v/@qaassim/instagram-mcp-server.svg)](https://www.npmjs.com/package/@qaassim/instagram-mcp-server)
[![CI](https://github.com/qaassimq/instagram-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/qaassimq/instagram-mcp-server/actions/workflows/ci.yml)

An MCP server for Meta's **official** Instagram Platform APIs. 37–42 tools covering
publishing, media, comments, direct messages, insights, and discovery.

No private endpoints, no scraping, no session cookies, no username/password login.
Every call goes to `graph.instagram.com` or `graph.facebook.com` with an OAuth token
you issued yourself.

- TypeScript, MCP SDK v2 (`@modelcontextprotocol/server`), Zod 4
- stdio and Streamable HTTP transports
- Graph API v26.0 by default, pinnable
- Supports **both** of Meta's Instagram configurations from one codebase

---

## Which auth mode do you want?

Meta ships two different Instagram APIs. This server implements both; `IG_AUTH_MODE`
picks one at startup, and only the tools that mode can actually serve get registered.

|                              | `instagram_login` (default) | `facebook_login` |
| ---------------------------- | --------------------------- | ---------------- |
| Host                         | `graph.instagram.com`       | `graph.facebook.com` |
| Facebook Page required       | **No**                      | **Yes** — and you must admin it |
| Scope family                 | `instagram_business_*`      | `instagram_*` + `pages_*` |
| Tools registered             | 37                          | 42 |
| Publishing, comments, DMs    | ✅                          | ✅ |
| Account and media insights   | ✅                          | ✅ |
| Mentions (read + reply)      | ✅                          | ✅ |
| Hashtag search               | ❌                          | ✅ |
| Business discovery (competitors) | ❌                      | ✅ |
| Product tagging / Shopping   | ❌                          | ✅ |
| Delete media                 | ❌                          | ✅ |
| `total_views` / `total_likes` / `total_comments` metrics | ❌ | ✅ |

**Pick `instagram_login`** if your users should be able to connect with just an
Instagram account. The onboarding is dramatically simpler and it is Meta's
forward-looking path.

**Pick `facebook_login`** if you need hashtag research, competitor lookup, or
Shopping tags. There is no way to get those on the Instagram Login path — it is a
Meta product decision, not a gap in this server.

You can run two instances side by side with different modes if you need both.

---

## Setup

### 1. Requirements

- Node.js 20.3 or newer
- An Instagram **professional** account — Business or Creator. Personal accounts
  cannot reach the Graph API at all.
- A Meta app at [developers.facebook.com](https://developers.facebook.com/apps)

### 2. Install

Nothing to install ahead of time. MCP clients can launch it straight from npm:

```bash
npx -y @qaassim/instagram-mcp-server
```

Run on its own, it exits and reports that `IG_ACCESS_TOKEN` is required. That is
expected. Your MCP client supplies the token through `env` (see step 5).

To install it globally instead:

```bash
npm install -g @qaassim/instagram-mcp-server
instagram-mcp-server
```

From source:

```bash
git clone https://github.com/qaassimq/instagram-mcp-server.git
cd instagram-mcp-server
npm install
npm run build
```

### 3. Create the Meta app and get a token

#### Instagram Login path

1. In the [App Dashboard](https://developers.facebook.com/apps), create an app and
   add the **Instagram** product.
2. Under **Instagram → API setup with Instagram Login**, connect your Instagram
   professional account.
3. In step 3 of that page, click **Generate token** next to your account. Copy the
   `IGAA...` token.
4. Request these permissions for your app:
   `instagram_business_basic`, `instagram_business_content_publish`,
   `instagram_business_manage_comments`, `instagram_business_manage_messages`.

#### Facebook Login path

1. Add the **Instagram** product and use **API setup with Facebook Login**.
2. Link your Instagram professional account to a Facebook Page you administer.
3. Generate a long-lived User or Page token with:
   `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
   `instagram_manage_insights`, `instagram_manage_messages`,
   `instagram_manage_contents`, `pages_show_list`, `pages_read_engagement`,
   `business_management`.
4. Run the server once and call `instagram_list_pages` to find your
   Instagram account ID, then set it as `IG_USER_ID`.

### 4. Configure

```bash
cp .env.example .env
# fill in IG_ACCESS_TOKEN, and IG_USER_ID if using facebook_login
```

### 5. Register with a client

Claude Desktop (`claude_desktop_config.json`) or any stdio MCP client:

```json
{
  "mcpServers": {
    "instagram": {
      "command": "npx",
      "args": ["-y", "@qaassim/instagram-mcp-server"],
      "env": {
        "IG_ACCESS_TOKEN": "IGAA...",
        "IG_AUTH_MODE": "instagram_login"
      }
    }
  }
}
```

From a source checkout, use `"command": "node"` and
`"args": ["/absolute/path/to/instagram-mcp-server/dist/index.js"]` instead.

For a remote deployment:

```bash
TRANSPORT=http PORT=3000 npm start
# -> http://127.0.0.1:3000/mcp
```

The HTTP handler validates `Host` and `Origin` on localhost binds. **Add bearer auth
before exposing it beyond localhost** — see `requireBearerAuth` in the
[SDK authorization docs](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.md).
The token in `IG_ACCESS_TOKEN` grants write access to a real Instagram account;
an unauthenticated public endpoint hands that to anyone who finds it.

### 6. Verify

```bash
npm run smoke        # 19 checks, no live credentials needed
npx @modelcontextprotocol/inspector node dist/index.js   # interactive
```

---

## Tools

### Account and auth (4–5)

| Tool | Notes |
| --- | --- |
| `instagram_get_account` | Profile **plus** a capability report for the active mode. Call this first. |
| `instagram_get_publishing_limit` | Quota used of the 100-post / 24h cap |
| `instagram_get_token_info` | `debug_token` on `facebook_login`; liveness check on `instagram_login` |
| `instagram_refresh_token` | Extends a long-lived token. Returns it — does **not** persist it. |
| `instagram_list_pages` | `facebook_login` only. Finds your `IG_USER_ID`. |

### Publishing (7)

`instagram_publish_image` · `instagram_publish_reel` · `instagram_publish_story` ·
`instagram_publish_carousel` · `instagram_create_container` ·
`instagram_get_container_status` · `instagram_publish_container`

The four high-level tools run Meta's whole create → process → publish flow. If video
processing outlasts `wait_seconds` they return the container ID instead of failing,
so an upload is never lost — finish it with `instagram_get_container_status` then
`instagram_publish_container`. `instagram_create_container` is the escape hatch for
parameters the high-level tools do not expose.

### Media (5–6)

`instagram_list_media` · `instagram_get_media` · `instagram_get_media_children` ·
`instagram_list_stories` · `instagram_list_tagged_media` ·
`instagram_delete_media` (`facebook_login` only)

### Comments (8)

`instagram_list_comments` · `instagram_get_comment` ·
`instagram_list_comment_replies` · `instagram_create_comment` ·
`instagram_reply_to_comment` · `instagram_hide_comment` ·
`instagram_delete_comment` · `instagram_toggle_media_comments`

### Direct messages (5)

`instagram_list_conversations` · `instagram_get_conversation` ·
`instagram_send_message` · `instagram_send_media_message` · `instagram_mark_seen`

`instagram_get_conversation` reports whether the 24-hour reply window is still open,
so you can tell a refusal from a policy limit before you try to send.

### Insights (5)

`instagram_list_metric_catalog` · `instagram_get_account_insights` ·
`instagram_get_media_insights` · `instagram_get_audience_demographics` ·
`instagram_get_story_insights`

Metric names change between Graph API versions and an unsupported metric or an
invalid metric/breakdown pair is a hard API error. `instagram_list_metric_catalog`
makes no API call and lists exactly what is valid, so the model looks names up
instead of guessing. Invalid pairs are rejected locally, before the round-trip.

`instagram_get_story_insights` reads every live story in one call — story insights
disappear with the story after 24 hours.

### Discovery (3–6)

`instagram_get_mentioned_comment` · `instagram_get_mentioned_media` ·
`instagram_reply_to_mention`
and on `facebook_login` only: `instagram_search_hashtag` ·
`instagram_get_hashtag_media` · `instagram_business_discovery`

**There is no "list all mentions" tool, because Meta has no such endpoint.** Mentions
are delivered to your app through the `mentions` webhook field and then read by ID.
Without a webhook you cannot discover mentions through the API. Photo tags are a
different edge and *can* be listed — that is `instagram_list_tagged_media`.

---

## Limitations you inherit from the Graph API

None of these are implementation gaps. They are Meta's constraints, and no MCP
wrapper can route around them.

**Account type.** Instagram professional accounts only. Personal accounts have no
Graph API access whatsoever.

**App Review.** Serving only your own business needs no review — Standard Access
covers it. The moment your app touches *another* business's account you need
Advanced Access, which means App Review: app icon, privacy policy, category, test
credentials, and an English screencast per permission. `instagram_manage_messages`
is the one that bites first, so **DMs will not work for third parties until you pass
review**.

**Publishing.** 100 API-published posts per rolling 24 hours, per account; a carousel
counts as one. JPEG is the only supported image format. Media must sit at a public
HTTPS URL that returns the file directly — Meta fetches it server-side, so local
paths, authenticated URLs, redirects and expiring signed URLs all fail. No filters,
no Shopping tags, no branded-content tags. `alt_text` works on image posts but not
on reels or stories.

**Rate limits.** Instagram Platform endpoints run on a Business Use Case limit of
`4800 × impressions` per 24 hours, where impressions is how many times the account's
content hit a screen in the last day. **A low-reach account is a low-quota account** —
your budget scales with the audience you already have, not with your needs. Business
Discovery and Hashtag Search sit outside this and fall under standard Platform Rate
Limits instead.

**Hashtag search.** 30 *unique* hashtags per rolling 7 days per account. Resolve a
hashtag to its ID once and reuse the ID. `recent_media` only covers the last 24
hours, and personal-account posts are never returned.

**Insights.** Carousel albums have no per-child insights. Audience demographics are
withheld below roughly 100 followers (an empty result, not an error). `impressions`
was replaced by `views` for media created after 2024-07-02.

**Messaging.** A standard reply is only allowed within 24 hours of the user's last
message. The `HUMAN_AGENT` tag extends that to 7 days. Unsolicited DMs are not
possible. Recipients are addressed by Instagram-scoped ID (IGSID) from a conversation
or webhook — never by public username.

**Version churn.** Meta retires a Graph API version roughly two years after release;
v26.0 shipped 2026-07-29. Pin `IG_API_VERSION` and treat upgrades as recurring work.

---

## Architecture

```
src/
  index.ts        createServer() factory + transport selection
  config.ts       environment resolution, auth-mode validation
  constants.ts    every documented Meta constraint, cited to its doc
  graph.ts        dual-host client, error mapping, cursor pagination
  format.ts       markdown/JSON switch, character-limit guard, renderers
  tools/
    account.ts    identity, capabilities, quota, token lifecycle
    publishing.ts container create → poll → publish
    media.ts      feed, single media, carousel children, stories, tags
    comments.ts   read and moderate
    messaging.ts  Instagram Direct
    insights.ts   account, media, demographics, stories, metric catalog
    discovery.ts  mentions, hashtags, business discovery
scripts/
  smoke.ts        19-check self-test
```

Design notes worth knowing if you extend it:

- **`createServer()` returns a fresh `McpServer` every call.** `createMcpHandler`
  invokes it per HTTP request; a shared instance passes manual testing and then
  fails under concurrency with `-32603`. The smoke test fires concurrent HTTP
  requests specifically to catch that regression.
- **The `GraphClient` lives at module scope** and is closed over, so the factory
  stays cheap.
- **Tools are gated at registration, not at call time.** In `instagram_login` mode
  the model never sees `instagram_search_hashtag`, so it cannot waste a turn
  discovering it does not work. `instagram_get_account` reports what is missing and
  why.
- **Error text is written for the model.** Meta's own message is preserved, the
  numeric code is kept, and a recovery sentence plus the failing call site are
  appended. `GraphError` exposes `isAuthError` / `isPermissionError` /
  `isRateLimited` for programmatic branching.
- **The token goes in the `Authorization` header on reads and in the form body on
  writes**, so it never lands in a logged query string on a mutation.
- **Responses stay under 25,000 characters by returning fewer items**, never by
  truncating text — the pagination cursor is suppressed when items are dropped so
  nothing is silently skipped.

---

## License

[MIT](LICENSE)
