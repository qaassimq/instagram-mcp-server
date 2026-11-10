/**
 * Configuration resolved once, at module scope, from the environment.
 *
 * The server supports both of Meta's Instagram Platform configurations. The
 * mode decides the host, the scope family, and which tools get registered.
 */
import {
  DEFAULT_API_VERSION,
  FACEBOOK_LOGIN_ONLY_CAPABILITIES,
  HOST_FACEBOOK_LOGIN,
  HOST_INSTAGRAM_LOGIN,
} from "./constants.js";

export type AuthMode = "instagram_login" | "facebook_login";

export interface Config {
  /** Which Meta API configuration to talk to. */
  authMode: AuthMode;
  /** graph.instagram.com or graph.facebook.com. */
  host: string;
  /** e.g. "v26.0". */
  apiVersion: string;
  /** Long-lived user access token. */
  accessToken: string;
  /**
   * The Instagram professional account ID. Optional: on the Instagram Login
   * path `me` resolves it, and tools that need an explicit ID fall back to it.
   */
  igUserId: string | undefined;
  /** Needed only for token debug and the Facebook Login token exchange. */
  appId: string | undefined;
  appSecret: string | undefined;
  /** True when hashtag search, business discovery and product tagging exist. */
  supportsDiscovery: boolean;
}

export class ConfigError extends Error {}

function readAuthMode(raw: string | undefined): AuthMode {
  const value = (raw ?? "instagram_login").trim().toLowerCase();
  if (value === "instagram_login" || value === "facebook_login") return value;
  throw new ConfigError(
    `IG_AUTH_MODE must be "instagram_login" or "facebook_login", got "${raw}". ` +
      `Use instagram_login (graph.instagram.com, no Facebook Page required) unless you need ` +
      `hashtag search, business discovery or product tagging, which exist only on facebook_login.`,
  );
}

function readApiVersion(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_API_VERSION).trim();
  if (!/^v\d+\.\d+$/.test(value)) {
    throw new ConfigError(
      `IG_API_VERSION must look like "v26.0", got "${raw}". Omit it to use ${DEFAULT_API_VERSION}.`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const accessToken = env.IG_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new ConfigError(
      "IG_ACCESS_TOKEN is required. Generate a long-lived Instagram access token in the Meta " +
        "App Dashboard (App > Instagram > API setup) and set it in the environment.",
    );
  }

  const authMode = readAuthMode(env.IG_AUTH_MODE);

  return {
    authMode,
    host: authMode === "instagram_login" ? HOST_INSTAGRAM_LOGIN : HOST_FACEBOOK_LOGIN,
    apiVersion: readApiVersion(env.IG_API_VERSION),
    accessToken,
    igUserId: env.IG_USER_ID?.trim() || undefined,
    appId: env.IG_APP_ID?.trim() || undefined,
    appSecret: env.IG_APP_SECRET?.trim() || undefined,
    supportsDiscovery: authMode === "facebook_login",
  };
}

/** One-line summary for logs and the whoami tool. */
export function describeConfig(config: Config): string {
  const parts = [
    `mode=${config.authMode}`,
    `host=${config.host.replace("https://", "")}`,
    `version=${config.apiVersion}`,
    config.igUserId ? `ig_user_id=${config.igUserId}` : "ig_user_id=resolved from token",
  ];
  return parts.join(" ");
}

/** What this mode cannot do, phrased for the model rather than for a human. */
export function unsupportedCapabilities(config: Config): readonly string[] {
  return config.supportsDiscovery ? [] : FACEBOOK_LOGIN_ONLY_CAPABILITIES;
}
