# Project Docs

This folder holds durable project memory: roadmap, architectural decisions, and Codex working context. It is not the home for every Markdown file in the repository.

## Documentation Ownership

| Need | Source of truth |
| --- | --- |
| Product and end-user documentation | `site/src/content/docs/` |
| App technical reference | `apps/<app>/README.md` |
| VPS/local Docker operations | `deploy/vps/README.md` |
| USB/self-host installer operations | `deploy/self-host/README.md` |
| Updater smoke tests and low-level host checks | `update/selfhost/docs/` |
| Durable roadmap and future work themes | `docs/roadmap.md` |
| Durable architecture decisions | `docs/decisions.md` |
| Codex/project workflow notes | `docs/codex-notes.md` |
| GitHub task shape | `.github/ISSUE_TEMPLATE/codex-task.yml` |
| Release workflow | `RELEASING.md` |
| Release notes | `CHANGELOG.md` |
| Agent instructions | `AGENTS.md` |

## Why Some Docs Stay At The Repo Root

Some files intentionally stay at the repository root because that is the industry-standard discovery location for both humans and tools:

- `README.md`: repository landing page.
- `CHANGELOG.md`: release notes.
- `RELEASING.md`: release process.
- `AGENTS.md`: agent instructions loaded by coding assistants.

Do not move these into `docs/` unless the project deliberately changes its tooling and contributor conventions.

## Anti-Drift Rules

- Do not create a new planning document when an update to `docs/roadmap.md` or GitHub Issues would do.
- Do not create a new architecture note when an update to `docs/decisions.md` would do.
- Do not duplicate task templates in Markdown; update `.github/ISSUE_TEMPLATE/codex-task.yml`.
- Keep runbooks close to the thing they operate unless they become broad project policy.
- If a document becomes obsolete, replace it with a pointer or delete it rather than letting it compete with newer docs.
