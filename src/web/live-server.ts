import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { Docify } from "../core/docify.ts";
import { sources, type SourceInfo } from "../core/search.ts";
import type { LogEntry } from "../core/logs.ts";
import { memberView } from "./api.ts";

type Role = "member" | "admin";
type Snapshot = Map<string, { row: SourceInfo; serialized: string }>;
export interface LivePeer {
  session: string | null;
  subscription?: { sources: boolean; logsAfter: number | null; token: string };
  previous?: Snapshot;
  opened: number;
  updates: number;
  windowStart: number;
}
type Socket = ServerWebSocket<LivePeer>;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PEERS = 128;

export function liveServer(docify: Docify, authorize: (session: string | null, token: string) => Role | null) {
  const peers = new Set<Socket>();
  let poll: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  function forget(ws: Socket) {
    peers.delete(ws);
    if (!peers.size && poll) { clearInterval(poll); poll = undefined; }
  }
  function close(ws: Socket, code: number, reason: string) {
    forget(ws);
    ws.close(code, reason);
  }
  function send(ws: Socket, frame: unknown) {
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > MAX_BYTES) { close(ws, 1009, "Live update too large; reload using HTTP"); return false; }
    if (ws.send(payload) <= 0) { close(ws, 1013, "Live client fell behind; reconnect"); return false; }
    return true;
  }
  function refresh(sockets: Iterable<Socket>) {
    let raw: SourceInfo[] | undefined;
    const views = new Map<Role, Snapshot>();
    const pages = new Map<number, LogEntry[]>();
    for (const ws of sockets) {
      const peer = ws.data;
      const sub = peer.subscription;
      if (!sub) {
        if (Date.now() - peer.opened >= 5000) close(ws, 1008, "Subscription required");
        continue;
      }
      try {
        const role = authorize(peer.session, sub.token);
        if (!role || (sub.logsAfter !== null && role !== "admin")) { close(ws, 1008, "Live access denied"); continue; }
        if (sub.sources) {
          let current = views.get(role);
          if (!current) {
            raw ??= docify.db.transaction(() => sources(docify))();
            const rows = role === "member" ? memberView(raw) : raw;
            current = new Map(rows.map(row => [row.id, { row, serialized: JSON.stringify(row) }]));
            views.set(role, current);
          }
          const upserts = [...current.values()].filter(({ row, serialized }) => serialized !== peer.previous?.get(row.id)?.serialized).map(({ row }) => row);
          const removed = peer.previous ? [...peer.previous.keys()].filter(id => !current.has(id)) : [];
          if ((!peer.previous || upserts.length || removed.length) && !send(ws, { type: "sources", reset: !peer.previous, upserts, removed })) continue;
          peer.previous = current;
        }
        if (sub.logsAfter !== null) {
          let entries = pages.get(sub.logsAfter);
          if (!entries) {
            entries = docify.logs.read(sub.logsAfter, 32).lines;
            pages.set(sub.logsAfter, entries);
          }
          if (entries.length && send(ws, { type: "logs", entries })) sub.logsAfter = entries.at(-1)!.seq;
        }
      } catch (err) {
        console.error("Live update failed:", err);
        close(ws, 1011, "Live update failed; check server logs");
      }
    }
  }
  const websocket: WebSocketHandler<LivePeer> = {
    data: {} as LivePeer,
    maxPayloadLength: 4096, backpressureLimit: MAX_BYTES, closeOnBackpressureLimit: true,
    open(ws) {
      if (stopped || peers.size >= MAX_PEERS) { ws.close(1013, "Live service unavailable"); return; }
      peers.add(ws);
      poll ??= setInterval(() => refresh(peers), 500);
    },
    message(ws, message) {
      if (!peers.has(ws)) return;
      const peer = ws.data;
      if (Date.now() - peer.windowStart >= 1000) { peer.windowStart = Date.now(); peer.updates = 0; }
      if (++peer.updates > 10) { close(ws, 1008, "Too many subscription changes"); return; }
      let msg;
      try { msg = typeof message === "string" && JSON.parse(message); } catch { /* Invalid subscriptions close below. */ }
      if (!msg || msg.type !== "subscribe" || typeof msg.token !== "string" || typeof msg.sources !== "boolean" ||
        !(msg.logsAfter === null || (Number.isSafeInteger(msg.logsAfter) && msg.logsAfter >= 0))) {
        close(ws, 1008, "Invalid live subscription"); return;
      }
      peer.subscription = { sources: msg.sources, token: msg.token, logsAfter: msg.logsAfter };
      peer.previous = undefined;
      refresh([ws]);
    },
    close: forget,
  };
  return { websocket, stop() { stopped = true; for (const ws of peers) close(ws, 1001, "Server stopping"); } };
}
