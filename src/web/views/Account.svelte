<script lang="ts">
  import { onMount } from "svelte";
  import { Check, Copy, RefreshCw, X } from "@lucide/svelte";
  import ConfirmDialog from "../components/ConfirmDialog.svelte";
  import Group from "../components/Group.svelte";
  import Row from "../components/Row.svelte";
  import Sheet from "../components/Sheet.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { account } from "../lib/account.svelte.ts";
  import { connectCommand, keyDetail, queryDetail, type KeyInfo } from "../lib/account.ts";
  import { api, errorText } from "../lib/api.ts";
  import { session } from "../lib/session.svelte.ts";
  import { button, capsule, capsuleButton, footnote, input, notice, panel, row, textArea } from "../lib/ui.ts";

  // A person's own corner: keys for their agents and what they searched for. Nobody else sees either.
  let busy = $state(false);
  let error = $state("");
  let adding = $state(false);
  let keyName = $state("");
  let creating = $state(false);
  let createError = $state("");
  // The new key lives here only while the sheet is open; the server never sends it again.
  let made = $state<{ name: string; token: string } | null>(null);
  let copied = $state<"" | "key" | "command">("");
  let revoking = $state<KeyInfo | null>(null);
  let confirmRevoke = $state(false);
  let confirmClear = $state(false);

  const address = `${location.origin}/mcp`;
  const atLimit = $derived((account.keys?.length ?? 0) >= account.maxKeys);
  const command = $derived(made ? connectCommand(location.origin, made.token) : "");

  onMount(account.refresh);
  $effect(() => {
    if (adding) return;
    made = null;
    keyName = "";
    createError = "";
    copied = "";
  });

  async function run(action: () => Promise<unknown>) {
    busy = true;
    error = "";
    try {
      await action();
    } catch (err) {
      error = errorText(err);
    }
    await account.refresh();
    busy = false;
  }

  async function create(ev: SubmitEvent) {
    ev.preventDefault();
    if (!keyName.trim() || creating) return;
    creating = true;
    createError = "";
    try {
      const r = await api<{ key: KeyInfo; token: string }>("/api/me/keys", { method: "POST", body: { name: keyName } });
      made = { name: r.key.name, token: r.token };
      await account.refresh();
    } catch (err) {
      createError = errorText(err);
    } finally {
      creating = false;
    }
  }

  async function copy(what: "key" | "command") {
    try {
      await navigator.clipboard.writeText(what === "key" ? made!.token : command);
      copied = what;
    } catch {
      // No clipboard on a plain http address; the text is selectable.
      createError = "Could not copy. Select the text and copy it by hand.";
    }
  }

  function askRevoke(key: KeyInfo) {
    revoking = key;
    confirmRevoke = true;
  }

  function revoke() {
    const key = revoking;
    if (key) run(() => api(`/api/me/keys/${key.id}`, { method: "DELETE", body: {} }));
  }

  const who = $derived(session.user ? (session.user.name ? `${session.user.login} (${session.user.name})` : session.user.login) : "");
</script>

<Toolbar>
  <span class="flex-1"></span>
  <span class={capsule()}>
    <button type="button" class={capsuleButton({ class: "px-0" })} aria-label="Refresh" title="Refresh" disabled={busy} onclick={() => run(async () => {})}><RefreshCw size={14} /></button>
  </span>
</Toolbar>

<div class="min-h-0 flex-1 overflow-y-auto">
  <div class="mx-auto max-w-[720px] px-8 pt-2 pb-10">
    <h1 class="text-[26px] leading-8 font-bold">Account</h1>
    <p class="mt-2 text-[13px] leading-[18px] text-label2">
      Signed in as {who}, {session.user?.role === "admin" ? "administrator" : "member"}. Your keys and searches are visible only to you.
    </p>

    {#if error || account.error}
      <div class={notice({ tone: "bad", class: "mt-4" })} role="alert">
        <StatusIcon tone="bad" class="mt-0.5" />
        <span class="min-w-0 flex-1 break-words">{error || account.error}</span>
        {#if error}<button type="button" class="shrink-0 rounded text-bad-text" aria-label="Dismiss" onclick={() => (error = "")}><X size={14} /></button>{/if}
      </div>
    {/if}

    {#if account.keys === null || account.queries === null}
      {#if !account.error}<p class="mt-6 text-[13px] text-label2">Loading your account…</p>{/if}
    {:else}
      <Group title="MCP keys" hint={`A key lets an agent such as Claude Code search these docs as you. Up to ${account.maxKeys} keys; revoke one you no longer use.`}>
        <Row label="Address" sub="Agents connect here with a key">
          <code class="ml-auto min-w-0 font-mono text-[12px] break-all text-label select-all">{address}</code>
        </Row>
        {#each account.keys as key (key.id)}
          <Row label={key.name} sub={keyDetail(key)} class="flex-wrap [&>div:first-child]:min-w-40">
            <button type="button" class={button({ intent: "danger", size: "xs", class: "ml-auto" })} disabled={busy} onclick={() => askRevoke(key)}>Revoke…</button>
          </Row>
        {:else}
          <p class={row({ class: "text-[13px] text-label2" })}>No keys yet.</p>
        {/each}
        {#snippet footer()}
          <div class="mt-2.5 flex justify-end">
            <button type="button" class={button({ intent: "primary" })} disabled={busy || atLimit} onclick={() => (adding = true)}>New Key…</button>
          </div>
        {/snippet}
      </Group>

      <Group title="Recent searches" hint={`Your searches on this site and through your keys: the words, not the results. The newest ${account.kept} are kept.`}>
        {#each account.queries as q (q.id)}
          <Row class="items-start">
            <div class="min-w-0 flex-1">
              <div class="line-clamp-2 text-[13px] break-words text-label" title={q.query}>{q.query}</div>
              <div class="mt-px text-[11px] leading-[14px] text-label2">{queryDetail(q)}</div>
            </div>
          </Row>
        {:else}
          <p class={row({ class: "text-[13px] text-label2" })}>No searches yet.</p>
        {/each}
        {#snippet footer()}
          {#if account.queries?.length}
            <div class="mt-2.5 flex justify-end">
              <button type="button" class={button({ intent: "danger" })} disabled={busy} onclick={() => (confirmClear = true)}>Clear History…</button>
            </div>
          {/if}
        {/snippet}
      </Group>
    {/if}
  </div>
</div>

<Sheet bind:open={adding} title="New Key" width={480}>
  {#if made}
    <h2 class="text-[17px] leading-[22px] font-semibold">Key “{made.name}”</h2>
    <p class={`${footnote} mt-1`}>Copy it now. It is not shown again; if you lose it, revoke it and make a new one.</p>
    {#if createError}
      <div class={notice({ tone: "bad", class: "mt-3" })} role="alert"><StatusIcon tone="bad" class="mt-0.5" /><span class="min-w-0 break-words">{createError}</span></div>
    {/if}
    <div class={panel({ class: "mt-4" })}>
      <div class={row({ class: "flex-col items-stretch gap-1.5" })}>
        <label for="new-key-value" class="text-[13px] text-label">Key</label>
        <div class="flex items-center gap-2">
          <input id="new-key-value" class={input({ mono: true })} readonly value={made.token} onfocus={(e) => e.currentTarget.select()} />
          <button type="button" class={button({ size: "xs" })} onclick={() => copy("key")}>
            {#if copied === "key"}<Check size={13} aria-hidden="true" />Copied{:else}<Copy size={13} aria-hidden="true" />Copy{/if}
          </button>
        </div>
      </div>
      <div class={row({ class: "flex-col items-stretch gap-1.5" })}>
        <label for="new-key-command" class="text-[13px] text-label">Add to Claude Code</label>
        <textarea id="new-key-command" class={textArea()} rows="3" readonly spellcheck="false" value={command} onfocus={(e) => e.currentTarget.select()}></textarea>
        <div class="flex justify-end">
          <button type="button" class={button({ size: "xs" })} onclick={() => copy("command")}>
            {#if copied === "command"}<Check size={13} aria-hidden="true" />Copied{:else}<Copy size={13} aria-hidden="true" />Copy Command{/if}
          </button>
        </div>
      </div>
    </div>
    <p class="mx-3.5 mt-1.5 text-[11px] leading-[14px] text-label2">Other agents: connect to {address} and send the header Authorization: Bearer followed by the key.</p>
  {:else}
    <form id="new-key-form" onsubmit={create} novalidate>
      <h2 class="text-[17px] leading-[22px] font-semibold">New Key</h2>
      <p class={`${footnote} mt-1`}>Name it after the computer or agent that will use it.</p>
      <div class={panel({ class: "mt-4" })}>
        <div class={row()}>
          <label for="new-key-name" class="shrink-0 text-[13px] text-label">Name</label>
          <input
            id="new-key-name"
            class={input({ invalid: !!createError })}
            maxlength="60"
            autocomplete="off"
            spellcheck="false"
            placeholder="Work laptop"
            aria-invalid={!!createError}
            aria-describedby="new-key-hint"
            bind:value={keyName}
            oninput={() => (createError = "")}
            disabled={creating}
          />
        </div>
      </div>
      <p id="new-key-hint" class="mx-3.5 mt-1.5 min-h-[14px] text-[11px] leading-[14px] {createError ? 'font-medium text-bad-text' : 'text-label2'}" role={createError ? "alert" : undefined}>{createError}</p>
    </form>
  {/if}

  {#snippet footer()}
    <span></span>
    <span class="flex gap-2.5">
      {#if made}
        <button type="button" class={button({ intent: "primary", size: "md" })} onclick={() => (adding = false)}>Done</button>
      {:else}
        <button type="button" class={button({ size: "md" })} onclick={() => (adding = false)}>Cancel</button>
        <button type="submit" form="new-key-form" class={button({ intent: "primary", size: "md" })} disabled={!keyName.trim() || creating}>{creating ? "Creating…" : "Create Key"}</button>
      {/if}
    </span>
  {/snippet}
</Sheet>

<ConfirmDialog
  bind:open={confirmRevoke}
  title={`Revoke “${revoking?.name ?? "key"}”?`}
  message="Agents that use this key stop working at once. This cannot be undone; make a new key to connect them again."
  confirmLabel="Revoke"
  onconfirm={revoke}
/>
<ConfirmDialog
  bind:open={confirmClear}
  title="Clear your search history?"
  message="The list of your recent searches is deleted. This cannot be undone."
  confirmLabel="Clear"
  onconfirm={() => run(() => api("/api/me/queries", { method: "DELETE", body: {} }))}
/>
