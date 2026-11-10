/**
 * Instagram Direct messaging.
 *
 * Every tool here needs the messaging scope, and that scope needs Advanced
 * Access — App Review — before it works for any business but your own. The
 * 24-hour reply window is Meta policy, not a client limit: outside it, only a
 * message tagged HUMAN_AGENT (7 days) is allowed.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  formatted,
  humanDate,
  moreLine,
  paginate,
  responseFormatSchema,
  textResult,
  truncateInline,
  type ResponseFormat,
} from "../format.js";
import type { GraphClient } from "../graph.js";

interface Conversation {
  id?: string;
  updated_time?: string;
  unread_count?: number;
  message_count?: number;
  participants?: { data?: { id?: string; username?: string; name?: string }[] };
  snippet?: string;
}

interface Message {
  id?: string;
  created_time?: string;
  message?: string;
  from?: { id?: string; username?: string };
  to?: { data?: { id?: string; username?: string }[] };
}

const recipientArg = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Instagram-scoped user ID (IGSID) of the recipient. Get it from instagram_list_conversations " +
      "participants or from a messaging webhook — a public @username will not work.",
  );

export function registerMessagingTools(server: McpServer, graph: GraphClient): void {
  server.registerTool(
    "instagram_list_conversations",
    {
      title: "List Conversations",
      description: `List Instagram Direct conversations in the account's inbox, most recently updated first.

Each entry carries the participant IGSIDs needed to send a message. Requires the messaging permission with Advanced Access.

Example: "any new DMs?" -> limit=10, then instagram_get_conversation on the ones with unread_count > 0`,
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum conversations per page"),
        after: z.string().trim().optional().describe("Pagination cursor from a previous call"),
        account_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Instagram professional account ID. Omit to use the token's own account."),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, after, account_id, response_format }, ctx) => {
      const ref = graph.accountRef(account_id);
      const raw = await graph.readEdge<Conversation>({
        path: `${ref}/conversations`,
        query: {
          platform: "instagram",
          fields: "id,updated_time,unread_count,message_count,snippet,participants",
        },
        limit,
        after,
        signal: ctx.mcpReq.signal,
        hint: `listing conversations for ${ref}`,
      });

      if (!(raw.data ?? []).length) {
        return textResult(
          "No Instagram Direct conversations found. If the inbox is not empty, the token is probably " +
            "missing the messaging permission — it needs Advanced Access via App Review.",
        );
      }

      const { result } = paginate(
        raw.data ?? [],
        raw.paging,
        response_format as ResponseFormat,
        (page) =>
          [
            `# Conversations (${page.count})`,
            "",
            page.items
              .map((conversation) => {
                const others = (conversation.participants?.data ?? [])
                  .map((person) => `@${person.username ?? person.id ?? "unknown"} (${person.id ?? "no id"})`)
                  .join(", ");
                return [
                  `## ${conversation.id ?? "no id"}`,
                  `- Participants: ${others || "unknown"}`,
                  `- Updated: ${humanDate(conversation.updated_time)}`,
                  conversation.unread_count !== undefined ? `- Unread: ${conversation.unread_count}` : null,
                  conversation.message_count !== undefined ? `- Messages: ${conversation.message_count}` : null,
                  conversation.snippet ? `- Latest: ${truncateInline(conversation.snippet, 200)}` : null,
                ]
                  .filter((line): line is string => line !== null)
                  .join("\n");
              })
              .join("\n\n"),
            ...moreLine(page, "instagram_list_conversations"),
          ].join("\n"),
      );
      return result;
    },
  );

  server.registerTool(
    "instagram_get_conversation",
    {
      title: "Get Conversation",
      description: `Read the messages in one conversation, newest first.

Note the 24-hour rule before replying: a standard reply is only allowed within 24 hours of the user's most recent message. Check the newest created_time to see whether the window is still open.`,
      inputSchema: z.strictObject({
        conversation_id: z.string().trim().min(1).describe("Conversation ID from instagram_list_conversations"),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum messages to return"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ conversation_id, limit, response_format }, ctx) => {
      const raw = await graph.request<{ id?: string; messages?: { data?: Message[] } }>({
        path: conversation_id,
        query: { fields: `id,messages.limit(${limit}){id,created_time,from,to,message}` },
        signal: ctx.mcpReq.signal,
        hint: `reading conversation ${conversation_id}`,
      });

      const messages = raw.messages?.data ?? [];
      if (!messages.length) return textResult(`Conversation ${conversation_id} has no readable messages.`);

      const newest = messages[0]?.created_time;
      const windowOpen = newest ? Date.now() - new Date(newest).getTime() < 24 * 60 * 60 * 1000 : false;

      const markdown = [
        `# Conversation ${conversation_id} (${messages.length} messages)`,
        windowOpen
          ? "- Reply window: OPEN (last message is under 24 hours old)"
          : "- Reply window: CLOSED (last message is over 24 hours old — a standard reply will be rejected)",
        "",
        ...messages.map((message) =>
          [
            `## ${humanDate(message.created_time)} — @${message.from?.username ?? message.from?.id ?? "unknown"}`,
            `- From ID: ${message.from?.id ?? "unknown"}`,
            message.message ? `- Text: ${truncateInline(message.message, 800)}` : "- (no text; attachment only)",
          ].join("\n"),
        ),
      ].join("\n");

      return formatted(
        response_format as ResponseFormat,
        { conversation_id, count: messages.length, reply_window_open: windowOpen, messages },
        markdown,
      );
    },
  );

  server.registerTool(
    "instagram_send_message",
    {
      title: "Send Direct Message",
      description: `Send a text message to an Instagram user.

Meta allows this only within 24 hours of that user's last message to the account. Outside the window, set tag="HUMAN_AGENT" to use the 7-day human-agent allowance; unsolicited messages are not possible at all.

Requires the messaging permission with Advanced Access. Get the recipient IGSID from instagram_list_conversations — a public username will not work.`,
      inputSchema: z.strictObject({
        recipient_id: recipientArg,
        text: z.string().trim().min(1).max(1000).describe("Message text, up to 1000 characters"),
        tag: z
          .enum(["HUMAN_AGENT"])
          .optional()
          .describe("Set HUMAN_AGENT to reply up to 7 days out, when a human is handling the thread"),
        account_id: z.string().trim().min(1).optional().describe("Sending account ID; omit for the token's own"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient_id, text, tag, account_id }, ctx) => {
      const ref = graph.accountRef(account_id);
      const response = await graph.request<{ message_id?: string; recipient_id?: string }>({
        path: `${ref}/messages`,
        method: "POST",
        body: {
          recipient: JSON.stringify({ id: recipient_id }),
          message: JSON.stringify({ text }),
          ...(tag ? { messaging_type: "MESSAGE_TAG", tag } : {}),
        },
        signal: ctx.mcpReq.signal,
        hint: `sending a DM to ${recipient_id}`,
      });
      return textResult(
        `Sent. Message ID: ${response.message_id ?? "(none returned)"} to ${response.recipient_id ?? recipient_id}.`,
      );
    },
  );

  server.registerTool(
    "instagram_send_media_message",
    {
      title: "Send Media Message",
      description: `Send an image, video, or audio attachment as a direct message.

The URL must be public HTTPS; Meta fetches it server-side. The same 24-hour window applies as for text messages.`,
      inputSchema: z.strictObject({
        recipient_id: recipientArg,
        media_url: z.url().describe("Public HTTPS URL of the file to send"),
        media_type: z
          .enum(["image", "video", "audio"])
          .default("image")
          .describe("Attachment type Meta should treat the URL as"),
        account_id: z.string().trim().min(1).optional().describe("Sending account ID; omit for the token's own"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient_id, media_url, media_type, account_id }, ctx) => {
      const ref = graph.accountRef(account_id);
      const response = await graph.request<{ message_id?: string }>({
        path: `${ref}/messages`,
        method: "POST",
        body: {
          recipient: JSON.stringify({ id: recipient_id }),
          message: JSON.stringify({ attachment: { type: media_type, payload: { url: media_url } } }),
        },
        signal: ctx.mcpReq.signal,
        hint: `sending a ${media_type} DM to ${recipient_id}`,
      });
      return textResult(`Sent ${media_type}. Message ID: ${response.message_id ?? "(none returned)"}.`);
    },
  );

  server.registerTool(
    "instagram_mark_seen",
    {
      title: "Mark Conversation Seen",
      description: `Mark the conversation with a user as read, which clears its unread badge.

Use it after processing an inbox so the same messages are not reprocessed as new.`,
      inputSchema: z.strictObject({
        recipient_id: recipientArg,
        account_id: z.string().trim().min(1).optional().describe("Account ID; omit for the token's own"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ recipient_id, account_id }, ctx) => {
      const ref = graph.accountRef(account_id);
      await graph.request<Record<string, unknown>>({
        path: `${ref}/messages`,
        method: "POST",
        body: { recipient: JSON.stringify({ id: recipient_id }), sender_action: "mark_seen" },
        signal: ctx.mcpReq.signal,
        hint: `marking the thread with ${recipient_id} as seen`,
      });
      return textResult(`Marked the conversation with ${recipient_id} as seen.`);
    },
  );
}
