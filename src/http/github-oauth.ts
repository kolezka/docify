// GitHub's OAuth web flow: send the browser to authorize, then trade the returned code for the
// person's public profile and, when asked, their organization membership and verified email
// addresses. The access token is used once here and never kept.
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

// What to read beyond the public profile. Each part needs a scope the person sees and grants.
export interface GitHubAsks {
  orgs: string[];
  emails: boolean;
}

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  // Of the organizations asked about, the ones this person is an active member of.
  orgs: string[];
  // Organizations GitHub gave no yes or no for, usually because they have not approved this OAuth app.
  unknownOrgs: string[];
  // Verified addresses only, in lower case. An unverified address proves nothing.
  emails: string[];
  emailsUnknown: boolean;
  // Scopes that were asked for and not granted; what they cover was not read.
  ungranted: string[];
}

export class OAuthError extends Error {}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// A display name is shown beside the login in the users list: no control or text-direction characters.
const cleanName = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 200);

const ORG_SCOPE = "read:org";
const EMAIL_SCOPE = "user:email";
const scopesFor = (asks?: GitHubAsks) => [asks?.orgs.length ? ORG_SCOPE : "", asks?.emails ? EMAIL_SCOPE : ""].filter(Boolean);

// No scope unless something is asked: the public profile is then all Docify reads.
export function githubAuthorizeUrl(config: GitHubOAuthConfig, state: string, asks?: GitHubAsks): string {
  const url = new URL(config.authorizeUrl ?? AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("state", state);
  const scopes = scopesFor(asks);
  if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
  if (config.redirectUri) url.searchParams.set("redirect_uri", config.redirectUri);
  return url.toString();
}

export async function githubProfile(config: GitHubOAuthConfig, code: string, asks?: GitHubAsks): Promise<GitHubProfile> {
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
  const orgs: string[] = [];
  const unknownOrgs: string[] = [];
  const emails: string[] = [];
  let emailsUnknown = false;
  let ungranted: string[] = [];
  const userUrl = config.userUrl ?? USER_URL;
  const api = (url: string, accessToken: string) =>
    request(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "user-agent": "docify" }, signal });
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
    const accessToken = token.access_token;
    user = await json(await api(userUrl, accessToken), "profile request");
    // The person can take a scope out of the link. What they did not grant counts as a plain no,
    // so withholding it never reads as "GitHub would not say".
    const granted = new Set(typeof token.scope === "string" ? token.scope.split(/[\s,]+/) : []);
    ungranted = scopesFor(asks).filter((scope) => !granted.has(scope));
    if (asks?.orgs.length && granted.has(ORG_SCOPE)) {
      for (const org of asks.orgs) {
        const res = await api(`${userUrl}/memberships/orgs/${encodeURIComponent(org)}`, accessToken);
        if (res.status === 404) continue;
        const membership = res.ok ? ((await res.json().catch(() => null)) as { state?: unknown } | null) : null;
        // "pending" is an invitation nobody accepted yet.
        if (membership?.state === "active") orgs.push(org);
        else if (!membership) unknownOrgs.push(org);
      }
    }
    if (asks?.emails && granted.has(EMAIL_SCOPE)) {
      const res = await api(`${userUrl}/emails?per_page=100`, accessToken);
      const list = res.ok ? ((await res.json().catch(() => null)) as unknown) : null;
      if (!Array.isArray(list)) emailsUnknown = true;
      else for (const entry of list) if (entry && typeof entry.email === "string" && entry.verified === true) emails.push(entry.email.toLowerCase());
    }
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    throw new OAuthError(`GitHub could not be reached: ${err instanceof Error ? err.message : err}`);
  }
  const { id, login, name } = user;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || typeof login !== "string" || !LOGIN_RE.test(login)) throw new OAuthError("GitHub returned an unexpected profile");
  return { id, login, name: (typeof name === "string" && cleanName(name)) || null, orgs, unknownOrgs, emails, emailsUnknown, ungranted };
}
