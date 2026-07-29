// Community and legal links shown inside Suite Manager.
//
// The repository, Discord, and contribution URLs come from
// shared/community-links.json, the same file the public site reads, so an
// installed suite never points somewhere the site has moved on from.
import communityLinks from '../../../../shared/community-links.json';

export const GITHUB_REPO_URL = communityLinks.github;
export const DISCORD_INVITE_URL = communityLinks.discord;
export const CONTRIBUTING_URL = communityLinks.contributing;
export const ISSUES_URL = communityLinks.issues;

// The public documentation site. Suite Manager runs on the owner's own server
// and cannot serve these pages itself, so they are absolute links out.
export const MOS_SITE_URL = 'https://myownsuite.org';
export const TERMS_URL = `${MOS_SITE_URL}/docs/terms/`;
export const PRIVACY_URL = `${MOS_SITE_URL}/docs/privacy/`;
export const LICENSE_URL = `${MOS_SITE_URL}/docs/license/`;
