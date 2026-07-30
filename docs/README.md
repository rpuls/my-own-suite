# Project Docs

This folder holds durable project memory: architectural decisions, documentation ownership, and Codex working context. It is not the home for every Markdown file in the repository.

## Documentation Ownership

| Need | Source of truth |
| --- | --- |
| Product and end-user documentation | `site/` |
| App technical reference | `apps/<app>/README.md` |
| MOS operator/developer scripts | `scripts/README.md` |
| Test harness guidance | `test/README.md` |
| USB/self-host installer support | `infrastructure/self-host/` and `scripts/README.md` |
| Host-agent implementation | `system-agents/` |
| Previous-site rollback/reference source | `site-mos1-reference/` |
| Durable architecture decisions | `docs/decisions.md` |
| Forward-looking themes, gates, sequencing, and decided-against list | `docs/roadmap.md` |
| Task state and progress on any roadmap item | GitHub Issues |
| Codex/project workflow notes | `docs/codex-notes.md` |
| Temporary branch development notes explicitly requested for an active epic | `docs/<topic>-plan.md`, removed or converted to GitHub Issues before merge unless the owner explicitly designates the file as a kept durable record (so marked in its status line) |
| GitHub task shape | `.github/ISSUE_TEMPLATE/codex-task.yml` |
| Release workflow | `RELEASING.md` |
| Release notes | `CHANGELOG.md` |
| Contributor onboarding | `CONTRIBUTING.md` |
| Vulnerability reporting, supported versions, and known security gaps | `SECURITY.md` |
| Agent instructions | `AGENTS.md` |

## Why Some Docs Stay At The Repo Root

Some files intentionally stay at the repository root because that is the industry-standard discovery location for both humans and tools:

- `README.md`: repository landing page.
- `CHANGELOG.md`: release notes.
- `RELEASING.md`: release process.
- `CONTRIBUTING.md`: contributor onboarding, discovered by GitHub's own contribution prompts.
- `SECURITY.md`: vulnerability reporting, surfaced by GitHub's Security tab and its "report a vulnerability" prompts.
- `AGENTS.md`: agent instructions loaded by coding assistants.

Do not move these into `docs/` unless the project deliberately changes its tooling and contributor conventions.

## Anti-Drift Rules

- `docs/roadmap.md` is the only forward-looking document. Do not create additional roadmap, TODO, backlog, or planning documents in repo docs.
- Keep the split strict: the roadmap holds themes, gates, and sequencing; GitHub Issues hold task state. The roadmap must never contain checkboxes, status notes, or implementation evidence — that is what turned its four predecessors into stale checklists.
- Do not create a new architecture note when an update to `docs/decisions.md` would do.
- Do not duplicate task templates in Markdown; update `.github/ISSUE_TEMPLATE/codex-task.yml`.
- Keep runbooks close to the thing they operate unless they become broad project policy.
- If a document becomes obsolete, replace it with a pointer or delete it rather than letting it compete with newer docs.
