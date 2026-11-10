/**
 * Graph API client. One module-scope instance is shared by every server
 * instance; it holds no per-request state.
 *
 * Meta returns errors in a documented envelope:
 *   { "error": { message, type, code, error_subcode, error_user_msg, fbtrace_id } }
 * `GraphError` keeps the codes so callers can branch, and renders a message that
 * tells the model how to recover.
 */
import type { Config } from "./config.js";
import { REQUEST_TIMEOUT_MS } from "./constants.js";

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

/** Cursor-based paging envelope Instagram returns on edge reads. */
export interface Paging {
  cursors?: { before?: string; after?: string };
  next?: string;
  previous?: string;
}

export interface EdgeResponse<T> {
  data: T[];
  paging?: Paging;
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly type?: string,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "GraphError";
  }

  /** True when refreshing or re-issuing the token is the fix. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 190 || this.code === 102 || this.type === "OAuthException";
  }

  /** True when a missing scope or unapproved permission is the fix. */
  get isPermissionError(): boolean {
    return this.code === 10 || this.code === 200 || this.code === 3 || this.status === 403;
  }

  get isRateLimited(): boolean {
    return [4, 17, 32, 613, 80004].includes(this.code ?? -1) || this.status === 429;
  }
}

/**
 * Turns Meta's error body into something actionable. Meta's own `message` is
 * always preserved; the added sentence says what to do about it.
 */
function renderGraphError(status: number, body: GraphErrorBody | undefined, hint: string): string {
  const base = body?.error_user_msg || body?.message || `Graph API returned HTTP ${status}`;
  const code = body?.code;
  const subcode = body?.error_subcode;
  const ref = [code != null ? `code ${code}` : null, subcode != null ? `subcode ${subcode}` : null]
    .filter(Boolean)
    .join(", ");

  let advice: string;
  switch (true) {
    case code === 190 || code === 102 || status === 401:
      advice =
        "The access token is invalid or expired. Call instagram_refresh_token, or mint a new long-lived " +
        "token in the Meta App Dashboard under App > Instagram > API setup.";
      break;
    case code === 10 || code === 200 || code === 3 || status === 403:
      advice =
        "The token is missing a permission, or the permission needs Advanced Access. Check the scope the " +
        "tool requires; instagram_manage_messages (DMs) needs App Review before it works for other businesses.";
      break;
    case code === 4 || code === 17 || code === 32 || code === 613 || status === 429:
      advice =
        "Rate limited. Instagram's Business Use Case limit is 4800 x impressions per 24h, so a low-reach " +
        "account has a small budget. Wait before retrying and batch reads where possible.";
      break;
    case code === 100 && subcode === 33:
      advice =
        "The object ID does not exist, or this token cannot see it. Confirm the ID came from a list tool " +
        "on this same account.";
      break;
    case code === 9004 || code === 2207050 || code === 2207032:
      advice =
        "Instagram could not fetch or process the media. The URL must be a public HTTPS URL that returns " +
        "the file directly (JPEG for images), with no redirect and no authentication.";
      break;
    case code === 9007:
      advice =
        "The media container is not ready to publish. Poll instagram_get_container_status until status_code " +
        "is FINISHED, then publish.";
      break;
    case status === 404:
      advice = "Not found. Verify the ID and that it belongs to the authenticated account.";
      break;
    default:
      advice = "Check the parameters against Meta's Instagram Platform reference.";
  }

  const parts = [base];
  if (ref) parts.push(`(${ref})`);
  parts.push(`— ${advice}`);
  if (hint) parts.push(`Context: ${hint}.`);
  return parts.join(" ");
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  /** Path after the version, e.g. "me" or "17841400000000000/media". */
  path: string;
  /** Query string parameters; undefined values are dropped. */
  query?: Record<string, QueryValue>;
  /** Form body for POST; undefined values are dropped. */
  body?: Record<string, QueryValue>;
  method?: "GET" | "POST" | "DELETE";
  signal: AbortSignal;
  /** Short description of the call, used in error text. */
  hint?: string;
  /** Override the host — used by the Facebook-Login-only token exchange. */
  host?: string;
  /**
   * Skip the `/vNN.N` path segment. The token endpoints
   * (`refresh_access_token`, `oauth/access_token`, `debug_token`) are served
   * unversioned.
   */
  unversioned?: boolean;
}

export class GraphClient {
  constructor(private readonly config: Config) {}

  get authMode() {
    return this.config.authMode;
  }

  get apiVersion() {
    return this.config.apiVersion;
  }

  get supportsDiscovery() {
    return this.config.supportsDiscovery;
  }

  get appId() {
    return this.config.appId;
  }

  get appSecret() {
    return this.config.appSecret;
  }

  /**
   * The configured account ID, or `me` on the Instagram Login path where the
   * token itself identifies the account.
   */
  defaultAccountRef(): string {
    if (this.config.igUserId) return this.config.igUserId;
    if (this.config.authMode === "instagram_login") return "me";
    throw new GraphError(
      "IG_USER_ID is required on the facebook_login path. Call instagram_list_pages to find the " +
        "Instagram account ID linked to your Facebook Page, then set IG_USER_ID.",
      400,
    );
  }

  /** Resolves a caller-supplied ID against the configured default. */
  accountRef(explicit?: string): string {
    return explicit?.trim() || this.defaultAccountRef();
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const { path, query, body, method = "GET", signal, hint = "", host, unversioned } = options;
    const base = host ?? this.config.host;
    const prefix = unversioned ? "" : `${this.config.apiVersion}/`;
    const url = new URL(`${base}/${prefix}${path.replace(/^\/+/, "")}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const init: RequestInit = {
      method,
      headers: { Accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    };

    // The token travels in the Authorization header on GET/DELETE and in the
    // form body on POST, so it never lands in a logged query string on writes.
    if (method === "POST") {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(body ?? {})) {
        if (value !== undefined) form.set(key, String(value));
      }
      form.set("access_token", this.config.accessToken);
      init.body = form;
      init.headers = { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" };
    } else {
      init.headers = { ...init.headers, Authorization: `Bearer ${this.config.accessToken}` };
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new GraphError(
          `The Graph API did not respond within ${REQUEST_TIMEOUT_MS / 1000}s. Retry, or narrow the ` +
            `request (fewer fields, a smaller limit).`,
          504,
        );
      }
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new GraphError(
        `Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      if (!response.ok) {
        throw new GraphError(`Graph API returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      }
      throw new GraphError(`Graph API returned unparseable JSON: ${text.slice(0, 300)}`, response.status);
    }

    if (!response.ok) {
      const body = (parsed as { error?: GraphErrorBody }).error;
      throw new GraphError(
        renderGraphError(response.status, body, hint),
        response.status,
        body?.code,
        body?.error_subcode,
        body?.type,
        body?.fbtrace_id,
      );
    }

    return parsed as T;
  }

  /** Reads one page of an edge. */
  async readEdge<T>(
    options: Omit<RequestOptions, "method"> & { limit?: number; after?: string },
  ): Promise<EdgeResponse<T>> {
    const { limit, after, query, ...rest } = options;
    return this.request<EdgeResponse<T>>({
      ...rest,
      method: "GET",
      query: { ...query, limit, after },
    });
  }
}
