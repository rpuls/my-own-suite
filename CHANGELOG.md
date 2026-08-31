# Changelog

Updater-facing software changes only — documentation, site, repository, and cosmetic changes are excluded. Format follows Keep a Changelog; versioning follows Semantic Versioning.

## [Unreleased]

### Added

- Suite Manager keeps technical detail out of the way until you ask for it. Package ids, digests, ports, volume names, generated configuration and raw logs are no longer shown on healthy screens; **Settings → Technical controls** brings them all back, per owner and off by default. Diagnostics on a screen that is reporting a failure stay visible either way, so a bug report can still quote them.
- Installed apps can now take environment variables you set yourself, under **Advanced details** in an app's **Settings** dialog. It is for values an app's own documentation asks for that MOS never knew to ask about — an upstream API credential, a feature switch — and it needs **Settings → Technical controls** switched on. Names MOS already manages are refused by name rather than silently ignored, hidden values are stored like any other app secret and never shown again, and MOS restarts the app and waits for it to answer: a value that stops it starting is rolled back to the previous environment on its own. Your variables survive app updates. **Compatibility:** a published privacy assessment describes an app as MOS ships it, so an app carrying your own variables says so on its posture panel.
- Own-hardware installs now work on machines with more than one internal disk, which the installer previously refused outright. It lists every disk large enough in a stable order and says what each already holds — `empty - no partitions`, or `NOT EMPTY` with the filesystems and labels it found — so the spare drive is distinguishable from the one with your photos on it. Only the disk you pick is touched; the confirmation names it and its contents again before anything is erased.

### Changed

- Installing an app now opens the same review dialog for every app in the catalog, replacing the **Prepare** panel some apps showed and the bare **Install** button the rest had. It lists whatever the app needs from you, the web address it will get, and whether to put a shortcut on Homepage. Apps that need nothing say so rather than installing on the first click.
- That dialog reopens as **Settings** once an app is running, and is no longer hidden behind technical controls. The values you gave at install are shown there as facts rather than editable fields: most are read only once, when the app first starts, so changing them afterwards would either do nothing or stop the app reaching its own data. Change them from inside the app itself.

### Fixed

- Updating MOS no longer leaves your browser running the interface from before the update. The Updates screen reloads itself once an update that changed the interface finishes, any other open tab offers a **Reload**, and the Suite Manager page is no longer cacheable, so a reload can no longer hand back the old version.
- The own-hardware installer no longer turns a mistyped answer into a silent non-install. It numbers the choices, takes the erase confirmation as a separate step, and asks again on anything it does not recognise. Previously any answer other than exactly `YES` — a lowercase `yes` included — continued booting from the USB stick and brought the suite up there, which looked like a finished install on a machine that stopped booting the moment the stick came out. A machine running from the stick now says so on its console instead of reporting itself installed, and the stick is no longer expanded to fill itself, so it stays usable as an installer.

## [0.18.0] - 2026-08-17

### Added

- A home-server install now has two ways in, and the screen shown when the install finishes offers both: `http://home.mos.home`, which needs a `*.mos.home` rule in your own router or Pi-hole, and `http://home.<your-lan-ip-with-dashes>.local.myownsuite.org` — for example `home.192-168-123-45.local.myownsuite.org` — which needs nothing set up on any device. Installed apps answer under whichever you use, neither address is a setting, and dashboard tiles now open the app through the address you arrived on instead of the one that installed it. **The second address sends DNS lookups for your app subdomains to MOS-operated nameservers, which do not log queries; the first never involves MOS infrastructure.** It contains your server's LAN address, so set a DHCP reservation — both addresses need one, and if it changes, saved links and app addresses break until each app is applied again. Applying your own domain with HTTPS stops the second address being served, and cloud/VPS installs are unaffected.
- App packages can declare what each of their services needs to run — memory and CPU at rest, and at peak where a service has heavy work to do — and the Resources view shows the figures beside the existing light/medium/heavy band. Radicale and Stirling PDF declare them first; apps without figures read as before. **Compatibility:** `resources.services.<id>.requires` is an optional addition to manifest generation 1 that older releases ignore, so packages using it require this release.
- **Actual Budget**: envelope budgeting, one service and one volume. Sets its own password on first open; connects to no bank unless you add sync credentials.
- **Paperless-ngx**: searchable scanned documents, OCR on your own server in the language chosen at install (EN/NL/DE/FR/IT/ES). Cloud AI, remote OCR and its own update check are off. Rated "Private by default" — no outbound traffic observed.

### Changed

- Installing on your own hardware now uses a prebuilt disk image (`.img.xz`, ~2 GB) instead of an ISO installer: the machine is installed and boot-tested in the release pipeline and you flash the finished result, so first boot downloads nothing and takes minutes instead of 15–30. **Compatibility:** the target machine must boot in UEFI mode and have a single internal disk — it names the disk it found and asks you to type `YES` rather than erasing anything on its own. Existing servers are unaffected and the ISO is no longer published.
- Servers installed from the image now show a My Own Suite login message instead of Ubuntu's. Canonical's version advertised Ubuntu Pro, printed a package-update count that contradicted the Updates screen, and fetched news from `motd.ubuntu.com` on a timer — an outbound call no owner asked for. The image still states plainly that it is built from Ubuntu and is not a Canonical product.
- Privacy labels reworked around one question: does anything leave your server, and who decided. New "Your choice" label where an in-app setting stops it; "External dependency" now means nothing can, and that MOS accepted the trade. Labels link to the full published assessment. Seafile → "Private by default"; Vaultwarden → "Your choice" (fetches website icons; Settings → "Show website icons" stops it). No grade moved. **Compatibility:** the assessment format changed, so all eight packages ship patch updates requiring this release. Update MOS before apps — older installs are not offered these versions rather than failing partway.
- Immich's privacy assessment redone from network captures: "Privacy configured" → "External dependency". The map requests tiles from Immich's tile service, which logs tile, IP and timing, and MOS pins the config so it cannot be disabled; photo coordinates are never sent. Version check goes to version.immich.cloud, not GitHub.
- Immich package 0.5.0 updates Immich to v3.1.0; its health check now targets an endpoint Immich serves. **Migrations are forward-only — no downgrade after this applies.** Live Photos uploaded in the background on the previous version may lack thumbnails until Immich's "missing" job runs.
- Catalog packages name the full set of products they replace, and app search matches them: "onedrive", "lastpass" and "ynab" find the right app.
- Vaultwarden and Stirling PDF show screenshots before install. Patch update; no runtime change.
- The app list shows each app's one-line summary instead of the opening paragraph of its full description, which had turned the catalog into a wall of text; the full description still opens with the app. Radicale, Seafile, Stirling PDF, ONLYOFFICE and Vaultwarden ship plainer summaries to match, and Stirling PDF moves from "Light" to "Medium" resources, which its declared figures now back up.

### Fixed

- The Apps screen now reliably picks up new apps and versions. Its background catalog fetch rejected itself as "too soon" if Apps had been opened in the last 30 seconds, and never retried after a failure, so the list could sit stale for hours.
- Backing up to an exFAT or NTFS drive no longer fails with "EPERM: operation not permitted, chmod ...". The snapshot is now built on the system disk and only the finished archive written to the drive. Affected every installation with apps; the backup failed rather than producing an incomplete bundle.

## [0.17.0] - 2026-08-08

### Added

- Seafile now enables its WebDAV extension: WebDAV-capable clients (for example the ONLYOFFICE mobile apps) can connect at `https://seafile.<your-domain>/seafdav` using Seafile account credentials.

### Changed

- The app package manifest is now a locked, versioned contract (generation 1). Manifests declare `manifestVersion: 1`, unknown fields are ignored instead of sometimes rejecting the package, every `${…}` template reference is validated against the fields it names, and a published JSON Schema (`apps/manifest.schema.json`) plus `npm run apps:manifest:check` let package authors validate without running MOS. All six catalog packages ship a patch update migrated to the locked shape (`catalog.replaces` is now a list, redundant route ports and dead onboarding metadata removed); the migrated packages require this MOS release or newer.

## [0.16.1] - 2026-08-08

### Changed

- The hosted one-line installer installs the latest published release instead of the tip of `main`, so both installer paths now start on the same release commit. Cloud installs previously picked up unreleased commits while still reporting the last release version.

### Fixed

- Installing an app whose images take more than three minutes to build no longer fails with "App runtime apply timed out". The app was in fact running — Suite Manager had stopped waiting and lost track of it. ONLYOFFICE hit this on a small server; an app left stuck this way recovers by running its install again.

### Security

- USB-installed servers no longer expose an unauthenticated endpoint that wipes the suite. It deletes every installed app's containers and volumes, and was enabled on published installer images, so any device on the same network could have triggered it. It is now confined to the disposable test-VM build profile, and a release build fails if a publishable image carries it. Machines installed from the v0.16.0 image close the endpoint when they take this update; reinstalling is not required.

## [0.16.0] - 2026-08-07

### Added

- Onboarding requires accepting the terms of use before the owner account is created.
- Settings can change the owner password. It verifies the current password, then signs every other browser out — the way to replace a password first set over plain HTTP on own-hardware and local installs.

### Changed

- Suite Manager's menu combines Dashboard and Customize into one row.
- Customize saves in one click. Validation runs as part of saving rather than as a separate button, and the reload button is replaced by a reload offered only when the file changed underneath the editor.
- The welcome screen adapts to whether any apps are installed.
- An installed app with an update waiting leads with **Review update**; opening the app stays beside it.
- App setup forms can prefill values from the owner profile (`${owner.name}` / `${owner.email}` manifest defaults), on install and when an update asks for newly required values. Radicale 0.4.0 uses this: the username prefills with the owner email and a new "Calendar name" field names the seeded calendar in connected clients — replacing the bare "default-calendar" slug phones showed, which invited deleting and recreating the calendar and silently broke the dashboard widget.
- Fresh installs resolve the control plane's dependencies with `npm ci` instead of `npm install`, matching what managed updates already did. Installs now use the committed lockfile exactly and fail fast if it and `package.json` disagree.

### Fixed

- A new Radicale install no longer shows a broken Homepage calendar widget. Homepage treats a feed with no entries as an error, so the package now seeds a yearly "Your independence day" event dated the install day. Existing calendars are untouched.
- Dialogs and action menus opened from app details now centre on screen and frost correctly.
- USB installer hardening: the installed server keeps its own hostname, the Ubuntu install phase no longer needs network access (first boot still does), the success screen shows the server's LAN IP with the local DNS override to add, and the ISO carries a `MOS-INSTALLER` volume label.
- The Vaultwarden package moves to server 1.37.0, restoring vault sync for Bitwarden clients 2026.7.0 and newer.
- Homepage customization now supports one level of nested service groups (sections inside a category), as Homepage itself renders and as MOS1 layouts used. Previously nested entries were silently accepted but ignored: their home-service Caddy routes were dropped on save and their metadata skipped validation. Guided add/remove and app URL reconciliation now reach entries inside subgroups too.

### Security

- The USB installer no longer decides the server's console password when the ISO is built. The autoinstall ships a locked account, and the installed machine generates its own login on first boot. The password is shown on the server's own screen and handed over once in Suite Manager, which deletes it as soon as the owner confirms they saved it — so it exists only on the machine that uses it. This replaces both the committed placeholder hash that briefly owned the account during install and the `MOS-server-login.txt` file written beside the ISO. **Anyone who has shared a built ISO should treat its machine password as public and change it.** Setting `LINUX_PASSWORD` still pins a password for a lab machine you own, and an ISO built that way must not be shared.

## [0.15.0] - 2026-07-25

### Added

- My Own Suite is now officially licensed as free and open-source software under the GNU Affero General Public License v3.0 only.

## [0.14.0] - 2026-07-24

### Added

- Every official catalog app now carries a published MOS privacy assessment. Immich, ONLYOFFICE, Vaultwarden, and Seafile are graded B ("Privacy configured"), while Radicale is graded A ("Private by default"). Their package versions were bumped so existing installations receive the assessments through ordinary app updates.

### Changed

- Suite Manager's app detail view now puts status, screenshots, privacy posture, resources, connections, and owner-relevant information first, with low-level diagnostics kept under Advanced details. App packages can now ship screenshots through the authenticated package API.
- Cloud owner setup now asks for the one-time claim key before account details when a setup link is incomplete, accepts the full printed key line, and allows a mis-copied key to be replaced. Owner setup also requires password confirmation.
- Privacy posture is presented as an A-to-D grade instead of a 0–10 score throughout Suite Manager and update review.
- The installer now prints one correct finish-setup link: cloud installs show only the claim-key URL required to create the owner account.
- Optional catalog and advisory refreshes now run quietly in the background. The Apps screen uses the signed catalog bundled with the release and no longer interrupts owners when a network refresh is stale or unavailable.
- Suite Manager's first-run screen now guides owners through installing an app, adding it to Homepage, and creating a backup. App connections use a clearer visual with a direct Connect action.
- App update availability is now determined by package version and MOS compatibility. Package contents must change version, downloaded updates remain verified against the signed catalog digest, privacy-assessment metadata no longer blocks official updates, and incompatible updates are explained in app details without an actionable badge.

### Fixed

- Catalog refresh now accepts a valid `304 Not Modified` response while continuing to reject actual redirects.
- Newly installed apps no longer show false catalog-integrity conflicts when the local checkout and catalog branch are at different commits.

### Compatibility

- Catalog package versions are Immich 0.4.0, ONLYOFFICE 0.2.0, Radicale 0.3.0, and Seafile, Stirling PDF, and Vaultwarden 0.2.1. Radicale also updates to 3.7.6.

## [0.13.0] - 2026-07-21

### Changed

- The Stable update track can now apply tagged releases. Fresh installs default to Stable, named-branch checkouts continue following their branch, and branch-track updates land exactly on the tracked remote branch even after rewritten history.

## [0.12.0] - 2026-07-21

Milestone release: My Own Suite is now an app platform instead of a fixed suite, with versioned and signed app packages managed individually through Suite Manager.

### Added

- Added browser owner setup, an authenticated Home/Suite Manager control plane, manifest-driven app lifecycle management, Homepage customization, private-LAN and public-VPS HTTPS, whole-suite backup and restore, and managed platform updates.
- Added independently versioned app packages with validated snapshots, preview, build, health-check, activation, rollback, recovery, and lifecycle handling. External Git packages use the same constrained pipeline and remain visibly **External · Unverified**.
- Added MOS Privacy Posture with evidence, provenance, freshness, per-dimension findings, and an explicit unrated state.
- Added hosted stable and development installers, a zero-configuration USB installer, and cloud and local installation paths.
- Added packages for Stirling PDF, Vaultwarden, Radicale, Seafile, ONLYOFFICE, and Immich, including setup fields, secrets, multi-service runtimes, Homepage projections, and Seafile/ONLYOFFICE integration.

### Changed

- App installs and updates retain the exact validated package snapshot. Update review shows permissions, privacy changes, migrations, downtime, backup requirements, and breaking changes before applying the reviewed digest.
- Uninstall confirmation now clearly distinguishes permanent removal of app resources and data from stopping an app while retaining its data.
- Whole-suite backup and restore now use schema version 3 with owned-resource inventory, database-consistent snapshots, size accounting, preflight bundle checks, uploaded-bundle validation, operator notes, and interruption recovery. Restore reconciles resources created after the backup, preserves one rescue generation, verifies the restored inventory, checks disk space, and refuses ambiguous or unsafe destinations. Version 2 bundles remain restorable.
- Managed platform reconciliation refreshes Suite Manager, Caddy wiring, Homepage, systemd units, and repo-owned host agents without rebuilding installed apps. Main and Staging branch tracks are selectable; installed apps continue updating separately from their retained package snapshots.

### Fixed

- Hardened app update interruption and rollback recovery, integrated-app updates, disabled and concurrent lifecycle handling, external app identity and configuration, orphan reporting, privacy-review validation, bounded backup hashing, image cleanup, and runtime status reporting.
- Public-cloud owner setup now uses trusted HTTPS, a root-only one-time claim secret, secure cookies, and firewall configuration.
- Fixed DNS-01 and Homepage route reconciliation so MOS-owned links follow the active domain without rewriting user-authored links, and managed updates retain installed Home and state paths.

### Security

- Official catalog and advisory files now require offline Ed25519 verification against the key shipped with the release; invalid or missing signatures fail closed.
- External packages are rejected before build or apply when they request unsafe privileges or undeclared capabilities. Downloads use immutable revisions with bounded time, redirects, size, file count, extraction, canonical paths, and concurrency.
- Added bounded progressive login throttling by client and account, trusted-proxy handling, `Retry-After`, and secret-free security aggregates with retention limits.

### Compatibility

- Removed the temporary generation label from MOS-owned environment variables, runtime paths, services, sockets, containers, and backup folders. Prototype environments should be reset before validation.
- MOS paths now live at the repository root, and the control-plane URL moved from `suite-manager.<domain>/setup/` to `home.<domain>/suite-manager/`.
- The app-agent contract is version 9. Manifests may constrain `amd64` and `arm64`; backup schema 2 rejects pre-snapshot bundles; external routes use `ext-<host>`; and releases require matching signed catalog and advisory metadata.
- USB installer owner fields were removed. Owners are created in the browser, and each installer build generates a unique machine login password.

### Known limitations

- MOS is beta. Platform updates leave installed apps on their package snapshots; apps update separately.
- Backups are manual, whole-suite, unencrypted, destination-limited, and version-sensitive. Restore requires a compatible MOS installation, and rollback is not guaranteed across data migrations.
- External packages remain unverified; publisher-key verification and cryptographic replay prevention are not yet implemented.

## [0.11.0] - 2026-06-07

### Changed

- Added repo-owned self-host service and backup agents. Managed reconciliation now maintains their systemd units, sockets, tokens, and Suite Manager mounts, while compatibility wrappers preserve the former update-agent paths.
- Added offline whole-suite backup and restore with mounted local, removable, and network destination discovery, capacity and free-space checks, cold volume archives, bundle validation, rescue copies, persistent job state, and capability-driven Suite Manager controls.
- Update and backup actions are now capability-driven: managed controls appear only when their corresponding host agent advertises support.
- Homepage customization can validate and apply generated external Caddy proxy routes through the service agent or `npm run caddy:external-proxies:apply`, while explicit user-authored links remain untouched.
- Added Cloudflare DNS-01 HTTPS configuration through Suite Manager, using a shared `DOMAIN`, `PUBLIC_URL_SCHEME`, and `MOS_TLS_MODE` contract for Caddy routes and managed Homepage links.

### Compatibility

- Self-host reconciliation manages `mos-update-agent`, `mos-service-agent`, and `mos-backup-agent`, their `/run` sockets, `/etc` token files, and Suite Manager env/socket mounts.
- `SUITE_MANAGER_UPDATES_MODE` was removed from active configuration.
- Caddy now imports generated snippets from `deploy/vps/generated/caddy/*.caddy`; DNS-01 mode also uses `deploy/vps/services/caddy/.env` and requires HTTPS, a real domain, an ACME email, and a Cloudflare API token.

### Fixed

- Managed updates can recover when the only dirty file is the generated external-proxy Caddy snippet.
- Fixed onboarding clipboard feedback and hardened Vaultwarden onboarding against upstream UI changes.

## [0.10.0] - 2026-05-29

### Changed

- Updated application images and dependencies, including Seafile 13 and its native database, admin, and cache bootstrap settings.
- Replaced Seafile's Memcached service with Valkey and added a migration for existing installations.
- Improved self-host installer handoff so domain, Linux, and Suite Manager settings flow through one first-boot manifest, supported Ubuntu media can be fetched automatically, and installation remains human-confirmed.
- Added managed self-host updates through `mos-update-agent`, including update-track selection, job status, full profiled image rebuilds, container recreation, and obsolete-service cleanup without removing persistent volumes.
- Added named own-infrastructure migrations for compatibility changes during managed updates.
- Moved Homepage customization into Suite Manager-owned runtime config with allow-listed YAML, CSS, and JavaScript editing and validation.

### Compatibility

- The Seafile cache service is now `seafile-valkey`; cache configuration uses `CACHE_PROVIDER=redis` and `REDIS_*` variables instead of `MEMCACHED_*`.
- Self-host setup recognizes `UPDATE_TRACK` and `UPDATE_REF`, and managed installs use `SUITE_MANAGER_UPDATES_MODE=managed`.
- Homepage runtime config uses `HOMEPAGE_CONFIG_SYNC_TOKEN`; `services.yaml` remains generated from `services.template.yaml`.

### Fixed

- Fixed Vaultwarden startup when shared SMTP is disabled, Suite Manager startup with default Homepage runtime state, self-host owner and domain propagation, ONLYOFFICE startup with newer images, and PostgreSQL 18 volume layout for Vaultwarden.

## [0.9.0] - 2026-04-17

### Changed

- Hardened the single-USB installer so it requires explicit confirmation, carries the primary user into bootstrap, and starts the stack after setup.
- Added deployment-aware update status in Suite Manager, release metadata checks, and manual self-host/VPS update commands with preflight safeguards.
- Reworked onboarding into dependency-based tracks after Vaultwarden credential setup.
- Added optional shared SMTP configuration consumed by Seafile and Vaultwarden.

## [0.8.0] - 2026-04-10

Milestone release: MOS gained a validated self-host installation path on home-server hardware over LAN.

### Changed

- Added an Ubuntu 24.04 single-USB installer builder with a clearly destructive boot entry and a ready-to-flash output image.
- Hardened the default stack against third-party calls by removing remotely hosted fonts and Homepage icons, disabling Vaultwarden relay push, and disabling Stirling PDF analytics by default.
- Fixed Vaultwarden credential-import onboarding and a Suite Manager runtime syntax error.

## [0.7.0] - 2026-03-29

### Added

- Added the Ubuntu 24.04 self-host bootstrap path, canonical `appname.mos.home` and `appname.mos.<your-domain>` addressing, Cloudflare wildcard tunnel scaffolding, and unattended installation support.

### Changed

- Hardened the default stack against third-party calls by removing remotely hosted fonts and Homepage icons, disabling Vaultwarden relay push, and disabling Stirling PDF analytics by default.

### Fixed

- Fixed Vaultwarden credential-import onboarding so the flow advances after manual confirmation.

## [0.5.0] - 2026-03-24

### Changed

- Improved first-run credential handoff from Suite Manager to Vaultwarden.
- Changed the default Docker Compose project name to `mos`; generated networks and named volumes now use the `mos_` prefix instead of `vps_`.
- Hardened local cross-platform operation with simpler `*.localhost` routing and Windows-safe script and entrypoint line endings.

## [0.4.0] - 2026-03-18

### Added

- Added the authenticated Suite Manager control plane with persistent onboarding state and guided first-run setup.

### Changed

- Made Suite Manager the single control-plane entry point, with Homepage linking into `/setup/`.
- Improved onboarding with Vaultwarden-first setup, guided Radicale connection, clearer completion, and a direct return to Homepage.
- Replaced the bootstrap-token gate with owner email/password authentication and signed sessions. `BOOTSTRAP_TOKEN` was replaced by required `OWNER_PASSWORD` and `SESSION_SECRET`; `SUITE_MANAGER_URL` now requires the `/setup/` suffix.
- Removed `HOMEPAGE_PUBLIC_URL` from the Suite Manager contract in favor of `HOMEPAGE_URL`.
- Added shared owner and integration inputs for Suite Manager and changed local/VPS Vaultwarden routing to HTTPS.

## [0.3.0] - 2026-03-09

### Added

- Added the initial Suite Manager service with status reporting and Homepage health checks.

### Changed

- Reworked VPS/local setup around shared Suite Manager inputs and service-level env templates.
- Simplified `vps:init` and `vps:doctor` for the new template layout and removed legacy `.env.example` compatibility.
- Fixed `vps:rebuild` so clean-slate rebuilds remove profiled service volumes and auth state.

## [0.2.0] - 2026-03-08

### Added

- Added `vps:init`, `vps:doctor`, and `vps:up` for non-destructive VPS configuration and startup.
- Added generated and shared secret expressions plus derived Base64 values in env templates.

## [0.1.0] - 2026-03-04

First official release of My Own Suite, establishing the release foundation and initial Docker Compose application stack.
