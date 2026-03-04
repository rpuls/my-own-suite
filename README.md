<h1 align="center">My Own Suite</h1>
<p align="center"><sub>Your Big Tech exit kit.</sub></p>
<p align="center">
  <a href="https://myownsuite.org/"><img alt="Website" src="https://img.shields.io/badge/Website-myownsuite.org-0ea5e9?style=for-the-badge"></a>
  <a href="https://myownsuite.org/docs"><img alt="Docs" src="https://img.shields.io/badge/Docs-Read_Now-22c55e?style=for-the-badge"></a>
</p>

> **One-click open source alternatives** to Google Drive, Google Calendar, 1Password, Microsoft 365, and more.  
> Deploy anywhere: Railway, VPS, or homelab. Your data, your control.

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

### Who It's For

- Individuals, families, freelancers exiting Big Tech SaaS
- Users who want **one-click privacy** without sysadmin complexity
- Privacy enthusiasts ready for VPS or homelab upgrades
- Developers seeking production-ready self-hosted stacks

## 🚀 Quick Start

### 1️⃣ **Easiest: Railway (Coming Soon)**

## Quick Start (Local VPS Stack)

One-click deploy → fully automated stack

### 2️⃣ **VPS/Local**
```bash
git clone https://github.com/rpuls/my-own-suite.git
cd my-own-suite
npm run vps:rebuild
```

### 3️⃣ Dockploy

Work in progress...

---

## 📁 Navigation

| Need | Go here |
| --- | --- |
| Project website + public docs | `site/` |
| App code + app-level READMEs | `apps/` |
| Deployment stacks | `deploy/` |
| Canonical VPS architecture + app onboarding steps | [deploy/vps/README.md](./deploy/vps/README.md) |
| Homepage service details | [apps/homepage/README.md](./apps/homepage/README.md) |
| Seafile service details | [apps/seafile/README.md](./apps/seafile/README.md) |
| ONLYOFFICE service details | [apps/onlyoffice/README.md](./apps/onlyoffice/README.md) |
| Immich service details | [apps/immich/README.md](./apps/immich/README.md) |
| Radicale service details | [apps/radicale/README.md](./apps/radicale/README.md) |
| Stirling PDF service details | [apps/stirling-pdf/README.md](./apps/stirling-pdf/README.md) |
| Vaultwarden service details | [apps/vaultwarden/README.md](./apps/vaultwarden/README.md) |

---

## Contributor Note

For app integration work (especially "add a new app"), treat [deploy/vps/README.md](./deploy/vps/README.md) as the canonical step-by-step architecture guide.
