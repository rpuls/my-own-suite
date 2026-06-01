# Homepage-Driven MOS Proxy Annotations Plan

> Temporary feature-branch planning artifact for `feat/homepage-proxy-annotations`.
>
> This document is intentionally temporary. Delete it before merge, or replace it with smaller durable updates in the right long-lived homes.
>
> - Durable architecture decisions belong in `docs/decisions.md`.
> - Task tracking should move to GitHub Issues using `.github/ISSUE_TEMPLATE/codex-task.yml`.
> - The previous `docs/roadmap.md` file has been retired; roadmap-like task state should live in GitHub Issues.
> - This file exists so the design can survive multiple chat sessions and context windows while the branch is active.

## 1. Product Vision

MOS should evolve into a self-hosting hub where users can manage both integrated MOS apps and externally hosted services from one friendly control plane.

The long-term experience should support:

- Installing, removing, and configuring integrated apps from a curated MOS app catalog.
- Adding external services such as Home Assistant, TrueNAS, NAS apps, switch/router/access-point UIs, lab services, or apps running on another machine.
- Showing those external services on the Homepage dashboard.
- Optionally exposing those external services through MOS-owned Caddy routing with friendly HTTPS subdomains.
- Keeping MOS responsible for the application routing layer while treating routers, firewalls, DNS resolvers, Tailscale, OPNsense, Unbound, and similar tools as external network infrastructure.
- Supporting private/internal-first deployments without assuming public exposure.
- Eventually supporting DNS-01 certificate flows so users can get real certificates for internally resolved hostnames without public inbound access or public A records pointing home.

Example end state:

```text
homeassistant.home.example.com -> http://192.168.30.4:8123
truenas.home.example.com       -> https://192.168.30.3
switch.home.example.com        -> https://192.168.20.2
```

The public domain may be real, but DNS records for these hosts may exist only internally through split DNS.

## 2. Core Decision

Homepage YAML remains the user-facing dashboard and layout source of truth.

MOS should not introduce a full proprietary service registry as the first source of truth. Homepage and Caddy are established tools with known formats, docs, examples, and community knowledge. Tech-savvy users can already configure Homepage YAML directly and ask tools like ChatGPT for help with standard Homepage syntax. Non-technical users should eventually use a polished Suite Manager flow that writes the safe subset for them.

The chosen direction:

- Homepage YAML owns layout, grouping, order, titles, descriptions, icons, widgets, and dashboard visibility.
- MOS adds small optional `mos` metadata annotations to Homepage service tiles only where Homepage lacks service/proxy semantics.
- Caddy generation reads those `mos` annotations.
- Suite Manager later edits a safe subset of Homepage YAML plus `mos` annotations through add/edit flows.
- Advanced users can still edit Homepage YAML directly and use existing Homepage docs/community/tooling.

Guiding wording:

> Homepage owns layout. MOS annotations add proxy/service semantics. Suite Manager manages common service-add/edit flows without rebuilding the full Homepage layout editor.

## 3. Current Architecture Notes

Current repo facts relevant to this work:

- Suite Manager owns persisted Homepage runtime config.
- Homepage fetches Suite Manager-owned config at startup through `/setup/api/homepage-config/export`.
- `services.template.yaml` is the editable source for service tiles.
- `services.yaml` is generated output and must not be manually edited.
- The current Homepage config generator replaces `${ENV_VAR}` placeholders and prunes tiles with unresolved placeholders.
- Caddy currently uses static `deploy/vps/Caddyfile` config mounted read-only into the Caddy container.
- The self-host service agent already exposes narrow restart capability for `homepage` and `caddy`.
- Built-in MOS routes and default domain behavior must keep working throughout this feature.

Current important compatibility surfaces:

- `*.localhost` local development behavior.
- `*.mos.home` self-host/LAN behavior.
- Configured `DOMAIN` behavior for own-infra installs.
- Existing static Caddy routes for built-in apps.
- Existing Homepage runtime config customization through Suite Manager.

## 4. Proposed Annotation Shape

MVP proxy metadata lives inside a Homepage tile under `mos`.

```yaml
- Home:
    - Home Assistant:
        href: https://homeassistant.home.example.com
        description: Smart home control
        icon: home-assistant
        mos:
          kind: external
          proxy:
            enabled: true
            upstream: http://192.168.30.4:8123
            tls:
              insecureSkipVerify: false
```

Rules:

- `href` remains the user-facing dashboard URL.
- For proxied services, Caddy host is inferred from `href`.
- `mos.kind` is `external` for the MVP.
- Built-in/integrated app annotations can wait until later phases.
- `mos.proxy.enabled: true` opts the tile into Caddy generation.
- `mos.proxy.upstream` is required when proxy is enabled.
- `mos.proxy.tls.insecureSkipVerify` is optional and defaults to `false`.
- No raw Caddy directives are accepted in annotations.

This deliberately keeps the extension small. Normal Homepage config remains normal Homepage config; MOS-specific fields appear only when a service needs MOS-managed proxy behavior.

## 5. Validation Rules

Validation must be strict and predictable before anything is ever applied to Caddy.

Required validation behavior:

- `href` must parse as an absolute `http` or `https` URL when used for proxy generation.
- Generated Caddy host is taken from `href.hostname`.
- `mos.proxy.upstream` must parse as an absolute `http` or `https` URL.
- Empty hosts are rejected.
- Wildcard hosts are rejected in service annotations for the MVP.
- Malformed URLs are rejected.
- Unsupported protocols are rejected.
- Duplicate proxy hostnames are rejected.
- User-supplied raw Caddy config is rejected.
- Unknown non-MOS Homepage fields are preserved.
- Tiles without `mos.proxy.enabled: true` are ignored by Caddy generation.
- Parsing supports nested Homepage groups, sections, and columns.

The parser should collect useful validation errors instead of failing opaquely. The generated Caddy preview should be unavailable or clearly marked invalid when validation fails.

## 6. Caddy Generation Direction

Initial implementation should generate a preview only. It must not write, reload, or restart Caddy yet.

Later implementation should:

- Write or expose a generated Caddy snippet.
- Add an import strategy to the base Caddyfile.
- Keep static built-in Caddy routes until generated routing has proven itself.
- Map external hostnames to upstream targets with optional upstream TLS verification skipping.
- Generate deterministic, stable, easy-to-inspect Caddy output.
- Use the host service agent for Caddy reload/restart on self-host installs.
- Avoid assuming writable Caddy config or host-agent capability on Railway/managed deployments.

Example generated route:

```caddyfile
homeassistant.home.example.com {
	reverse_proxy http://192.168.30.4:8123
}
```

Example generated route for an internal appliance with self-signed HTTPS:

```caddyfile
truenas.home.example.com {
	reverse_proxy https://192.168.30.3 {
		transport http {
			tls_insecure_skip_verify
		}
	}
}
```

Future Caddy generation should remain conservative:

- Do not accept arbitrary snippets from the UI in early phases.
- Do not try to manage DNS providers before the local/private routing path works.
- Do not make the firewall/router the application proxy.
- Do not require public inbound access.

## 7. Suite Manager UI Direction

Suite Manager should manage common service workflows, not become a full interactive clone of Homepage.

MVP UI should focus on external services:

- Add external service.
- Edit external service.
- Remove external service.
- Choose whether the service appears on the dashboard.
- Choose a simple destination group.
- Configure the friendly/public URL.
- Configure whether MOS/Caddy proxying is enabled.
- Configure the upstream URL.
- Configure whether HTTPS upstream verification should be skipped for self-signed internal appliances.

Wizard fields:

- Title.
- Description.
- Icon.
- Dashboard visibility.
- Simple destination group.
- Public/friendly URL.
- Proxy enabled.
- Upstream URL.
- Upstream HTTPS/self-signed toggle.

Recommended initial UI behavior:

- Insert MOS-managed external services into a dedicated default group such as `My External Services`.
- Allow choosing from existing simple groups only if it can be done safely.
- Leave advanced layout edits in the existing Homepage YAML customization screen.
- Add richer placement controls only after real user pain justifies them.

This keeps the product boundary clear:

> Suite Manager manages services. Homepage manages advanced dashboard layout.

## 8. Phased Implementation

## Progress Checklist

- [x] Phase 1: Parser and Caddy preview
  - [x] Add a Suite Manager backend parser for `mos.proxy` annotations in `services.template.yaml`.
  - [x] Validate proxy-enabled tiles before generating any Caddy output.
  - [x] Generate deterministic preview-only Caddy text without writing, reloading, or restarting Caddy.
  - [x] Expose a protected Suite Manager preview endpoint.
  - [x] Surface current-editor preview in the existing Suite Manager Homepage Customize screen as a secondary advanced action below the editor.
  - [x] Add focused parser/generator tests for nested groups, valid routes, invalid URLs, duplicate hosts, TLS skip generation, and ignored tiles.
  - [x] Update technical docs and changelog for the preview-only contract.
- [ ] Phase 2: Safe generated Caddy snippet
  - [x] Add a generated snippet path and base Caddyfile import strategy.
  - [x] Add self-host service-agent capability for safe Caddy write/reload or restart.
  - [ ] Add validation/smoke coverage for generated external proxy config.
- [ ] Phase 3: External Services UI
  - [ ] Add Suite Manager add/edit/remove flows for MOS-managed external services.
  - [ ] Preserve user-authored Homepage YAML while writing the safe subset of service tile metadata.
  - [ ] Restart Homepage after saves when the host service-agent capability is available.
- [ ] Phase 4: App catalog integration
  - [ ] Connect curated MOS app install flows to dashboard tile and proxy metadata.
  - [ ] Preserve the distinction between integrated apps and external metadata-only services.
- [ ] Phase 5: Advanced capabilities
  - [ ] Evaluate health checks, access policy, DNS automation, DNS-01 certificates, and split-DNS docs after the core model is stable.

### Phase 1: Parser And Preview

Add a backend parser and preview path.

Required work:

- Parse Suite Manager-owned `services.template.yaml`.
- Detect Homepage tiles with `mos.proxy.enabled: true`.
- Validate proxy annotations.
- Generate Caddy preview text.
- Do not apply generated Caddy config.
- Add tests for:
  - nested Homepage structures
  - valid external proxy routes
  - invalid `href` values
  - invalid upstream URLs
  - duplicate proxy hostnames
  - TLS skip generation
  - ignored tiles without enabled proxy annotations
- Update technical docs.
- Update changelog only when actual implementation begins.

### Phase 2: Safe Generated Caddy Snippet

Add a safe apply path after preview behavior is trusted.

Required work:

- Add a generated snippet path.
- Add a Caddy import strategy.
- Add self-host service-agent capability for writing/reloading or restarting Caddy safely.
- Keep built-in routes static.
- Add `vps:doctor` validation for generated external proxy config.
- Add E2E or integration smoke coverage where feasible.

### Phase 3: External Services UI

Add a user-facing Suite Manager flow.

Required work:

- Add an External Services page in Suite Manager.
- Implement add/edit/remove for MOS-managed external service tiles.
- Write to `services.template.yaml` while preserving existing user-authored Homepage YAML.
- Keep advanced layout in the YAML editor.
- Restart Homepage after save using existing service-agent capability when available.
- Surface clear guidance when restart capability is unavailable.

### Phase 4: App Catalog Integration

Connect the same model to curated MOS apps.

Required work:

- Add curated app catalog metadata.
- Let integrated app install flows write dashboard tiles and eventually proxy metadata.
- Preserve the distinction between integrated and external apps:
  - Integrated app: MOS owns install, lifecycle, config, proxy, and dashboard entry.
  - External app: MOS owns dashboard/proxy metadata only.
- Do not remove existing hardcoded app behavior until migration is safe.

### Phase 5: Advanced Capabilities

Add optional power features after the core model is stable.

Potential work:

- Health checks.
- Auth/access policy.
- DNS provider automation.
- DNS-01 certificate strategy.
- Custom Caddy image with DNS provider modules.
- Split-DNS documentation for OPNsense/Unbound/Tailscale style setups.

## 9. Risks And Non-Goals

Guardrails:

- Do not introduce a separate full service-registry format for the MVP.
- Do not manually edit generated `services.yaml`.
- Do not break existing `*.localhost`, `*.mos.home`, or configured `DOMAIN` behavior.
- Do not require public DNS.
- Do not require public inbound access.
- Do not make OPNsense, Unbound, Tailscale, routers, or firewalls part of MOS management.
- Do not expose host-level config writes directly from the Suite Manager container.
- Do not accept raw Caddy snippets from the UI in early phases.
- Do not rebuild Homepage's full interactive layout editor.
- Do not remove existing static built-in Caddy routes until generated routing has proven itself.

Known risks:

- Homepage tile YAML is flexible, so parser traversal must support nested structures without destroying user-authored layout.
- Caddy config generation must be strict because malformed proxy config can break access to the suite.
- Internal appliances often use self-signed certificates, redirects, websockets, or hostname-sensitive behavior.
- DNS-01 support will require deliberate Caddy image/plugin work because the current Caddy image is stock and pinned.
- Hosted platforms may not allow the same generated Caddy apply path as self-host/own-infra installs.

## 10. GitHub Issue Breakdown

Suggested Codex-ready issue slices:

1. Parser and Caddy preview for `mos.proxy` annotations.
2. Docs/ADR for Homepage-as-source and MOS proxy annotation design.
3. Generated Caddy snippet import and self-host apply/reload path.
4. Suite Manager External Services MVP UI.
5. App catalog integration design.
6. Follow-up GitHub Issues: move each implementation phase into focused Codex-ready issues instead of restoring a long-lived roadmap document.

Suggested issue body pattern:

- Goal: one concrete outcome.
- Context: why this phase matters and what previous phase it depends on.
- Files likely involved: approximate areas only.
- Acceptance criteria: concrete testable bullets.
- Constraints: compatibility, deployment, security, UX, and data-safety boundaries.
- Testing: smallest useful verification.
- Related issues, PRs, and decisions: include ADR/doc references when they exist.

## 11. Acceptance Criteria For This Planning Artifact

This temporary Markdown plan is complete when:

- It captures all decisions from the design discussion.
- It is detailed enough for a later agent to resume without reading the original chat.
- It clearly distinguishes MVP from end vision.
- It names the temporary nature of the document.
- It includes issue-sized implementation phases.
- It does not mutate architecture docs yet except through later planned work.
- It does not update `CHANGELOG.md` until actual implementation begins.

## Assumptions

- This file lives at `docs/homepage-proxy-annotations-plan.md`.
- This file will be deleted before merge, or replaced by durable updates in `docs/decisions.md`, app READMEs, and GitHub Issues.
- The long-lived roadmap document has been retired; future planning should be split into GitHub Issues and durable architecture decisions only when needed.
- No implementation code should be written until this temporary plan exists and has been reviewed.
