/**
 * Insights.
 *
 * Metric names churn between Graph API versions and an unsupported
 * metric/breakdown pair is a hard API error, so this module validates the
 * request against the documented catalog before calling out, and ships
 * instagram_list_metric_catalog so the model can look the names up rather than
 * guess them.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  ACCOUNT_METRIC_BREAKDOWNS,
  ACCOUNT_METRICS_DEFAULT,
  ACCOUNT_METRICS_DEMOGRAPHIC,
  BREAKDOWN_VALUES,
  DEMOGRAPHIC_BREAKDOWNS,
  DEPRECATED_METRICS,
  MEDIA_METRICS,
  MEDIA_METRICS_FACEBOOK_LOGIN_ONLY,
} from "../constants.js";
import { formatted, responseFormatSchema, textResult, type ResponseFormat } from "../format.js";
import { GraphError, type GraphClient } from "../graph.js";

interface InsightValue {
  value?: number | Record<string, number>;
  end_time?: string;
}

interface InsightEntry {
  name?: string;
  title?: string;
  description?: string;
  period?: string;
  values?: InsightValue[];
  total_value?: { value?: number; breakdowns?: { dimension_keys?: string[]; results?: { dimension_values?: string[]; value?: number }[] }[] };
}

const accountIdArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Instagram professional account ID. Omit to use the token's own account.");

/** Renders Meta's two different insight payload shapes into one readable block. */
function renderInsight(entry: InsightEntry): string {
  const lines = [`## ${entry.name ?? "unnamed metric"}`];
  if (entry.title && entry.title !== entry.name) lines.push(`- ${entry.title}`);

  if (entry.total_value) {
    if (entry.total_value.value !== undefined) lines.push(`- Total: ${entry.total_value.value}`);
    for (const breakdown of entry.total_value.breakdowns ?? []) {
      const keys = (breakdown.dimension_keys ?? []).join(" / ");
      lines.push(`- Breakdown by ${keys || "dimension"}:`);
      for (const row of breakdown.results ?? []) {
        lines.push(`  - ${(row.dimension_values ?? []).join(" / ")}: ${row.value ?? 0}`);
      }
    }
  }

  for (const value of entry.values ?? []) {
    if (typeof value.value === "number") {
      lines.push(`- ${value.end_time ? value.end_time.slice(0, 10) : "value"}: ${value.value}`);
    } else if (value.value && typeof value.value === "object") {
      lines.push(`- ${value.end_time ? value.end_time.slice(0, 10) : "breakdown"}:`);
      for (const [key, count] of Object.entries(value.value)) lines.push(`  - ${key}: ${count}`);
    }
  }
  return lines.join("\n");
}

function rejectDeprecated(metrics: string[]): void {
  const bad = metrics.filter((metric) => (DEPRECATED_METRICS as readonly string[]).includes(metric));
  if (bad.length) {
    throw new GraphError(
      `Meta deprecated these metrics: ${bad.join(", ")}. Use "views" instead of impressions, plays or ` +
        `video_views. instagram_list_metric_catalog lists what is currently supported.`,
      400,
    );
  }
}

export function registerInsightsTools(server: McpServer, graph: GraphClient): void {
  server.registerTool(
    "instagram_list_metric_catalog",
    {
      title: "List Metric Catalog",
      description: `List every insight metric this server can request, which surface it applies to, and which breakdowns each one accepts. Makes no API call.

Read this before calling instagram_get_account_insights or instagram_get_media_insights with custom metrics — an unsupported metric or an invalid metric/breakdown pair is a hard API error, not an empty result.`,
      inputSchema: z.strictObject({ response_format: responseFormatSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ response_format }) => {
      const payload = {
        account_metrics: ACCOUNT_METRICS_DEFAULT,
        account_demographic_metrics: ACCOUNT_METRICS_DEMOGRAPHIC,
        media_metrics_by_type: MEDIA_METRICS,
        media_metrics_facebook_login_only: MEDIA_METRICS_FACEBOOK_LOGIN_ONLY,
        metric_breakdowns: ACCOUNT_METRIC_BREAKDOWNS,
        breakdown_values: BREAKDOWN_VALUES,
        deprecated: DEPRECATED_METRICS,
        auth_mode: graph.authMode,
      };

      const markdown = [
        "# Insight metric catalog",
        "",
        "## Account metrics (period=day)",
        ACCOUNT_METRICS_DEFAULT.map((metric) => {
          const breakdowns = ACCOUNT_METRIC_BREAKDOWNS[metric];
          return `- ${metric}${breakdowns ? ` — breakdowns: ${breakdowns.join(", ")}` : ""}`;
        }).join("\n"),
        "",
        "## Account demographics (period=lifetime, breakdown required)",
        ACCOUNT_METRICS_DEMOGRAPHIC.map((metric) => `- ${metric}`).join("\n"),
        `Breakdowns: ${DEMOGRAPHIC_BREAKDOWNS.join(", ")}`,
        "",
        "## Media metrics by media_product_type",
        Object.entries(MEDIA_METRICS)
          .map(([type, metrics]) => `### ${type}\n${metrics.map((metric) => `- ${metric}`).join("\n")}`)
          .join("\n\n"),
        "",
        graph.supportsDiscovery
          ? `## Also available on this (facebook_login) path\n${MEDIA_METRICS_FACEBOOK_LOGIN_ONLY.map((m) => `- ${m}`).join("\n")}`
          : `## Facebook-Login-only metrics (NOT available in this mode)\n${MEDIA_METRICS_FACEBOOK_LOGIN_ONLY.map((m) => `- ${m}`).join("\n")}`,
        "",
        "## Deprecated — do not request",
        DEPRECATED_METRICS.map((metric) => `- ${metric}`).join("\n"),
        "",
        'Note: `impressions` was replaced by `views`. Carousel albums have no per-item insights.',
      ].join("\n");

      return formatted(response_format as ResponseFormat, payload, markdown);
    },
  );

  server.registerTool(
    "instagram_get_account_insights",
    {
      title: "Get Account Insights",
      description: `Get account-level insights: reach, views, interactions, likes, comments, shares, saves, follows and profile link taps.

Defaults to the full interaction metric set for the last 7 days as totals. Narrow with metrics, or split a metric with breakdown (one metric at a time when using a breakdown).

For audience age/city/country/gender use instagram_get_audience_demographics instead.

Examples:
  - "how did we do last week" -> defaults
  - "reach split by followers vs non-followers" -> metrics=["reach"], breakdown="follow_type"`,
      inputSchema: z.strictObject({
        metrics: z
          .array(z.string())
          .min(1)
          .max(12)
          .optional()
          .describe(
            `Metric names. Omit for the default set: ${ACCOUNT_METRICS_DEFAULT.join(", ")}. ` +
              "See instagram_list_metric_catalog.",
          ),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start date, YYYY-MM-DD. Defaults to 7 days ago. Meta allows at most 30 days per call."),
        until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("End date, YYYY-MM-DD. Defaults to today."),
        metric_type: z
          .enum(["total_value", "time_series"])
          .default("total_value")
          .describe(
            "'total_value' returns one total per metric and supports breakdowns; " +
              "'time_series' returns a daily series and ignores breakdowns.",
          ),
        breakdown: z
          .string()
          .optional()
          .describe(
            "Split the result along a dimension. Only valid with metric_type=total_value and only for " +
              "metrics that support it — check instagram_list_metric_catalog.",
          ),
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ metrics, since, until, metric_type, breakdown, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const requested = metrics ?? [...ACCOUNT_METRICS_DEFAULT];
      rejectDeprecated(requested);

      if (breakdown) {
        if (metric_type !== "total_value") {
          throw new GraphError(
            "A breakdown only works with metric_type='total_value'. Drop the breakdown or switch metric_type.",
            400,
          );
        }
        const unsupported = requested.filter(
          (metric) => !(ACCOUNT_METRIC_BREAKDOWNS[metric] ?? []).includes(breakdown),
        );
        if (unsupported.length) {
          const suggestions = requested
            .map((metric) => `${metric}: ${(ACCOUNT_METRIC_BREAKDOWNS[metric] ?? ["none"]).join(", ")}`)
            .join("; ");
          throw new GraphError(
            `Breakdown '${breakdown}' is not supported for ${unsupported.join(", ")}. ` +
              `Supported breakdowns per requested metric — ${suggestions}. ` +
              `Request one metric at a time when using a breakdown.`,
            400,
          );
        }
      }

      const sinceDate = since ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const untilDate = until ?? new Date().toISOString().slice(0, 10);

      const raw = await graph.request<{ data?: InsightEntry[] }>({
        path: `${ref}/insights`,
        query: {
          metric: requested.join(","),
          period: "day",
          metric_type,
          since: sinceDate,
          until: untilDate,
          breakdown,
        },
        signal: ctx.mcpReq.signal,
        hint: `reading account insights for ${ref} (${sinceDate} to ${untilDate})`,
      });

      const entries = raw.data ?? [];
      if (!entries.length) {
        return textResult(
          `No insight data returned for ${sinceDate}..${untilDate}. Accounts with very low reach often ` +
            `return empty metrics, and insights need a professional account with recent activity.`,
        );
      }

      const markdown = [
        `# Account insights ${sinceDate} to ${untilDate}`,
        `Mode: ${metric_type}${breakdown ? `, broken down by ${breakdown}` : ""}`,
        "",
        entries.map(renderInsight).join("\n\n"),
      ].join("\n");

      return formatted(
        response_format as ResponseFormat,
        { since: sinceDate, until: untilDate, metric_type, breakdown, metrics: entries },
        markdown,
      );
    },
  );

  server.registerTool(
    "instagram_get_media_insights",
    {
      title: "Get Media Insights",
      description: `Get per-post insights for one media object.

The valid metric set depends on the media type, so pass media_product_type and the right defaults are used: FEED for posts and carousels, REELS for reels, STORY for stories. Carousel albums report only whole-post figures — Meta serves no per-child insights.

Example: "how did the latest reel do" -> media_id from instagram_list_media, media_product_type="REELS"`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Media ID to read insights for"),
        media_product_type: z
          .enum(["FEED", "REELS", "STORY"])
          .default("FEED")
          .describe("Which metric set to request. Check the media's media_product_type with instagram_get_media."),
        metrics: z
          .array(z.string())
          .min(1)
          .max(15)
          .optional()
          .describe("Override the default metric set for this media type. See instagram_list_metric_catalog."),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ media_id, media_product_type, metrics, response_format }, ctx) => {
      const requested = metrics ?? [...MEDIA_METRICS[media_product_type]];
      rejectDeprecated(requested);

      const fbOnly = requested.filter((metric) =>
        (MEDIA_METRICS_FACEBOOK_LOGIN_ONLY as readonly string[]).includes(metric),
      );
      if (fbOnly.length && !graph.supportsDiscovery) {
        throw new GraphError(
          `${fbOnly.join(", ")} are served only on the Instagram API with Facebook Login. ` +
            `This server is running in instagram_login mode — drop those metrics or switch IG_AUTH_MODE.`,
          400,
        );
      }

      const raw = await graph.request<{ data?: InsightEntry[] }>({
        path: `${media_id}/insights`,
        query: { metric: requested.join(",") },
        signal: ctx.mcpReq.signal,
        hint: `reading insights for media ${media_id}`,
      });

      const entries = raw.data ?? [];
      if (!entries.length) {
        return textResult(
          `No insights for media ${media_id}. Insights are unavailable for media older than roughly two ` +
            `years, for media inside a carousel album, and for posts published before the account became professional.`,
        );
      }

      const flat: Record<string, number | Record<string, number>> = {};
      for (const entry of entries) {
        if (!entry.name) continue;
        const total = entry.total_value?.value;
        const first = entry.values?.[0]?.value;
        if (total !== undefined) flat[entry.name] = total;
        else if (first !== undefined) flat[entry.name] = first;
      }

      const markdown = [
        `# Insights for ${media_id} (${media_product_type})`,
        "",
        Object.entries(flat)
          .map(([name, value]) => `- ${name}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
          .join("\n"),
      ].join("\n");

      return formatted(
        response_format as ResponseFormat,
        { media_id, media_product_type, values: flat, raw: entries },
        markdown,
      );
    },
  );

  server.registerTool(
    "instagram_get_audience_demographics",
    {
      title: "Get Audience Demographics",
      description: `Get the follower or engaged-audience breakdown by age, city, country or gender.

These are lifetime metrics and a breakdown is mandatory. Meta withholds demographics for accounts under roughly 100 followers, which comes back as an empty result rather than an error.

Example: "where are our followers" -> metric="follower_demographics", breakdown="country"`,
      inputSchema: z.strictObject({
        metric: z
          .enum(ACCOUNT_METRICS_DEMOGRAPHIC)
          .default("follower_demographics")
          .describe(
            "'follower_demographics' profiles everyone who follows the account; " +
              "'engaged_audience_demographics' profiles only accounts that engaged.",
          ),
        breakdown: z
          .enum(DEMOGRAPHIC_BREAKDOWNS)
          .describe("Dimension to break the audience down by"),
        timeframe: z
          .enum(["this_week", "this_month", "last_14_days", "last_30_days", "last_90_days", "prev_month"])
          .default("this_month")
          .describe(
            "Window Meta computes the demographic over. Only this_week and this_month are supported for " +
              "engaged_audience_demographics since v20.0.",
          ),
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ metric, breakdown, timeframe, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.request<{ data?: InsightEntry[] }>({
        path: `${ref}/insights`,
        query: {
          metric,
          period: "lifetime",
          metric_type: "total_value",
          timeframe,
          breakdown,
        },
        signal: ctx.mcpReq.signal,
        hint: `reading ${metric} by ${breakdown} for ${ref}`,
      });

      const entries = raw.data ?? [];
      const rows = entries[0]?.total_value?.breakdowns?.[0]?.results ?? [];
      if (!rows.length) {
        return textResult(
          `No ${metric} data by ${breakdown}. Meta withholds audience demographics for accounts with ` +
            `fewer than about 100 followers, and for timeframes with too little activity.`,
        );
      }

      const sorted = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      const markdown = [
        `# ${metric} by ${breakdown} (${timeframe})`,
        "",
        ...sorted.map((row) => `- ${(row.dimension_values ?? []).join(" / ")}: ${row.value ?? 0}`),
      ].join("\n");

      return formatted(
        response_format as ResponseFormat,
        { metric, breakdown, timeframe, rows: sorted },
        markdown,
      );
    },
  );

  server.registerTool(
    "instagram_get_story_insights",
    {
      title: "Get Insights for All Live Stories",
      description: `Read insights for every story currently live on the account, in one call.

Stories vanish after 24 hours and their insights go with them, so this is the tool for catching a day's story performance before it is lost. Equivalent to instagram_list_stories followed by instagram_get_media_insights on each result.`,
      inputSchema: z.strictObject({
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const signal = ctx.mcpReq.signal;

      const stories = await graph.request<{ data?: { id: string; timestamp?: string; media_type?: string }[] }>({
        path: `${ref}/stories`,
        query: { fields: "id,timestamp,media_type,permalink" },
        signal,
        hint: `listing stories for ${ref}`,
      });

      const list = stories.data ?? [];
      if (!list.length) return textResult("No stories are live right now, so there are no story insights to read.");

      const metrics = MEDIA_METRICS.STORY.join(",");
      const results: { id: string; timestamp?: string; values: Record<string, number>; error?: string }[] = [];

      for (const story of list) {
        try {
          const raw = await graph.request<{ data?: InsightEntry[] }>({
            path: `${story.id}/insights`,
            query: { metric: metrics },
            signal,
            hint: `reading insights for story ${story.id}`,
          });
          const values: Record<string, number> = {};
          for (const entry of raw.data ?? []) {
            if (!entry.name) continue;
            const value = entry.total_value?.value ?? entry.values?.[0]?.value;
            if (typeof value === "number") values[entry.name] = value;
          }
          results.push({ id: story.id, timestamp: story.timestamp, values });
        } catch (error) {
          results.push({
            id: story.id,
            timestamp: story.timestamp,
            values: {},
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const markdown = [
        `# Story insights (${results.length} live stories)`,
        "",
        ...results.map((story) => {
          const header = `## ${story.id}${story.timestamp ? ` — posted ${story.timestamp.slice(0, 16).replace("T", " ")} UTC` : ""}`;
          if (story.error) return `${header}\n- Could not read insights: ${story.error}`;
          const rows = Object.entries(story.values).map(([name, value]) => `- ${name}: ${value}`);
          return [header, ...(rows.length ? rows : ["- No metrics returned"])].join("\n");
        }),
      ].join("\n");

      return formatted(response_format as ResponseFormat, { count: results.length, stories: results }, markdown);
    },
  );
}
