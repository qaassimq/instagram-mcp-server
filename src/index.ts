#!/usr/bin/env node
/**
 * instagram-mcp-server — MCP server for Meta's official Instagram Platform APIs.
 *
 * Supports both of Meta's configurations:
 *   IG_AUTH_MODE=instagram_login  (default) graph.instagram.com, no Facebook Page required
 *   IG_AUTH_MODE=facebook_login             graph.facebook.com, Page-linked, adds hashtag
 *                                           search, business discovery and media deletion
 *
 * Serves stdio by default, Streamable HTTP when TRANSPORT=http.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, describeConfig, loadConfig, type Config } from "./config.js";
import { GraphClient } from "./graph.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerInsightsTools } from "./tools/insights.js";
import { registerMediaTools } from "./tools/media.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerPublishingTools } from "./tools/publishing.js";

const SERVER_NAME = "instagram-mcp-server";
const SERVER_VERSION = "1.0.0";

// Configuration and the API client are built once and closed over by the
// factory, so creating a server per request stays cheap.
function loadOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[${SERVER_NAME}] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const config: Config = loadOrExit();

const graph = new GraphClient(config);

const INSTRUCTIONS = `Tools for a single Instagram professional (Business or Creator) account through Meta's official Graph API.

Start with instagram_get_account: it returns the account ID other tools need and reports which capabilities this auth mode supports. Running in ${config.authMode} mode${
  config.supportsDiscovery
    ? ", so hashtag search and business discovery are available."
    : ", so hashtag search, business discovery and product tagging are NOT available — those endpoints exist only on the Facebook Login path."
}

Constraints worth knowing before you act:
- Publishing is capped at 100 posts per rolling 24 hours; a carousel counts as one. Check instagram_get_publishing_limit before a batch.
- All media must be at a public HTTPS URL that serves the file directly. Images must be JPEG. Meta fetches server-side, so local paths never work.
- Direct messages need the messaging permission with Advanced Access, and a reply is only allowed within 24 hours of the user's last message.
- Insight metric names change between Graph API versions. Call instagram_list_metric_catalog instead of guessing metric names.
- Reads are billed against a Business Use Case limit of 4800 x impressions per 24 hours, so prefer one call with a field list over many small calls.`;

/**
 * Builds a fresh server with every tool registered on it. serveStdio calls this
 * once per connection; createMcpHandler calls it once per HTTP request.
 */
function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerAccountTools(server, graph);
  registerPublishingTools(server, graph);
  registerMediaTools(server, graph);
  registerCommentTools(server, graph);
  registerMessagingTools(server, graph);
  registerInsightsTools(server, graph);
  registerDiscoveryTools(server, graph);

  return server;
}

if (process.env.TRANSPORT === "http") {
  const handler = createMcpHandler(createServer);
  const app = createMcpExpressApp();
  const nodeHandler = toNodeHandler(handler);
  app.all("/mcp", (req, res) => void nodeHandler(req, res, req.body));

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, "127.0.0.1", () => {
    console.error(`[${SERVER_NAME}] listening on http://127.0.0.1:${port}/mcp — ${describeConfig(config)}`);
  });
} else {
  serveStdio(createServer);
  console.error(`[${SERVER_NAME}] running on stdio — ${describeConfig(config)}`);
}
