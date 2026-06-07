# Managed Update Compatibility

The canonical self-host update-agent implementation now lives under:

- [agents/selfhost/update/](../agents/selfhost/update/)

This folder remains only for compatibility with older scripts, docs, and installed systems that still reference `update/selfhost/*`.

Do not add new update-agent implementation files here. Use:

- [docs/roadmap.md](../docs/roadmap.md)
- [docs/decisions.md](../docs/decisions.md)
- GitHub Issues for task-level work
