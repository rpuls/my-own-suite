const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PausedPages, pausedByDrives } = require('./paused-pages.cjs');

const ROUTES = `# mos-app-route:start jellyfin
https://jellyfin.home.example {
  reverse_proxy http://mos-app-jellyfin:8096
}
https://jellyfin.192-168-30-12.local.myownsuite.org {
  reverse_proxy http://mos-app-jellyfin:8096
}
# mos-app-route:end jellyfin
# mos-app-route:start radicale
https://radicale.home.example {
  reverse_proxy http://mos-app-radicale:5232
}
# mos-app-route:end radicale
`;

test('only apps whose drive is out are paused, and only while it is', () => {
  const drives = [
    { apps: ['jellyfin'], name: 'Movies drive', state: 'ejected' },
    { apps: ['immich'], label: 'PHOTOS', name: null, state: 'read-only' },
  ];
  assert.deepEqual([...pausedByDrives(drives)], [['jellyfin', { driveName: 'Movies drive', state: 'ejected' }]]);
});

// Every address an app answers on, read from its own routes block, gets the page;
// an app on another drive gets none.
test("a paused app's addresses get its page, and the page goes when the drive is back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-paused-'));
  const routesPath = path.join(root, 'routes.caddy');
  fs.writeFileSync(routesPath, ROUTES);
  const pages = new PausedPages({ appNameOf: () => 'Jellyfin', root: path.join(root, 'apps'), routesPath });
  pages.sync(new Map([['jellyfin', { driveName: 'Movies drive', state: 'ejected' }]]));
  const files = fs.readdirSync(path.join(root, 'apps')).sort();
  assert.deepEqual(files, ['jellyfin.192-168-30-12.local.myownsuite.org.html', 'jellyfin.home.example.html']);
  const page = fs.readFileSync(path.join(root, 'apps', files[1]), 'utf8');
  assert.match(page, /Jellyfin is paused/u);
  assert.match(page, /Its Movies drive was ejected\. Plug the drive back in, or open Suite Manager to use it again without replugging\./u);
  assert.match(page, /href="\/\/home\.home\.example\/suite-manager\/settings#set-storage"/u);
  pages.sync(new Map());
  assert.deepEqual(fs.readdirSync(path.join(root, 'apps')), []);
});
