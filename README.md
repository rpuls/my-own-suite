<h1 align="center">My Own Suite</h1>
<p align="center"><sub>Your Big Tech exit kit.</sub></p>
<p align="center">
  <a href="https://myownsuite.org/"><img alt="Website" src="https://img.shields.io/badge/Website-myownsuite.org-0ea5e9?style=for-the-badge"></a>
  <a href="https://myownsuite.org/docs"><img alt="Docs" src="https://img.shields.io/badge/Docs-Read_Now-22c55e?style=for-the-badge"></a>
</p>

### What is My Own Suite

My Own Suite is not just a bundle of tools.
It is a carefully selected stack of battle-tested open-source alternatives trusted by large communities and matured over many years of development.
Each app is chosen for reliability, practical usability, and long-term maintainability.
The goal is an experience close to enterprise SaaS, and in many cases better, while keeping your data and infrastructure under your control.

Think of it as the Swiss Army knife of open-source tools, always within reach.

### Who is My Own Suite for

- People who want data ownership without becoming full-time sysadmins.
- People who value privacy and want more digital independence.
- Users planning a realistic exit from Big Tech SaaS lock-in without sacrificing usability.
- People who want to move to open source but do not have deep technical experience.


---

## Solutions Included

| Solution | App (icon + name) | Alternative to |
| --- | --- | --- |
| Dashboard | <img src="./site/src/assets/logos/homepage.png" alt="Homepage" width="18" /> **Homepage** | Link hubs and fragmented bookmarks |
| Cloud Storage | <img src="./site/src/assets/logos/seafile.png" alt="Seafile" width="18" /> **Seafile** | Google Drive, Dropbox, OneDrive |
| Office Suite | <img src="./site/src/assets/logos/OnlyOffice.png" alt="OnlyOffice" width="18" /> **OnlyOffice** | Google Docs, Microsoft 365 |
| Password Manager | <img src="./site/src/assets/logos/vaultwarden.png" alt="Vaultwarden" width="18" /> **Vaultwarden** | 1Password, LastPass, Bitwarden cloud |

---

## Quick Start (Local VPS Stack)

```bash
git clone https://github.com/rpuls/my-own-suite.git
cd my-own-suite
npm run vps:rebuild
```

`vps:rebuild` performs a full reset and rebuild, including Docker volumes.

### Railway

Deploy template coming soon.

### Dockploy

Work in progress...

---

## Resource Map

| Need | Go here |
| --- | --- |
| Project website + public docs | `site/` |
| App code + app-level READMEs | `apps/` |
| Deployment stacks | `deploy/` |
| Canonical VPS architecture + app onboarding steps | [deploy/vps/README.md](./deploy/vps/README.md) |
| Homepage service details | [apps/homepage/README.md](./apps/homepage/README.md) |
| Seafile service details | [apps/seafile/README.md](./apps/seafile/README.md) |
| OnlyOffice service details | [apps/onlyoffice/README.md](./apps/onlyoffice/README.md) |
| Vaultwarden service details | [apps/vaultwarden/README.md](./apps/vaultwarden/README.md) |

---

## Contributor Note

For app integration work (especially "add a new app"), treat [deploy/vps/README.md](./deploy/vps/README.md) as the canonical step-by-step architecture guide.
