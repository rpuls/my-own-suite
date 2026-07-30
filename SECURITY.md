# Security Policy

My Own Suite runs on other people's servers and holds their files, photos, and passwords. Security reports are welcome here, and they are read.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Report it privately, in either of these ways:

- **GitHub private vulnerability reporting:** the [Security tab](https://github.com/rpuls/my-own-suite/security/advisories/new) of this repository. Preferred: it keeps the report, the discussion, and the eventual advisory in one place.
- **Email:** the address on the [maintainer's GitHub profile](https://github.com/rpuls).

A useful report includes what you found, how to reproduce it, which MOS version and install path (cloud one-liner, USB, SSH), and what an attacker could do with it. A proof of concept helps; a working exploit is not required.

**What to expect:** an acknowledgement within 7 days and an assessment within 14. This is a small project, currently one maintainer, so please read those as honest targets rather than a commercial SLA. If a report goes unacknowledged past 7 days, ping the [Discord](https://discord.gg/YMpF6faBCv) without describing the issue and the maintainer will pick it up.

Please give a fix a reasonable window before publishing. If a report needs longer than 90 days, you will hear why rather than hear nothing.

## Supported versions

Only the **latest release** is supported. MOS is pre-1.0 and moves quickly; fixes land on `main` and reach installs through the Stable update track. There are no backports to older tags.

## Scope

**In scope:** anything in this repository: Suite Manager (the control plane), the host agents in `system-agents/`, the installers and bootstrap contract in `scripts/installers/`, the app packages in `apps/`, the catalog and advisory signing chain, and the public site in `site/`.

**Out of scope:** vulnerabilities in the upstream applications MOS packages (Immich, Seafile, ONLYOFFICE, Vaultwarden, Radicale, Stirling PDF). Report those to their own projects; if the flaw is in *how MOS configures or exposes* one of them, that is in scope here. Also out of scope: findings against someone else's running install without their permission, and reports from automated scanners with no demonstrated impact.

## Known gaps, please don't spend your time rediscovering these

MOS is a prototype. The items below are already known, publicly recorded in the **Alpha gate** section of [`docs/roadmap.md`](./docs/roadmap.md), and scheduled to be addressed before the project calls itself an alpha. Reports that go *beyond* them, a concrete exploit, a sharper impact, an attack the roadmap entry misses, are still very welcome.

- **No second factor on owner sign-in.** A password is currently the only credential for Suite Manager, including on internet-facing cloud installs.
- **The host OS is not patched by MOS.** MOS updates itself and the apps; nothing currently keeps Ubuntu's own packages current.
- **Own-hardware disks are not encrypted.** The installer uses a plain disk layout, so physical theft exposes stored data.
- **Backup bundles are unencrypted full-secret exports.** This is stated in the product and in [the backup guide](https://myownsuite.org/docs/guides/backup-restore/).
- **App containers are constrained at the install gate, not at runtime.** Resource, capability, and filesystem limits on running app containers are not yet applied.
- **Release and installer artifacts are not signed.** The app catalog and the advisory feed are Ed25519-signed and verified on the server; the release itself and the pipe-to-shell installer are not.

## Security advisories for packaged apps

MOS publishes a signed advisory feed (`apps/advisories.json`) that flags problems against the app version an owner actually has installed. If you know of a published vulnerability affecting a version MOS ships, opening a normal issue about it is fine and useful, that is disclosure of someone else's already-public finding, not a report of a new one.

## Recognition

There is no bug bounty; there is no money here. Reporters are credited by name in the changelog and the advisory unless they'd rather not be.
