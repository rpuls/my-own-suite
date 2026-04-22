# Self-Host Managed Updates MVP

This document tracks the first proof-of-concept slice for managed self-host updates.

## Goal

Validate that a USB-installed self-host machine can expose a host-owned updater service that Suite Manager can detect and trigger safely, without giving the Suite Manager container direct host control.

This MVP is intentionally narrow:

- self-host only
- host-managed updates only
- no backup implementation yet
- no rollback automation yet
- no public network API
- no Railway behavior changes
- no zero-downtime orchestration

## Product Shape

Desired user experience:

1. Suite Manager detects that this installation supports managed updates.
2. Suite Manager clearly shows which update track this machine is following.
3. The Updates screen offers `Update now`.
4. Clicking the button starts a host-side update job.
5. The suite may go offline while containers rebuild and restart.
6. Suite Manager comes back and shows the new installed version.

Examples of track labels:

- `Stable releases`
- `Staging branch`
- `Feature branch: feat/selfhost-managed-updates-mvp`

## Architecture Direction

Core components:

- `Suite Manager` remains the authenticated UI and API frontend.
- `MOS update agent` runs on the self-host machine under systemd.
- `MOS update worker` performs the real host-side update steps.
- `scripts/mos-updater.cjs` remains the current update engine foundation and should be reused rather than replaced outright.

Security boundary:

- Suite Manager must not update the host directly.
- The host exposes a controlled local updater interface.
- The first implementation should use a Unix socket plus a shared bearer token.
- The updater interface must not be exposed publicly on the LAN or internet.

## Proposed Repo Layout

Planned isolated workspace:

- `update/selfhost/agent/`
- `update/selfhost/systemd/`
- `update/selfhost/docs/`
- `update/selfhost/state/`

Likely first files:

- `update/selfhost/agent/mos-update-agent.cjs`
- `update/selfhost/agent/mos-update-worker.cjs`
- `update/selfhost/systemd/mos-update-agent.service`
- `update/selfhost/docs/selfhost-managed-updates.md`

## MVP Scope

Included:

- new update mode support for `managed`
- explicit self-host update track support for `stable` and `branch`
- host-side updater agent for self-host installs
- local-only transport from Suite Manager to the host updater
- one update job at a time
- progress/state persisted on disk
- UI support for `Update now` when the service is available
- UI visibility into which track the machine is currently following
- safe proof-of-concept update flow that preserves Docker volumes

Not included:

- backups
- automated rollback
- scheduled updates
- cancel/resume
- service-by-service selective updates in the UI
- VPS managed mode
- Railway-managed apply actions

## Release Track Advice

For this feature, the updater should support two update tracks:

- `stable`: follow published releases/tags
- `branch`: follow the configured branch head

Recommended behavior:

- production `main` installs should use `stable`
- development and validation installs can use `branch`
- `branch` mode should be able to follow `staging` or a feature branch for real-machine testing before merge/release

Reason:

- the updater model is release-oriented
- stable tags are a safer contract than a moving branch
- development still needs an honest way to validate updates before merge and release

Proposed config shape:

- `MOS_UPDATE_TRACK=stable|branch`
- `MOS_UPDATE_REF=main|staging|feat/...`

The current track should always be visible in the Updates UI so users understand what they are subscribed to.

## Phase Plan

### Phase 0 - Planning and repo isolation

Deliverables:

- isolated `update/` workspace
- this plan document
- initial changelog entry

Validation:

- repo structure is in place
- MVP scope and non-goals are explicit

### Phase 1 - Refactor updater foundation

Goal:

Make the existing updater logic reusable by a future agent instead of only being a CLI entrypoint.

Expected work:

- extract shared update functions from `scripts/mos-updater.cjs`
- keep existing `npm run update:*` commands working
- define structured progress/state output
- define track-aware update detection for both `stable` and `branch`

Validation:

- `npm run update:check`
- `npm run update:status`
- manual dry-run review of the extracted update engine shape

Stop gate:

- do not proceed until the CLI still behaves like before

### Phase 2 - Host update agent proof of concept

Goal:

Expose a local-only host service that can report status and start an update job.

Expected work:

- add a small Node-based host agent
- add a persisted state directory and lock handling
- add systemd service/socket units
- support endpoints for status, start job, and job polling

Validation:

- local service smoke test on Linux/self-host target
- verify only one job can run at a time
- verify state survives agent restart
- verify the agent can be installed by the self-host bootstrap path instead of only manually

Stop gate:

- do not wire Suite Manager to it until the host service works in isolation

### Phase 3 - Self-host bootstrap integration

Goal:

Install and enable the updater agent automatically on USB/self-host installs.

Expected work:

- extend self-host bootstrap scripts
- create/update token and state directories
- install systemd unit files
- enable the updater socket
- set self-host installs to the new managed mode

Validation:

- fresh bootstrap on test machine or VM
- confirm agent is installed and reachable after first boot
- confirm existing stack still starts normally

Stop gate:

- do not add UI apply actions until bootstrap-managed installs are proven reachable

### Phase 4 - Suite Manager integration

Goal:

Teach Suite Manager to detect the managed updater service and proxy update actions to it.

Expected work:

- extend updates status payload
- add backend proxy routes for apply and job polling
- add frontend managed-update states and `Update now`

Validation:

- frontend loads normally in notify-only mode
- frontend shows manual/managed states correctly
- managed mode can start and poll a real job

Stop gate:

- do not attempt end-to-end update testing until polling and service detection are stable

### Phase 5 - End-to-end update proof

Goal:

Prove that a self-host install can update to a newer target version and come back online with preserved data volumes.

Expected work:

- define a safe branch/tag-based test strategy
- trigger update from Suite Manager
- observe downtime and recovery
- verify installed version changed

Validation:

- Suite Manager comes back after the update
- the reported suite version changes to target version
- named volumes remain intact
- at least one real app data path is preserved after update

## Testing Strategy

We should avoid testing after every tiny change. Instead, use phase gates.

Recommended balance:

- lightweight checks during refactors
- one isolated host-agent smoke test before UI wiring
- one bootstrap integration test after installer wiring
- one real end-to-end update proof before merging toward `staging`

### Fast checks between phases

Use these often:

- targeted file/code review
- `npm run update:check`
- `npm run update:status`
- local Suite Manager smoke check for updates UI rendering

### Slower checks reserved for milestones

Use these only at phase boundaries:

- fresh self-host bootstrap on VM or spare machine
- managed update agent installation verification
- real update from one release candidate target to another

## Safe Development Update Path

We need a way to test updating without depending on `main` releases.

Recommended approach:

1. Build the feature on a dedicated branch.
2. Build the USB installer so the test machine follows that branch:
   - `MOS_UPDATE_TRACK=branch`
   - `MOS_UPDATE_REF=feat/selfhost-managed-updates-mvp`
3. Validate that the machine can detect newer commits on that branch and update to them.
4. Separately keep `stable` mode for the eventual production path on `main`.

Why this is the best balance:

- testing does not require publishing official releases
- staging and feature branches can be validated on real hardware before merge
- production still keeps a cleaner release-oriented contract
- the same updater service can support both tracks with different detection logic

Open question for implementation:

- whether branch mode should compare against the remote branch HEAD directly
- or whether branch mode should be limited to fast-forwardable tracked refs only

Current recommendation:

- MVP should support direct branch-following for self-host development machines
- stable release-following remains the intended production path

## MVP Exit Criteria

This MVP is successful when all of the following are true:

- a self-host install can expose a managed updater service
- Suite Manager can detect that service
- Suite Manager can start an update job through that service
- the host can update to a newer tagged version
- the stack returns after downtime
- persistent Docker volumes are preserved
- Railway behavior remains notify-only

## Roadmap After MVP

Later improvements:

- backup-before-update
- health-based rollback
- richer job logs and progress details
- release channel controls
- branch-switching from the UI, similar to hosted platforms, so development installs can intentionally move between branches without manual SSH/git steps
- VPS compatibility path
- better recovery after interrupted updates
