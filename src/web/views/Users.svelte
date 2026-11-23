<script lang="ts">
  import { onMount } from "svelte";
  import { RefreshCw, X } from "@lucide/svelte";
  import ConfirmDialog from "../components/ConfirmDialog.svelte";
  import Group from "../components/Group.svelte";
  import Row from "../components/Row.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { access } from "../lib/access.svelte.ts";
  import { KINDS, admittedBy, removeMessage, ruleDetail, type Outsiders, type RuleInfo, type RuleKind } from "../lib/access.ts";
  import { ApiError, api, errorText } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";
  import { users, type UserInfo } from "../lib/users.svelte.ts";
  import { button, capsule, capsuleButton, input, notice, popup, row, type ChipTone } from "../lib/ui.ts";

  // The administration panel: who gets in, approving sign-ups, roles, disabling and removing accounts.
  let busy = $state(false);
  let error = $state("");
  let removing = $state<UserInfo | null>(null);
  let confirmRemove = $state(false);
  let kind = $state<RuleKind>("org");
  let value = $state("");
  let addError = $state("");
  let dropping = $state<RuleInfo | null>(null);
  let confirmDrop = $state(false);

  const waiting = $derived(users.list?.filter((u) => u.status === "pending") ?? []);
  const people = $derived(users.list?.filter((u) => u.status !== "pending") ?? []);

  const entry = $derived(KINDS.find((k) => k.kind === kind) ?? KINDS[0]!);
  const refresh = () => Promise.all([users.refresh(), access.refresh()]);

  onMount(refresh);

  async function run(action: () => Promise<unknown>) {
    busy = true;
    error = "";
    addError = "";
    try {
      await action();
    } catch (err) {
      error = errorText(err);
    }
    await refresh();
    busy = false;
  }

  // A refused entry is reported at its field, not in the banner.
  async function addRule(ev: SubmitEvent) {
    ev.preventDefault();
    if (!value.trim() || busy) return;
    busy = true;
    addError = "";
    try {
      await api("/api/access/rules", { method: "POST", body: { kind, value } });
      value = "";
    } catch (err) {
      // At the field the sentence is enough; the code is for the banner.
      const message = err instanceof ApiError && err.field ? err.message : errorText(err);
      addError = message.charAt(0).toUpperCase() + message.slice(1);
    }
    await refresh();
    busy = false;
  }

  function askDrop(rule: RuleInfo) {
    dropping = rule;
    confirmDrop = true;
  }

  function drop() {
    const rule = dropping;
    if (rule) run(() => api(`/api/access/rules/${rule.id}`, { method: "DELETE", body: {} }));
  }

  const setOutsiders = (outsiders: Outsiders) => run(() => api("/api/access", { method: "PUT", body: { outsiders } }));

  const patch = (u: UserInfo, body: { role?: "admin" | "member"; status?: "active" | "disabled" }) =>
    run(() => api(`/api/users/${u.id}`, { method: "PATCH", body }));

  function askRemove(u: UserInfo) {
    removing = u;
    confirmRemove = true;
  }

  function remove() {
    const u = removing;
    if (u) run(() => api(`/api/users/${u.id}`, { method: "DELETE", body: {} }));
  }

  const title = (u: UserInfo) => (u.name ? `${u.login} (${u.name})` : u.login);
  function chipFor(u: UserInfo): { tone: ChipTone; label: string } {
    if (u.status === "disabled") return { tone: "neutral", label: "Disabled" };
    return u.role === "admin" ? { tone: "ok", label: "Administrator" } : { tone: "ok", label: "Member" };
  }
  const rowClass = "flex-wrap [&>div:first-child]:min-w-40";
  const controls = "ml-auto flex shrink-0 items-center gap-2";
  function detail(u: UserInfo): string {
    if (u.self) return "You";
    if (u.named) return "Named in DOCIFY_ADMINS";
    const seen = `Last signed in ${ago(u.lastLoginAt)}`;
    return u.rule ? `${seen} · ${admittedBy(u.rule)}` : seen;
  }
</script>

<Toolbar>
  <span class="flex-1"></span>
  <span class={capsule()}>
    <button type="button" class={capsuleButton({ class: "px-0" })} aria-label="Refresh" title="Refresh" disabled={busy} onclick={() => run(async () => {})}><RefreshCw size={14} /></button>
  </span>
</Toolbar>

<div class="min-h-0 flex-1 overflow-y-auto">
  <div class="mx-auto max-w-[720px] px-8 pt-2 pb-10">
    <h1 class="text-[26px] leading-8 font-bold">Users</h1>
    <p class="mt-2 text-[13px] leading-[18px] text-label2">
      People sign in with GitHub. Members search and read; administrators also manage sources, settings, backups and these accounts.
    </p>

    {#if error || users.error || access.error}
      <div class={notice({ tone: "bad", class: "mt-4" })} role="alert">
        <StatusIcon tone="bad" class="mt-0.5" />
        <span class="min-w-0 flex-1 break-words">{error || users.error || access.error}</span>
        {#if error}<button type="button" class="shrink-0 rounded text-bad-text" aria-label="Dismiss" onclick={() => (error = "")}><X size={14} /></button>{/if}
      </div>
    {/if}

    {#if users.list === null}
      {#if !users.error}<p class="mt-6 text-[13px] text-label2">Loading accounts…</p>{/if}
    {:else}
      {#if waiting.length}
        <Group title="Waiting for approval" hint="A waiting account can sign in but sees nothing until you approve it.">
          {#each waiting as u (u.id)}
            <Row label={title(u)} sub={`Signed up ${ago(u.createdAt)}`} class={rowClass}>
              <span class={controls}>
                <button type="button" class={button({ intent: "danger", size: "xs" })} disabled={busy} onclick={() => askRemove(u)}>Remove…</button>
                <button type="button" class={button({ intent: "primary", size: "xs" })} disabled={busy} onclick={() => patch(u, { status: "active" })}>Approve</button>
              </span>
            </Row>
          {/each}
        </Group>
      {/if}

      {#if access.info}
        {@const info = access.info}
        <Group title="Access list">
          {#each info.rules as rule (rule.id)}
            <Row label={rule.value} sub={ruleDetail(rule)} class={rowClass}>
              <span class={controls}>
                <button type="button" class={button({ intent: "danger", size: "xs" })} disabled={busy} onclick={() => askDrop(rule)}>Remove…</button>
              </span>
            </Row>
          {:else}
            <p class={row({ class: "text-[13px] text-label2" })}>No entries. Nobody gets in without your approval.</p>
          {/each}
          <form class={row({ class: "flex-wrap gap-2" })} onsubmit={addRule} novalidate>
            <select class={popup()} aria-label="Kind of entry" bind:value={kind} disabled={busy} onchange={() => (addError = "")}>
              {#each KINDS as k (k.kind)}<option value={k.kind}>{k.label}</option>{/each}
            </select>
            <input
              class={input({ invalid: !!addError, class: "min-w-40 flex-1" })}
              aria-label={entry.label}
              aria-invalid={!!addError}
              aria-describedby="access-hint"
              placeholder={entry.placeholder}
              maxlength="254"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              bind:value
              oninput={() => (addError = "")}
              disabled={busy}
            />
            <button type="submit" class={button({ intent: "primary", size: "xs", class: "ml-auto" })} disabled={busy || !value.trim()}>Add</button>
          </form>
          <Row label="Everyone else" sub="People who match no entry" class={rowClass}>
            <span class={controls}>
              <select class={popup()} aria-label="Everyone else" value={info.outsiders} disabled={busy} onchange={(e) => setOutsiders(e.currentTarget.value as Outsiders)}>
                <option value="pending">Wait for approval</option>
                <option value="refuse">Are refused</option>
              </select>
            </span>
          </Row>
          {#snippet footer()}
            <p id="access-hint" class="mx-3.5 mt-1.5 text-[11px] leading-[14px] {addError ? 'font-medium text-bad-text' : 'text-label2'}" role={addError ? "alert" : undefined}>
              {addError || `${entry.hint} A person who matches an entry gets in as a member when they sign in.`}
            </p>
          {/snippet}
        </Group>
      {/if}

      <Group title="Accounts" hint="Administrators named in DOCIFY_ADMINS are changed in that variable, not here. You cannot change your own account.">
        {#each people as u (u.id)}
          {@const s = chipFor(u)}
          <Row label={title(u)} sub={detail(u)} class={rowClass}>
            <span class={controls}>
            {#if u.self || u.named}
              <StatusChip tone={s.tone} label={s.label} />
            {:else if u.status === "disabled"}
              <StatusChip tone={s.tone} label={s.label} />
              <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => patch(u, { status: "active" })}>Enable</button>
              <button type="button" class={button({ intent: "danger", size: "xs" })} disabled={busy} onclick={() => askRemove(u)}>Remove…</button>
            {:else}
              <select
                class={popup()}
                aria-label={`Role of ${u.login}`}
                value={u.role}
                disabled={busy}
                onchange={(e) => patch(u, { role: e.currentTarget.value as "admin" | "member" })}
              >
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
              <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => patch(u, { status: "disabled" })}>Disable</button>
              <button type="button" class={button({ intent: "danger", size: "xs" })} disabled={busy} onclick={() => askRemove(u)}>Remove…</button>
            {/if}
            </span>
          </Row>
        {/each}
      </Group>
    {/if}
  </div>
</div>

<ConfirmDialog
  bind:open={confirmRemove}
  title={`Remove ${removing?.login ?? "account"}?`}
  message={`${removing?.login ?? "This person"} is signed out and the account is deleted. If they sign in again, the access list decides whether they get in or wait.`}
  confirmLabel="Remove"
  onconfirm={remove}
/>
<ConfirmDialog
  bind:open={confirmDrop}
  title={`Remove ${dropping?.value ?? "this entry"} from the access list?`}
  message={dropping ? removeMessage(dropping, access.info?.outsiders ?? "pending") : ""}
  confirmLabel="Remove"
  onconfirm={drop}
/>
