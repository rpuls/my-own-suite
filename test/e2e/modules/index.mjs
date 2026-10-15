import { absent, app, connect, install, installed, lifecycle, routes, tiles, update, verify } from './apps.mjs';
import { backup, cleanup, restore } from './backups.mjs';
import { compare } from './compare.mjs';
import { diagnostics } from './diagnostics.mjs';
import { homepage, homepageCheck } from './homepage.mjs';
import { dns01 } from './https.mjs';
import { reset } from './lab.mjs';
import { marketing } from './marketing.mjs';
import { network } from './network.mjs';
import { owner } from './owner.mjs';
import { platformUpdate } from './platform.mjs';

// Step name (see steps.mjs) → what runs it, given the run context and the arg.
export const MODULES = {
  absent,
  app,
  backup,
  cleanup,
  compare,
  connect,
  diagnostics,
  dns01,
  homepage,
  'homepage-check': homepageCheck,
  install,
  installed,
  lifecycle,
  marketing,
  network,
  owner,
  'platform-update': platformUpdate,
  reset,
  restore,
  routes,
  tiles,
  update,
  verify,
};
