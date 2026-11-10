/**
 * Account identity, capability reporting, publishing quota, and token lifecycle.
 *
 * instagram_get_account doubles as the server's self-description: it reports
 * which auth mode is active and which capabilities that mode cannot reach, so
 * the model learns the shape of its own toolbox from a single read.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  HOST_FACEBOOK_LOGIN,
  PROFILE_FIELDS_FACEBOOK_LOGIN,
  PROFILE_FIELDS_INSTAGRAM_LOGIN,
  PUBLISH_QUOTA_PER_24H,
  SCOPES_FACEBOOK_LOGIN,
  SCOPES_INSTAGRAM_LOGIN,
} from "../constants.js";
import { FACEBOOK_LOGIN_ONLY_CAPABILITIES } from "../constants.js";
import { formatted, responseFormatSchema, textResult, type ResponseFormat } from "../format.js";
import { GraphError, type GraphClient } from "../graph.js";

const accountIdArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    "Instagram professional account ID. Omit to use the account the access token belongs to, " +
      "which is the normal case.",
  );

export function registerAccountTools(server: McpServer, graph: GraphClient): void {
  server.registerTool(
    "instagram_get_account",
    {
      title: "Get Account",
      description: `Get the authenticated Instagram professional account's profile, and the server's active capabilities.

Returns username, account type, follower/following/media counts, bio and website, plus which Meta auth mode this server is running in and what that mode cannot do.

Call this first in a new session: it tells you the account ID to pass to other tools and whether hashtag search and business discovery are available at all.`,
      inputSchema: z.strictObject({
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const fields =
        graph.authMode === "instagram_login"
          ? PROFILE_FIELDS_INSTAGRAM_LOGIN
          : PROFILE_FIELDS_FACEBOOK_LOGIN;

      const profile = await graph.request<Record<string, unknown>>({
        path: ref,
        query: { fields: fields.join(",") },
        signal: ctx.mcpReq.signal,
        hint: `reading profile for ${ref}`,
      });

      const unsupported = graph.supportsDiscovery ? [] : [...FACEBOOK_LOGIN_ONLY_CAPABILITIES];
      const payload = {
        profile,
        server: {
          auth_mode: graph.authMode,
          api_version: graph.apiVersion,
          host: graph.authMode === "instagram_login" ? "graph.instagram.com" : "graph.facebook.com",
          scope_family: graph.authMode === "instagram_login" ? SCOPES_INSTAGRAM_LOGIN : SCOPES_FACEBOOK_LOGIN,
          unsupported_in_this_mode: unsupported,
        },
      };

      const accountIdValue = profile.user_id ?? profile.id ?? ref;
      const lines = [
        `# @${String(profile.username ?? "unknown")}`,
        `- Account ID: ${String(accountIdValue)}`,
        profile.account_type ? `- Account type: ${String(profile.account_type)}` : null,
        profile.name ? `- Name: ${String(profile.name)}` : null,
        `- Followers: ${String(profile.followers_count ?? "n/a")} · Following: ${String(
          profile.follows_count ?? "n/a",
        )} · Media: ${String(profile.media_count ?? "n/a")}`,
        profile.biography ? `- Bio: ${String(profile.biography)}` : null,
        profile.website ? `- Website: ${String(profile.website)}` : null,
        "",
        `## Server`,
        `- Auth mode: ${graph.authMode} (Graph API ${graph.apiVersion})`,
      ].filter((line): line is string => line !== null);

      if (unsupported.length) {
        lines.push("", "## Not available in this mode", ...unsupported.map((item) => `- ${item}`));
        lines.push(
          "",
          "Switch IG_AUTH_MODE to facebook_login and supply a Page-linked token to enable these.",
        );
      }

      return formatted(response_format as ResponseFormat, payload, lines.join("\n"));
    },
  );

  server.registerTool(
    "instagram_get_publishing_limit",
    {
      title: "Get Publishing Limit",
      description: `Check how much of the 100-post / 24-hour API publishing quota the account has used.

Meta counts a carousel as one post. Call this before a bulk publish run, and after a publish failure that might be quota exhaustion rather than a bad request.`,
      inputSchema: z.strictObject({
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.request<{
        data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[];
      }>({
        path: `${ref}/content_publishing_limit`,
        query: { fields: "config,quota_usage" },
        signal: ctx.mcpReq.signal,
        hint: `reading publishing quota for ${ref}`,
      });

      const entry = raw.data?.[0];
      const used = entry?.quota_usage ?? 0;
      const total = entry?.config?.quota_total ?? PUBLISH_QUOTA_PER_24H;
      const remaining = Math.max(0, total - used);

      const payload = {
        quota_usage: used,
        quota_total: total,
        quota_remaining: remaining,
        quota_duration_seconds: entry?.config?.quota_duration ?? 86_400,
      };

      const markdown = [
        "# Publishing quota",
        `- Used: ${used} of ${total} posts in the rolling 24-hour window`,
        `- Remaining: ${remaining}`,
        remaining === 0
          ? "- Publishing will fail until the window rolls forward. A carousel counts as one post."
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      return formatted(response_format as ResponseFormat, payload, markdown);
    },
  );

  server.registerTool(
    "instagram_get_token_info",
    {
      title: "Get Token Info",
      description: `Inspect the configured access token: its type, scopes, and expiry.

On the facebook_login path this calls debug_token and needs IG_APP_ID and IG_APP_SECRET. On the instagram_login path Meta exposes no debug endpoint, so this verifies the token by reading the account and reports what it can.

Use it to diagnose a permission error before assuming a tool is broken.`,
      inputSchema: z.strictObject({ response_format: responseFormatSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }, ctx) => {
      if (graph.authMode === "facebook_login") {
        if (!graph.appId || !graph.appSecret) {
          throw new GraphError(
            "debug_token needs app credentials. Set IG_APP_ID and IG_APP_SECRET, or read the token's " +
              "scopes in the Meta App Dashboard under App > Roles > Access Tokens.",
            400,
          );
        }
        const raw = await graph.request<{ data?: Record<string, unknown> }>({
          path: "debug_token",
          query: { input_token: "SELF", access_token: `${graph.appId}|${graph.appSecret}` },
          host: HOST_FACEBOOK_LOGIN,
          unversioned: true,
          signal: ctx.mcpReq.signal,
          hint: "inspecting the access token",
        });
        const data = raw.data ?? {};
        const scopes = Array.isArray(data.scopes) ? (data.scopes as string[]) : [];
        const expires = typeof data.expires_at === "number" && data.expires_at > 0
          ? new Date(data.expires_at * 1000).toISOString()
          : "never (long-lived or system user token)";
        const markdown = [
          "# Access token",
          `- Valid: ${data.is_valid === true ? "yes" : "no"}`,
          `- Type: ${String(data.type ?? "unknown")}`,
          `- App ID: ${String(data.app_id ?? "unknown")}`,
          `- Expires: ${expires}`,
          `- Scopes (${scopes.length}): ${scopes.join(", ") || "none reported"}`,
        ].join("\n");
        return formatted(response_format as ResponseFormat, { token: data }, markdown);
      }

      // Instagram Login tokens (IGAA...) have no debug endpoint; prove liveness instead.
      const profile = await graph.request<Record<string, unknown>>({
        path: graph.accountRef(),
        query: { fields: "user_id,username,account_type" },
        signal: ctx.mcpReq.signal,
        hint: "verifying the access token",
      });
      const payload = {
        token: {
          is_valid: true,
          auth_mode: "instagram_login",
          introspection_available: false,
          account: profile,
        },
      };
      const markdown = [
        "# Access token",
        "- Valid: yes (the token successfully read its own account)",
        `- Account: @${String(profile.username ?? "unknown")} (${String(profile.user_id ?? "unknown")})`,
        "- Scopes: not introspectable on the instagram_login path. Meta serves no debug_token for",
        "  Instagram Login tokens; check granted permissions in the App Dashboard.",
        "- Expiry: Instagram long-lived tokens last 60 days. Call instagram_refresh_token to extend.",
      ].join("\n");
      return formatted(response_format as ResponseFormat, payload, markdown);
    },
  );

  server.registerTool(
    "instagram_refresh_token",
    {
      title: "Refresh Access Token",
      description: `Extend the configured long-lived access token and return the new one.

instagram_login: refreshes an Instagram long-lived token for another 60 days. The token must be at least 24 hours old and not yet expired.
facebook_login: exchanges the token for a fresh long-lived one; needs IG_APP_ID and IG_APP_SECRET.

This does NOT write the new token anywhere. Save the returned value into IG_ACCESS_TOKEN yourself, or the next restart uses the old one.`,
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (_args, ctx) => {
      if (graph.authMode === "instagram_login") {
        const raw = await graph.request<{ access_token?: string; expires_in?: number }>({
          path: "refresh_access_token",
          query: { grant_type: "ig_refresh_token" },
          unversioned: true,
          signal: ctx.mcpReq.signal,
          hint: "refreshing the Instagram long-lived token",
        });
        return textResult(
          [
            "Token refreshed.",
            `- Expires in: ${raw.expires_in ?? "unknown"} seconds (~${Math.round((raw.expires_in ?? 0) / 86400)} days)`,
            "",
            "Set this as IG_ACCESS_TOKEN — it is not persisted automatically:",
            raw.access_token ?? "(no token returned)",
          ].join("\n"),
        );
      }

      if (!graph.appId || !graph.appSecret) {
        throw new GraphError(
          "The facebook_login token exchange needs IG_APP_ID and IG_APP_SECRET. Add both to the " +
            "environment, or mint a new long-lived token in the App Dashboard instead.",
          400,
        );
      }
      const raw = await graph.request<{ access_token?: string; expires_in?: number }>({
        path: "oauth/access_token",
        query: {
          grant_type: "fb_exchange_token",
          client_id: graph.appId,
          client_secret: graph.appSecret,
          fb_exchange_token: "SELF",
        },
        host: HOST_FACEBOOK_LOGIN,
        unversioned: true,
        signal: ctx.mcpReq.signal,
        hint: "exchanging the Facebook token",
      });
      return textResult(
        [
          "Token exchanged.",
          `- Expires in: ${raw.expires_in ?? "unknown"} seconds`,
          "",
          "Set this as IG_ACCESS_TOKEN — it is not persisted automatically:",
          raw.access_token ?? "(no token returned)",
        ].join("\n"),
      );
    },
  );

  // Page discovery only exists where a Facebook Page is in the picture.
  if (graph.supportsDiscovery) {
    server.registerTool(
      "instagram_list_pages",
      {
        title: "List Pages and Linked Accounts",
        description: `List the Facebook Pages this token administers, with the Instagram professional account linked to each.

Use it to find the Instagram account ID to set as IG_USER_ID. Only available on the facebook_login path, where accounts are reached through a Page.`,
        inputSchema: z.strictObject({ response_format: responseFormatSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ response_format }, ctx) => {
        const raw = await graph.request<{
          data?: { id: string; name?: string; instagram_business_account?: { id: string; username?: string } }[];
        }>({
          path: "me/accounts",
          query: { fields: "id,name,instagram_business_account{id,username}", limit: 100 },
          signal: ctx.mcpReq.signal,
          hint: "listing Pages and linked Instagram accounts",
        });

        const pages = raw.data ?? [];
        const payload = { count: pages.length, pages };
        const markdown = pages.length
          ? [
              `# Pages (${pages.length})`,
              "",
              ...pages.map((page) => {
                const ig = page.instagram_business_account;
                return [
                  `## ${page.name ?? "unnamed"} (Page ${page.id})`,
                  ig
                    ? `- Instagram: @${ig.username ?? "unknown"} — set IG_USER_ID=${ig.id}`
                    : "- Instagram: no professional account linked to this Page",
                ].join("\n");
              }),
            ].join("\n")
          : "No Pages found. This token administers no Page, so no Instagram account is reachable on the facebook_login path.";

        return formatted(response_format as ResponseFormat, payload, markdown);
      },
    );
  }
}
