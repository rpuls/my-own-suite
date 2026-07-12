import { createInstallerWorker } from '../core.mjs';

// Development follows the branch configured in the Worker environment.
export default createInstallerWorker((env) => env.INSTALL_BRANCH);
