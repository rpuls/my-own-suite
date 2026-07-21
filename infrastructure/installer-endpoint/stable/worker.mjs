import { createInstallerWorker } from '../core.mjs';

// Production is deliberately fixed to the release branch.
export default createInstallerWorker(() => 'main');
