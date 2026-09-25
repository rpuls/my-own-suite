// The console banner is the last screen of a self-host install and the only one
// that cannot be corrected afterwards by someone who cannot reach the machine.
// Three of its constraints are invisible in the source: the console font is
// ASCII and nothing more, the whole screen is 25 rows and the banner does not
// own all of them, and the Easy Door name it prints has to be the one Suite
// Manager's host gate admits.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const { easyDoorHomeHost } = require('../../shared/easy-door.cjs');
const { renderCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');
const { renderConsoleLoginInitScript } = require('../../scripts/installers/console-login.cjs');

const easyDoorModule = path.resolve(__dirname, '..', '..', 'shared', 'easy-door.cjs');
const script = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'image-builder', 'payload', 'mos-first-boot'),
  'utf8',
).replace(/\r\n/gu, '\n');

// The longest value each substitution can carry on a real machine. The Easy Door
// name is longest inside 172.16/12 and 192.168/16, and the docs URL and the
// domain are the ones `render-bake-seed.cjs` bakes in. The domain is a ceiling
// and not just a default: this screen only ever exists on a machine installed
// from the published image, which is built with exactly this one.
const WIDEST = {
  docs_url: 'https://myownsuite.org/docs/install/own-hardware/',
  domain: 'mos.home',
  easy_host: 'home.192-168-255-255.local.myownsuite.org',
  home_url: 'http://home.mos.home/',
  lan_ip: '255.255.255.255',
};

// Latin-1 is not the whole console font, and neither is CP437. The honest rule
// is an allow-list of glyphs seen on a physical console: the block and
// double-line box drawing the logo is made of render, and that is the whole of
// what is known to. The single-line ─ does not, though it sits beside ═ in the
// same Unicode block - it came off a real machine as a row of `?` under a logo
// that rendered perfectly, which is why the rules it drew are gone. A codepoint
// ceiling would either reject the logo or wave that back in.
const CONSOLE_GLYPHS = new Set([...'█╗║╔╝╚═']);

// agetty paints the address banner, then the server login as its own file, then
// the prompt, all into one 80x25 screen with no scrollback. The three budgets
// are one budget, so the login block is measured here rather than trusted to
// stay small somewhere else.
const CONSOLE_ROWS = 25;
const PROMPT_ROWS = 1;

function bannerLines() {
  const block = script.split('banner=/etc/issue.d/10-mos-address.issue')[1];
  return block.split('} > "$staged"')[0].split('\n');
}

// The rows of /etc/issue.d/20-mos-server-login.issue, which agetty prints below
// the banner. Rendered with the widest realistic substitutions, since the file
// is a heredoc the generator expands on the machine.
function loginBlockLines() {
  const rendered = renderConsoleLoginInitScript({
    runtimeUser: 'mos',
    setupUrl: 'http://home.mos.home/suite-manager/',
    stateDir: '/var/lib/mos/suite-manager',
    username: 'mos',
  });
  return rendered
    .split('<<MOS_CONSOLE_ISSUE\n')[1]
    .split('\nMOS_CONSOLE_ISSUE')[0]
    .split('\n')
    .map((line) => line.replace('$username', 'mos').replace('$password', 'abcde-fghij-klmno'));
}

// Widest rendered width of one printf, with ANSI escapes removed: they move the
// cursor without consuming a column, and with `\\` collapsed to the one column
// the backslashes in the logo actually take.
function renderedWidth(line) {
  const format = line.match(/^\s*printf\s+'([^']*)'/u)[1];
  const args = [...line.matchAll(/"\$([a-z_]+)"/gu)].map((match) => match[1]);
  let index = 0;
  return format
    .replace(/\\\\/gu, '\\')
    .replace(/\\033\[[0-9;]*[A-Za-z]/gu, '')
    .replace(/\\n$/u, '')
    .replace(/%(-?\d+)?s/gu, (_match, width) => {
      const value = WIDEST[args[index]];
      index += 1;
      assert.ok(value, `mos-first-boot substitutes an unknown variable: ${args[index - 1]}`);
      return width ? value.padEnd(Math.abs(Number(width))) : value;
    })
    .length;
}

// The tallest path through the banner's if/else structure, one line per printf.
function tallestPath(lines, start = 0) {
  let count = 0;
  let index = start;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line === 'fi' || line === 'else') return { count, next: index };
    if (line.startsWith('if ')) {
      const taken = tallestPath(lines, index + 1);
      let otherwise = 0;
      let next = taken.next;
      if (lines[next].trim() === 'else') {
        const skipped = tallestPath(lines, next + 1);
        otherwise = skipped.count;
        next = skipped.next;
      }
      count += Math.max(taken.count, otherwise);
      index = next + 1;
      continue;
    }
    if (line.startsWith('printf ')) count += 1;
    index += 1;
  }
  return { count, next: index };
}

test('the banner fits an 80x25 console and stays inside the console font', () => {
  const lines = bannerLines();
  const printfs = lines.filter((line) => line.trim().startsWith('printf '));
  assert.ok(printfs.length > 10, 'the banner block was not found');

  for (const line of printfs) {
    const format = line.match(/^\s*printf\s+'([^']*)'/u)[1];
    assert.equal(format.match(/\\n/gu)?.length, 1, `one line per printf: ${format}`);
    assert.ok(format.endsWith('\\n'), `printf must end its line: ${format}`);
    assert.ok(renderedWidth(line) <= 80, `wider than an 80-column console: ${format}`);
    for (const character of format) {
      assert.ok(
        character.codePointAt(0) <= 0xff || CONSOLE_GLYPHS.has(character),
        `outside the console font and blank on screen: ${character}`,
      );
    }
  }

  // 48 rows was the old budget, taken from a 1024x768 framebuffer and an 8x16
  // font. Firmware is under no obligation to hand the kernel a framebuffer, and
  // the first hardware install got an 80x25 text mode: the banner and the login
  // block came to 54 rows between them, so the logo, the state headline and the
  // whole of the first address scrolled away before agetty finished painting.
  // Nothing about that was visible to the machine - it had already succeeded.
  const login = loginBlockLines();
  for (const line of login) {
    assert.ok(line.length <= 80, `wider than an 80-column console: ${line}`);
    assert.ok([...line].every((character) => character.codePointAt(0) <= 0x7e), line);
  }
  const banner = tallestPath(lines).count;
  assert.ok(
    banner + login.length + PROMPT_ROWS <= CONSOLE_ROWS,
    `the screen is ${banner} banner rows plus ${login.length} login rows plus the prompt, over ${CONSOLE_ROWS}`,
  );
});

test('the banner derives the Easy Door name rather than reimplementing it', () => {
  assert.match(script, /easy_door_module=\/opt\/mos\/repo\/shared\/easy-door\.cjs/u);
  assert.match(script, /"\$easy_door_module" home-host "\$lan_ip"/u);
  assert.match(script, /"\$easy_door_module" address/u);
  // A second implementation of "this machine's LAN address" or of the dashed
  // name is exactly the divergence that puts an unserved address on the screen.
  // Naming the zone as prose is fine and necessary — the rebinding note has to
  // tell the owner what to allow — so this rejects *building* a name from one,
  // not mentioning one.
  assert.doesNotMatch(script, /[%$][^ ]*\.local\.myownsuite\.org/u);
  assert.doesNotMatch(script, /tr '\.' '-'|sed 's\/\\\.\/-\/|192\.168/u);

  // Every Easy Door line sits behind the derived name being non-empty, so a
  // public address or a closed door prints one door and never a dead second one.
  const easyDoorBlock = script.split('if [ -n "$easy_host" ]; then')[2].split('else')[0];
  assert.match(easyDoorBlock, /THE EASY WAY IN/u);
  assert.match(easyDoorBlock, /http:\/\/%s\//u);
  assert.match(easyDoorBlock, /Nothing loads\?/u);
  assert.doesNotMatch(script.split('if [ -n "$easy_host" ]; then')[0], /THE EASY WAY IN/u);

  // With one door there is no "A" to label and no "B" to point at, so the
  // lettered pair is replaced rather than left half-referenced.
  const labels = bannerLines().filter((line) => line.includes('WAY IN'));
  assert.equal(labels.length, 3, 'expected a lettered pair and a single-door label');
  assert.match(labels[0], /A   THE BEST WAY IN/u);
  assert.doesNotMatch(labels[1], /BEST|EASY/u);
  assert.match(labels[2], /B   THE EASY WAY IN/u);

  // Both doors need the reservation, so it is stated before either of them.
  const withAddress = script.split('if [ -n "$lan_ip" ]; then')[1];
  assert.ok(withAddress.indexOf('Reserve that address') < withAddress.indexOf('WAY IN'));
  assert.match(withAddress, /only from inside your own network/u);
});

// The door is always open on a LAN machine — a domain does not close it — so the
// banner prints it for any private address without reading the Caddyfile.
test('the Easy Door CLI answers with the name the host gate admits', () => {
  const cli = (args) => execFileSync(process.execPath, [easyDoorModule, ...args], { encoding: 'utf8' }).trim();

  for (const address of ['192.168.123.45', '10.0.0.5', '172.16.0.1']) {
    assert.equal(cli(['home-host', address]), easyDoorHomeHost(address));
  }
  // A public address has no Easy Door: the nameserver refuses those names, so
  // the banner must print the first door alone rather than a dead second one.
  assert.equal(cli(['home-host', '203.0.113.9']), '');
  assert.equal(renderCaddyfile().includes('# mos-easy-door'), true);
});

// The banner runs on every boot whether the vault opened or not, so it may read
// nothing the vault protects, it may not run the login generator (which waits
// for the vault and writes its own file after this one), and it has to say
// "locked" when the gate failed rather than "running" over a suite that is not.
test('the banner is vault-independent, runs no generator, and never claims a locked machine is running', () => {
  assert.doesNotMatch(script, /mos-console-login-init|chpasswd|\/var\/lib\/mos\b|\/var\/lib\/docker|\/etc\/mos\/secrets/u);
  // Nothing runs from the stick any more, so the banner has no second shape to
  // choose between and asks no question about the medium it is printed on.
  assert.doesNotMatch(script, /lsblk|findmnt|\/sys\/block|installer-media|USB STICK/u);
  // Nothing is stripped out of /etc/issue, because nothing is written into it.
  assert.doesNotMatch(script, /awk -v b=/u);

  assert.match(script, /systemctl is-failed --quiet mos-vault\.service/u);
  const locked = script.split('if [ "$vault_locked" = yes ]; then')[1].split('else')[0];
  assert.match(locked, /Locked\./u);
  assert.match(locked, /recovery key/u);
  assert.doesNotMatch(locked, /Installed and running/u);
});

// An address that moves under a running machine leaves this screen the only
// surface still telling the truth, so a timer runs the banner again rather than
// waiting for a reboot nobody knows to perform. That makes one property load
// bearing that was free while this only ran at boot: the console is repainted
// only when the screen would actually say something different. Repainting
// unconditionally would throw whoever is signed in at tty1 off every couple of
// minutes, forever, on every machine — so the order below is the feature, and
// it is asserted on the source because the alternative needs systemd and a tty.
test('the banner repaints only when it changed, so a timer can run it', () => {
  const staged = script.indexOf('staged="${banner}.tmp"');
  const compared = script.indexOf('cmp -s "$staged" "$banner"');
  const moved = script.indexOf('mv "$staged" "$banner"');
  const repainted = script.indexOf('systemctl restart getty@tty1.service');

  assert.ok(staged > 0, 'the banner is rendered to a staged file');
  assert.ok(compared > staged, 'the staged banner is compared against the one on screen');
  assert.ok(moved > compared, 'the staged banner replaces the live one only after the comparison');
  assert.ok(repainted > moved, 'the console is repainted only after the banner actually changed');

  // The early return is what makes the run free. Without it the comparison
  // would be decoration and the timer would repaint regardless.
  const unchanged = script.slice(compared, moved);
  assert.match(unchanged, /exit 0/u, 'an unchanged banner leaves without touching the console');

  // Atomic, and invisible to agetty while it is being written: agetty expands
  // `*.issue` in this directory every time it paints.
  assert.doesNotMatch(script, /\} > "\$banner"/u, 'the banner is never written in place');
  assert.match(script, /staged="\$\{banner\}\.tmp"/u);
});

// A unit that is written but never enabled is the shape this would most likely
// fail in, and it would fail silently: the banner would simply go on being
// correct only at boot, which is exactly what it does today.
test('the address watch is wired into the image and enabled on it', () => {
  const units = path.resolve(__dirname, '..', '..', 'image-builder', 'payload', 'units');
  const service = fs.readFileSync(path.join(units, 'mos-address-watch.service'), 'utf8');
  const timer = fs.readFileSync(path.join(units, 'mos-address-watch.timer'), 'utf8');
  const seed = fs.readFileSync(path.resolve(__dirname, '..', '..', 'image-builder', 'render-bake-seed.cjs'), 'utf8');
  const finalize = fs.readFileSync(path.resolve(__dirname, '..', '..', 'image-builder', 'payload', 'mos-image-finalize'), 'utf8');

  // The same script as the boot unit, not a second copy of the logic.
  assert.match(service, /^ExecStart=\/usr\/local\/sbin\/mos-first-boot$/mu);
  assert.match(timer, /^OnUnitActiveSec=/mu);
  assert.match(timer, /^WantedBy=timers\.target$/mu);
  // Timer-activated only: a [Install] section on the service would run the
  // banner a second time at boot for nothing.
  assert.doesNotMatch(service, /^\[Install\]$/mu);

  for (const name of ['mos-address-watch.service', 'mos-address-watch.timer']) {
    assert.ok(seed.includes(`'${name}'`), `${name} is not written into the image`);
  }
  assert.match(finalize, /systemctl enable mos-address-watch\.timer/u);
  assert.doesNotMatch(finalize, /systemctl enable[^\n]*mos-address-watch\.service/u);
});
