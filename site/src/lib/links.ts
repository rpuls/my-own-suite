// Repository and community URLs come from shared/community-links.json so the
// public site and Suite Manager send people to the same places.
import communityLinks from '../../../shared/community-links.json'

export const GITHUB_REPO_URL = communityLinks.github
export const DISCORD_INVITE_URL = communityLinks.discord
export const CONTRIBUTING_URL = communityLinks.contributing
export const ISSUES_URL = communityLinks.issues
export const CHANGELOG_URL = `${GITHUB_REPO_URL}/blob/main/CHANGELOG.md`
export const DOCS_PATH = '/docs'
export const GET_STARTED_PATH = '/docs/getting-started/'
// The two install paths the landing page's platform cards point at. They live
// here rather than inline so a docs reshuffle is one edit, not a hunt.
export const INSTALL_CLOUD_PATH = '/docs/install/cloud-server/'
export const INSTALL_OWN_HARDWARE_PATH = '/docs/install/own-hardware/'
export const LICENSE_PATH = '/docs/license/'
export const TERMS_PATH = '/docs/terms/'
export const PRIVACY_PATH = '/docs/privacy/'
