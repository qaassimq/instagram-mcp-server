/**
 * Mentions, hashtag search, and competitor lookup.
 *
 * Two honest limits are encoded here. Meta exposes no "list all mentions"
 * endpoint — mentions arrive by webhook and are then read by ID — so this
 * module offers read-by-ID plus a reply tool rather than pretending a listing
 * exists. And hashtag search, hashtag media and business discovery live only on
 * the Instagram API with Facebook Login, so they are registered only in that
 * mode.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { formatted, renderComment, renderMedia, responseFormatSchema, textResult, type CommentLike, type MediaLike, type ResponseFormat } from "../format.js";
import { GraphError, type GraphClient } from "../graph.js";

const accountIdArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Instagram professional account ID. Omit to use the token's own account.");

const HASHTAG_MEDIA_FIELDS = "id,caption,media_type,media_url,permalink,like_count,comments_count,timestamp,children{media_url,media_type}";

export function registerDiscoveryTools(server: McpServer, graph: GraphClient): void {
  server.registerTool(
    "instagram_get_mentioned_comment",
    {
      title: "Get Mentioned Comment",
      description: `Read a comment in which the account was @mentioned, by comment ID.

Meta provides no endpoint that lists mentions — they are delivered to your app through the "mentions" webhook field, and this tool reads one once you have its ID. If you have no webhook configured, you cannot discover mentions through the API at all.

Reply with instagram_reply_to_mention.`,
      inputSchema: z.strictObject({
        comment_id: z.string().trim().min(1).describe("Comment ID from a mentions webhook payload"),
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ comment_id, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.request<{ mentioned_comment?: CommentLike & Record<string, unknown> }>({
        path: ref,
        query: {
          fields: `mentioned_comment.comment_id(${comment_id}){id,text,timestamp,like_count,username,media{id,permalink,caption}}`,
        },
        signal: ctx.mcpReq.signal,
        hint: `reading mentioned comment ${comment_id}`,
      });

      const comment = raw.mentioned_comment;
      if (!comment) {
        return textResult(
          `No mention found for comment ${comment_id}. The comment may have been deleted, or it does not ` +
            `mention this account.`,
        );
      }
      return formatted(response_format as ResponseFormat, { mentioned_comment: comment }, renderComment(comment));
    },
  );

  server.registerTool(
    "instagram_get_mentioned_media",
    {
      title: "Get Mentioned Media",
      description: `Read a media object whose caption @mentions the account, by media ID.

As with mentioned comments, Meta delivers these through the "mentions" webhook rather than a list endpoint. Photo tags are a different edge — use instagram_list_tagged_media for those, which does support listing.`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Media ID from a mentions webhook payload"),
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ media_id, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.request<{ mentioned_media?: MediaLike & Record<string, unknown> }>({
        path: ref,
        query: {
          fields: `mentioned_media.media_id(${media_id}){id,caption,media_type,media_url,permalink,like_count,comments_count,timestamp,owner}`,
        },
        signal: ctx.mcpReq.signal,
        hint: `reading mentioned media ${media_id}`,
      });

      const media = raw.mentioned_media;
      if (!media) {
        return textResult(
          `No mention found for media ${media_id}. It may have been deleted, the author may be private, ` +
            `or the caption may not mention this account.`,
        );
      }
      return formatted(response_format as ResponseFormat, { mentioned_media: media }, renderMedia(media));
    },
  );

  server.registerTool(
    "instagram_reply_to_mention",
    {
      title: "Reply to Mention",
      description: `Reply to a mention of the account on someone else's media.

Pass comment_id to reply to the specific comment that mentioned you; omit it to leave a new top-level comment on the media instead. The media's owner must allow comments.`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Media ID the mention appears on"),
        message: z.string().trim().min(1).max(2200).describe("Reply text"),
        comment_id: z
          .string()
          .trim()
          .optional()
          .describe("Comment ID to thread the reply under. Omit to comment on the media itself."),
        account_id: accountIdArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ media_id, message, comment_id, account_id }, ctx) => {
      const ref = graph.accountRef(account_id);
      const response = await graph.request<{ id?: string }>({
        path: `${ref}/mentions`,
        method: "POST",
        body: { media_id, message, comment_id },
        signal: ctx.mcpReq.signal,
        hint: `replying to a mention on ${media_id}`,
      });
      return textResult(
        comment_id
          ? `Replied to comment ${comment_id} on media ${media_id}. ID: ${response.id ?? "(none returned)"}.`
          : `Commented on media ${media_id}. ID: ${response.id ?? "(none returned)"}.`,
      );
    },
  );

  if (!graph.supportsDiscovery) return;

  server.registerTool(
    "instagram_search_hashtag",
    {
      title: "Search Hashtag",
      description: `Resolve a hashtag name to its Instagram hashtag ID.

The ID is what instagram_get_hashtag_media needs. Pass the name without the leading #.

Hard limit: Meta allows an account to query 30 UNIQUE hashtags in any rolling 7-day window. Repeating a hashtag you already queried in that window is free, so resolve once and reuse the ID.`,
      inputSchema: z.strictObject({
        hashtag: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[^\s#]+$/, "Pass the hashtag name without '#' and without spaces")
          .describe("Hashtag name without the # — e.g. 'coffee'"),
        account_id: accountIdArg,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ hashtag, account_id }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.request<{ data?: { id?: string }[] }>({
        path: "ig_hashtag_search",
        query: { user_id: ref, q: hashtag },
        signal: ctx.mcpReq.signal,
        hint: `resolving hashtag #${hashtag}`,
      });
      const id = raw.data?.[0]?.id;
      if (!id) {
        return textResult(
          `Instagram returned no hashtag ID for #${hashtag}. The tag may not exist, or it may be blocked.`,
        );
      }
      return textResult(
        [
          `#${hashtag} -> hashtag ID ${id}`,
          "",
          `Next: instagram_get_hashtag_media with hashtag_id="${id}".`,
          "Remember the 30-unique-hashtags-per-7-days cap; reuse this ID rather than resolving again.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "instagram_get_hashtag_media",
    {
      title: "Get Hashtag Media",
      description: `List public media carrying a hashtag — either the top-performing posts or the most recent ones.

Resolve the hashtag ID with instagram_search_hashtag first. Meta returns only public media from professional accounts, caps the window at the last 24 hours for 'recent', and never returns personal-account posts.`,
      inputSchema: z.strictObject({
        hashtag_id: z.string().trim().min(1).describe("Hashtag ID from instagram_search_hashtag"),
        edge: z
          .enum(["top_media", "recent_media"])
          .default("top_media")
          .describe("'top_media' ranks by engagement; 'recent_media' returns the last 24 hours chronologically"),
        limit: z.number().int().min(1).max(50).default(25).describe("Maximum posts to return"),
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ hashtag_id, edge, limit, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.request<{ data?: MediaLike[] }>({
        path: `${hashtag_id}/${edge}`,
        query: { user_id: ref, fields: HASHTAG_MEDIA_FIELDS, limit },
        signal: ctx.mcpReq.signal,
        hint: `reading ${edge} for hashtag ${hashtag_id}`,
      });

      const media = raw.data ?? [];
      if (!media.length) {
        return textResult(
          `No public media returned for hashtag ${hashtag_id} via ${edge}. ` +
            `'recent_media' only covers the last 24 hours, and personal-account posts are never included.`,
        );
      }

      const markdown = [
        `# Hashtag ${hashtag_id} — ${edge} (${media.length})`,
        "",
        media.map(renderMedia).join("\n\n"),
      ].join("\n");

      return formatted(
        response_format as ResponseFormat,
        { hashtag_id, edge, count: media.length, media },
        markdown,
      );
    },
  );

  server.registerTool(
    "instagram_business_discovery",
    {
      title: "Business Discovery",
      description: `Look up another public Instagram professional account by username: follower count, media count, bio, and recent posts with engagement.

This is the competitor-research endpoint. It works only for public professional (Business or Creator) accounts — personal and private accounts return an error. It cannot read insights for accounts you do not own, only public engagement counts.

Example: "how does @competitor's engagement compare" -> username="competitor", media_limit=12`,
      inputSchema: z.strictObject({
        username: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^[^\s@]+$/, "Pass the username without '@'")
          .describe("Public professional account username, without the @"),
        media_limit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(12)
          .describe("How many recent posts to include. 0 returns profile figures only."),
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ username, media_limit, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const mediaClause =
        media_limit > 0
          ? `,media.limit(${media_limit}){id,caption,media_type,media_product_type,permalink,like_count,comments_count,timestamp}`
          : "";

      const raw = await graph.request<{
        business_discovery?: {
          username?: string;
          name?: string;
          biography?: string;
          website?: string;
          followers_count?: number;
          follows_count?: number;
          media_count?: number;
          media?: { data?: MediaLike[] };
        };
      }>({
        path: ref,
        query: {
          fields: `business_discovery.username(${username}){username,name,biography,website,followers_count,follows_count,media_count${mediaClause}}`,
        },
        signal: ctx.mcpReq.signal,
        hint: `discovering @${username}`,
      });

      const profile = raw.business_discovery;
      if (!profile) {
        throw new GraphError(
          `Could not read @${username}. Business discovery works only for public Business or Creator ` +
            `accounts — personal, private and deleted accounts are not reachable.`,
          404,
        );
      }

      const media = profile.media?.data ?? [];
      const engagement = media.reduce(
        (sum, item) => sum + (item.like_count ?? 0) + (item.comments_count ?? 0),
        0,
      );
      const avgEngagement = media.length ? Math.round(engagement / media.length) : null;
      const engagementRate =
        avgEngagement !== null && profile.followers_count
          ? Number(((avgEngagement / profile.followers_count) * 100).toFixed(2))
          : null;

      const markdown = [
        `# @${profile.username ?? username}`,
        profile.name ? `- Name: ${profile.name}` : null,
        `- Followers: ${profile.followers_count ?? "n/a"} · Following: ${profile.follows_count ?? "n/a"} · Posts: ${profile.media_count ?? "n/a"}`,
        profile.biography ? `- Bio: ${profile.biography}` : null,
        profile.website ? `- Website: ${profile.website}` : null,
        avgEngagement !== null
          ? `- Avg engagement over last ${media.length} posts: ${avgEngagement} (likes + comments)`
          : null,
        engagementRate !== null ? `- Engagement rate vs followers: ${engagementRate}%` : null,
        media.length ? "" : null,
        media.length ? `## Recent posts (${media.length})` : null,
        media.length ? media.map(renderMedia).join("\n\n") : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      return formatted(
        response_format as ResponseFormat,
        {
          profile: { ...profile, media: undefined },
          media,
          computed: { average_engagement: avgEngagement, engagement_rate_percent: engagementRate },
        },
        markdown,
      );
    },
  );
}
