import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { uiAssets } from "../src/web/bundle.ts";

// Run the production client against a local DOM and controlled API responses, without a browser or server.
test("source progress polls preserve the document tree until the active generation changes", async () => {
  const win = new Window({ url: "http://localhost/", settings: { enableJavaScriptEvaluation: true } });
  const assets = await uiAssets();
  const script = [...assets].find(([path]) => path.endsWith(".js"))![1];
  let generation = 1, polls = 0, documents = 0;
  const source = () => ({ id: "fixture", library: "fixture", kind: "local", state: "preparing", locator: "/fixture", groups: [], ignore: [], graphIgnore: [], latest: { phase: "collect", progress: `${polls}` }, activeGeneration: { id: generation, stats: {}, graphStatus: "skipped" } });
  win.fetch = (async (url: string) => {
    let data: unknown;
    if (url === "/api/session") data = { accounts: false, user: null };
    else if (url === "/api/sources") { polls++; data = [source()]; }
    else if (url === "/api/sources/fixture/documents") { documents++; data = { paths: [`folder/page-${generation}.md`] }; }
    else throw new Error(`Unexpected request: ${url}`);
    return Response.json(data);
  }) as unknown as typeof win.fetch;
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
    expect(predicate()).toBe(true);
  };
  try {
    win.sessionStorage.setItem("docify-nav", JSON.stringify({ view: "source", sourceId: "fixture" }));
    win.document.body.innerHTML = '<div id="app"></div>';
    win.eval(await script.body.text());
    await until(() => !!win.document.querySelector("details"));
    const folder = win.document.querySelector("details")!;
    folder.open = true;
    await until(() => polls >= 3);
    expect(documents).toBe(1);
    expect(win.document.querySelector("details")).toBe(folder);
    expect(folder.open).toBe(true);
    generation++;
    await until(() => win.document.body.textContent.includes("page-2.md"));
    expect(documents).toBe(2);
  } finally { await win.happyDOM.close(); }
}, 15000);
