/**
 * Reading the account's own media: the feed, single objects, carousel
 * children, live stories, and media the account was tagged in.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { MEDIA_FIELDS } from "../constants.js";
import {
  formatted,
  moreLine,
  paginate,
  renderMedia,
  responseFormatSchema,
  textResult,
  type MediaLike,
  type ResponseFormat,
} from "../format.js";
import type { GraphClient } from "../graph.js";

const accountIdArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Instagram professional account ID. Omit to use the token's own account.");

const limitArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe("Maximum items to return in this page. Default 25, max 100.");

const afterArg = z
  .string()
  .trim()
  .optional()
  .describe("Pagination cursor from a previous call's next_cursor. Omit for the first page.");

const fieldsArg = z
  .array(z.string())
  .optional()
  .describe(
    `Specific fields to request. Omit for a sensible default set: ${MEDIA_FIELDS.slice(0, 8).join(", ")}, …`,
  );

function resolveFields(fields: string[] | undefined): string {
  return (fields?.length ? fields : [...MEDIA_FIELDS]).join(",");
}

export function registerMediaTools(server: McpServer, graph: GraphClient): void {
  server.registerTool(
    "instagram_list_media",
    {
      title: "List Media",
      description: `List the account's published media, newest first.

Returns one page with a cursor. Covers feed posts, reels and carousels; stories are separate (instagram_list_stories) because they expire.

Use this to find media IDs for instagram_get_media_insights, instagram_list_comments, or instagram_get_media.

Example: "what did we post recently" -> limit=10`,
      inputSchema: z.strictObject({
        limit: limitArg,
        after: afterArg,
        fields: fieldsArg,
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, after, fields, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.readEdge<MediaLike>({
        path: `${ref}/media`,
        query: { fields: resolveFields(fields) },
        limit,
        after,
        signal: ctx.mcpReq.signal,
        hint: `listing media for ${ref}`,
      });

      const { result } = paginate(
        raw.data ?? [],
        raw.paging,
        response_format as ResponseFormat,
        (page) =>
          [
            `# Media (${page.count})`,
            "",
            page.items.map(renderMedia).join("\n\n"),
            ...moreLine(page, "instagram_list_media"),
          ].join("\n"),
      );

      if (!(raw.data ?? []).length) {
        return textResult("This account has no published media, or none visible to this token.");
      }
      return result;
    },
  );

  server.registerTool(
    "instagram_get_media",
    {
      title: "Get Media",
      description: `Get one media object by ID, with caption, type, engagement counts and permalink.

Use instagram_list_media to find IDs. For a carousel, instagram_get_media_children lists the individual photos and videos inside it.`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Instagram media ID"),
        fields: fieldsArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ media_id, fields, response_format }, ctx) => {
      const media = await graph.request<MediaLike & Record<string, unknown>>({
        path: media_id,
        query: { fields: resolveFields(fields) },
        signal: ctx.mcpReq.signal,
        hint: `reading media ${media_id}`,
      });
      return formatted(response_format as ResponseFormat, { media }, renderMedia(media));
    },
  );

  server.registerTool(
    "instagram_get_media_children",
    {
      title: "Get Carousel Children",
      description: `List the individual images and videos inside a carousel post.

Only meaningful for media whose media_type is CAROUSEL_ALBUM. Note that Meta serves no per-child insights — insights exist only for the carousel as a whole.`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Carousel media ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ media_id, response_format }, ctx) => {
      const raw = await graph.request<{ data?: MediaLike[] }>({
        path: `${media_id}/children`,
        query: { fields: "id,media_type,media_url,permalink,thumbnail_url,timestamp" },
        signal: ctx.mcpReq.signal,
        hint: `reading children of ${media_id}`,
      });
      const children = raw.data ?? [];
      if (!children.length) {
        return textResult(
          `Media ${media_id} has no children. Only carousel albums do — check media_type with instagram_get_media.`,
        );
      }
      const markdown = [`# Carousel children (${children.length})`, "", children.map(renderMedia).join("\n\n")].join(
        "\n",
      );
      return formatted(response_format as ResponseFormat, { count: children.length, children }, markdown);
    },
  );

  server.registerTool(
    "instagram_list_stories",
    {
      title: "List Active Stories",
      description: `List the account's currently live stories.

Stories expire 24 hours after posting, so this returns only what is live right now. Story insights come from instagram_get_media_insights with media_product_type="STORY".`,
      inputSchema: z.strictObject({
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.request<{ data?: MediaLike[] }>({
        path: `${ref}/stories`,
        query: { fields: "id,media_type,media_url,permalink,thumbnail_url,timestamp" },
        signal: ctx.mcpReq.signal,
        hint: `listing stories for ${ref}`,
      });
      const stories = raw.data ?? [];
      if (!stories.length) return textResult("No stories are live on this account right now.");
      const markdown = [`# Active stories (${stories.length})`, "", stories.map(renderMedia).join("\n\n")].join("\n");
      return formatted(response_format as ResponseFormat, { count: stories.length, stories }, markdown);
    },
  );

  server.registerTool(
    "instagram_list_tagged_media",
    {
      title: "List Tagged Media",
      description: `List media published by other accounts in which this account was tagged.

Different from mentions: this is the photo-tag edge, not @mentions in captions or comments. Use instagram_list_mentions for those.`,
      inputSchema: z.strictObject({
        limit: limitArg,
        after: afterArg,
        account_id: accountIdArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, after, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.readEdge<MediaLike>({
        path: `${ref}/tags`,
        query: { fields: "id,caption,media_type,media_url,permalink,timestamp,username" },
        limit,
        after,
        signal: ctx.mcpReq.signal,
        hint: `listing tagged media for ${ref}`,
      });
      if (!(raw.data ?? []).length) {
        return textResult("No media tags this account, or the tagging accounts are private.");
      }
      const { result } = paginate(
        raw.data ?? [],
        raw.paging,
        response_format as ResponseFormat,
        (page) =>
          [
            `# Tagged media (${page.count})`,
            "",
            page.items.map(renderMedia).join("\n\n"),
            ...moreLine(page, "instagram_list_tagged_media"),
          ].join("\n"),
      );
      return result;
    },
  );

  // Deleting media needs instagram_manage_contents, which exists only in the
  // Facebook Login scope family.
  if (graph.supportsDiscovery) {
    server.registerTool(
      "instagram_delete_media",
      {
        title: "Delete Media",
        description: `Permanently delete one of the account's own posts, reels or stories.

This cannot be undone and the media is removed from Instagram. Requires the instagram_manage_contents permission. Confirm the media ID with instagram_get_media before calling.`,
        inputSchema: z.strictObject({
          media_id: z.string().trim().min(1).describe("Media ID to delete permanently"),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ media_id }, ctx) => {
        await graph.request<{ success?: boolean }>({
          path: media_id,
          method: "DELETE",
          signal: ctx.mcpReq.signal,
          hint: `deleting media ${media_id}`,
        });
        return textResult(`Deleted media ${media_id}. This is permanent.`);
      },
    );
  }
}
