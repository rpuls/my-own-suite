# V2 App Packages

Future app packages live here, one app per folder.

Each app package should own its app-specific manifest, Dockerfiles, setup helpers, runtime assets, Caddy snippets, Homepage contributions, backup metadata, and technical notes.

Use `icon.png` in the package root for the catalog icon, and point `manifest.json` `icon` at that file. Richer screenshots or marketing assets are optional catalog metadata, not required package scaffolding.

The first package is `stirling-pdf`, intentionally chosen as a boring app to prove discovery, manifest validation, projections, and lifecycle behavior before MOS grows a catalog.

The second package is `vaultwarden`, intentionally chosen to pressure-test generated setup values, secret redaction, persistent storage, package onboarding metadata, and app-specific runtime environment projection without adding app-specific logic to Suite Manager core.

Current package manifests are validation inputs only. They must not imply that the app is installed until Suite Manager persists app instance state and a lifecycle agent applies the generated runtime projections.
