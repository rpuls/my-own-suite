# Managed Update Work

This folder is the isolated workspace for future managed-update infrastructure.

Current focus:

- `selfhost/`: host-managed update flow for USB-installed self-host deployments

Goals for this workspace:

- keep updater-specific design and implementation separate from the app codebase
- allow staged experimentation before the feature is wired deeply into Suite Manager
- make it easier to track MVP scope, later roadmap items, and deployment-specific differences
