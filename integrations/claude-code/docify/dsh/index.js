// DeepSeek Harness entry for the docify Claude Code plugin. The plugin tree is read as is.
// The runtime is the published claude-plugin-dsh package: run `bun install` in this directory first.
import { createPlugin, rootFrom } from 'claude-plugin-dsh'

const plugin = createPlugin({ root: rootFrom(import.meta.url) })
export const { name, apply } = plugin
export default plugin
