# Reprove

Open-source agentic code review for GitHub pull requests. See [README.md](README.md)
for the overview and [docs/prd.md](docs/prd.md) for the full product definition.

**Status:** pre-implementation. No source code exists yet; the PRD is the spec of record.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
