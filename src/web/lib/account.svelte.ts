import type { KeyInfo, QueryInfo } from "./account.ts";
import { api, errorText } from "./api.ts";

// The signed-in person's own MCP keys and recent searches.
class Account {
  keys = $state<KeyInfo[] | null>(null);
  maxKeys = $state(10);
  queries = $state<QueryInfo[] | null>(null);
  kept = $state(200);
  error = $state("");

  refresh = async (): Promise<void> => {
    try {
      const [k, q] = await Promise.all([api<{ keys: KeyInfo[]; max: number }>("/api/me/keys"), api<{ queries: QueryInfo[]; kept: number }>("/api/me/queries")]);
      this.keys = k.keys;
      this.maxKeys = k.max;
      this.queries = q.queries;
      this.kept = q.kept;
      this.error = "";
    } catch (err) {
      this.error = errorText(err);
    }
  };
}

export const account = new Account();
