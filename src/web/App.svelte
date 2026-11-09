<script lang="ts">
  import TopBar from "./components/TopBar.svelte";
  import Search from "./views/Search.svelte";
  import Settings from "./views/Settings.svelte";
  import Sources from "./views/Sources.svelte";

  type View = "workspace" | "settings";

  function initialView(): View {
    try {
      return sessionStorage.getItem("docify-view") === "settings" ? "settings" : "workspace";
    } catch {
      return "workspace";
    }
  }

  let view = $state<View>(initialView());

  $effect(() => {
    try {
      sessionStorage.setItem("docify-view", view);
    } catch {
      // the view is then not kept across reloads
    }
  });
</script>

<div class="flex h-dvh flex-col">
  <TopBar bind:view />
  <!-- The workspace stays mounted so search results survive a visit to Settings. -->
  <main
    class="mx-auto w-full max-w-[1440px] min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5 lg:flex-row lg:overflow-hidden"
    class:flex={view === "workspace"}
    class:hidden={view !== "workspace"}
  >
    <Sources class="lg:w-[40%]" />
    <Search class="lg:w-[60%]" />
  </main>
  {#if view === "settings"}
    <Settings />
  {/if}
</div>
