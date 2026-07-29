# Contributing to My Own Suite

Thank you for being here. My Own Suite is early software, and the fastest way it gets better is people running it, breaking it, and saying so.

There is no contributor agreement to sign and no gatekeeping ceremony. Come and say hello:

- **Discord** — [discord.gg/YMpF6faBCv](https://discord.gg/YMpF6faBCv) for questions, feedback, ideas, and "is this supposed to happen?"
- **GitHub Issues** — [github.com/rpuls/my-own-suite/issues](https://github.com/rpuls/my-own-suite/issues) for bugs and concrete proposals

## The most useful thing you can do

Run it and report what happened. Genuinely. A clear bug report from a real install is worth more than most patches, because the failures that matter are the ones nobody has hit yet.

A good report has:

- what you were doing, and what you expected instead
- how MOS was installed (cloud provider, own hardware, USB installer) and whether HTTPS is configured
- the MOS version from **Settings → Advanced details**, or the `VERSION` file
- any error text Suite Manager showed, including what is under **Advanced details** — that section exists so you have something to paste

Please scrub secrets before pasting: API tokens, passwords, and the one-time owner setup key.

## Ways to contribute

**Test and report.** See above. Installing on a platform we have not tried is a real contribution.

**Documentation.** The public site under [`site/`](./site/) is end-user documentation; [`apps/<app>/README.md`](./apps/) files are the technical reference for each app package. Fixing a confusing sentence is a welcome first pull request.

**App packages.** Adding an app to the catalog means writing a package under `apps/<app>/` — a manifest, a Dockerfile pinned to an image digest, and a README. Every catalog app also needs a completed privacy posture review before it ships. Read [`apps/README.md`](./apps/README.md) first, and open an issue to discuss the app before building the package.

**Code.** Suite Manager (control plane), the host agents, and the installers are all open. Start with an issue so nobody duplicates work.

## Working in this repository

The full workflow rules live in [AGENTS.md](./AGENTS.md) — it is written for coding agents but applies to humans just as well. The essentials:

- Never commit directly to `main`. Branch as `feat/…`, `fix/…`, `docs/…`, or `chore/…`.
- `staging` is the integration branch; `main` holds released batches.
- Run `npm run hooks:install` once so the local hooks block accidental commits on `main`.
- Update [`CHANGELOG.md`](./CHANGELOG.md) under `## [Unreleased]` when your change affects how MOS behaves for someone updating it. Documentation-only and website-only changes do not need an entry.
- Releases follow [RELEASING.md](./RELEASING.md). Do not invent version numbers.

### Getting set up

```bash
npm install
npm run dev            # builds the Suite Manager client and starts the backend
npm run test           # typecheck, unit tests, catalog/privacy/release checks, builds
```

Browser and infrastructure tests are run by hand because they are noisy or create paid cloud resources — see [`scripts/README.md`](./scripts/README.md) and [`test/README.md`](./test/README.md).

### What we look for in a pull request

- One change, described in plain language: what it does and why.
- Tests when the change is behavioural. Existing tests should keep passing.
- No new dependency without a reason worth stating.
- Code that reads like the code around it.

## How AI is used here

Parts of this project were written with AI assistance, and we say so openly — on the website, in the README, and in the beta notice inside Suite Manager. You are welcome to use AI tools on your contributions too. The expectation is the same either way: you understand what you are submitting and you stand behind it.

## Security

Please do **not** open a public issue for a security vulnerability. Report it privately through Discord to a maintainer, or by email to the address on the [GitHub profile](https://github.com/rpuls). This is early software run by real people on their own servers, so responsible disclosure genuinely matters here.

## License

My Own Suite is licensed under the [GNU Affero General Public License v3.0 only](./LICENSE). By contributing, you agree that your contribution is licensed under the same terms.
