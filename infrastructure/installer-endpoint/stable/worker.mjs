import { createInstallerWorker } from '../core.mjs';

// Production installs the published release, never a branch tip.
export default createInstallerWorker(() => ({ stable: true }));
