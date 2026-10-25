# MOS Tests

Fast backend, migration, renderer, agent, and contract tests run with:

```powershell
cmd /c npm test
```

The MOS Playwright harness under `e2e/` builds the real frontend, starts Suite Manager with isolated temporary SQLite state, runs the pinned Homepage container on a private loopback port, and starts a test-owned local adapter behind the real Homepage agent contract. It has no auth bypasses or production-only test routes.

Install Chromium once, then run local E2E explicitly:

```powershell
cmd /c npm run e2e:install
cmd /c npm run e2e:local
cmd /c npm run e2e:local:headed
```

Local E2E covers owner setup, Customize navigation, invalid YAML, allowlisted editing, guided link/home-service apply, Homepage tile rendering, Settings validation, sign-out, and signed-out protection. It deliberately runs without privileged systemd/Caddy writes, Cloudflare, or DigitalOcean. Real Homepage-agent and DNS-01 validation is separate and documented in `scripts/README.md`.

## Lab E2E: steps, paths and app modules

The lab suite runs against a real, already-running MOS install, normally the Hyper-V lab. It never creates or destroys the VM. Start or reset the lab yourself first and wait for Suite Manager readiness. After a host PC restart, run `npm run smoke:hyperv:refresh` (Administrator terminal) first: the Default Switch subnet changes on every host boot, so the lab is unreachable until the guest IP and hosts entries are refreshed (details in `scripts/README.md`).

A run is a **path**: a sequence of **steps**, each a core module in `test/e2e/modules/` or an app's own module in `apps/<id>/e2e/`. Named paths are shorthand for common sequences, and steps can be added to them or used alone:

```powershell
cmd /c npm run e2e -- @full                       # the whole platform with every catalog app
cmd /c npm run e2e -- @app-cycle <app>            # back up, install, use, restore, prove it is gone, network check
cmd /c npm run e2e -- @app-dr <app>               # bucket backup, wiped lab, restore from the bucket, network check
cmd /c npm run e2e -- @update <app>               # journey, platform + app update, check, before/after and network reports
cmd /c npm run e2e -- @drive-drills <app>         # an NTFS drive pulled, checked, ejected, power-cut and restarted under the app
cmd /c npm run e2e -- @drive-dr <app>             # files on a drive + data in a disk backup: reset, restore, files found again; another server's copy taken over, erased, a drive forgotten, renamed, used again
cmd /c npm run e2e -- @drive-files <app>          # the files screen on the app's NTFS drive: browse, add, download, rename, move, delete; read-only, replugged, leftovers
cmd /c npm run e2e -- @app-cycle --each-app       # one run per catalog app, then a matrix
cmd /c npm run e2e -- reset owner install:<app> app:<app> verify:<app>
cmd /c npm run e2e -- --list                      # every step and named path
cmd /c npm run e2e -- --dry-run @full             # the resolved steps, no browser
cmd /c npm run e2e:full                           # the same as `e2e -- @full`
```

- Steps that need HTTPS for an app whose manifest declares `requirements.https` get a `dns01` step in front of them automatically; `--dry-run` shows where.
- The first install of an app that declares `storage` folders gets a `drive` step in front of it, which gives a lab with no usable drive a 2 GiB FAT32 image on a loop device (it needs the root shell below). Installs pick the lab's drive whenever the dialog offers one, so optional folders are tested too, and a journey reaches the drive through `drive.put(folder, file, name)`, which copies onto the drive the way an owner would from another computer, and `drive.replug()`, which starts the same unit udev starts when a drive is plugged back in.
- `@drive-drills` puts the app on an NTFS drive (`drive:ntfs` adds an NTFS loop image when none is offered) and drives it through `drive-pull`, `drive-check`, `drive-eject`, `power-cut` and `reboot`, running the app's `verify` after each. A real disk is pulled by deleting it from the kernel while mounted and brought back by a SCSI rescan, so udev starts the attach unit exactly as for a cable; a loop image is copied while mounted and swapped in. `power-cut` resets the lab through `/proc/sysrq-trigger` after a `sync`, so nothing is unmounted. On the Hyper-V lab the NTFS disk must come before any other usable drive, since an install takes the first one offered.
- `@drive-dr` is the storage story as a drill: the app's files on an NTFS drive and its data in a backup to the backup disk, then a reset lab is restored from that backup and the app's `verify` must find its files on the drive again. `drive-found` then plants another server's archive on a drive nothing uses, pulls and replugs it, and expects Storage to say what it holds and Backups to list it, with no claim made. `takeover` then clones that backup as another server would have left it — its restore points name another install, and only a fresh key opens it — and proves it is listed apart and locked, opens with that key but cannot be changed, and that restoring it makes this server that one, key and drive included. The owner's other storage actions follow, each from the screen an owner would use: `erase-other-archive` plants one more archive and erases it from **Backups from another server**, expecting it gone from the list and the drive while the archive it was copied from is untouched; `drive-away` backs up to a spare drive from **Back up now**, pulls it, and expects the drive and those backups gone from Storage and Backups and listed again as this server's when plugged back in; `rename-storage` renames the backup drive and a spare in Settings → Storage and expects the names in Backups and in the Back up now picker, then gives the spare its own label back with an empty name; `use-again` ejects the apps' drive and brings it back with **Use it again** on its row, expecting it ready read-write with its apps running. Each needs a second drive no app or backup uses, which a FAT32 loop image from an earlier `drive` step provides.
- `@drive-files` is the files screen on the app's NTFS drive. `drive-files` makes a folder, adds a multi-GB file while the connection is cut twice, downloads it back byte for byte, renames it, moves it and deletes the lot; `drive-files-read-only` pulls the drive without ejecting and expects its files to be browsable and downloadable while every change is refused; `drive-files-live` ejects the drive under an open files screen, which must close, and expects the screen to open again without a reload when the drive is plugged back in; `drive-files-leftovers` uninstalls the app and expects the folder it left to be listed last and greyed in the apps folder, deletable whole from its row.
- `@update` and `@app-dr` also install the catalog apps the app works with: those that export what its manifest's `integrations` accept, and those that accept what it exports. They are connected, used and checked alongside it, providers first, and only the named app is updated.
- Each run writes `test/e2e/results/<run>/`: `summary.json` (every step, its duration and any error), `state.json` (what the apps' journeys made), app screenshots under `shots/`, the compare report under `compare/`, the network report under `network/`, Playwright's trace, video and `error-context.md` under `playwright/`, and, when an app step fails, the app's own tabs as text under `failures/` (Playwright's error context shows only the suite's tab). The terminal shows one line per step and, on failure, the paths to all of these.
- `--continue <run>` carries an earlier run's app data and screenshots into a new run, so `verify:<app>` and `compare` work across runs: install and use an app, change the lab, then check it.
- `platform-update:wait` waits up to 40 minutes for the lab's update track to offer a new commit. The lab follows the branch it was installed from (`MOS_SMOKE_REPO_REF` at `smoke:hyperv:reset`), so pushing a commit to that branch while the step waits is how an update under test reaches the lab.

### App modules

Core test code names no app; a unit test enforces it. Everything particular to an app lives in its package at `apps/<id>/e2e/index.mjs`, whose default export is:

- `journey({ page, url, env, state, make, shot, step, freshPage, setup, drive })`: what an owner does in the app on a fresh install: sign in or register, create real data, and remember in `state` what `verify` will look for.
- `verify(...)`: that data is still there, after a restore, an update or a move to another domain.
- Optional: `network` (the hosts the app may contact, see below), `landed({ page })` (the app's page has loaded), `setupValue({ field, env })` (a value for an install dialog field), `secrets({ env })` (values the diagnostics check must never find), `masks(page)` (regions to hide in screenshots), and `showcase` (which site screenshots the app volunteers for).
- `shot(name)` takes a named screenshot. The same name taken in a later step pairs with it in `compare`. `make.pdf()`, `make.png()`, `make.video()` (a short WebM recorded from a canvas) and `make.text()` draw test files at run time, so nothing binary is committed. `freshPage()` is a browser with nothing stored, as a new device would be. `connected` lists the app's own integration slots (from its manifest) that another installed app currently fills, so a journey can test working together without naming the other app.

### Network capture

A path that holds the `network` step captures, from its first step, what every app contacts outside the suite, and the step fails on anything the app's module does not expect. The app paths (`@update`, `@app-dr`, `@app-cycle`) all end with it.

- **Server:** over SSH as root on the lab, every DNS lookup an app container makes (read inside the container, since Docker forwards lookups from the host) and every new connection it opens to a public address (read on the Docker bridges, which exist before the container starts). Each app container first gets a control lookup and connection to `example.com`. A container whose control does not show up fails the step, so silence is a measurement.
- **Browser:** every request any page makes to a host outside the suite, credited to the app whose address the page is on.
- **Expected hosts:** the `outbound` list in the app's `privacy-review.json`: each host (exact, `*.domain`, or `*` for any host), whether the server or the browser contacts it, why, and who receives it. Owners read the same list in Suite Manager and on the site, so the step checks the public claim itself. An empty list means the app may contact nothing. In `@update`, hosts seen only before the update are reported but not held to the new review.
- **Report:** `network/report.md` lists each app's hosts, where they came from and in which steps. In `@update` it also shows whether each was seen before the update, after it or both, and calls out the hosts that are new after the update. The platform's own traffic is listed but not checked. Raw captures stay in the ignored results folder.
- **Limits:** it decrypts nothing, sees only what the run made the apps do (a journey that never opens a map never meets the map's hosts), and reads IPv4 only.

A package's `e2e/` folder is never package content: it is not digested, copied into an installed app, or downloaded with a catalog update, so editing a test never changes the package version.

### Configuration

Create a local ignored config file before running:

```powershell
Copy-Item test\e2e\.env.example test\e2e\.env
```

- `MOS_E2E_BASE_URL`: the Home origin, for example `http://home.mos.hyperv`.
- `MOS_E2E_OWNER_EMAIL` and `MOS_E2E_OWNER_PASSWORD`: used to create the owner on a fresh install or sign in on an existing one.
- `MOS_E2E_OWNER_CLAIM_TOKEN`: the one-time owner setup key a cloud install asks for, from `/etc/mos/secrets/owner-claim.env` on the server.
- `MOS_E2E_DNS01_BASE_DOMAIN` and `CLOUDFLARE_API_TOKEN` (never commit it): the Cloudflare-managed domain the `dns01` step moves the suite to.
- `MOS_E2E_LAB_VM`: the Hyper-V VM's name. The default switch may lease the lab a new address when it restarts, and the Easy Door name follows the address; with the name set, the `reboot` and `power-cut` steps ask Hyper-V where the lab went and the run follows it. Without it, a run whose lab moved waits for the old address and fails.
- `MOS_E2E_HOST_RESOLVER_RULES`: Chromium host-resolver rules for the test browser, such as `MAP *.hyperv.lab.example.site 172.25.191.202`, for a Hyper-V lab whose address moved when the hosts file cannot be rewritten without an elevated shell.
- `MOS_E2E_SECRETS_COMMAND`: a command that prints `KEY=value` lines, whose output joins the environment below anything set in `.env`. It keeps lab keys out of files.
- App credentials have defaults in each app module and can be overridden with that module's own variables, such as `MOS_E2E_RADICALE_PASSWORD`.
- `MOS_E2E_LAB_SSH` (`user@host`, or `local` when the tests run on the lab itself) and `MOS_E2E_LAB_SSH_KEY`: a root shell on the lab for the network capture (`sudo -n` must work). The Hyper-V lab needs neither: `smoke:hyperv:reset` bakes in the key it makes at `.mos-smoke/lab-ssh/id_ed25519`, which also gives the lab user passwordless `sudo`, and runs use `mos@` the Home host with that key.
- `backup:bucket` and `restore:bucket` use only the disposable lab bucket, whose `MOS_LAB_S3_*` values come from the environment (such as `MOS_E2E_SECRETS_COMMAND`), each run in a folder of its own.
- `MOS_E2E_BACKUP_TO=bucket`: a plain `backup` or `restore`, as in `@full`, uses the lab bucket, for a lab with no backup disk. `scripts/smoke/local-lab.cjs` sets it, since the machine it runs on is the lab.

Before DNS-01 runs, Windows must resolve both the bootstrap hosts, such as `home.mos.hyperv`, and the post-DNS-01 hosts, such as `home.hyperv.lab.my-demo-domain.site`, to the Hyper-V guest IP. `smoke:hyperv:reset` writes both sets into the marked hosts block and flushes DNS automatically. If you use another DNS-01 lab domain, set `MOS_HYPERV_EXTRA_HOST_DOMAINS` before reset or add equivalent local DNS/hosts entries yourself.

Site screenshots are captured best-effort by the `marketing` step and during installs into the ignored `test/e2e/screenshots/` folder, harvested by `npm run screenshots:update` (see `scripts/README.md`). A failed capture logs a warning and never fails the run.

Lab reset behavior:

- `smoke:hyperv:reset` installs a root-owned `mos-lab-reset-agent.service` only for the USB/Hyper-V front door and enables Suite Manager's lab reset endpoint with `MOS_LAB_RESET_ENABLED=1`.
- The endpoint schedules the reset internally, returns immediately, and then the agent clears Suite Manager state, Homepage edits, app routes, app containers, app networks, and app Docker volumes before restarting the control plane.
- Non-lab installs render the same code but keep `MOS_LAB_RESET_ENABLED=0`, so `/suite-manager/api/lab/reset` returns `LAB_RESET_DISABLED`.

Troubleshooting:

- If app routes fail to resolve after a VM reset, open Suite Manager's Apps page and copy the Hyper-V hosts repair command from Advanced details, or rerun the Hyper-V reset harness that writes the hosts block.
- If DNS-01 succeeds but HTTPS Home does not load from Windows, confirm local DNS points `home.<base-domain>` and app subdomains at the VM LAN IP.
- If Backup is skipped, confirm the Hyper-V smoke VM has the second backup disk mounted at `/media/mos-backup` and the backup agent is running.
