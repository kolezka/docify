import { expect, test } from "bun:test";
import { YAML } from "bun";
import { readFileSync } from "node:fs";

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string };
const workflow = YAML.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as {
  on: { workflow_dispatch: { inputs: { bump: unknown } } };
  permissions: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: { release: { if: string; steps: Step[] } };
};

test("release is manual, main-only, serialized and checks out full main history", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.on.workflow_dispatch.inputs.bump).toMatchObject({
    required: true,
    default: "patch",
    type: "choice",
    options: ["patch", "minor", "major"],
  });
  expect(workflow.permissions).toEqual({ contents: "write" });
  expect(workflow.concurrency).toEqual({ group: "docify-release", "cancel-in-progress": false });
  expect(workflow.jobs.release.if).toBe("github.ref == 'refs/heads/main'");
  const checkout = workflow.jobs.release.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout!.with).toEqual({ ref: "main", "fetch-depth": 0 });
});

test("release validates input, uses the shared script and atomically pushes only main and the new tag", () => {
  const steps = workflow.jobs.release.steps;
  const bumpIndex = steps.findIndex((step) => step.name === "Bump, commit and tag");
  const bump = steps[bumpIndex]!;
  expect(bump.env!.BUMP).toBe("${{ inputs.bump }}");
  expect(bump.run).toContain('case "$BUMP" in');
  expect(bump.run).toContain("major|minor|patch)");
  expect(bump.run).toContain('bun scripts/release.ts "$BUMP"');
  expect(bump.run).not.toContain("${{");
  expect(steps.slice(0, bumpIndex).some((step) => step.run?.includes("bun run typecheck"))).toBe(true);
  expect(steps.slice(0, bumpIndex).some((step) => step.run?.includes("bun test tests/version.test.ts"))).toBe(true);
  const push = steps[bumpIndex + 1]!.run!;
  expect(push.indexOf("bun test tests/version.test.ts")).toBeLessThan(push.indexOf("git push"));
  expect(push).toContain('git push --atomic origin HEAD:refs/heads/main "refs/tags/v${version}"');
  expect(push).not.toContain("--force");
  expect(push).not.toContain("--follow-tags");
});
