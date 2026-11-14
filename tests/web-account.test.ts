import { expect, test } from "bun:test";
import { connectCommand, keyDetail, queryDetail, type QueryInfo } from "../src/web/lib/account.ts";

const now = Date.parse("2026-11-14T12:00:00Z");

test("the connect command names this server's /mcp address and carries the key", () => {
  expect(connectCommand("https://docs.example.com", "dcf_abc")).toBe('claude mcp add --transport http docify https://docs.example.com/mcp --header "Authorization: Bearer dcf_abc"');
});

test("a key row shows how the key starts and when it was made and used, never more of it", () => {
  const key = { id: 1, name: "laptop", prefix: "dcf_Ab12", createdAt: "2026-11-14T10:00:00Z", lastUsedAt: null };
  expect(keyDetail(key, now)).toBe("dcf_Ab12… · Created 2 h ago · Not used yet");
  expect(keyDetail({ ...key, lastUsedAt: "2026-11-14T11:58:00Z" }, now)).toBe("dcf_Ab12… · Created 2 h ago · Last used 2 min ago");
});

test("a search row says where it looked, how it ended and where it came from", () => {
  const q: QueryInfo = { id: 1, at: "2026-11-14T11:59:50Z", via: "web", keyName: null, query: "serve", scope: "bun@1.4.3", status: "ok", hits: 3 };
  expect(queryDetail(q, now)).toBe("bun@1.4.3 · Good match, 3 passages · This site · just now");
  expect(queryDetail({ ...q, via: "mcp", keyName: "laptop", scope: null, status: "weak_match", hits: 1 }, now)).toBe("All sources · Weak match, 1 passage · Key laptop · just now");
  expect(queryDetail({ ...q, via: "mcp", status: "no_match", hits: 0 }, now)).toBe("bun@1.4.3 · No match · MCP · just now");
});
