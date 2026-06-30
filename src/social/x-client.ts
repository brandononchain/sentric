import { SocialPost, SocialProfile } from "../types";
import { extractTokens } from "./token-extractor";
import { config } from "../config";

/**
 * Social Provider abstraction
 *
 * The cost of the official X API for fast polling is brutal (pay-per-use at
 * ~$0.005/read, and filtered streaming is Pro tier at $5k/mo). So Sentric
 * talks to social data through a provider interface — you can run it against:
 *
 *   - "x"          : official X API v2 (bearer token, pay-per-use)
 *   - "socialdata" : SocialData.tools (third-party, ~100x cheaper reads)
 *   - "none"       : disabled (no credentials) — degrades gracefully
 *
 * Pick the provider via SOCIAL_PROVIDER env var. Default "none".
 */

export interface SocialProvider {
  getProfile(handle: string): Promise<SocialProfile | null>;
  getRecentPosts(userId: string, sinceId?: string): Promise<SocialPost[]>;
  resolveHandle(handle: string): Promise<string | null>; // handle -> userId
}

// ============================================================
// Official X API v2 provider
// ============================================================

class XApiProvider implements SocialProvider {
  private base = "https://api.x.com/2";
  private headers: Record<string, string>;

  constructor(bearerToken: string) {
    this.headers = { Authorization: `Bearer ${bearerToken}` };
  }

  async resolveHandle(handle: string): Promise<string | null> {
    const clean = handle.replace(/^@/, "");
    try {
      const res = await fetch(`${this.base}/users/by/username/${clean}`, {
        headers: this.headers,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      return data?.data?.id || null;
    } catch {
      return null;
    }
  }

  async getProfile(handle: string): Promise<SocialProfile | null> {
    const clean = handle.replace(/^@/, "");
    try {
      const res = await fetch(
        `${this.base}/users/by/username/${clean}?user.fields=public_metrics,verified,created_at`,
        { headers: this.headers }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      const u = data?.data;
      if (!u) return null;
      return {
        handle: clean,
        userId: u.id,
        followers: u.public_metrics?.followers_count || 0,
        verified: !!u.verified,
        accountCreatedAt: u.created_at ? new Date(u.created_at).getTime() : 0,
      };
    } catch {
      return null;
    }
  }

  async getRecentPosts(userId: string, sinceId?: string): Promise<SocialPost[]> {
    try {
      let url = `${this.base}/users/${userId}/tweets?max_results=10&tweet.fields=created_at&exclude=retweets,replies`;
      if (sinceId) url += `&since_id=${sinceId}`;

      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) return [];

      const data = (await res.json()) as any;
      const tweets = data?.data || [];

      return tweets.map((t: any) => this.toPost(t, userId));
    } catch {
      return [];
    }
  }

  private toPost(t: any, authorId: string): SocialPost {
    return {
      id: t.id,
      authorHandle: "",
      authorId,
      text: t.text || "",
      createdAt: t.created_at ? new Date(t.created_at).getTime() : Date.now(),
      url: `https://x.com/i/web/status/${t.id}`,
      extractedTokens: extractTokens(t.text || ""),
    };
  }
}

// ============================================================
// SocialData.tools provider (third-party, cheaper reads)
// ============================================================

class SocialDataProvider implements SocialProvider {
  private base = "https://api.socialdata.tools";
  private headers: Record<string, string>;

  constructor(apiKey: string) {
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
  }

  async resolveHandle(handle: string): Promise<string | null> {
    const clean = handle.replace(/^@/, "");
    try {
      const res = await fetch(`${this.base}/twitter/user/${clean}`, {
        headers: this.headers,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      return data?.id_str || data?.id?.toString() || null;
    } catch {
      return null;
    }
  }

  async getProfile(handle: string): Promise<SocialProfile | null> {
    const clean = handle.replace(/^@/, "");
    try {
      const res = await fetch(`${this.base}/twitter/user/${clean}`, {
        headers: this.headers,
      });
      if (!res.ok) return null;
      const u = (await res.json()) as any;
      if (!u) return null;
      return {
        handle: clean,
        userId: u.id_str || u.id?.toString() || "",
        followers: u.followers_count || 0,
        verified: !!(u.verified || u.is_blue_verified),
        accountCreatedAt: u.created_at ? new Date(u.created_at).getTime() : 0,
      };
    } catch {
      return null;
    }
  }

  async getRecentPosts(userId: string, sinceId?: string): Promise<SocialPost[]> {
    try {
      // SocialData uses search; query the user's tweets
      const res = await fetch(
        `${this.base}/twitter/user/${userId}/tweets`,
        { headers: this.headers }
      );
      if (!res.ok) return [];

      const data = (await res.json()) as any;
      const tweets = data?.tweets || data || [];

      const posts: SocialPost[] = [];
      for (const t of tweets) {
        // Stop at sinceId if provided
        if (sinceId && t.id_str === sinceId) break;
        posts.push({
          id: t.id_str || t.id?.toString() || "",
          authorHandle: t.user?.screen_name || "",
          authorId: userId,
          text: t.full_text || t.text || "",
          createdAt: t.tweet_created_at
            ? new Date(t.tweet_created_at).getTime()
            : Date.now(),
          url: `https://x.com/i/web/status/${t.id_str || t.id}`,
          extractedTokens: extractTokens(t.full_text || t.text || ""),
        });
      }
      return posts;
    } catch {
      return [];
    }
  }
}

// ============================================================
// No-op provider (disabled)
// ============================================================

class NoopProvider implements SocialProvider {
  async resolveHandle(): Promise<string | null> {
    return null;
  }
  async getProfile(): Promise<SocialProfile | null> {
    return null;
  }
  async getRecentPosts(): Promise<SocialPost[]> {
    return [];
  }
}

/**
 * Factory — picks the provider based on env config.
 */
export function createSocialProvider(): { provider: SocialProvider; name: string } {
  const which = (config.socialProvider || "none").toLowerCase();

  if (which === "x" && config.xBearerToken) {
    return { provider: new XApiProvider(config.xBearerToken), name: "x-api" };
  }
  if (which === "socialdata" && config.socialDataApiKey) {
    return { provider: new SocialDataProvider(config.socialDataApiKey), name: "socialdata" };
  }
  return { provider: new NoopProvider(), name: "none" };
}
