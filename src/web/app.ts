// Documentation text is untrusted: everything from the API is rendered with textContent.
type SourceInfo = {
  id: string;
  version: string | null;
  kind: string;
  locator: string;
  state: string;
  activeGeneration: null | { id: number; downloadedAt: string | null; graphStatus: string | null; stats: { passages?: number } };
  latest: null | { status: string; phase: string | null; progress: string | null; error: string | null };
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.code ?? res.status}: ${data.error ?? res.statusText}`);
  return data as T;
}

function el(tag: string, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshSources() {
  let list: SourceInfo[];
  try {
    list = await api<SourceInfo[]>("/api/sources");
  } catch (err) {
    $("#add-error").textContent = String(err);
    return;
  }
  const body = $("#sources tbody");
  body.replaceChildren();
  if (!list.length) {
    const row = el("tr");
    const cell = el("td", "No sources yet.", "muted");
    (cell as HTMLTableCellElement).colSpan = 10;
    row.append(cell);
    body.append(row);
  }
  for (const s of list) {
    const row = el("tr");
    row.dataset.source = s.id;
    const g = s.activeGeneration;
    const badge = el("span", s.state, `badge state-${s.state}`);
    const stateCell = el("td");
    stateCell.append(badge);
    let progress = "";
    if (s.latest?.status === "staging") progress = `${s.latest.phase ?? ""} ${s.latest.progress ?? ""}`.trim();
    else if (s.latest?.status === "failed") progress = s.latest.error ?? "failed";
    const progressCell = el("td", progress, s.latest?.status === "failed" ? "error" : "muted");
    row.append(
      el("td", s.id),
      el("td", s.version ?? "unknown"),
      el("td", s.kind),
      stateCell,
      el("td", g ? String(g.id) : "-"),
      el("td", g?.stats.passages !== undefined ? String(g.stats.passages) : "-"),
      el("td", g?.graphStatus ?? "-"),
      el("td", g?.downloadedAt ? new Date(g.downloadedAt).toLocaleString() : "-"),
      progressCell,
    );
    const actions = el("td", undefined, "actions");
    const preparing = s.state === "preparing";
    const button = (label: string, onClick: () => Promise<unknown>, secondary = true) => {
      const b = el("button", label, secondary ? "secondary" : "") as HTMLButtonElement;
      b.type = "button";
      b.onclick = async () => {
        b.disabled = true;
        try {
          await onClick();
        } catch (err) {
          $("#add-error").textContent = String(err);
        }
        await refreshSources();
      };
      return b;
    };
    if (!preparing) {
      actions.append(
        button("Prepare", () => api(`/api/sources/${encodeURIComponent(s.id)}/prepare`, { method: "POST", body: { graph: true } }), false),
        button("Prepare without graph", () => api(`/api/sources/${encodeURIComponent(s.id)}/prepare`, { method: "POST", body: { graph: false } })),
        button("Remove", () => api(`/api/sources/${encodeURIComponent(s.id)}`, { method: "DELETE", body: {} })),
      );
    } else actions.append(button("Cancel", () => api(`/api/sources/${encodeURIComponent(s.id)}/cancel`, { method: "POST", body: {} })));
    row.append(actions);
    body.append(row);
  }
  if (pollTimer) clearTimeout(pollTimer);
  if (list.some((s) => s.state === "preparing")) pollTimer = setTimeout(refreshSources, 1000);
}

$("#add-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  const data = new FormData(form);
  const locator = String(data.get("locator") ?? "").trim();
  $("#add-error").textContent = "";
  try {
    await api("/api/sources", {
      method: "POST",
      body: { library: data.get("library"), version: data.get("version"), locator, kind: /^https?:\/\//.test(locator) ? "url" : "local" },
    });
    form.reset();
  } catch (err) {
    $("#add-error").textContent = String(err);
  }
  await refreshSources();
});

type Hit = { id: string; rank: number; truncated: boolean; citation: { source: string; document: string; headingPath: string[]; lines: [number, number]; url: string | null } };

$("#search-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const data = new FormData(ev.target as HTMLFormElement);
  $("#search-meta").textContent = "searching...";
  try {
    const r = await api<{ status: string; tokens: number; maxTokens: number; hits: Hit[]; warnings: string[]; timings: { totalMs: number }; text: string }>("/api/search", {
      method: "POST",
      body: {
        query: data.get("query"),
        library: data.get("library"),
        version: data.get("version"),
        mode: data.get("mode"),
        maxTokens: Number(data.get("maxTokens")),
        graphWeight: Number(data.get("graphWeight")),
      },
    });
    $("#search-meta").textContent = `status ${r.status} | ${r.tokens} of ${r.maxTokens} tokens | ${r.hits.length} hits | ${r.timings.totalMs} ms`;
    $("#search-text").textContent = r.text;
    const list = $("#citations");
    list.replaceChildren();
    for (const h of r.hits) {
      const li = el("li");
      const a = el("a", `[${h.rank}] ${h.citation.source} ${h.citation.url ?? h.citation.document} > ${h.citation.headingPath.join(" > ")} lines ${h.citation.lines[0]}-${h.citation.lines[1]}${h.truncated ? " (truncated)" : ""}`);
      a.dataset.passage = h.id;
      a.onclick = async () => {
        try {
          $("#read-text").textContent = (await api<{ text: string }>(`/api/read/${h.id}`)).text;
        } catch (err) {
          $("#read-text").textContent = String(err);
        }
      };
      li.append(a);
      list.append(li);
    }
  } catch (err) {
    $("#search-meta").textContent = String(err);
  }
});

refreshSources();
