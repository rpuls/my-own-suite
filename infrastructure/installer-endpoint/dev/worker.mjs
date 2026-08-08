import { createInstallerWorker } from '../core.mjs';

// Development installs unreleased code, so it follows a branch.
export default createInstallerWorker((env) => ({ branch: env.INSTALL_BRANCH }));
