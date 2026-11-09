import { jsonError, type Guard } from "./guard.ts";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// DOCIFY_ALLOWED_HOSTS: comma or space separated Host values, with or without a port.
export function parseAllowedHosts(value = process.env.DOCIFY_ALLOWED_HOSTS): string[] {
  return splitList(value);
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// A request is accepted when its Host matches an entry exactly, or when the entry has no
// port and the hostnames match. "*" accepts any Host; the token still guards /api.
// Loopback is always accepted so local checks keep working when a container publishes
// the port under a different host port.
export function hostAllowed(hostHeader: string | null, allowed: Iterable<string>): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const hostname = hostnameOf(host);
  if (hostname && LOOPBACK_HOSTS.has(hostname)) return true;
  for (const entry of allowed) {
    if (entry === "*" || host === entry) return true;
    if (!entry.includes(":") && hostname === entry) return true;
  }
  return false;
}

// Behind a TLS-terminating proxy the Origin scheme is https while the app speaks http,
// so compare hostnames instead of full origins.
export function originAllowed(origin: string | null, hostHeader: string): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = hostnameOf(hostHeader);
  return !!hostname && parsed.hostname.toLowerCase() === hostname;
}

// DNS rebinding and cross-site browser requests. Agents send no Origin, so only Host applies to them.
export function hostGuard(allowed: Iterable<string>, allowAnyHost: boolean): Guard {
  return (req) => {
    const hostHeader = req.headers.get("host") ?? "";
    if (!allowAnyHost && !hostAllowed(hostHeader, allowed)) return jsonError(403, "forbidden", "forbidden host");
    if (!originAllowed(req.headers.get("origin"), hostHeader)) return jsonError(403, "forbidden", "forbidden origin");
    return null;
  };
}
