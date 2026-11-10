/**
 * Response shaping shared by every tool: the markdown/JSON switch, cursor
 * pagination envelopes, and the character-limit guard.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CHARACTER_LIMIT } from "./constants.js";
import type { Paging } from "./graph.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const responseFormatSchema = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for readable text, 'json' for structured data");

/** The SDK's own tool-result shape, re-exported so tools import it from here. */
export type ToolResult = CallToolResult;

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * Picks the response shape. In JSON mode the text is the serialized payload, so
 * `structuredContent` and the text always agree (the spec asks for both).
 */
export function formatted(
  format: ResponseFormat,
  payload: Record<string, unknown>,
  markdown: string,
): ToolResult {
  return format === ResponseFormat.JSON ? jsonResult(payload) : textResult(markdown);
}

/**
 * Builds a cursor-paginated page and keeps the rendered text under
 * CHARACTER_LIMIT by returning fewer items — never by truncating text, so the
 * cursor still points at the first item left out.
 */
export function paginate<T>(
  items: T[],
  paging: Paging | undefined,
  format: ResponseFormat,
  render: (page: PageEnvelope<T>) => string,
  extra: Record<string, unknown> = {},
): { result: ToolResult; page: PageEnvelope<T> } {
  const build = (slice: T[]): PageEnvelope<T> => {
    // The upstream cursor is only valid for the full page Meta returned. If we
    // drop items to fit the limit, say so instead of handing back a cursor that
    // would silently skip them.
    const complete = slice.length === items.length;
    const nextCursor = complete ? paging?.cursors?.after : undefined;
    return {
      ...extra,
      count: slice.length,
      items: slice,
      has_more: complete ? Boolean(paging?.next) : true,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      ...(complete ? {} : { truncated_for_size: items.length - slice.length }),
    } as PageEnvelope<T>;
  };

  let slice = items;
  let page = build(slice);
  let text = format === ResponseFormat.JSON ? JSON.stringify(page, null, 2) : render(page);

  while (slice.length > 1 && text.length > CHARACTER_LIMIT) {
    slice = slice.slice(0, Math.ceil(slice.length / 2));
    page = build(slice);
    text = format === ResponseFormat.JSON ? JSON.stringify(page, null, 2) : render(page);
  }

  const result: ToolResult =
    format === ResponseFormat.JSON
      ? { content: [{ type: "text", text }], structuredContent: page as Record<string, unknown> }
      : textResult(text);

  return { result, page };
}

export interface PageEnvelope<T> extends Record<string, unknown> {
  count: number;
  items: T[];
  has_more: boolean;
  next_cursor?: string;
  truncated_for_size?: number;
}

/** Standard footer telling the model how to get the next page. */
export function moreLine(page: PageEnvelope<unknown>, toolName: string): string[] {
  if (page.truncated_for_size) {
    return [
      "",
      `${page.truncated_for_size} more item(s) were dropped to stay within the response size limit. ` +
        `Call ${toolName} again with a smaller limit to page through them.`,
    ];
  }
  if (page.has_more && page.next_cursor) {
    return ["", `More results: call ${toolName} again with after="${page.next_cursor}".`];
  }
  if (page.has_more) return ["", "More results exist but no cursor was returned; narrow the query."];
  return [];
}

// ---------------------------------------------------------------------------
// Entity renderers
// ---------------------------------------------------------------------------

export function humanDate(iso: string | undefined): string {
  if (!iso) return "unknown date";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export interface MediaLike {
  id?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  username?: string;
  media_url?: string;
  alt_text?: string;
}

export function renderMedia(media: MediaLike): string {
  const kind = [media.media_product_type, media.media_type].filter(Boolean).join("/") || "media";
  const lines = [`## ${kind} — ${media.id ?? "no id"}`];
  if (media.timestamp) lines.push(`- Posted: ${humanDate(media.timestamp)}`);
  if (media.username) lines.push(`- Account: @${media.username}`);
  const engagement: string[] = [];
  if (media.like_count !== undefined) engagement.push(`${media.like_count} likes`);
  if (media.comments_count !== undefined) engagement.push(`${media.comments_count} comments`);
  if (engagement.length) lines.push(`- Engagement: ${engagement.join(", ")}`);
  if (media.caption) lines.push(`- Caption: ${truncateInline(media.caption, 280)}`);
  if (media.alt_text) lines.push(`- Alt text: ${truncateInline(media.alt_text, 160)}`);
  if (media.permalink) lines.push(`- Permalink: ${media.permalink}`);
  return lines.join("\n");
}

export interface CommentLike {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  hidden?: boolean;
  parent_id?: string;
}

export function renderComment(comment: CommentLike): string {
  const header = `## @${comment.username ?? "unknown"} — ${comment.id ?? "no id"}`;
  const lines = [header];
  if (comment.timestamp) lines.push(`- Posted: ${humanDate(comment.timestamp)}`);
  if (comment.like_count !== undefined) lines.push(`- Likes: ${comment.like_count}`);
  if (comment.hidden) lines.push("- Hidden: yes");
  if (comment.parent_id) lines.push(`- Reply to: ${comment.parent_id}`);
  if (comment.text) lines.push(`- Text: ${truncateInline(comment.text, 500)}`);
  return lines.join("\n");
}

/**
 * Shortens one field for display. Only ever applied to a single field inside
 * markdown output, never to a JSON payload, so structuredContent stays exact.
 */
export function truncateInline(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
