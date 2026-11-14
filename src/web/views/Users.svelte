<script lang="ts">
  import { onMount } from "svelte";
  import { RefreshCw, X } from "@lucide/svelte";
  import ConfirmDialog from "../components/ConfirmDialog.svelte";
  import Group from "../components/Group.svelte";
  import Row from "../components/Row.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { api, errorText } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";
  import { users, type UserInfo } from "../lib/users.svelte.ts";
  import { button, capsule, capsuleButton, notice, popup, type ChipTone } from "../lib/ui.ts";

  // The administration panel: approve sign-ups, set roles, disable and remove accounts.
  let busy = $state(false);
  let error = $state("");
  let removing = $state<UserInfo | null>(null);
  let confirmRemove = $state(false);

  const waiting = $derived(users.list?.filter((u) => u.status === "pending") ?? []);
  const people = $derived(users.list?.filter((u) => u.status !== "pending") ?? []);

  onMount(users.refresh);

  async function run(action: () => Promise<unknown>) {
    busy = true;
    error = "";
    try {
      await action();
    } catch (err) {
      error = errorText(err);
    }
    await users.refresh();
    busy = false;
  }

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
    return `Last signed in ${ago(u.lastLoginAt)}`;
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

    {#if error || users.error}
      <div class={notice({ tone: "bad", class: "mt-4" })} role="alert">
        <StatusIcon tone="bad" class="mt-0.5" />
        <span class="min-w-0 flex-1 break-words">{error || users.error}</span>
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
  message={`${removing?.login ?? "This person"} is signed out and the account is deleted. They can sign up again and would then wait for approval.`}
  confirmLabel="Remove"
  onconfirm={remove}
/>
