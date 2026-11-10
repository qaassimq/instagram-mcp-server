/**
 * Self-check. Starts the built server over stdio and exercises everything that
 * can be verified without live Instagram credentials:
 *
 *   1. the tool registry, including auth-mode gating of Facebook-Login-only tools
 *   2. every tool's schema is advertised with descriptions
 *   3. input validation rejects bad arguments before any network call
 *   4. instagram_list_metric_catalog, which makes no API call, returns real data
 *   5. a network tool with a bogus token fails as a readable tool error, not a crash
 *   6. the HTTP transport builds a fresh server per request (concurrency safety)
 *
 * Run with: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const FAKE_TOKEN = "IGAA_smoke_test_token_not_real";

const ALWAYS_PRESENT = [
  "instagram_create_comment",
  "instagram_create_container",
  "instagram_delete_comment",
  "instagram_get_account",
  "instagram_get_account_insights",
  "instagram_get_audience_demographics",
  "instagram_get_comment",
  "instagram_get_container_status",
  "instagram_get_conversation",
  "instagram_get_media",
  "instagram_get_media_children",
  "instagram_get_media_insights",
  "instagram_get_mentioned_comment",
  "instagram_get_mentioned_media",
  "instagram_get_publishing_limit",
  "instagram_get_story_insights",
  "instagram_get_token_info",
  "instagram_hide_comment",
  "instagram_list_comment_replies",
  "instagram_list_comments",
  "instagram_list_conversations",
  "instagram_list_media",
  "instagram_list_metric_catalog",
  "instagram_list_stories",
  "instagram_list_tagged_media",
  "instagram_mark_seen",
  "instagram_publish_carousel",
  "instagram_publish_container",
  "instagram_publish_image",
  "instagram_publish_reel",
  "instagram_publish_story",
  "instagram_refresh_token",
  "instagram_reply_to_comment",
  "instagram_reply_to_mention",
  "instagram_send_media_message",
  "instagram_send_message",
  "instagram_toggle_media_comments",
].sort();

const FACEBOOK_LOGIN_ONLY = [
  "instagram_business_discovery",
  "instagram_delete_media",
  "instagram_get_hashtag_media",
  "instagram_list_pages",
  "instagram_search_hashtag",
].sort();

async function connectStdio(authMode: string): Promise<Client> {
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        ...getDefaultEnvironment(),
        // Forwarded when set so the live-error check below reaches Meta from
        // behind a corporate or CI proxy instead of failing at the socket.
        ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
        ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
        IG_ACCESS_TOKEN: FAKE_TOKEN,
        IG_AUTH_MODE: authMode,
        IG_USER_ID: "17841400000000000",
      },
    }),
  );
  return client;
}

function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type?: string; text?: string }[];
  return blocks.map((block) => block.text ?? "").join("\n");
}

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.error(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- 1 & 2: registry and gating, instagram_login mode -----------------------

console.error("instagram_login mode");
const igClient = await connectStdio("instagram_login");
const igTools = (await igClient.listTools()).tools;
const igNames = igTools.map((tool) => tool.name).sort();

check(`registers ${ALWAYS_PRESENT.length} tools`, () => {
  assert.deepEqual(igNames, ALWAYS_PRESENT);
});

check("hides Facebook-Login-only tools", () => {
  const leaked = igNames.filter((name) => FACEBOOK_LOGIN_ONLY.includes(name));
  assert.deepEqual(leaked, [], `these should not be registered in instagram_login mode: ${leaked.join(", ")}`);
});

check("every tool has a title, description and annotations", () => {
  for (const tool of igTools) {
    assert.ok(tool.title, `${tool.name} has no title`);
    assert.ok((tool.description ?? "").length > 40, `${tool.name} has a thin description`);
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    assert.equal(
      typeof tool.annotations?.readOnlyHint,
      "boolean",
      `${tool.name} does not declare readOnlyHint`,
    );
  }
});

check("destructive tools are marked destructive", () => {
  const destructive = ["instagram_delete_comment"];
  for (const name of destructive) {
    const tool = igTools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} missing`);
    assert.equal(tool?.annotations?.destructiveHint, true, `${name} is not marked destructive`);
  }
});

check("argument descriptions survive into the advertised schema", () => {
  const publish = igTools.find((tool) => tool.name === "instagram_publish_image");
  const properties = (publish?.inputSchema as { properties?: Record<string, { description?: string }> })
    ?.properties;
  assert.ok(properties?.image_url?.description, "image_url lost its .describe() text");
  assert.match(String(properties?.image_url?.description), /JPEG/i);
});

// --- 3: input validation ----------------------------------------------------

const badUrl = await igClient.callTool({
  name: "instagram_publish_image",
  arguments: { image_url: "not-a-url" },
});
check("rejects a non-URL image_url", () => {
  assert.equal(badUrl.isError, true, "an invalid URL should be a tool error");
});

const unknownArg = await igClient.callTool({
  name: "instagram_get_media",
  arguments: { media_id: "123", surprise: true },
});
check("rejects unknown arguments (strictObject)", () => {
  assert.equal(unknownArg.isError, true, "an unknown argument should be rejected");
});

const badStory = await igClient.callTool({
  name: "instagram_publish_story",
  arguments: { image_url: "https://example.com/a.jpg", video_url: "https://example.com/a.mp4" },
});
check("rejects a story with both image_url and video_url", () => {
  assert.equal(badStory.isError, true, "the refine() rule should reject both at once");
});

const badBreakdown = await igClient.callTool({
  name: "instagram_get_account_insights",
  arguments: { metrics: ["accounts_engaged"], breakdown: "media_product_type" },
});
check("rejects an unsupported metric/breakdown pair without an API round-trip", () => {
  assert.equal(badBreakdown.isError, true);
  assert.match(textOf(badBreakdown), /not supported/i);
});

const deprecated = await igClient.callTool({
  name: "instagram_get_media_insights",
  arguments: { media_id: "1", metrics: ["impressions"] },
});
check("rejects deprecated metrics with a replacement suggestion", () => {
  assert.equal(deprecated.isError, true);
  assert.match(textOf(deprecated), /views/i);
});

const fbOnlyMetric = await igClient.callTool({
  name: "instagram_get_media_insights",
  arguments: { media_id: "1", metrics: ["total_views"] },
});
check("rejects Facebook-Login-only metrics in instagram_login mode", () => {
  assert.equal(fbOnlyMetric.isError, true);
  assert.match(textOf(fbOnlyMetric), /facebook login/i);
});

// --- 4: the offline tool actually works -------------------------------------

const catalog = await igClient.callTool({
  name: "instagram_list_metric_catalog",
  arguments: { response_format: "json" },
});
check("instagram_list_metric_catalog returns a real catalog with no network call", () => {
  assert.ok(!catalog.isError, `catalog failed: ${textOf(catalog)}`);
  const data = catalog.structuredContent as {
    account_metrics?: string[];
    media_metrics_by_type?: Record<string, string[]>;
    deprecated?: string[];
    auth_mode?: string;
  };
  assert.ok(Array.isArray(data.account_metrics) && data.account_metrics.includes("reach"));
  assert.ok(data.media_metrics_by_type?.REELS?.includes("ig_reels_avg_watch_time"));
  assert.ok(data.deprecated?.includes("impressions"));
  assert.equal(data.auth_mode, "instagram_login");
});

check("JSON mode serializes structuredContent into the text block", () => {
  assert.deepEqual(JSON.parse(textOf(catalog)), catalog.structuredContent);
});

const catalogMarkdown = await igClient.callTool({
  name: "instagram_list_metric_catalog",
  arguments: {},
});
check("markdown mode is the default and returns no structuredContent", () => {
  assert.ok(!catalogMarkdown.isError);
  assert.equal(catalogMarkdown.structuredContent, undefined);
  assert.match(textOf(catalogMarkdown), /^# Insight metric catalog/);
});

// --- 5: a live call with a bogus token degrades readably --------------------

const unauthorized = await igClient.callTool({
  name: "instagram_get_account",
  arguments: {},
});
check("a rejected token produces an actionable tool error, not a crash", () => {
  assert.equal(unauthorized.isError, true, "a fake token should fail");
  const text = textOf(unauthorized);
  assert.ok(text.length > 0, "the error should carry text the model can read");

  const reachedMeta = /OAuth|access token|code \d+/i.test(text);
  if (reachedMeta) {
    // Meta answered: the envelope must be mapped to recovery advice, and the
    // call site must be named so the model knows what failed.
    assert.match(text, /instagram_refresh_token|App Dashboard/i, `no recovery advice: ${text}`);
    assert.match(text, /Context:/, `no call context: ${text}`);
  } else {
    // No egress to graph.instagram.com from this environment. The error must
    // still name the host rather than surfacing a bare "fetch failed".
    assert.match(text, /Could not reach https:\/\/graph\./, `unhelpful transport error: ${text}`);
    console.error("       note: no network egress to Meta — error mapping checked on the transport path only");
  }
});

await igClient.close();

// --- 1 & 2 again: facebook_login mode registers the extra tools -------------

console.error("facebook_login mode");
const fbClient = await connectStdio("facebook_login");
const fbNames = (await fbClient.listTools()).tools.map((tool) => tool.name).sort();

check(`registers ${ALWAYS_PRESENT.length + FACEBOOK_LOGIN_ONLY.length} tools`, () => {
  assert.deepEqual(fbNames, [...ALWAYS_PRESENT, ...FACEBOOK_LOGIN_ONLY].sort());
});

check("exposes hashtag search and business discovery", () => {
  for (const name of FACEBOOK_LOGIN_ONLY) {
    assert.ok(fbNames.includes(name), `${name} should be registered in facebook_login mode`);
  }
});

const hashtagBadInput = await fbClient.callTool({
  name: "instagram_search_hashtag",
  arguments: { hashtag: "#coffee" },
});
check("instagram_search_hashtag rejects a leading '#'", () => {
  assert.equal(hashtagBadInput.isError, true);
});

await fbClient.close();

// --- 6: HTTP transport, fresh server per request ----------------------------

console.error("http transport");
const port = 39_517;
const httpServer = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    TRANSPORT: "http",
    PORT: String(port),
    IG_ACCESS_TOKEN: FAKE_TOKEN,
    IG_AUTH_MODE: "instagram_login",
  },
  stdio: ["ignore", "ignore", "pipe"],
});

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTP server did not start within 10s")), 10_000);
    httpServer.stderr.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    httpServer.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited early with code ${code}`));
    });
  });

  // Two independent clients issuing concurrent calls. A factory that returned a
  // shared McpServer would fail one of these with -32603.
  const clients = await Promise.all(
    [0, 1].map(async () => {
      const client = new Client({ name: "smoke-http", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      return client;
    }),
  );

  const concurrent = await Promise.all(
    clients.map((client) =>
      client.callTool({ name: "instagram_list_metric_catalog", arguments: { response_format: "json" } }),
    ),
  );

  check("serves concurrent HTTP requests from independent server instances", () => {
    for (const [index, result] of concurrent.entries()) {
      assert.ok(!result.isError, `concurrent request ${index} failed: ${textOf(result)}`);
    }
  });

  await Promise.all(clients.map((client) => client.close()));
} finally {
  httpServer.kill("SIGTERM");
}

// --- result -----------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.error("\nAll smoke checks passed");
