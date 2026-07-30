import betaNotice from '../../../../../shared/beta-notice.json';
import { DisclaimerNotice } from './DisclaimerNotice';

// The same early-software warning the public landing page shows, in the same
// words. Someone who never read the website still has to meet this warning
// before they trust the platform with their data, so unlike the landing-page
// snackbar this one is part of the page and cannot be dismissed away.
export function BetaNotice() {
  return <DisclaimerNotice copy={betaNotice} variant="warning" />;
}
