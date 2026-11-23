import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { accountsFromEnv, startServer } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

const credentials = { DOCIFY_GITHUB_CLIENT_ID: "id", DOCIFY_GITHUB_CLIENT_SECRET: "secret", DOCIFY_ADMINS: "admin" };

test("requiring accounts never falls back to a server without sign-in", () => {
  expect(() => accountsFromEnv({ DOCIFY_ACCOUNTS_ENABLED: "true" })).toThrow("DOCIFY_GITHUB_CLIENT_ID");
  expect(accountsFromEnv({ ...credentials, DOCIFY_ACCOUNTS_ENABLED: "true" })).toEqual(accountsFromEnv(credentials));
});

test("an invalid account setting stops startup", () => {
  expect(() => accountsFromEnv({ DOCIFY_ACCOUNTS_ENABLED: "flase" })).toThrow("DOCIFY_ACCOUNTS_ENABLED");
});

test("disabling accounts with credentials present uses the shared web token instead", async () => {
  const accounts = accountsFromEnv({ ...credentials, DOCIFY_ACCOUNTS_ENABLED: "false" });
  expect(accounts).toBeNull();
  const home = tempDir();
  const d = newDocify(home);
  const token = "test-shared-web-token";
  try {
    const server = await startServer(0, { docify: d, quiet: true, token, accounts, mcpClients: [] });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/status`)).status).toBe(401);
      const headers = { "X-Docify-Token": token };
      expect((await (await fetch(`${base}/api/status`, { headers })).json()).home).toBe(home);
      expect((await fetch(`${base}/auth/github`, { redirect: "manual" })).status).toBe(404);
      expect(existsSync(join(home, "accounts.sqlite"))).toBe(false);
    } finally {
      server.stop(true);
    }
  } finally {
    d.close();
  }
});
