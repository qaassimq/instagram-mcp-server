/**
 * Comment reading and moderation.
 *
 * Every write here needs the comment-management scope
 * (instagram_business_manage_comments on the Instagram Login path,
 * instagram_manage_comments on the Facebook Login path).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { COMMENT_FIELDS } from "../constants.js";
import {
  formatted,
  moreLine,
  paginate,
  renderComment,
  responseFormatSchema,
  textResult,
  type CommentLike,
  type ResponseFormat,
} from "../format.js";
import type { GraphClient } from "../graph.js";

const limitArg = z.number().int().min(1).max(100).default(25).describe("Maximum comments per page. Max 100.");
const afterArg = z
  .string()
  .trim()
  .optional()
  .describe("Pagination cursor from a previous call's next_cursor.");

const messageArg = z
  .string()
  .trim()
  .min(1)
  .max(2200)
  .describe("Comment text. Instagram rejects repeated identical text as spam.");

export function registerCommentTools(server: McpServer, graph: GraphClient): void {
  server.registerTool(
    "instagram_list_comments",
    {
      title: "List Comments",
      description: `List top-level comments on one of the account's media objects.

Replies are nested one level deeper — use instagram_list_comment_replies for a specific thread. Hidden comments are included with hidden=true.

Example: "what are people saying on our latest post" -> first instagram_list_media, then this with that media_id`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Media ID whose comments to read"),
        limit: limitArg,
        after: afterArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ media_id, limit, after, response_format }, ctx) => {
      const raw = await graph.readEdge<CommentLike>({
        path: `${media_id}/comments`,
        query: { fields: COMMENT_FIELDS.filter((field) => field !== "replies" && field !== "user").join(",") },
        limit,
        after,
        signal: ctx.mcpReq.signal,
        hint: `listing comments on ${media_id}`,
      });

      if (!(raw.data ?? []).length) {
        return textResult(`No comments on media ${media_id}.`);
      }

      const { result } = paginate(
        raw.data ?? [],
        raw.paging,
        response_format as ResponseFormat,
        (page) =>
          [
            `# Comments on ${media_id} (${page.count})`,
            "",
            page.items.map(renderComment).join("\n\n"),
            ...moreLine(page, "instagram_list_comments"),
          ].join("\n"),
        { media_id },
      );
      return result;
    },
  );

  server.registerTool(
    "instagram_get_comment",
    {
      title: "Get Comment",
      description: "Get one comment by ID, including its text, author, like count and hidden state.",
      inputSchema: z.strictObject({
        comment_id: z.string().trim().min(1).describe("Comment ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ comment_id, response_format }, ctx) => {
      const comment = await graph.request<CommentLike & Record<string, unknown>>({
        path: comment_id,
        query: { fields: "id,text,timestamp,username,like_count,hidden,parent_id" },
        signal: ctx.mcpReq.signal,
        hint: `reading comment ${comment_id}`,
      });
      return formatted(response_format as ResponseFormat, { comment }, renderComment(comment));
    },
  );

  server.registerTool(
    "instagram_list_comment_replies",
    {
      title: "List Comment Replies",
      description: `List the replies to one top-level comment.

Instagram supports exactly one level of nesting, so replies have no replies of their own.`,
      inputSchema: z.strictObject({
        comment_id: z.string().trim().min(1).describe("Top-level comment ID"),
        limit: limitArg,
        after: afterArg,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ comment_id, limit, after, response_format }, ctx) => {
      const raw = await graph.readEdge<CommentLike>({
        path: `${comment_id}/replies`,
        query: { fields: "id,text,timestamp,username,like_count,hidden,parent_id" },
        limit,
        after,
        signal: ctx.mcpReq.signal,
        hint: `listing replies to ${comment_id}`,
      });
      if (!(raw.data ?? []).length) return textResult(`Comment ${comment_id} has no replies.`);
      const { result } = paginate(
        raw.data ?? [],
        raw.paging,
        response_format as ResponseFormat,
        (page) =>
          [
            `# Replies to ${comment_id} (${page.count})`,
            "",
            page.items.map(renderComment).join("\n\n"),
            ...moreLine(page, "instagram_list_comment_replies"),
          ].join("\n"),
        { comment_id },
      );
      return result;
    },
  );

  server.registerTool(
    "instagram_create_comment",
    {
      title: "Comment on Media",
      description: `Post a new top-level comment on one of the account's own media objects.

To answer someone else's comment use instagram_reply_to_comment instead — a reply threads under theirs and notifies them.`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Media ID to comment on"),
        message: messageArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ media_id, message }, ctx) => {
      const response = await graph.request<{ id?: string }>({
        path: `${media_id}/comments`,
        method: "POST",
        body: { message },
        signal: ctx.mcpReq.signal,
        hint: `commenting on ${media_id}`,
      });
      return textResult(`Posted comment ${response.id ?? "(no id returned)"} on media ${media_id}.`);
    },
  );

  server.registerTool(
    "instagram_reply_to_comment",
    {
      title: "Reply to Comment",
      description: `Reply to a comment, threaded underneath it.

Only top-level comments accept replies — Instagram allows a single level of nesting. Replying to a reply fails; reply to its parent_id instead.`,
      inputSchema: z.strictObject({
        comment_id: z.string().trim().min(1).describe("Top-level comment ID to reply to"),
        message: messageArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ comment_id, message }, ctx) => {
      const response = await graph.request<{ id?: string }>({
        path: `${comment_id}/replies`,
        method: "POST",
        body: { message },
        signal: ctx.mcpReq.signal,
        hint: `replying to comment ${comment_id}`,
      });
      return textResult(`Replied to comment ${comment_id}. New comment ID: ${response.id ?? "(none returned)"}.`);
    },
  );

  server.registerTool(
    "instagram_hide_comment",
    {
      title: "Hide or Unhide Comment",
      description: `Hide a comment from public view, or unhide one.

Hiding is reversible and leaves the comment visible to its author — prefer it to deletion for borderline content. Use instagram_delete_comment only for comments on the account's own media that should be gone for good.`,
      inputSchema: z.strictObject({
        comment_id: z.string().trim().min(1).describe("Comment ID"),
        hide: z.boolean().default(true).describe("true hides the comment, false unhides it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ comment_id, hide }, ctx) => {
      await graph.request<{ success?: boolean }>({
        path: comment_id,
        method: "POST",
        body: { hide },
        signal: ctx.mcpReq.signal,
        hint: `${hide ? "hiding" : "unhiding"} comment ${comment_id}`,
      });
      return textResult(`${hide ? "Hid" : "Unhid"} comment ${comment_id}.`);
    },
  );

  server.registerTool(
    "instagram_delete_comment",
    {
      title: "Delete Comment",
      description: `Permanently delete a comment.

Works on comments the account authored, and on comments by others on the account's own media. This cannot be undone — instagram_hide_comment is the reversible alternative.`,
      inputSchema: z.strictObject({
        comment_id: z.string().trim().min(1).describe("Comment ID to delete permanently"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ comment_id }, ctx) => {
      await graph.request<{ success?: boolean }>({
        path: comment_id,
        method: "DELETE",
        signal: ctx.mcpReq.signal,
        hint: `deleting comment ${comment_id}`,
      });
      return textResult(`Deleted comment ${comment_id}. This is permanent.`);
    },
  );

  server.registerTool(
    "instagram_toggle_media_comments",
    {
      title: "Enable or Disable Comments",
      description: `Turn commenting on or off for one of the account's media objects.

Disabling hides the whole comment thread and blocks new comments. Existing comments return when it is re-enabled.`,
      inputSchema: z.strictObject({
        media_id: z.string().trim().min(1).describe("Media ID"),
        enabled: z.boolean().describe("true allows comments, false disables them"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ media_id, enabled }, ctx) => {
      await graph.request<{ success?: boolean }>({
        path: media_id,
        method: "POST",
        body: { comment_enabled: enabled },
        signal: ctx.mcpReq.signal,
        hint: `${enabled ? "enabling" : "disabling"} comments on ${media_id}`,
      });
      return textResult(`Comments are now ${enabled ? "enabled" : "disabled"} on media ${media_id}.`);
    },
  );
}
