<script lang="ts">
  // Placeholder; replaced by the add-source sheet.
  import Sheet from "../components/Sheet.svelte";
  import { nav } from "../lib/nav.svelte.ts";
</script>

<Sheet bind:open={nav.addingSource} title="New Source"><p>New source</p></Sheet>
