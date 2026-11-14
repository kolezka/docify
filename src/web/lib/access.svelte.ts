import { api, errorText } from "./api.ts";
import type { AccessInfo } from "./access.ts";

// The access list of this server. Administrators only; the Users view shows it.
class AccessStore {
  info = $state<AccessInfo | null>(null);
  error = $state("");

  refresh = async (): Promise<void> => {
    try {
      this.info = await api<AccessInfo>("/api/access");
      this.error = "";
    } catch (err) {
      this.error = errorText(err);
    }
  };
}

export const access = new AccessStore();
