# claude-voice — thin convenience wrapper over the npm scripts (the source of
# truth). `make` with no target prints this help.
.DEFAULT_GOAL := help
.PHONY: help deps init install uninstall check test typecheck list voices config say

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

deps: ## Install dev dependencies (typescript, @types/node)
	npm install

init: ## Interactive setup: pick voice/verbosity and wire hooks
	npm run init

install: ## Wire hooks into ~/.claude/settings.json (idempotent)
	npm run hooks:install

uninstall: ## Remove claude-voice hooks (leaves other hooks intact)
	npm run hooks:uninstall

check: ## Typecheck + run tests
	npm run check

test: ## Run decision-logic assertions
	npm test

typecheck: ## Type-check with tsc (no emit)
	npm run typecheck

list: ## List TTS providers
	npm run list

voices: ## List installed system voices
	npm run voices

config: ## Show active config + its path
	npm run config

say: ## Speak a phrase: make say TEXT="hello there"
	npm run say -- "$(TEXT)"
