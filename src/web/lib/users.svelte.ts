import { api, errorText } from "./api.ts";
import type { RuleKind } from "./access.ts";

export interface UserInfo {
  id: number;
  login: string;
  name: string | null;
  role: "admin" | "member";
  status: "pending" | "active" | "disabled";
  createdAt: string;
  approvedAt: string | null;
  lastLoginAt: string | null;
  // Named in DOCIFY_ADMINS: the panel cannot demote, disable or remove this account.
  named: boolean;
  self: boolean;
  // The access-list entry that let this person in; null when an administrator approved them.
  rule: { kind: RuleKind; value: string } | null;
}

// The account list, shared by the Users view and the sidebar's count of people waiting.
class UserStore {
  list = $state<UserInfo[] | null>(null);
  error = $state("");

  get pending(): number {
    return this.list?.filter((u) => u.status === "pending").length ?? 0;
  }

  refresh = async (): Promise<void> => {
    try {
      this.list = (await api<{ users: UserInfo[] }>("/api/users")).users;
      this.error = "";
    } catch (err) {
      this.error = errorText(err);
    }
  };
}

export const users = new UserStore();
