# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-10

First public release.

### Added

- MCP server for Meta's official Instagram Platform APIs. It uses no private
  endpoints, scraping or cookie auth.
- Two auth modes, selected with `IG_AUTH_MODE`:
  - `instagram_login` (default): `graph.instagram.com`, no Facebook Page
    required, 37 tools.
  - `facebook_login`: `graph.facebook.com`, 42 tools. Adds hashtag search,
    business discovery, Page listing and media deletion, which Meta serves only
    on the Facebook Login path.
- Tools for account and auth, publishing (images, Reels, carousels, Stories), media, comments, direct messages, insights and discovery.
- Local validation of insight metric and breakdown pairs, with replacement
  suggestions for deprecated metrics, before any request goes to the API.
- Markdown (default) and JSON response formats. JSON mode returns
  `structuredContent`.
- stdio transport (default) and Streamable HTTP (`TRANSPORT=http`) with
  `Host`/`Origin` validation on localhost binds.
- Graph API pinned to v26.0 by default. Override it with `IG_API_VERSION`.
- Smoke test suite (`npm run smoke`, 19 checks) that needs no live credentials.

[1.0.0]: https://github.com/qaassimq/instagram-mcp-server/releases/tag/v1.0.0
