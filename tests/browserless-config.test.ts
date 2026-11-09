import { expect, test } from "bun:test";
import { describeConfig, loadConfig, saveConfig, validateConfigPatch } from "../src/core/config.ts";
import { tempDir } from "./helpers.ts";

test("Browserless settings default and validate without persisting secrets", () => {
  const home = tempDir();
  const defaults = loadConfig(home);
  expect(defaults).toMatchObject({ crawlProvider: "builtin", browserlessUrl: "http://127.0.0.1:3000", browserlessApiKeyEnv: "BROWSERLESS_API_KEY", browserlessTimeoutSeconds: 120 });
  for (const url of ["http://user:password@localhost:3000", "http://localhost:3000/?token=secret", "http://localhost:3000/#secret", "file:///tmp/test"]) {
    expect(() => saveConfig(home, { browserlessUrl: url })).toThrow();
  }
  for (const value of [0, 3601, "120"]) expect(() => validateConfigPatch({ browserlessTimeoutSeconds: value })).toThrow();
  expect(() => validateConfigPatch({ browserlessApiKeyEnv: "secret-value" })).toThrow();
  expect(saveConfig(home, { browserlessUrl: "https://browser.example/", browserlessApiKeyEnv: "MY_BROWSER_KEY", browserlessTimeoutSeconds: 60 })).toMatchObject({ browserlessUrl: "https://browser.example", browserlessApiKeyEnv: "MY_BROWSER_KEY", browserlessTimeoutSeconds: 60 });
  const description = describeConfig(loadConfig(home), { MY_BROWSER_KEY: "secret-value", CRAWL4AI_API_KEY: "other-secret" });
  expect(description.environment.find((e) => e.name === "MY_BROWSER_KEY")).toMatchObject({ set: true, value: null });
  expect(description.environment.find((e) => e.name === "CRAWL4AI_API_KEY")).toMatchObject({ set: true, value: null });
  expect(JSON.stringify(description)).not.toContain("secret-value");
  expect(JSON.stringify(description)).not.toContain("other-secret");
});
