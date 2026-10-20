# Manual operator targets; CI never runs them. The deterministic checks are `bash scripts/ci/check.sh`.
# LLM evals of the mvp-sdlc plugin (evals layer 1, plugins/mvp-sdlc/evals/README.md), before a version bump; they
# make model calls and cost money:
#   make eval                    GREEN and RED arms of every case, then eval-results
#   make eval CASE=<name>        one case
#   make eval-results            rewrite eval/results/<version>.json from the last run
# Public mirrors (scripts/publish-mirror.README.md):
#   make mirror REPO=<repo>      sync one public mirror; optional REF=<ref>, ARGS="--dry-run --subject <text>"

VERSION := $(shell python3 -c 'import json; print(json.load(open("plugins/mvp-sdlc/.claude-plugin/plugin.json"))["version"])')
RUNS_DIR := .eval-runs/$(VERSION)
EVAL_JOBS ?= 2
EVAL_MAX_COST_USD ?= 40

.PHONY: eval eval-results mirror

eval:
	python3 scripts/evals.py run --replace --out $(RUNS_DIR) --jobs $(EVAL_JOBS) --max-cost-usd $(EVAL_MAX_COST_USD) $(if $(CASE),--case $(CASE))
	$(MAKE) eval-results

eval-results:
	python3 scripts/evals.py results --runs $(RUNS_DIR) --out eval/results/$(VERSION).json

mirror:
	@test -n "$(REPO)" || { echo 'usage: make mirror REPO=<repo> [REF=<ref>] [ARGS="--dry-run --subject <text>"]' >&2; exit 64; }
	bash scripts/publish-mirror.sh $(REPO) $(REF) $(ARGS)
