/**
 * Static facts about Meta's Instagram Platform APIs.
 *
 * Everything in here is a documented Meta constraint, not a choice of ours.
 * Each group cites the doc it comes from so it can be re-checked when Meta ships
 * a new Graph API version.
 */

/** Latest Graph API version at time of writing (released 2026-07-29). */
export const DEFAULT_API_VERSION = "v26.0";

/** Instagram API with Instagram Login. Business Login; no Facebook Page needed. */
export const HOST_INSTAGRAM_LOGIN = "https://graph.instagram.com";

/** Instagram API with Facebook Login. Requires a linked Facebook Page. */
export const HOST_FACEBOOK_LOGIN = "https://graph.facebook.com";

/** Resumable upload host for large videos (Facebook Login only). */
export const HOST_RUPLOAD = "https://rupload.facebook.com";

/** Cap on a single tool response. Stay under it by returning fewer items. */
export const CHARACTER_LIMIT = 25_000;

/** Upstream request timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Meta's hard publishing cap: 100 API-published posts per rolling 24h per
 * account; a carousel counts as one.
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
export const PUBLISH_QUOTA_PER_24H = 100;

/** Max children in a carousel container. */
export const CAROUSEL_MAX_CHILDREN = 20;
export const CAROUSEL_MIN_CHILDREN = 2;

/** Container status codes returned by GET /{container-id}?fields=status_code */
export const CONTAINER_STATUS = {
  EXPIRED: "not published within 24 hours of creation",
  ERROR: "processing failed",
  FINISHED: "ready to publish",
  IN_PROGRESS: "still processing",
  PUBLISHED: "already published",
} as const;

// ---------------------------------------------------------------------------
// Field sets
// ---------------------------------------------------------------------------

export const PROFILE_FIELDS_INSTAGRAM_LOGIN = [
  "user_id",
  "username",
  "name",
  "account_type",
  "profile_picture_url",
  "followers_count",
  "follows_count",
  "media_count",
  "biography",
  "website",
] as const;

export const PROFILE_FIELDS_FACEBOOK_LOGIN = [
  "id",
  "username",
  "name",
  "profile_picture_url",
  "followers_count",
  "follows_count",
  "media_count",
  "biography",
  "website",
  "ig_id",
] as const;

export const MEDIA_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "media_url",
  "permalink",
  "thumbnail_url",
  "timestamp",
  "username",
  "like_count",
  "comments_count",
  "is_shared_to_feed",
  "shortcode",
  "alt_text",
] as const;

export const COMMENT_FIELDS = [
  "id",
  "text",
  "timestamp",
  "username",
  "like_count",
  "hidden",
  "parent_id",
  "replies",
  "user",
] as const;

// ---------------------------------------------------------------------------
// Insights metrics
// https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
// https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/
// ---------------------------------------------------------------------------

/** Account-level interaction metrics. period=day, metric_type=total_value. */
export const ACCOUNT_METRICS_DEFAULT = [
  "reach",
  "views",
  "total_interactions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "follows_and_unfollows",
  "profile_links_taps",
  "accounts_engaged",
] as const;

/** Demographic metrics. period=lifetime, and a breakdown is mandatory. */
export const ACCOUNT_METRICS_DEMOGRAPHIC = [
  "follower_demographics",
  "engaged_audience_demographics",
] as const;

export const DEMOGRAPHIC_BREAKDOWNS = ["age", "city", "country", "gender"] as const;

/**
 * Which breakdowns Meta accepts per account metric. Requesting an unsupported
 * pair is an API error, so tools validate against this before calling out.
 */
export const ACCOUNT_METRIC_BREAKDOWNS: Record<string, readonly string[]> = {
  comments: ["media_product_type"],
  follows_and_unfollows: ["follow_type"],
  likes: ["media_product_type"],
  profile_links_taps: ["contact_button_type"],
  reach: ["media_product_type", "follow_type"],
  saves: ["media_product_type"],
  shares: ["media_product_type"],
  total_interactions: ["media_product_type"],
  views: ["follow_type", "media_product_type"],
  follower_demographics: DEMOGRAPHIC_BREAKDOWNS,
  engaged_audience_demographics: DEMOGRAPHIC_BREAKDOWNS,
};

export const BREAKDOWN_VALUES: Record<string, readonly string[]> = {
  contact_button_type: [
    "BOOK_NOW",
    "CALL",
    "DIRECTION",
    "EMAIL",
    "INSTANT_EXPERIENCE",
    "TEXT",
    "UNDEFINED",
  ],
  follow_type: ["FOLLOWER", "NON_FOLLOWER", "UNKNOWN"],
  media_product_type: ["AD", "FEED", "REELS", "STORY"],
};

/** Media-level metrics, keyed by media_product_type. */
export const MEDIA_METRICS: Record<"FEED" | "REELS" | "STORY", readonly string[]> = {
  FEED: [
    "reach",
    "views",
    "likes",
    "comments",
    "saved",
    "shares",
    "total_interactions",
    "follows",
    "profile_visits",
    "profile_activity",
  ],
  REELS: [
    "reach",
    "views",
    "likes",
    "comments",
    "saved",
    "shares",
    "total_interactions",
    "ig_reels_avg_watch_time",
    "ig_reels_video_view_total_time",
    "reels_skip_rate",
  ],
  STORY: [
    "reach",
    "views",
    "replies",
    "shares",
    "total_interactions",
    "follows",
    "profile_visits",
    "profile_activity",
    "navigation",
    "link_clicks",
  ],
};

/** Metrics Meta serves only on the Facebook Login path. */
export const MEDIA_METRICS_FACEBOOK_LOGIN_ONLY = [
  "total_comments",
  "total_likes",
  "total_views",
] as const;

/**
 * Deprecated — never sent by default. `impressions` returns data only for media
 * created before 2024-07-02; `views` replaced it.
 */
export const DEPRECATED_METRICS = ["impressions", "plays", "video_views", "clips_replays_count"] as const;

// ---------------------------------------------------------------------------
// OAuth scopes
// ---------------------------------------------------------------------------

export const SCOPES_INSTAGRAM_LOGIN = {
  basic: "instagram_business_basic",
  publish: "instagram_business_content_publish",
  comments: "instagram_business_manage_comments",
  messages: "instagram_business_manage_messages",
} as const;

export const SCOPES_FACEBOOK_LOGIN = {
  basic: "instagram_basic",
  publish: "instagram_content_publish",
  comments: "instagram_manage_comments",
  insights: "instagram_manage_insights",
  messages: "instagram_manage_messages",
  contents: "instagram_manage_contents",
  pages: "pages_show_list,pages_read_engagement",
  business: "business_management",
} as const;

/** Capabilities that exist only on the Facebook Login path. */
export const FACEBOOK_LOGIN_ONLY_CAPABILITIES = [
  "hashtag search (ig_hashtag_search)",
  "business discovery of other public professional accounts",
  "product tagging / Instagram Shopping",
  "partnership ads",
  "resumable video upload for large files",
  "Page-linked account discovery",
] as const;
