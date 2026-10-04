// The console banner is the last screen of a self-host install and the only one
// that cannot be corrected afterwards by someone who cannot reach the machine.
// Three of its constraints are invisible in the source: the console font is
// ASCII and nothing more, the screen is only as tall as the machine says it is
// and the banner does not own all of those rows, and the Easy Door name it
// prints has to be the one Suite Manager's host gate admits.

const assert = require('node:assert/strict');
const fs = require('node:fs');
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
// name is longest inside 172.16/12 and 192.168/16, and the docs URLs and the
// domain are the ones `render-bake-seed.cjs` bakes in. The domain is a ceiling
// and not just a default: this screen only ever exists on a machine installed
// from the published image, which is built with exactly this one.
const WIDEST = {
  docs_url: 'https://myownsuite.org/docs/install/own-hardware/',
  domain: 'mos.home',
  easy_docs_url: 'https://myownsuite.org/docs/install/easy-address/',
  easy_host: 'home.192-168-255-255.local.myownsuite.org',
  easy_scheme: 'https',
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
// the prompt, into one screen with no scrollback. The three budgets are one
// budget, so the login block is measured here rather than trusted to stay small
// somewhere else. 25 rows is the smallest console that exists and the one the
// banner assumes when tty1 will not say, so every screen but the tall one is
// measured against it; the tall one is measured against what the script asks
// the console for before printing it.
const SMALLEST_CONSOLE_ROWS = 25;
const PROMPT_ROWS = 1;

// One screen's own lines, as written in the shell. Each render_* function is a
// whole screen in the order it appears on the console, so a screen is measured
// and read here the same way it is edited there.
function functionLines(name) {
  const opens = `\n${name}() {\n`;
  const start = script.indexOf(opens);
  assert.ok(start > 0, `mos-first-boot no longer defines ${name}`);
  return script.slice(start + opens.length).split('\n}\n')[0].split('\n');
}

// Each screen carries its own logo, so a screen is exactly the lines of its own
// function - nothing is pulled in from anywhere else to read it.
function screenLines(name) {
  return functionLines(name);
}

// The rows of a screen that are logo rather than words, in the order they are
// printed and with the escapes and the state text taken off. Two screens draw
// the same small logo, and this is what keeps those copies from drifting.
function logoRows(name) {
  return screenLines(name)
    .filter((line) => [...CONSOLE_GLYPHS].some((glyph) => line.includes(glyph)))
    .map((line) => line.match(/\[32m([^\\]*)/u)[1]);
}

const SCREENS = ['render_tall', 'render_short', 'render_no_address'];

// The rows of /etc/issue.d/20-mos-server-login.issue, which agetty prints below
// the banner. Rendered with the widest realistic substitutions, since the file
// is a heredoc the generator expands on the machine.
function loginBlockLines() {
  const rendered = renderConsoleLoginInitScript({
    runtimeUser: 'mos',
    stateDir: '/var/lib/mos/suite-manager',
    username: 'mos',
  });
  return rendered
    .split('<<MOS_CONSOLE_ISSUE\n')[1]
    .split('\nMOS_CONSOLE_ISSUE')[0]
    .split('\n')
    .map((line) => line.replace('$username', 'mos').replace('$password', 'abcde-fghij-klmno'));
}

// What the script itself says the tall screen costs, and what it reserves for
// everything printed under it. Read out of the shell rather than restated here,
// because the shell is what decides at runtime which screen a machine gets.
function declared(name) {
  const value = script.match(new RegExp(`^${name}=(\\d+)$`, 'mu'));
  assert.ok(value, `mos-first-boot no longer declares ${name}`);
  return Number(value[1]);
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

// The tallest path through one screen's if/else structure, one line per printf.
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

test('every screen stays inside the console font and inside 80 columns', () => {
  for (const screen of SCREENS) {
    const printfs = screenLines(screen).filter((line) => line.trim().startsWith('printf '));
    assert.ok(printfs.length > 6, `${screen} was not found`);

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
  }
});

test('each screen fits the console it is printed on', () => {
  // The first hardware install got an 80x25 text mode, where the banner and the
  // login block came to 54 rows between them and the logo, the state headline
  // and the whole of the first address scrolled away before agetty finished
  // painting. Nothing about that was visible to the machine, which had already
  // succeeded. That is what the short screen is for, and why a console that
  // will not give its size counts as the smallest one.
  const login = loginBlockLines();
  for (const line of login) {
    assert.ok(line.length <= 80, `wider than an 80-column console: ${line}`);
    assert.ok([...line].every((character) => character.codePointAt(0) <= 0x7e), line);
  }
  assert.equal(
    declared('reserved_rows'),
    login.length + PROMPT_ROWS,
    'the rows reserved for the login block and the prompt no longer match what is printed under the banner',
  );

  for (const screen of ['render_short', 'render_no_address']) {
    const rows = tallestPath(screenLines(screen)).count;
    assert.ok(
      rows + login.length + PROMPT_ROWS <= SMALLEST_CONSOLE_ROWS,
      `${screen} is ${rows} rows plus ${login.length} login rows plus the prompt, over ${SMALLEST_CONSOLE_ROWS}`,
    );
  }

  // The tall screen has no fixed ceiling, because it is printed only on a
  // console with room for it. What is asserted instead is that the machine is
  // asked for exactly as many rows as the screen actually takes: a line added
  // to it without raising the number prints a screen that scrolls on the
  // smallest console that accepts it, which is the failure this whole mechanism
  // exists to prevent and the one a passing test would otherwise hide.
  const tall = tallestPath(screenLines('render_tall')).count;
  assert.equal(
    tall,
    declared('tall_rows'),
    `render_tall is ${tall} rows and the script asks the console for ${declared('tall_rows')}`,
  );
  assert.ok(
    tall > tallestPath(screenLines('render_short')).count,
    'the tall screen carries more than the short one',
  );
});

// A console that answers is used at its real size; one that does not, or that
// answers something implausible, is treated as the smallest console there is.
// Getting that backwards puts the tall screen on an 80x25 machine, where it
// scrolls its own logo and first address away.
// Two logos, deliberately: the tall screen opens with the six-row one and says
// what the machine is doing underneath it, while the short screen sets the state
// beside a four-row one, which is what pays for the words it keeps. The small
// one is drawn twice, so the copies are compared rather than trusted.
test('each screen draws its own logo, and the two copies of the small one match', () => {
  assert.doesNotMatch(script, /^logo\(\) \{$/mu, 'the screens draw their own logos rather than sharing one');

  const tall = logoRows('render_tall');
  const short = logoRows('render_short');
  const noAddress = logoRows('render_no_address');

  assert.equal(tall.length, 6, 'the tall screen opens with the six-row logo');
  assert.equal(noAddress.length, 4, 'the no-address screen uses the four-row logo');
  // The short screen writes its state block out twice, running and locked, so
  // it draws the small logo twice over - and both copies have to be the same
  // four rows the no-address screen draws.
  assert.equal(short.length, 8, 'the short screen draws its logo once per state');
  assert.deepEqual(short.slice(0, 4), noAddress, 'the small logo drifted between two screens');
  assert.deepEqual(short.slice(4), noAddress, 'the short screen draws two different logos');
  assert.notDeepEqual(tall.slice(0, 4), noAddress, 'the two logos are meant to differ');

  // Every screen starts by clearing the console, because agetty hands whatever
  // is in this file straight to a terminal that still has the boot log on it.
  for (const screen of SCREENS) {
    const first = screenLines(screen).filter((line) => line.trim().startsWith('printf '));
    const clears = first.filter((line) => line.includes('\\033[2J\\033[H'));
    assert.ok(clears.length >= 1, `${screen} never clears the console`);
    for (const line of clears) {
      assert.ok(
        [...CONSOLE_GLYPHS].some((glyph) => line.includes(glyph)),
        `${screen} clears the console somewhere other than its first row`,
      );
    }
  }
});

test('the banner asks the console its size and distrusts the answer', () => {
  assert.match(script, /stty -F \/dev\/tty1 size/u);
  assert.match(script, /^console_rows=25$/mu);
  assert.match(script, /^console_cols=80$/mu);
  assert.match(script, /^layout=short$/mu);

  const detection = script.split('console_size="$(stty')[1].split('install -d')[0];
  assert.match(detection, /\|\| true/u, 'a console that cannot be asked must not fail the script');
  assert.match(detection, /-ge 24 \] && \[ "\$cols" -ge 80/u, 'an implausible size is not adopted');
  assert.match(
    detection,
    /-ge "\$\(\(tall_rows \+ reserved_rows\)\)"/u,
    'the tall screen is chosen by measured rows, not assumed',
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

  // Both screens carry both doors, so both are checked. A rule that held only on
  // the screen the test happened to measure would be no rule at all.
  assert.match(script, /easy_scheme=http\n/u);
  assert.match(script, /curl -s -o \/dev\/null --max-time 5 --resolve "\$easy_host:443:127\.0\.0\.1" "https:\/\/\$easy_host\/"/u);
  assert.doesNotMatch(script, /curl[^\n]*(-k|--insecure)/u, 'an untrusted certificate must not count as HTTPS');

  for (const screen of ['render_tall', 'render_short']) {
    const lines = screenLines(screen);
    const text = lines.join('\n');

    // Every Easy Door line sits behind the derived name being non-empty, so a
    // public address or a closed door prints one door and never a dead second one.
    const easyDoorBlock = text.split('if [ -n "$easy_host" ]; then')[2].split('else')[0];
    assert.match(easyDoorBlock, /THE EASY WAY IN/u, screen);
    // The certificate may never arrive, so the scheme is the one a trusted local
    // handshake proves rather than a promise of HTTPS.
    assert.match(easyDoorBlock, /%s:\/\/%s\/\\033\[0m\\n' "\$easy_scheme" "\$easy_host"/u, screen);
    assert.match(easyDoorBlock, /Nothing loads\?/u, screen);
    assert.doesNotMatch(text.split('if [ -n "$easy_host" ]; then')[0], /THE EASY WAY IN/u, screen);

    // With one door there is no "A" to label and no "B" to point at, so the
    // lettered pair is replaced rather than left half-referenced.
    const labels = lines.filter((line) => line.includes('WAY IN'));
    assert.equal(labels.length, 3, `expected a lettered pair and a single-door label: ${screen}`);
    assert.match(labels[0], /A   THE BEST WAY IN/u, screen);
    assert.doesNotMatch(labels[1], /BEST|EASY/u, screen);
    assert.match(labels[2], /B   THE EASY WAY IN/u, screen);

    // Both doors need the reservation, so it is stated before either of them.
    assert.ok(text.indexOf('Reserve that address') < text.indexOf('WAY IN'), screen);
    assert.match(text, /only from inside your own network/u, screen);
  }

  // The explainer behind the Easy Door is a second URL, and only the tall screen
  // has the row for it. It is baked in by the seed renderer, so a screen that
  // prints it and a build that does not fill it would put '@@EASY_DOCS_URL@@' on
  // the console of every machine.
  const seed = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'image-builder', 'render-bake-seed.cjs'),
    'utf8',
  );
  assert.match(seed, /EASY_DOCS_URL: easyAddressDocsUrl/u);
  assert.match(screenLines('render_tall').join('\n'), /Curious how\?/u);
  assert.doesNotMatch(screenLines('render_short').join('\n'), /easy_docs_url/u);
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
  for (const screen of ['render_tall', 'render_short']) {
    const locked = screenLines(screen).join('\n').split('if [ "$vault_locked" = yes ]; then')[1].split('else')[0];
    assert.match(locked, /Locked\./u, screen);
    assert.match(locked, /recovery key/u, screen);
    assert.doesNotMatch(locked, /Installed and running/u, screen);
  }
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
