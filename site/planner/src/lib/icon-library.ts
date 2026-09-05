import mos from '@/assets/my-own-suite-mark.svg?raw';

// The only bundled artwork is our own brand mark. Every other icon reaches
// the document at runtime — from the first-party staged Dashboard Icons set,
// the MOS app catalog, or a user upload — and is embedded as a data URL, so
// exports stay self-contained without third-party artwork in the repository.
export const rawIconLibrary: Record<string, { name: string; svg: string }> = {
  'my-own-suite-mark': { name: 'My Own Suite', svg: mos },
};

const encode = (value: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`;

export function sanitizeAndScopeSvg(raw: string, scope: string): string {
  const safeScope = scope.replace(/[^a-zA-Z0-9_-]/g, '-');
  let svg = raw
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!doctype[^[]*\[[\s\S]*?\]\s*>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\sxmlns:[\w-]+\s*=\s*(['"])&[^;]+;\1/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(
      /\s(?:href|xlink:href)\s*=\s*(['"])(?:https?:|javascript:)[\s\S]*?\1/gi,
      '',
    );
  const ids = [...svg.matchAll(/\bid\s*=\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  for (const id of ids) {
    const scoped = `${safeScope}-${id}`;
    svg = svg.replace(
      new RegExp(`(id\\s*=\\s*['"])${escapeRegExp(id)}(['"])`, 'g'),
      `$1${scoped}$2`,
    );
    svg = svg.replace(
      new RegExp(`url\\(#${escapeRegExp(id)}\\)`, 'g'),
      `url(#${scoped})`,
    );
    svg = svg.replace(
      new RegExp(`(["'])#${escapeRegExp(id)}(["'])`, 'g'),
      `$1#${scoped}$2`,
    );
  }
  const classes = [...svg.matchAll(/\bclass\s*=\s*['"]([^'"]+)['"]/g)].flatMap(
    (m) => m[1].split(/\s+/),
  );
  for (const className of new Set(classes)) {
    if (!className) continue;
    const scoped = `${safeScope}-${className}`;
    svg = svg.replace(
      new RegExp(
        `(class\\s*=\\s*['"][^'"]*)\\b${escapeRegExp(className)}\\b`,
        'g',
      ),
      `$1${scoped}`,
    );
    svg = svg.replace(
      new RegExp(`\\.${escapeRegExp(className)}\\b`, 'g'),
      `.${scoped}`,
    );
  }
  if (!/<svg\b/i.test(svg))
    throw new Error('The selected SVG does not contain a valid root element.');
  return svg;
}

export function libraryIconDataUrl(id: string, instance = id) {
  const found = rawIconLibrary[id];
  if (!found) return undefined;
  return encode(sanitizeAndScopeSvg(found.svg, `icon-${instance}`));
}

export function svgTextToDataUrl(raw: string, instance: string) {
  return encode(sanitizeAndScopeSvg(raw, `upload-${instance}`));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
