// Every temporary disclaimer Suite Manager renders, so retiring one is a
// deletion rather than a hunt: drop the component here, drop its call sites,
// drop its .suite-disclaimer- styles. The beta wording is the exception that
// lives in shared/beta-notice.json, because the public landing page shows the
// same words and must not drift from these.
export { BetaNotice } from './BetaNotice';
export { CustomizeYamlNotice } from './CustomizeYamlNotice';
export { DisclaimerNotice, type DisclaimerCopy } from './DisclaimerNotice';
