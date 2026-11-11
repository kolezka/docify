<script lang="ts">
  import { FileText, Folder } from "@lucide/svelte";
  import Group from "./Group.svelte";
  import { api, errorText } from "../lib/api.ts";

  let { sourceId, generation }: { sourceId: string; generation: number } = $props();
  type Node = { name: string; path: string; children: Node[]; file: boolean };
  let paths = $state<string[] | null>(null);
  let error = $state("");

  function tree(items: string[]): Node[] {
    const root: Node[] = [];
    for (const path of items) {
      const parts = path.split("/").filter(Boolean);
      let nodes = root;
      let prefix = "";
      parts.forEach((name, i) => {
        prefix += (prefix ? "/" : "") + name;
        const file = i === parts.length - 1;
        let node = nodes.find((entry) => entry.name === name && entry.file === file);
        if (!node) {
          node = { name, path: prefix, children: [], file };
          nodes.push(node);
        }
        nodes = node.children;
      });
    }
    const sort = (nodes: Node[]) => {
      nodes.sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
      nodes.forEach((node) => sort(node.children));
    };
    sort(root);
    return root;
  }
  const nodes = $derived(tree(paths ?? []));

  $effect(() => {
    const id = sourceId;
    void generation;
    const controller = new AbortController();
    paths = null;
    error = "";
    api<{ paths: string[] }>(`/api/sources/${encodeURIComponent(id)}/documents`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) paths = result.paths; })
      .catch((err) => { if (!controller.signal.aborted) error = errorText(err); });
    return () => controller.abort();
  });
</script>

{#snippet branch(items: Node[])}
  <ul class="list-none">
    {#each items as node (node.path + (node.file ? ':file' : ':folder'))}
      <li>
        {#if node.file}
          <div class="flex min-w-0 items-start gap-2 py-1 pl-5 text-[13px] text-label2" title={node.path}>
            <FileText size={15} class="mt-0.5 shrink-0 text-label3" aria-hidden="true" />
            <span class="min-w-0 break-all font-mono text-[12px]">{node.name}</span>
          </div>
        {:else}
          <details class="group/tree">
            <summary class="flex cursor-pointer list-none items-start gap-2 py-1 text-[13px] font-medium text-label marker:content-none">
              <span class="inline-block w-3 shrink-0 text-label3 transition-transform group-open/tree:rotate-90" aria-hidden="true">›</span>
              <Folder size={15} class="mt-0.5 shrink-0 text-label3" aria-hidden="true" />
              <span class="min-w-0 break-all">{node.name}</span>
            </summary>
            <div class="ml-5">{@render branch(node.children)}</div>
          </details>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<Group title="Source tree" hint="Documents in the active generation">
  <div class="px-3.5 py-2">
    {#if error}
      <p class="text-[13px] text-bad-text" role="alert">Could not load documents: {error}</p>
    {:else if paths === null}
      <p class="text-[13px] text-label2" role="status">Loading documents…</p>
    {:else if paths.length === 0}
      <p class="text-[13px] text-label2">No indexed documents.</p>
    {:else}
      {@render branch(nodes)}
    {/if}
  </div>
</Group>
