// GitHub's OAuth web flow: send the browser to authorize, then trade the returned code for the
// person's public profile. The access token is used once here and never kept.
export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  // Sent only when set; GitHub otherwise uses the callback URL registered for the OAuth app.
  redirectUri?: string;
  fetch?: typeof fetch;
  authorizeUrl?: string;
  tokenUrl?: string;
  userUrl?: string;
  timeoutMs?: number;
}

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
}

export class OAuthError extends Error {}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// A display name is shown beside the login in the users list: no control or text-direction characters.
const cleanName = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 200);

// No scope: the public profile is all Docify reads.
export function githubAuthorizeUrl(config: GitHubOAuthConfig, state: string): string {
  const url = new URL(config.authorizeUrl ?? AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("state", state);
  if (config.redirectUri) url.searchParams.set("redirect_uri", config.redirectUri);
  return url.toString();
}

export async function githubProfile(config: GitHubOAuthConfig, code: string): Promise<GitHubProfile> {
  const request = config.fetch ?? fetch;
  const signal = AbortSignal.timeout(config.timeoutMs ?? 10_000);
  const json = async (res: Response, what: string) => {
    if (!res.ok) throw new OAuthError(`GitHub ${what} failed with HTTP ${res.status}`);
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new OAuthError(`GitHub ${what} returned no JSON`);
    }
  };
  let token: Record<string, unknown>;
  let user: Record<string, unknown>;
  try {
    token = await json(
      await request(config.tokenUrl ?? TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "docify" },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, ...(config.redirectUri ? { redirect_uri: config.redirectUri } : {}) }),
        signal,
      }),
      "token exchange",
    );
    // GitHub reports a bad or reused code as 200 with an error field.
    if (typeof token.access_token !== "string" || !token.access_token) throw new OAuthError(`GitHub refused the code${typeof token.error === "string" ? `: ${token.error}` : ""}`);
    user = await json(
      await request(config.userUrl ?? USER_URL, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "docify" },
        signal,
      }),
      "profile request",
    );
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    throw new OAuthError(`GitHub could not be reached: ${err instanceof Error ? err.message : err}`);
  }
  const { id, login, name } = user;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || typeof login !== "string" || !LOGIN_RE.test(login)) throw new OAuthError("GitHub returned an unexpected profile");
  return { id, login, name: (typeof name === "string" && cleanName(name)) || null };
}
