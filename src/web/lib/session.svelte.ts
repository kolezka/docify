import { api, errorText } from "./api.ts";

export interface SessionUser {
  id: number;
  login: string;
  name: string | null;
  role: "admin" | "member";
  status: "pending" | "active" | "disabled";
}

// Who is using the page. On a server without accounts there is no user and nothing is restricted.
class Session {
  loaded = $state(false);
  accounts = $state(false);
  user = $state<SessionUser | null>(null);
  // What sign-in asks GitHub for beyond the public profile; the access list decides.
  asks = $state<{ orgs: boolean; emails: boolean } | null>(null);
  error = $state("");

  // May use the app at all: no accounts, or an approved account.
  get ready(): boolean {
    return this.loaded && !this.error && (!this.accounts || this.user?.status === "active");
  }

  // May manage sources, settings, logs and users. The server enforces this; the page only hides controls.
  get admin(): boolean {
    return this.ready && (!this.accounts || this.user?.role === "admin");
  }

  refresh = async (): Promise<void> => {
    try {
      const s = await api<{ accounts: boolean; user: SessionUser | null; asks?: { orgs: boolean; emails: boolean } }>("/api/session");
      this.accounts = s.accounts;
      this.user = s.user;
      this.asks = s.asks ?? null;
      this.error = "";
    } catch (err) {
      this.error = errorText(err);
    }
    this.loaded = true;
  };

  // A full reload drops everything the page still holds from this person's session.
  signOut = async (): Promise<void> => {
    await api("/api/session", { method: "DELETE", body: {} });
    location.assign("/");
  };
}

export const session = new Session();

// A session that ended on the server (expired, disabled, removed) shows up as a 401 on any call.
addEventListener("docify-unauthorized", () => {
  if (session.accounts && session.user) void session.refresh();
});
