# Shortcuts for the commands in docs/guide.md. `make` alone lists them.

.DEFAULT_GOAL := help
.PHONY: help install link setup test typecheck check serve mcp eval mcp-smoke

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-11s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	bun install

link: ## Put `docify` on PATH (~/.bun/bin) pointing at this checkout
	bun link

setup: ## Install Graphify and download the embedding model (needs the network)
	bun src/cli.ts setup

test: ## Run the test suite (set DOCIFY_MODELS_DIR if the model is not in the store's models/)
	bun test

typecheck: ## Type-check the TypeScript sources
	bun run typecheck

check: typecheck test ## Type-check and test

serve: ## Start the web UI on 127.0.0.1:4747
	bun src/cli.ts serve

mcp: ## Start the MCP server on stdio
	bun src/cli.ts mcp

eval: ## Run the retrieval evaluation against the prepared store
	bun scripts/eval.ts

mcp-smoke: ## Drive the MCP server over stdio
	bun scripts/mcp-smoke.ts
