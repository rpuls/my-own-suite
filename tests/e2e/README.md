# E2E Tests

This folder contains black-box Playwright tests for My Own Suite.

The current suite starts a real Docker stack on alternate local ports, drives the live Suite Manager onboarding flow, and tears the stack down again after the run. It does not change app source code or rely on test-only bypasses.

## Commands

Run these from the repo root:

- Install the test dependencies and Chromium browser: `npm run e2e:install`
- Run the onboarding happy path headless: `npm run e2e:onboarding`
- Run the onboarding happy path headed: `npm run e2e:onboarding:headed`
- Run the onboarding happy path headed with a single worker and extra timeout for visual debugging: `npm run e2e:onboarding:debug`

## What It Verifies

The onboarding test currently verifies that a fresh local stack can:

- start cleanly on an isolated E2E Docker Compose project
- sign in to Suite Manager with the generated owner credentials
- create the real Vaultwarden owner account
- detect that account back in Suite Manager
- import the generated suite credentials into Vaultwarden
- complete the calendar onboarding step
- reach Homepage successfully

## Notes

- The E2E stack uses `deploy/vps/docker-compose.yml` plus `deploy/vps/docker-compose.e2e.yml`.
- Caddy is mapped to alternate ports during the test run so the harness does not collide with a normal local stack.
- Generated credentials are read from `deploy/vps/services/suite-manager/.env` after the stack starts.
- If a run fails, Playwright keeps screenshots, videos, and a trace under `tests/e2e/test-results`.
