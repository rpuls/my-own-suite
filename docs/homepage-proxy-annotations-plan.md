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
- Supporting DNS-01 certificate flows so users can get real certificates for internally resolved hostnames without public inbound access or public A/AAAA records pointing home.
- Keeping certificate renewal inside Caddy, with DNS provider credentials supplied only to the reverse proxy component that needs them.

Example end state:

```text
homeassistant.home.example.com -> http://192.168.30.4:8123
truenas.home.example.com       -> https://192.168.30.3
switch.home.example.com        -> https://192.168.20.2
```

The public domain may be real, but DNS records for these hosts may exist only internally through split DNS.

For the local HTTPS end state, public DNS is used only for ACME DNS-01 TXT challenges. User-facing app records can remain private LAN DNS records, such as router, Unbound, AdGuard Home, or Tailscale DNS entries that point `*.home.example.com` to the MOS machine.

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
- Caddy uses static `deploy/vps/Caddyfile` as the entrypoint plus generated snippets under `deploy/vps/generated/caddy/` for built-in routes, global TLS options, and external proxy routes.
- The self-host service agent exposes service lifecycle capabilities such as restarting `homepage` and `caddy`, and currently also has the existing generated external-proxy snippet apply path from Phase 2.
- The service-agent boundary should not be expanded for domain, certificate, DNS provider, email, or broad host configuration duties. Future host config writes should belong to a separate, purpose-built config/domain agent if app startup scripts and service restarts are not enough.
- Built-in MOS routes and default domain behavior must keep working throughout this feature.
- Suite Manager now includes a Customize helper for adding Homepage items. The LAN app path writes MOS-managed external service tiles with `mos.id`, `mos.kind: external`, and `mos.managed: true`.
- The LAN app helper currently derives the friendly URL from Suite Manager's `DOMAIN` and `PUBLIC_URL_SCHEME` config values at add time.
- The local HTTPS foundation now includes `MOS_TLS_MODE`, a Cloudflare-capable Caddy image, generated built-in-route/global-options snippets, and a Suite Manager Settings status page.

Current important compatibility surfaces:

- `*.localhost` local development behavior.
- `*.mos.home` self-host/LAN behavior.
- Configured `DOMAIN` behavior for own-infra installs.
- Existing static Caddy routes for built-in apps.
- Existing Homepage runtime config customization through Suite Manager.
- Existing MOS-managed external service metadata written by the Add to Homepage helper.

Important agent boundary:

- Service agent: service lifecycle and observability only, such as restart/status/resource reporting.
- App/container startup scripts: perform app-local prep after restart when possible.
- Caddy: ACME issuance and renewal, including DNS-01 challenge automation.
- Future config/domain agent: optional narrow host writer for approved domain/TLS/env changes if Suite Manager needs to apply those settings from the UI.
- Suite Manager: UI, validation, preview, and intent capture.

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

For the local HTTPS phase, MOS-managed LAN app tiles should gain enough structured intent to rebuild their friendly URL from the global stack URL settings without searching and replacing arbitrary YAML text.

Candidate managed LAN tile shape:

```yaml
- My External Services:
    - Home Assistant:
        href: https://homeassistant.home.example.com
        description: Smart home control
        icon: home-assistant
        mos:
          id: 4b5d3f2a-...
          kind: external
          managed: true
          public:
            mode: app-subdomain
            subdomain: homeassistant
          proxy:
            enabled: true
            upstream: http://192.168.30.4:8123
            tls:
              insecureSkipVerify: false
```

Rules for the derived URL model:

- `href` remains the concrete Homepage/Caddy URL so advanced users can still understand the rendered config.
- `mos.public.mode: app-subdomain` tells Suite Manager that `href` may be regenerated as `<PUBLIC_URL_SCHEME>://<mos.public.subdomain>.<DOMAIN>`.
- `mos.public.subdomain` is the stable MOS-managed app host label, such as `homeassistant` in `homeassistant.home.example.com`.
- Explicit links and user-authored tiles without `mos.public.mode: app-subdomain` are not rewritten by domain/TLS changes.
- Upstream URLs stay explicit and must never be rewritten from the public protocol setting.
- Manual URLs such as `http://192.168.1.1` remain valid for generic links or non-proxied tiles, which covers protected VLAN/router/admin interfaces that should bypass MOS-owned Caddy routing.

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

Local HTTPS direction:

- Caddy should own ACME issuance and renewal through DNS-01.
- Start with Cloudflare DNS-01 only. Cloudflare is common in homelab setups, has well-supported API tokens, and has a maintained Caddy DNS provider module.
- Use scoped Cloudflare API tokens, not global API keys.
- Do not depend on a Cloudflare one-click/OAuth setup button for the first implementation. That may become a later convenience layer only after the proven token-based flow works.
- Build or package a Caddy image that includes the Cloudflare DNS provider module while keeping Dockerfile base images pinned by digest.
- Keep DNS provider secrets out of Homepage YAML and generated service annotations.
- Do not add certificate-renewal jobs to Suite Manager or any host agent; Caddy should renew certificates.

Protocol and TLS source of truth:

- `DOMAIN` remains the stack domain suffix source of truth.
- `PUBLIC_URL_SCHEME` becomes the canonical public URL protocol for MOS-generated app links.
- Add an explicit TLS mode setting, for example `MOS_TLS_MODE=off` or `MOS_TLS_MODE=cloudflare-dns01`.
- `PUBLIC_URL_SCHEME=https` should be paired with `MOS_TLS_MODE=cloudflare-dns01` for the local HTTPS path.
- Caddy should switch routing behavior from these settings or generated mode snippets, not through many hard-coded protocol checks spread across scripts.
- Homepage should receive generated final URLs through its existing template/env pipeline; MOS should not scan final YAML and replace `http` with `https`.

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
  - [x] Surface current-editor preview in the existing Suite Manager Homepage Customize screen as a secondary advanced action below the editor, only when the Caddy apply capability is available.
  - [x] Add focused parser/generator tests for nested groups, valid routes, invalid URLs, duplicate hosts, TLS skip generation, and ignored tiles.
  - [x] Update technical docs and changelog for the preview-only contract.
- [x] Phase 2: Safe generated Caddy snippet
  - [x] Add a generated snippet path and base Caddyfile import strategy.
  - [x] Add self-host service-agent capability for safe Caddy write/reload or restart.
  - [x] Add a local/VPS operator command for applying saved generated proxy routes.
  - [x] Auto-apply saved `services.template.yaml` proxy routes from Suite Manager save/reset when the self-host service-agent Caddy capability is available.
  - [x] Add validation/smoke coverage for generated external proxy config.
- [x] Phase 3: External Services UI (add item wizard setup helper)
  - [x] Add a Suite Manager Customize helper for adding MOS-managed links and LAN apps.
  - [x] Preserve user-authored Homepage YAML while writing the safe subset of service tile metadata.
  - [x] Restart Homepage after saves when the host service-agent capability is available.
- [ ] Phase 4: Advanced capabilities
  - [x] Add shared `DOMAIN` / `PUBLIC_URL_SCHEME` / `MOS_TLS_MODE` contract.
  - [x] Add Cloudflare-capable Caddy build.
  - [x] Generate built-in Caddy routes and global Caddy TLS options from shared mode settings.
  - [x] Add Suite Manager Settings status page for local HTTPS readiness.
  - [ ] Add a separate config/domain agent or equivalent safe host apply path for UI-driven domain/TLS changes.
  - [ ] Add final polished Local HTTPS setup/apply flow.

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
- Auto-apply saved `services.template.yaml` proxy routes from Suite Manager when the safe self-host Caddy capability is available.
- Keep built-in routes static.
- Add `vps:doctor` validation for generated external proxy config.
- Add E2E or integration smoke coverage where feasible.

### Phase 3: External Services UI

Add a user-facing Suite Manager flow.

Required work:

- Add an External Services helper in the Suite Manager Customize flow.
- Implement add/edit/remove for MOS-managed external service tiles.
- Write to `services.template.yaml` while preserving existing user-authored Homepage YAML.
- Keep advanced layout in the YAML editor.
- Restart Homepage after save using existing service-agent capability when available.
- Surface clear guidance when restart capability is unavailable.

### Phase 4: Advanced Capabilities

Add local HTTPS through DNS-01 after the core Homepage/proxy model is stable.

Required work:

- Add a Suite Manager Settings page or section, hidden on managed/Railway-style installs where self-host capabilities are unavailable.
- Add a Local HTTPS setup flow for self-host users with a real domain and Cloudflare DNS.
- Keep the service agent scoped to service restart/status. If UI-driven host config writes are required, introduce a separate narrow config/domain agent instead of expanding the service agent.
- Prefer app/container startup scripts plus service-agent restarts for app-local preparation where possible.
- Add a custom Caddy build with the Cloudflare DNS provider module.
- Add `MOS_TLS_MODE` or equivalent as the single TLS mode flag, paired with existing `DOMAIN` and `PUBLIC_URL_SCHEME`.
- Refactor built-in Caddy routes so they can run in default HTTP mode or Cloudflare DNS-01 HTTPS mode from the shared TLS/domain settings.
- Store Cloudflare credentials in Caddy-owned env/secrets, not in Homepage YAML or MOS service annotations.
- Let Caddy perform certificate issuance and renewal through DNS-01.
- Update the Add to Homepage LAN app model so MOS-managed URLs can be regenerated from `PUBLIC_URL_SCHEME`, `DOMAIN`, and a stored subdomain, while explicit URLs remain untouched.
- Provide a clear confirmation summary before changing the stack domain/protocol, focused on the resulting built-in app URLs and managed LAN app URLs.
- Document split-DNS requirements for OPNsense/Unbound/AdGuard Home/router/Tailscale style setups without making those tools part of MOS management.

Cloudflare-first setup constraints:

- First provider: Cloudflare only.
- User creates a scoped API token manually in Cloudflare.
- Required user guidance should say that public A/AAAA records are not required for private LAN apps; DNS-01 uses temporary `_acme-challenge` TXT records.
- One-click Cloudflare OAuth/App setup is explicitly out of scope for the first version unless it proves to be a simple wrapper around the same token/permission model.

Suggested implementation slices:

1. Settings route and self-host-only capability gating.
2. Domain/TLS status API that reports current `DOMAIN`, `PUBLIC_URL_SCHEME`, TLS mode, and whether local HTTPS setup can be offered.
3. Cloudflare-enabled Caddy image and Caddyfile TLS-mode refactor.
4. Host config application design: startup-script/restart first; separate config/domain agent only if persistent host env/secrets must be written from Suite Manager.
5. Managed external service URL intent: add `mos.public.mode` and `mos.public.subdomain` for LAN-app tiles.
6. Local HTTPS setup UI with Cloudflare token guidance and final URL confirmation.
7. Docs, `vps:doctor` validation, and focused smoke tests.

## 9. Risks And Non-Goals

Guardrails:

- Do not introduce a separate full service-registry format for the MVP.
- Do not manually edit generated `services.yaml`.
- Do not break existing `*.localhost`, `*.mos.home`, or configured `DOMAIN` behavior.
- Do not require public DNS.
- Do not require public inbound access.
- Do not make OPNsense, Unbound, Tailscale, routers, or firewalls part of MOS management.
- Do not expose host-level config writes directly from the Suite Manager container.
- Do not expand the service agent into a general config, DNS, certificate, or email agent.
- Do not accept raw Caddy snippets from the UI in early phases.
- Do not rebuild Homepage's full interactive layout editor.
- Do not remove existing static built-in Caddy routes until generated routing has proven itself.
- Do not rewrite arbitrary `http` strings in Homepage YAML when switching protocol/domain.
- Do not store Cloudflare credentials in Homepage YAML.

Known risks:

- Homepage tile YAML is flexible, so parser traversal must support nested structures without destroying user-authored layout.
- Caddy config generation must be strict because malformed proxy config can break access to the suite.
- Internal appliances often use self-signed certificates, redirects, websockets, or hostname-sensitive behavior.
- DNS-01 support will require deliberate Caddy image/plugin work because the current Caddy image is stock and pinned.
- Switching global protocol/domain can make the Suite Manager front door move; the UI should clearly summarize final URLs before applying.
- Existing MOS-managed LAN app tiles created before `mos.public` metadata may need a one-time safe inference path from their `href` host and current `DOMAIN`.
- Hosted platforms may not allow the same generated Caddy apply path as self-host/own-infra installs.

## 10. GitHub Issue Breakdown

Suggested Codex-ready issue slices:

1. Parser and Caddy preview for `mos.proxy` annotations.
2. Docs/ADR for Homepage-as-source and MOS proxy annotation design.
3. Generated Caddy snippet import and self-host apply/reload path.
4. Suite Manager External Services MVP UI.
5. Local HTTPS architecture ADR: service-agent boundary, Caddy-owned DNS-01 renewal, and config/domain-agent decision.
6. Cloudflare DNS-01 Caddy image and TLS-mode Caddyfile refactor.
7. Suite Manager Settings page and self-host-only Local HTTPS setup flow.
8. Managed external service URL intent metadata and safe domain/protocol regeneration for MOS-managed LAN app tiles.
9. Split-DNS/local HTTPS docs for self-host users.
10. Follow-up GitHub Issues: move each implementation phase into focused Codex-ready issues instead of restoring a long-lived roadmap document.

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
