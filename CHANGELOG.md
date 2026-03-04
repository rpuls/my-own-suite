# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Changed

- Updated `AGENTS.md` app-doc pattern to use `### References` (instead of `### Technical specs`) as the canonical embedded README heading.

## [0.1.0] - 2026-03-04

First official release of My Own Suite.
Establishes the release/publishing foundation and ships the initial MVP application stack, validated locally with Docker Compose and in a Railway cloud deployment.

### Added

- `RELEASING.md` with SemVer rules, compatibility contracts, and a clear release workflow.
- `CHANGELOG.md` as the canonical release history.
- Starlight docs `Releases` page rendering `CHANGELOG.md`.
- Top-level `Project` docs section (after `Apps`) containing `Releases`.
- Git hooks (`pre-commit`, `pre-push`) to block commits/pushes directly on `main`.
