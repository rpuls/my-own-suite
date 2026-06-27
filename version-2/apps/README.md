# V2 App Packages

Future app packages live here, one app per folder.

Each app package should own its app-specific manifest, Dockerfiles, setup helpers, runtime assets, Caddy snippets, Homepage contributions, backup metadata, and technical notes.

The first package is `stirling-pdf`, intentionally chosen as a boring app to prove discovery, manifest validation, projections, and lifecycle behavior before MOS grows a catalog.

Current package manifests are validation inputs only. They must not imply that the app is installed until Suite Manager persists app instance state and a lifecycle agent applies the generated runtime projections.
