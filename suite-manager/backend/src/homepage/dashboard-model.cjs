'use strict';

const crypto = require('node:crypto');
const YAML = require('yaml');

const { HomepageConfigError, MANAGED_APP_HREF_PREFIX, PROTOCOLS } = require('../../../../shared/homepage-contract.cjs');

// The dashboard as an AI or a person thinks of it: groups holding tiles, in
// order, each tile with a kind. Operations change that model and are written
// back through the YAML document API, so comments and formatting survive and
// the `mos:` metadata behind app tiles and home services is never touched.

const GROUP_SEPARATOR = ' > ';
const LAYOUT_STYLES = new Set(['row', 'column']);
const MAX_COLUMNS = 8;
const ICON_PATTERN = /^(?:https?:\/\/\S+|\/\S+|[a-z0-9][a-z0-9._-]*)$/iu;

function fail(message, code = 'INVALID_DASHBOARD_CHANGE') {
  throw new HomepageConfigError(code, message, 400);
}

function parse(content, file) {
  const document = YAML.parseDocument(String(content ?? ''), { strict: true, uniqueKeys: true });
  if (document.errors.length) fail(`${file} is not valid YAML, so it cannot be changed this way. Fix it in Customize first.`, 'INVALID_HOMEPAGE_YAML');
  return document;
}

function plainText(value, label, max = 160) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\r\n]/u.test(text)) fail(`${label} must be one line of text, at most ${max} characters.`);
  return text;
}

function groupName(value) {
  const name = plainText(value, 'A group name', 80);
  if (name.includes(GROUP_SEPARATOR.trim())) fail(`A group name cannot contain "${GROUP_SEPARATOR.trim()}".`);
  return name;
}

function iconOf(value) {
  const icon = plainText(value, 'An icon');
  if (!ICON_PATTERN.test(icon)) fail('Use a Homepage icon name, such as jellyfin or mdi-link, or the web address of an image.');
  return icon;
}

function linkOf(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { fail('A link must be a full http or https address.'); }
  if (!PROTOCOLS.has(url.protocol.replace(':', '')) || url.username || url.password) fail('A link must be http or https, without a name or password in it.');
  return url.href;
}

function keyOf(pair) {
  return String(YAML.isScalar(pair?.key) ? pair.key.value : pair?.key ?? '');
}

function scalar(map, key) {
  const value = YAML.isMap(map) ? map.get(key) : undefined;
  return typeof value === 'string' ? value : value === undefined || value === null ? null : String(value);
}

function kindOf(config) {
  const mos = YAML.isMap(config) ? config.get('mos') : null;
  if (YAML.isMap(mos) && mos.get('proxy') !== undefined) return 'home-service';
  if (String(scalar(config, 'href') || '').startsWith(MANAGED_APP_HREF_PREFIX)) return 'app';
  return 'link';
}

// One service list item is either a tile ({ name: config }) or a subgroup
// ({ name: [ ...items ] }).
function itemOf(node) {
  const pair = YAML.isMap(node) ? node.items[0] : null;
  if (!pair) return null;
  return YAML.isSeq(pair.value) ? { kind: 'group', name: keyOf(pair), node, pair } : { kind: 'tile', name: keyOf(pair), node, pair };
}

class Dashboard {
  constructor({ services, settings }) {
    this.services = parse(services, 'services.template.yaml');
    this.settings = parse(settings, 'settings.yaml');
    if (this.services.contents === null) this.services.contents = this.services.createNode([]);
    if (!YAML.isSeq(this.services.contents)) fail('The dashboard is not a list of groups, so it cannot be changed this way. Fix it in Customize first.', 'INVALID_SERVICES_TEMPLATE');
    if (this.settings.contents === null) this.settings.contents = this.settings.createNode({});
    this.log = [];
  }

  topGroups() {
    return this.services.contents.items.map((node) => itemOf(node)).filter((item) => item?.kind === 'group');
  }

  // A group by "Name" or "Parent > Name".
  group(path) {
    const parts = String(path ?? '').split(GROUP_SEPARATOR).map((part) => part.trim()).filter(Boolean);
    if (!parts.length || parts.length > 2) fail(`Name a group as "Group" or "Group${GROUP_SEPARATOR}Subgroup".`);
    const top = this.topGroups().find((item) => item.name === parts[0]);
    if (!top) fail(`There is no group called "${parts[0]}".`, 'DASHBOARD_GROUP_NOT_FOUND');
    if (parts.length === 1) return { ...top, parentSeq: this.services.contents, path: top.name, top: true };
    const sub = top.pair.value.items.map(itemOf).find((item) => item?.kind === 'group' && item.name === parts[1]);
    if (!sub) fail(`"${top.name}" has no subgroup called "${parts[1]}".`, 'DASHBOARD_GROUP_NOT_FOUND');
    return { ...sub, parentSeq: top.pair.value, path: `${top.name}${GROUP_SEPARATOR}${sub.name}`, top: false };
  }

  allGroups() {
    return this.topGroups().flatMap((top) => [
      { ...top, path: top.name },
      ...top.pair.value.items.map(itemOf).filter((item) => item?.kind === 'group').map((sub) => ({ ...sub, path: `${top.name}${GROUP_SEPARATOR}${sub.name}` })),
    ]);
  }

  tile(name, inGroup) {
    const groups = inGroup ? [this.group(inGroup)] : this.allGroups();
    const found = groups.flatMap((group) => group.pair.value.items.map(itemOf)
      .filter((item) => item?.kind === 'tile' && item.name === name)
      .map((item) => ({ ...item, group })));
    if (!found.length) fail(`There is no tile called "${name}"${inGroup ? ` in "${inGroup}"` : ''}.`, 'DASHBOARD_TILE_NOT_FOUND');
    if (found.length > 1) fail(`More than one tile is called "${name}". Say which group it is in.`, 'DASHBOARD_TILE_AMBIGUOUS');
    return { ...found[0], kind: kindOf(found[0].pair.value) };
  }

  insertAt(seq, node, position) {
    const index = position === undefined || position === null ? seq.items.length : Math.max(0, Math.min(seq.items.length, Number.parseInt(position, 10) || 0));
    seq.items.splice(index, 0, node);
  }

  layout() {
    const layout = this.settings.get('layout');
    if (layout === undefined || layout === null) {
      this.settings.set('layout', this.settings.createNode({}));
      return this.settings.get('layout');
    }
    if (!YAML.isMap(layout)) fail('The layout in settings.yaml is not a mapping, so it cannot be changed this way.');
    return layout;
  }

  model() {
    const tileOf = (item) => {
      const config = item.pair.value;
      const kind = kindOf(config);
      return {
        description: scalar(config, 'description'),
        icon: scalar(config, 'icon'),
        kind,
        ...(kind === 'link' ? { link: scalar(config, 'href') } : {}),
        name: item.name,
      };
    };
    const layout = YAML.isMap(this.settings.get('layout')) ? this.settings.get('layout').toJSON() : {};
    const groupOf = (group, depth) => ({
      ...(depth === 1 && layout[group.name] ? { layout: { columns: layout[group.name].columns ?? null, style: layout[group.name].style ?? null } } : {}),
      items: group.pair.value.items.map(itemOf).filter(Boolean).map((item) => (item.kind === 'group'
        ? { group: groupOf(item, depth + 1) }
        : { tile: tileOf(item) })),
      name: group.name,
    });
    return {
      columns: this.settings.get('columns') ?? null,
      groups: this.topGroups().map((group) => groupOf(group, 1)),
      title: this.settings.get('title') ?? null,
    };
  }

  // ---- operations ----

  move({ position, tile, to, from }) {
    const found = this.tile(plainText(tile, 'The tile'), from);
    const target = this.group(to);
    if (target.pair.value.items.some((node) => node !== found.node && itemOf(node)?.kind === 'tile' && itemOf(node).name === found.name)) {
      fail(`"${target.path}" already has a tile called "${found.name}".`);
    }
    const source = found.group.pair.value;
    source.items.splice(source.items.indexOf(found.node), 1);
    this.insertAt(target.pair.value, found.node, position);
    this.log.push(`Moved ${found.name} to ${target.path}`);
  }

  edit({ description, from, icon, link, name, tile }) {
    const found = this.tile(plainText(tile, 'The tile'), from);
    const config = found.pair.value;
    const changes = [];
    if (name !== undefined) {
      const next = plainText(name, 'A tile name');
      if (found.group.pair.value.items.some((node) => node !== found.node && itemOf(node)?.name === next)) fail(`"${found.group.path}" already has something called "${next}".`);
      found.pair.key = this.services.createNode(next);
      changes.push(`renamed it ${next}`);
    }
    if (description !== undefined) { config.set('description', plainText(description, 'A description')); changes.push('new description'); }
    if (icon !== undefined) { config.set('icon', iconOf(icon)); changes.push('new icon'); }
    if (link !== undefined) {
      if (found.kind !== 'link') fail(`${found.name} is ${found.kind === 'app' ? 'an app MOS placed' : 'a home service'}; its address is managed by MOS and cannot be changed here.`, 'DASHBOARD_TILE_MANAGED');
      config.set('href', linkOf(link));
      changes.push('new link');
    }
    if (!changes.length) fail('Say what to change: name, description, icon or link.');
    this.log.push(`Edited ${found.name}: ${changes.join(', ')}`);
  }

  add_link({ description, icon, link, name, position, to }) {
    const target = this.group(to);
    const tileName = plainText(name, 'A tile name');
    if (target.pair.value.items.some((node) => itemOf(node)?.name === tileName)) fail(`"${target.path}" already has something called "${tileName}".`);
    const node = this.services.createNode({
      [tileName]: {
        description: plainText(description, 'A description'),
        href: linkOf(link),
        icon: iconOf(icon ?? 'mdi-link'),
        mos: { id: crypto.randomUUID(), managedBy: 'user' },
      },
    });
    this.insertAt(target.pair.value, node, position);
    this.log.push(`Added ${tileName} to ${target.path}`);
  }

  remove_link({ from, tile }) {
    const found = this.tile(plainText(tile, 'The tile'), from);
    if (found.kind !== 'link') {
      fail(found.kind === 'app'
        ? `${found.name} belongs to an installed app. It goes away when the app is uninstalled; it can be moved, not removed.`
        : `${found.name} is a home service with its own address; remove it in Customize.`, 'DASHBOARD_TILE_MANAGED');
    }
    const source = found.group.pair.value;
    source.items.splice(source.items.indexOf(found.node), 1);
    this.log.push(`Removed ${found.name}`);
  }

  add_group({ name, parent, position }) {
    const newName = groupName(name);
    const seq = parent ? this.group(parent) : null;
    if (seq && !seq.top) fail('Groups can be nested only one level deep.');
    const siblings = seq ? seq.pair.value : this.services.contents;
    if (siblings.items.some((node) => itemOf(node)?.name === newName)) fail(`There is already something called "${newName}" there.`);
    this.insertAt(siblings, this.services.createNode({ [newName]: [] }), position);
    this.log.push(`Added the group ${newName}`);
  }

  rename_group({ group, name }) {
    const found = this.group(group);
    const newName = groupName(name);
    if (found.parentSeq.items.some((node) => node !== found.node && itemOf(node)?.name === newName)) fail(`There is already something called "${newName}" there.`);
    found.pair.key = this.services.createNode(newName);
    if (found.top && YAML.isMap(this.settings.get('layout'))) {
      const layout = this.settings.get('layout');
      const entry = layout.items.find((pair) => keyOf(pair) === found.name);
      if (entry) entry.key = this.settings.createNode(newName);
    }
    this.log.push(`Renamed the group ${found.name} to ${newName}`);
  }

  move_group({ group, position }) {
    const found = this.group(group);
    found.parentSeq.items.splice(found.parentSeq.items.indexOf(found.node), 1);
    this.insertAt(found.parentSeq, found.node, position);
    this.log.push(`Moved the group ${found.name}`);
  }

  remove_group({ group }) {
    const found = this.group(group);
    if (found.pair.value.items.length) fail(`"${found.path}" is not empty. Move or remove what is in it first.`);
    found.parentSeq.items.splice(found.parentSeq.items.indexOf(found.node), 1);
    if (found.top && YAML.isMap(this.settings.get('layout'))) this.settings.get('layout').delete(found.name);
    this.log.push(`Removed the group ${found.name}`);
  }

  set_layout({ columns, group, style }) {
    const found = this.group(group);
    if (!found.top) fail('Layout is set per top-level group.');
    const layout = this.layout();
    let entry = layout.get(found.name);
    if (!YAML.isMap(entry)) {
      layout.set(found.name, this.settings.createNode({}));
      entry = layout.get(found.name);
    }
    const changes = [];
    if (style !== undefined) {
      if (!LAYOUT_STYLES.has(style)) fail('A layout style is "row" (tiles side by side) or "column" (tiles stacked).');
      entry.set('style', style);
      changes.push(style === 'row' ? 'side by side' : 'stacked');
    }
    if (columns !== undefined) {
      const count = Number(columns);
      if (!Number.isInteger(count) || count < 1 || count > MAX_COLUMNS) fail(`Columns must be a whole number from 1 to ${MAX_COLUMNS}.`);
      entry.set('columns', count);
      changes.push(`${count} column${count === 1 ? '' : 's'}`);
    }
    if (!changes.length) fail('Say the style, the columns, or both.');
    this.log.push(`Laid out ${found.name}: ${changes.join(', ')}`);
  }

  set_title({ title }) {
    const text = plainText(title, 'The title', 80);
    this.settings.set('title', text);
    this.log.push(`Set the title to ${text}`);
  }

  apply(operations) {
    if (!Array.isArray(operations) || !operations.length) fail('Send at least one operation.');
    if (operations.length > 50) fail('Send at most 50 operations at once.');
    operations.forEach((operation, index) => {
      const name = String(operation?.op ?? '');
      if (!OPERATIONS.has(name)) fail(`Operation ${index + 1} has no known "op". Use one of: ${[...OPERATIONS].join(', ')}.`);
      try {
        this[name](operation);
      } catch (error) {
        if (error instanceof HomepageConfigError) throw new HomepageConfigError(error.code, `Operation ${index + 1} (${name}): ${error.message} Nothing was changed.`, error.statusCode);
        throw error;
      }
    });
    return { services: String(this.services), settings: String(this.settings), summary: this.log };
  }
}

const OPERATIONS = new Set(['move', 'edit', 'add_link', 'remove_link', 'add_group', 'rename_group', 'move_group', 'remove_group', 'set_layout', 'set_title']);

// Restoring an older dashboard must not bring back a tile of an app that is no
// longer installed, nor drop the tile of one installed since: app tiles follow
// the apps, whatever the checkpoint held.
function reconcileAppTiles({ current, restored, installedIds }) {
  const restoredDoc = parse(restored, 'services.template.yaml');
  const currentDoc = parse(current, 'services.template.yaml');
  const appIdOf = (item) => {
    if (item?.kind !== 'tile' || kindOf(item.pair.value) !== 'app') return null;
    const mos = item.pair.value.get('mos');
    return YAML.isMap(mos) ? String(mos.get('id') ?? '') : null;
  };
  const lists = (document) => {
    const found = [];
    for (const top of (YAML.isSeq(document.contents) ? document.contents.items : []).map(itemOf).filter((item) => item?.kind === 'group')) {
      found.push({ name: top.name, seq: top.pair.value });
      for (const sub of top.pair.value.items.map(itemOf).filter((item) => item?.kind === 'group')) found.push({ name: sub.name, parent: top.name, seq: sub.pair.value });
    }
    return found;
  };
  const kept = new Set();
  for (const { seq } of lists(restoredDoc)) {
    seq.items = seq.items.filter((node) => {
      const id = appIdOf(itemOf(node));
      if (id === null) return true;
      if (!installedIds.has(id)) return false;
      kept.add(id);
      return true;
    });
  }
  for (const list of lists(currentDoc)) {
    for (const node of list.seq.items) {
      const id = appIdOf(itemOf(node));
      if (id === null || kept.has(id) || !installedIds.has(id)) continue;
      let target = lists(restoredDoc).find((candidate) => candidate.name === list.name && candidate.parent === list.parent)
        || lists(restoredDoc).find((candidate) => candidate.name === (list.parent || list.name) && !candidate.parent);
      if (!target) {
        if (!YAML.isSeq(restoredDoc.contents)) restoredDoc.contents = restoredDoc.createNode([]);
        restoredDoc.contents.items.push(restoredDoc.createNode({ [list.parent || list.name]: [] }));
        target = lists(restoredDoc).at(-1);
      }
      target.seq.items.push(restoredDoc.createNode(node.toJSON()));
      kept.add(id);
    }
  }
  return String(restoredDoc);
}

function homeServiceSubdomains(content) {
  const found = new Set();
  let document;
  try { document = YAML.parse(String(content ?? '')); } catch { return found; }
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const subdomain = value.mos?.proxy?.subdomain;
      if (typeof subdomain === 'string') found.add(subdomain.trim().toLowerCase());
      Object.values(value).forEach(walk);
    }
  };
  walk(document);
  return found;
}

module.exports = { Dashboard, GROUP_SEPARATOR, homeServiceSubdomains, OPERATIONS, reconcileAppTiles };
