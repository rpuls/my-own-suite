<p align="center">
  <img src="./branding/my-own-suite-mark.png" alt="My Own Suite logo" width="96" />
</p>
<h1 align="center">My Own Suite</h1>
<p align="center"><sub>Your Big Tech exit kit.</sub></p>
<p align="center">
  <a href="https://myownsuite.org/"><img alt="Website" src="https://img.shields.io/badge/Website-myownsuite.org-0ea5e9?style=for-the-badge"></a>
  <a href="https://myownsuite.org/docs"><img alt="Docs" src="https://img.shields.io/badge/Docs-Read_Now-22c55e?style=for-the-badge"></a>
</p>

> **One-click open source alternatives** to Google Drive, Google Calendar, 1Password, Microsoft 365, and more.  
> Today the repo is centered on a VPS/local Docker Compose stack, with more deploy targets to follow.

> Shared MOS branding lives in [`branding/`](./branding/). If you change shared brand assets or brand tokens, edit the canonical files there and run `npm run branding:sync` instead of hand-editing app-local copies.

### Solutions Included

| Solution | App | Alternative to |
| --- | --- | --- |
| Dashboard | <img src="./site/src/assets/logos/homepage.png" alt="Homepage" width="18" /> **Homepage** | Link hubs, bookmarks |
| Cloud Storage | <img src="./site/src/assets/logos/seafile.png" alt="Seafile" width="18" /> **Seafile** | Google Drive, Dropbox, OneDrive |
| Office Suite | <img src="./site/src/assets/logos/ONLYOFFICE.png" alt="ONLYOFFICE" width="18" /> **ONLYOFFICE** | Google Docs, Microsoft 365 |
| Photo Library | <img src="./site/src/assets/logos/immich.png" alt="Immich" width="18" /> **Immich** | Google Photos, iCloud Photos |
| Calendar Sync | <img src="./site/src/assets/logos/radicale.png" alt="Radicale" width="18" /> **Radicale** | Google Calendar, iCloud, Outlook |
| PDF Tools | <img src="./site/src/assets/logos/stirling-pdf.png" alt="Stirling PDF" width="18" /> **Stirling PDF** | Adobe Acrobat, Smallpdf |
| Password Manager | <img src="./site/src/assets/logos/vaultwarden.png" alt="Vaultwarden" width="18" /> **Vaultwarden** | 1Password, LastPass, Bitwarden cloud |
| Control Plane | <img src="./branding/my-own-suite-mark.png" alt="My Own Suite" width="18" /> **Suite Manager** | Guided onboarding, login, and shared entrypoint for the suite |

### Who It's For

- Individuals, families, freelancers exiting Big Tech SaaS
- Users who want one-click privacy without sysadmin complexity
- Privacy enthusiasts ready for VPS or homelab upgrades
- Developers seeking production-ready self-hosted stacks

## Quick Start (Local VPS Stack)

```bash
git clone https://github.com/rpuls/my-own-suite.git
cd my-own-suite
npm run vps:init
```

`vps:init` now auto-generates required secrets from template expressions in `*.env.template`.
You can still customize values in `deploy/vps/**/*.env` before startup.

Then validate and start:

```bash
npm run vps:doctor
npm run vps:up
```

If you need a full destructive reset (removes volumes and data):

```bash
npm run vps:rebuild
```

## E2E Testing

The repo includes real black-box Playwright tests that boot an isolated Docker stack, exercise the live browser flows, and tear the stack down again after the run.

```bash
npm run e2e:install
```

Install the Playwright test dependencies and Chromium browser once on your machine.

```bash
npm run e2e:full
npm run e2e:full:headed
```

Run the full E2E suite. Use `e2e:full` for headless CI-style verification or `e2e:full:headed` when you want to watch the whole flow in the browser.

```bash
npm run e2e:onboarding
npm run e2e:onboarding:headed
npm run e2e:onboarding:debug
```

Run just the onboarding flow. Use `:headed` or `:debug` when you want to watch the browser step through account creation, credential import, and Homepage handoff.

```bash
npm run e2e:apps
npm run e2e:apps:headed
```

Run the Homepage app verification flow. This checks live routes for Suite Manager, Vaultwarden, Seafile, Stirling PDF, Immich, and Radicale so image updates are safer to validate.

For the more detailed harness notes, see [tests/e2e/README.md](./tests/e2e/README.md).

---

## Navigation

| Need | Go here |
| --- | --- |
| Project website + public docs | `site/` |
| App code + app-level READMEs | `apps/` |
| Deployment stacks | `deploy/` |
| Canonical VPS architecture + app onboarding steps | [deploy/vps/README.md](./deploy/vps/README.md) |
| Homepage service details | [apps/homepage/README.md](./apps/homepage/README.md) |
| Suite Manager service details | [apps/suite-manager/README.md](./apps/suite-manager/README.md) |
| Seafile service details | [apps/seafile/README.md](./apps/seafile/README.md) |
| ONLYOFFICE service details | [apps/onlyoffice/README.md](./apps/onlyoffice/README.md) |
| Immich service details | [apps/immich/README.md](./apps/immich/README.md) |
| Radicale service details | [apps/radicale/README.md](./apps/radicale/README.md) |
| Stirling PDF service details | [apps/stirling-pdf/README.md](./apps/stirling-pdf/README.md) |
| Vaultwarden service details | [apps/vaultwarden/README.md](./apps/vaultwarden/README.md) |

---

## Contributor Note

For app integration work (especially "add a new app"), treat [deploy/vps/README.md](./deploy/vps/README.md) as the canonical step-by-step architecture guide.

For day-to-day prototyping, use `staging` as the integration branch and reserve `main` for stable release-ready batches.
