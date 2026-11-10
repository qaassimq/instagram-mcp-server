/**
 * Content publishing.
 *
 * Meta's publish flow is always two steps: create a media container, then
 * publish it by ID. Video containers need processing time in between. The
 * high-level tools here run all three steps with a bounded wait, and hand back
 * the container ID if processing outlives the budget so the caller can finish
 * with instagram_get_container_status + instagram_publish_container rather than
 * losing the upload.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  CAROUSEL_MAX_CHILDREN,
  CAROUSEL_MIN_CHILDREN,
  CONTAINER_STATUS,
  MEDIA_FIELDS,
} from "../constants.js";
import { textResult, type ToolResult } from "../format.js";
import { GraphError, type GraphClient, type QueryValue } from "../graph.js";

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 240;

const accountIdArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Instagram professional account ID. Omit to use the token's own account.");

const captionArg = z
  .string()
  .max(2200)
  .optional()
  .describe(
    "Caption text, up to 2200 characters. Hashtags and @mentions work inside the caption. " +
      "Instagram counts a maximum of 30 hashtags.",
  );

const waitArg = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .default(DEFAULT_WAIT_SECONDS)
  .describe(
    `Seconds to wait for video processing before giving up and returning the container ID. ` +
      `0 publishes immediately (images only). Default ${DEFAULT_WAIT_SECONDS}.`,
  );

const userTagsArg = z
  .array(
    z.object({
      username: z.string().describe("Public username to tag, without the @"),
      x: z.number().min(0).max(1).optional().describe("Horizontal position 0-1, images only"),
      y: z.number().min(0).max(1).optional().describe("Vertical position 0-1, images only"),
    }),
  )
  .max(20)
  .optional()
  .describe(
    "People to tag. Images need x and y coordinates; videos and reels take username only. " +
      "The tagged account must be public.",
  );

interface ContainerStatus {
  id?: string;
  status_code?: keyof typeof CONTAINER_STATUS | string;
  status?: string;
}

async function createContainer(
  graph: GraphClient,
  accountRef: string,
  body: Record<string, QueryValue>,
  signal: AbortSignal,
  what: string,
): Promise<string> {
  const response = await graph.request<{ id?: string }>({
    path: `${accountRef}/media`,
    method: "POST",
    body,
    signal,
    hint: `creating the ${what} container`,
  });
  if (!response.id) {
    throw new GraphError(`Instagram accepted the ${what} container request but returned no container ID.`, 502);
  }
  return response.id;
}

async function readContainerStatus(
  graph: GraphClient,
  containerId: string,
  signal: AbortSignal,
): Promise<ContainerStatus> {
  return graph.request<ContainerStatus>({
    path: containerId,
    query: { fields: "id,status_code,status" },
    signal,
    hint: `reading status of container ${containerId}`,
  });
}

/**
 * Polls until the container is publishable or the budget runs out.
 * Returns the terminal status rather than throwing on IN_PROGRESS, so the
 * caller can decide between publishing and handing the ID back.
 */
async function waitForContainer(
  graph: GraphClient,
  containerId: string,
  waitSeconds: number,
  signal: AbortSignal,
): Promise<ContainerStatus> {
  const deadline = Date.now() + waitSeconds * 1000;
  let status = await readContainerStatus(graph, containerId, signal);

  while (status.status_code === "IN_PROGRESS" && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(remaining, 0)));
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
    status = await readContainerStatus(graph, containerId, signal);
  }
  return status;
}

async function publishContainer(
  graph: GraphClient,
  accountRef: string,
  containerId: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await graph.request<{ id?: string }>({
    path: `${accountRef}/media_publish`,
    method: "POST",
    body: { creation_id: containerId },
    signal,
    hint: `publishing container ${containerId}`,
  });
  if (!response.id) {
    throw new GraphError("Instagram accepted the publish request but returned no media ID.", 502);
  }
  return response.id;
}

/** Shared ending for every high-level publish tool. */
async function finishPublish(
  graph: GraphClient,
  accountRef: string,
  containerId: string,
  waitSeconds: number,
  label: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  const status = await waitForContainer(graph, containerId, waitSeconds, signal);

  if (status.status_code === "ERROR") {
    throw new GraphError(
      `Instagram failed to process the ${label} (container ${containerId}): ${
        status.status ?? "no detail given"
      }. Check that the media URL is a public HTTPS link serving the file directly, and that the ` +
        `format matches Instagram's specs (JPEG for images; MOV/MP4 for video).`,
      422,
    );
  }
  if (status.status_code === "EXPIRED") {
    throw new GraphError(
      `Container ${containerId} expired before it was published. Containers live 24 hours; create a new one.`,
      410,
    );
  }
  if (status.status_code === "IN_PROGRESS") {
    return textResult(
      [
        `The ${label} is still processing after ${waitSeconds}s and has NOT been published yet.`,
        "",
        `Container ID: ${containerId}`,
        "",
        "Nothing is lost — the container stays valid for 24 hours. Next step:",
        `1. instagram_get_container_status with container_id="${containerId}"`,
        `2. once status_code is FINISHED, instagram_publish_container with container_id="${containerId}"`,
      ].join("\n"),
    );
  }

  const mediaId = await publishContainer(graph, accountRef, containerId, signal);
  const media = await graph
    .request<Record<string, unknown>>({
      path: mediaId,
      query: { fields: "id,permalink,media_type,media_product_type,timestamp" },
      signal,
      hint: `reading published media ${mediaId}`,
    })
    .catch(() => ({ id: mediaId }) as Record<string, unknown>);

  return textResult(
    [
      `Published the ${label}.`,
      `- Media ID: ${mediaId}`,
      media.permalink ? `- Permalink: ${String(media.permalink)}` : null,
      media.media_product_type ? `- Type: ${String(media.media_product_type)}` : null,
      "",
      "This counts against the 100-post / 24-hour quota; instagram_get_publishing_limit shows what is left.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
}

function serializeUserTags(
  tags: { username: string; x?: number; y?: number }[] | undefined,
): string | undefined {
  if (!tags?.length) return undefined;
  return JSON.stringify(tags);
}

export function registerPublishingTools(server: McpServer, graph: GraphClient): void {
  server.registerTool(
    "instagram_publish_image",
    {
      title: "Publish Image",
      description: `Publish a single image to the Instagram feed.

The image must be a JPEG served from a public HTTPS URL that returns the file directly — no redirects, no authentication, no HTML wrapper. Meta fetches it server-side, so a local path or a signed URL that expires will fail.

For two or more images in one post use instagram_publish_carousel. For video use instagram_publish_reel.

Example: "post this photo with the caption 'new drop'" -> image_url="https://cdn.example.com/a.jpg", caption="new drop"`,
      inputSchema: z.strictObject({
        image_url: z.url().describe("Public HTTPS URL of a JPEG image"),
        caption: captionArg,
        alt_text: z
          .string()
          .max(1000)
          .optional()
          .describe("Accessibility alt text. Supported on image posts only, not reels or stories."),
        location_id: z
          .string()
          .trim()
          .optional()
          .describe("Facebook Page ID of a location to tag"),
        user_tags: userTagsArg,
        collaborators: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("Up to 3 public usernames invited as collaborators"),
        is_ai_generated: z
          .boolean()
          .optional()
          .describe("Mark the content as AI-generated. Set it when the image was AI-created."),
        account_id: accountIdArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      const ref = graph.accountRef(args.account_id);
      const containerId = await createContainer(
        graph,
        ref,
        {
          image_url: args.image_url,
          caption: args.caption,
          alt_text: args.alt_text,
          location_id: args.location_id,
          user_tags: serializeUserTags(args.user_tags),
          collaborators: args.collaborators?.length ? JSON.stringify(args.collaborators) : undefined,
          is_ai_generated: args.is_ai_generated,
        },
        ctx.mcpReq.signal,
        "image",
      );
      return finishPublish(graph, ref, containerId, 20, "image", ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "instagram_publish_reel",
    {
      title: "Publish Reel",
      description: `Publish a video as a Reel.

Reels are the only way to publish video to the feed — Instagram converted standalone feed video to Reels. The video must be at a public HTTPS URL; Meta downloads and transcodes it, which takes time, so this tool waits for processing before publishing.

If processing outlasts wait_seconds the tool returns the container ID instead of failing; finish with instagram_get_container_status then instagram_publish_container.

Specs: MOV or MP4, 3s-15min, aspect ratio 0.01:1 to 10:1, up to 1GB.`,
      inputSchema: z.strictObject({
        video_url: z.url().describe("Public HTTPS URL of an MP4 or MOV video"),
        caption: captionArg,
        cover_url: z
          .url()
          .optional()
          .describe("Public HTTPS URL of a custom cover image. Overrides thumb_offset."),
        thumb_offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Milliseconds into the video to use as the thumbnail"),
        share_to_feed: z
          .boolean()
          .optional()
          .describe("Whether the reel also appears in the main feed grid. Defaults to Instagram's setting."),
        location_id: z.string().trim().optional().describe("Facebook Page ID of a location to tag"),
        user_tags: userTagsArg,
        collaborators: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("Up to 3 public usernames invited as collaborators"),
        audio_name: z.string().optional().describe("Name for the audio track attributed to this reel"),
        is_ai_generated: z.boolean().optional().describe("Mark the content as AI-generated"),
        wait_seconds: waitArg,
        account_id: accountIdArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      const ref = graph.accountRef(args.account_id);
      const containerId = await createContainer(
        graph,
        ref,
        {
          media_type: "REELS",
          video_url: args.video_url,
          caption: args.caption,
          cover_url: args.cover_url,
          thumb_offset: args.thumb_offset,
          share_to_feed: args.share_to_feed,
          location_id: args.location_id,
          user_tags: serializeUserTags(args.user_tags),
          collaborators: args.collaborators?.length ? JSON.stringify(args.collaborators) : undefined,
          audio_name: args.audio_name,
          is_ai_generated: args.is_ai_generated,
        },
        ctx.mcpReq.signal,
        "reel",
      );
      return finishPublish(graph, ref, containerId, args.wait_seconds, "reel", ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "instagram_publish_story",
    {
      title: "Publish Story",
      description: `Publish an image or video story. Stories expire after 24 hours.

Supply exactly one of image_url or video_url. Stickers, polls, links and music cannot be added through the API — Meta exposes none of those on the publishing endpoint.`,
      inputSchema: z
        .strictObject({
          image_url: z.url().optional().describe("Public HTTPS URL of a JPEG for an image story"),
          video_url: z.url().optional().describe("Public HTTPS URL of an MP4/MOV for a video story"),
          wait_seconds: waitArg,
          account_id: accountIdArg,
        })
        .refine((value) => Boolean(value.image_url) !== Boolean(value.video_url), {
          message: "Provide exactly one of image_url or video_url",
        }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      const ref = graph.accountRef(args.account_id);
      const containerId = await createContainer(
        graph,
        ref,
        { media_type: "STORIES", image_url: args.image_url, video_url: args.video_url },
        ctx.mcpReq.signal,
        "story",
      );
      const wait = args.image_url ? Math.min(args.wait_seconds, 20) : args.wait_seconds;
      return finishPublish(graph, ref, containerId, wait, "story", ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "instagram_publish_carousel",
    {
      title: "Publish Carousel",
      description: `Publish a carousel of ${CAROUSEL_MIN_CHILDREN}-${CAROUSEL_MAX_CHILDREN} images and/or videos as one post.

This creates a child container per item, waits for any video children to process, then creates and publishes the carousel container. The whole carousel counts as a single post against the publishing quota.

Example: "post these three photos as one post" -> items=[{image_url:"..."},{image_url:"..."},{image_url:"..."}]`,
      inputSchema: z.strictObject({
        items: z
          .array(
            z
              .strictObject({
                image_url: z.url().optional().describe("Public HTTPS JPEG URL"),
                video_url: z.url().optional().describe("Public HTTPS MP4/MOV URL"),
                user_tags: userTagsArg,
              })
              .refine((value) => Boolean(value.image_url) !== Boolean(value.video_url), {
                message: "Each item needs exactly one of image_url or video_url",
              }),
          )
          .min(CAROUSEL_MIN_CHILDREN)
          .max(CAROUSEL_MAX_CHILDREN)
          .describe(`Ordered carousel items, ${CAROUSEL_MIN_CHILDREN}-${CAROUSEL_MAX_CHILDREN} of them`),
        caption: captionArg,
        location_id: z.string().trim().optional().describe("Facebook Page ID of a location to tag"),
        collaborators: z.array(z.string()).max(3).optional().describe("Up to 3 collaborator usernames"),
        is_ai_generated: z.boolean().optional().describe("Mark the carousel as AI-generated"),
        wait_seconds: waitArg,
        account_id: accountIdArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      const ref = graph.accountRef(args.account_id);
      const signal = ctx.mcpReq.signal;

      const childIds: string[] = [];
      for (const [index, item] of args.items.entries()) {
        const childId = await createContainer(
          graph,
          ref,
          {
            is_carousel_item: true,
            image_url: item.image_url,
            video_url: item.video_url,
            ...(item.video_url ? { media_type: "VIDEO" } : {}),
            user_tags: serializeUserTags(item.user_tags),
          },
          signal,
          `carousel item ${index + 1}`,
        );
        childIds.push(childId);
      }

      // Video children must finish processing before the parent accepts them.
      const videoChildren = childIds.filter((_, index) => Boolean(args.items[index]?.video_url));
      for (const childId of videoChildren) {
        const status = await waitForContainer(graph, childId, args.wait_seconds, signal);
        if (status.status_code === "ERROR") {
          throw new GraphError(
            `Carousel item ${childId} failed to process: ${status.status ?? "no detail"}. ` +
              `Check the video URL and format, then retry the whole carousel.`,
            422,
          );
        }
        if (status.status_code === "IN_PROGRESS") {
          return textResult(
            [
              `Carousel item ${childId} is still processing after ${args.wait_seconds}s, so the carousel was NOT published.`,
              "",
              `Child container IDs: ${childIds.join(", ")}`,
              "",
              "Children stay valid for 24 hours. Once every child reports FINISHED via",
              "instagram_get_container_status, assemble and publish them with instagram_create_container",
              `(media_type="CAROUSEL", children=[...]) then instagram_publish_container.`,
            ].join("\n"),
          );
        }
      }

      const carouselId = await createContainer(
        graph,
        ref,
        {
          media_type: "CAROUSEL",
          children: childIds.join(","),
          caption: args.caption,
          location_id: args.location_id,
          collaborators: args.collaborators?.length ? JSON.stringify(args.collaborators) : undefined,
          is_ai_generated: args.is_ai_generated,
        },
        signal,
        "carousel",
      );

      return finishPublish(graph, ref, carouselId, args.wait_seconds, "carousel", signal);
    },
  );

  server.registerTool(
    "instagram_create_container",
    {
      title: "Create Media Container",
      description: `Low-level escape hatch: create a media container with arbitrary parameters, without publishing it.

Prefer instagram_publish_image / _reel / _story / _carousel, which run the whole flow. Use this when you need a parameter those tools do not expose, or when assembling a carousel from children that were created earlier.

Returns the container ID. Publish it with instagram_publish_container.`,
      inputSchema: z.strictObject({
        media_type: z
          .enum(["IMAGE", "VIDEO", "REELS", "STORIES", "CAROUSEL"])
          .optional()
          .describe("Omit for a single image; Instagram infers IMAGE"),
        image_url: z.url().optional(),
        video_url: z.url().optional(),
        caption: captionArg,
        children: z
          .array(z.string())
          .max(CAROUSEL_MAX_CHILDREN)
          .optional()
          .describe("Child container IDs, for media_type=CAROUSEL"),
        is_carousel_item: z.boolean().optional().describe("True when this container is a carousel child"),
        extra_params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Any other documented container parameter, passed through verbatim " +
              "(e.g. cover_url, thumb_offset, share_to_feed, alt_text, product_tags, upload_type).",
          ),
        account_id: accountIdArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      const ref = graph.accountRef(args.account_id);
      const containerId = await createContainer(
        graph,
        ref,
        {
          media_type: args.media_type,
          image_url: args.image_url,
          video_url: args.video_url,
          caption: args.caption,
          children: args.children?.length ? args.children.join(",") : undefined,
          is_carousel_item: args.is_carousel_item,
          ...(args.extra_params ?? {}),
        },
        ctx.mcpReq.signal,
        args.media_type?.toLowerCase() ?? "image",
      );
      return textResult(
        [
          `Container created: ${containerId}`,
          "",
          "Next: poll instagram_get_container_status until status_code is FINISHED, then publish with",
          `instagram_publish_container container_id="${containerId}". Containers expire after 24 hours.`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "instagram_get_container_status",
    {
      title: "Get Container Status",
      description: `Check whether a media container is ready to publish.

status_code is one of:
${Object.entries(CONTAINER_STATUS)
  .map(([code, meaning]) => `  ${code} — ${meaning}`)
  .join("\n")}

Meta advises polling about once a minute for no more than five minutes.`,
      inputSchema: z.strictObject({
        container_id: z.string().trim().min(1).describe("Container ID returned when the container was created"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ container_id }, ctx) => {
      const status = await readContainerStatus(graph, container_id, ctx.mcpReq.signal);
      const code = status.status_code ?? "UNKNOWN";
      const meaning = (CONTAINER_STATUS as Record<string, string>)[code] ?? "unrecognized status";
      const lines = [`Container ${container_id}: ${code} — ${meaning}`];
      if (status.status) lines.push(`Detail: ${status.status}`);
      if (code === "FINISHED") {
        lines.push("", `Ready. Publish with instagram_publish_container container_id="${container_id}".`);
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "instagram_publish_container",
    {
      title: "Publish Container",
      description: `Publish a media container that is already FINISHED.

Use this to complete a publish that was interrupted, or after assembling a carousel with instagram_create_container. Publishing a container that is still IN_PROGRESS fails; check instagram_get_container_status first.`,
      inputSchema: z.strictObject({
        container_id: z.string().trim().min(1).describe("Container ID to publish"),
        account_id: accountIdArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ container_id, account_id }, ctx) => {
      const ref = graph.accountRef(account_id);
      const mediaId = await publishContainer(graph, ref, container_id, ctx.mcpReq.signal);
      const media = await graph
        .request<Record<string, unknown>>({
          path: mediaId,
          query: { fields: MEDIA_FIELDS.join(",") },
          signal: ctx.mcpReq.signal,
          hint: `reading published media ${mediaId}`,
        })
        .catch(() => ({ id: mediaId }) as Record<string, unknown>);
      return textResult(
        [
          `Published. Media ID: ${mediaId}`,
          media.permalink ? `Permalink: ${String(media.permalink)}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
    },
  );
}
