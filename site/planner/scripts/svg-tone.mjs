// Classifies a logo file by the colours it paints with, so the planner can
// tell a single-colour glyph (which needs its light or dark sibling on the
// other canvas) from a coloured logo (which reads on both and is never swapped).

const NAMED = { black: [0, 0, 0], currentcolor: [0, 0, 0], white: [255, 255, 255] };
const SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'use']);
const UNPAINTED_CONTAINERS = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'lineargradient', 'radialgradient']);

function parseColour(value) {
  const colour = value.trim().toLowerCase();
  if (NAMED[colour]) return NAMED[colour];
  // Upstream has nine-digit hex values that browsers read by their first six.
  const hex = colour.match(/^#([0-9a-f]{3,9})$/)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  const rgb = colour.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return rgb.slice(1, 4).map(Number);
  return undefined;
}

function declaration(css, name) {
  return css?.match(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, 'i'))?.[1];
}

function classRules(svg) {
  const stylesheet = [...svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('');
  const rules = new Map();
  for (const [, selectors, body] of stylesheet.matchAll(/([^{}]+)\{([^}]*)\}/g))
    for (const [, className] of selectors.matchAll(/\.([\w-]+)/g))
      rules.set(className, `${rules.get(className) ?? ''};${body}`);
  return rules;
}

// CSS order: inline style, then class rules, then the presentation attribute.
function property(attributes, name, rules) {
  const style = attributes.match(/\sstyle\s*=\s*["']([^"']*)/i)?.[1];
  const classes = attributes.match(/\sclass\s*=\s*["']([^"']*)/i)?.[1].split(/\s+/) ?? [];
  const fromClass = classes.map((c) => declaration(rules.get(c), name)).findLast(Boolean);
  return (
    declaration(style, name) ?? fromClass ?? attributes.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)`, 'i'))?.[1]
  );
}

// Every colour the file actually paints: the inherited or default (black)
// fill and stroke of each visible shape, plus gradient stops.
function paints(svg) {
  const found = [];
  for (const match of svg.matchAll(/stop-color\s*(?:=\s*["']|:\s*)([^"';}]+)/gi)) found.push(match[1]);
  const rules = classRules(svg);

  const stack = [{ fill: 'black', stroke: 'none', hidden: false }];
  for (const [, closing, rawName, attributes, selfClosing] of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const name = rawName.toLowerCase();
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1];
    const state = {
      fill: property(attributes, 'fill', rules) ?? parent.fill,
      stroke: property(attributes, 'stroke', rules) ?? parent.stroke,
      hidden: parent.hidden || UNPAINTED_CONTAINERS.has(name),
    };
    if (SHAPES.has(name) && !state.hidden) found.push(state.fill, state.stroke);
    if (!selfClosing) stack.push(state);
  }
  return found;
}

// 'light' or 'dark' for a single-colour logo; 'colour' when any paint carries
// hue or the logo mixes light and dark marks.
export function svgTone(svg) {
  let light = false;
  let dark = false;
  for (const value of paints(svg)) {
    const colour = parseColour(value);
    if (!colour) continue;
    const [r, g, b] = colour;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 48) return 'colour';
    if ((r + g + b) / 3 >= 128) light = true;
    else dark = true;
  }
  if (light === dark) return 'colour';
  return light ? 'light' : 'dark';
}
