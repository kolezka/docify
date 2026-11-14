<script lang="ts">
  import StatusIcon from "../components/StatusIcon.svelte";
  import ThemeSwitch from "../components/ThemeSwitch.svelte";
  import { errorText } from "../lib/api.ts";
  import { session } from "../lib/session.svelte.ts";
  import { button, notice } from "../lib/ui.ts";

  // Shown instead of the app while nobody is signed in, or while the account waits for approval.
  // It says why an account is needed before asking for one (HIG Managing accounts).
  const RESULTS: Record<string, string> = {
    cancelled: "Sign-in was cancelled at GitHub.",
    expired: "That sign-in link expired or was opened in another browser. Start again here.",
    failed: "GitHub did not confirm the sign-in. Try again in a moment.",
    disabled: "This account is disabled. Ask an administrator of this server to enable it.",
  };

  // The server reports how a sign-in ended as #signin=<word>; read it once and clean the address bar.
  function takeResult(): string {
    const word = new URLSearchParams(location.hash.slice(1)).get("signin");
    if (word) history.replaceState(null, "", location.pathname);
    return word ? (RESULTS[word] ?? "") : "";
  }

  let result = $state(takeResult());
  let busy = $state(false);
  let error = $state("");

  async function check() {
    busy = true;
    await session.refresh();
    busy = false;
  }

  async function signOut() {
    busy = true;
    try {
      await session.signOut();
    } catch (err) {
      error = errorText(err);
      busy = false;
    }
  }
</script>

<div class="flex h-dvh flex-col">
  <div class="flex justify-end px-4 pt-3"><ThemeSwitch /></div>
  <main class="flex min-h-0 flex-1 items-center justify-center px-6 pb-16">
    <div class="w-full max-w-[380px] text-center">
      <h1 class="text-[26px] leading-8 font-bold">Docify</h1>
      {#if session.error}
        <div class={notice({ tone: "bad", class: "mt-5 text-left" })} role="alert"><StatusIcon tone="bad" class="mt-0.5" /><span class="break-words">{session.error}</span></div>
        <button type="button" class={button({ size: "md", class: "mt-5" })} disabled={busy} onclick={check}>Try Again</button>
      {:else if !session.user}
        <p class="mt-2 text-[13px] leading-[18px] text-label2">
          Sign in to search the documentation on this server. A new account can be used once an administrator approves it.
        </p>
        {#if result}
          <div class={notice({ tone: "warn", class: "mt-5 text-left" })} role="status"><StatusIcon tone="warn" class="mt-0.5" /><span>{result}</span></div>
        {/if}
        <!-- A plain link: the page policy allows no form posts, and GitHub needs a top-level visit. -->
        <a href="/auth/github" class={button({ intent: "primary", size: "md", class: "mt-5 h-8 px-5" })}>Sign In with GitHub</a>
        <p class="mt-3 text-[11px] leading-[14px] text-label2">Docify reads only your public GitHub profile: your login and name.</p>
      {:else}
        <h2 class="mt-5 text-[17px] leading-[22px] font-semibold">{session.user.status === "pending" ? "Waiting for Approval" : "Account Disabled"}</h2>
        <p class="mt-2 text-[13px] leading-[18px] text-label2">
          You are signed in as <span class="font-medium text-label">{session.user.login}</span>.
          {session.user.status === "pending"
            ? "An administrator of this server has to approve the account before you can search."
            : "Ask an administrator of this server to enable it."}
        </p>
        {#if error}
          <div class={notice({ tone: "bad", class: "mt-5 text-left" })} role="alert"><StatusIcon tone="bad" class="mt-0.5" /><span class="break-words">{error}</span></div>
        {/if}
        <div class="mt-5 flex justify-center gap-2.5">
          <button type="button" class={button({ size: "md" })} disabled={busy} onclick={signOut}>Sign Out</button>
          <button type="button" class={button({ intent: "primary", size: "md" })} disabled={busy} onclick={check}>Check Again</button>
        </div>
      {/if}
    </div>
  </main>
</div>
