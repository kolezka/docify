// Behind one reverse proxy (Traefik in Coolify) the last X-Forwarded-For entry is the one the
// proxy appended; earlier entries come from the client and can be forged.
export function clientIp(req: Request, peer: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const last = forwarded.at(-1);
    if (last) return last;
  }
  return peer ?? "unknown";
}
