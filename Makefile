# LLM evals of the mvp-sdlc plugin (evals layer 1, plugins/mvp-sdlc/evals/README.md). Manual only, before a version
# bump: every target makes model calls and costs money, and CI never runs them. The deterministic checks are
# `bash scripts/ci/check.sh`.
#   make eval                    GREEN and RED arms of every case, then eval-results
#   make eval CASE=<name>        one case
#   make eval-results            rewrite eval/results/<version>.json from the last run

VERSION := $(shell python3 -c 'import json; print(json.load(open("plugins/mvp-sdlc/.claude-plugin/plugin.json"))["version"])')
RUNS_DIR := .eval-runs/$(VERSION)
EVAL_JOBS ?= 2
EVAL_MAX_COST_USD ?= 40

.PHONY: eval eval-results

eval:
	python3 scripts/evals.py run --replace --out $(RUNS_DIR) --jobs $(EVAL_JOBS) --max-cost-usd $(EVAL_MAX_COST_USD) $(if $(CASE),--case $(CASE))
	$(MAKE) eval-results

eval-results:
	python3 scripts/evals.py results --runs $(RUNS_DIR) --out eval/results/$(VERSION).json
