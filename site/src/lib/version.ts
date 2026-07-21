// Single source of truth for the MOS version shown in the site UI.
// The repo-root VERSION file is read at build time (Vite `?raw` import), so
// the badges on the landing page never drift from the actual release — bump
// VERSION (per RELEASING.md) and the site follows on the next build.
import versionRaw from '../../../VERSION?raw'

export const MOS_VERSION = versionRaw.trim()

// Shared "Beta · <version>" label used by the hero, footer, and beta notice.
export const MOS_BETA_LABEL = `Beta · ${MOS_VERSION}`
