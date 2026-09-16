export type RasterFormat = 'png' | 'webp';

// The three Open Sans faces the graphic draws with. An exported SVG is opened
// outside this page and a raster export is drawn in an isolated document, so
// neither can reach the site's own @font-face rules: the brand face has to
// travel inside the file or the export silently falls back to whatever sans
// the reader happens to have.
const BRAND_FACES = [400, 600, 800] as const;

let embeddedFaces: Promise<string> | null = null;

export function brandFontFaceCss(): Promise<string> {
  embeddedFaces ??= Promise.all(
    BRAND_FACES.map(async (weight) => {
      const response = await fetch(`/brand/fonts/open-sans-${weight}.ttf`);
      if (!response.ok) throw new Error(`Open Sans ${weight} is unavailable.`);
      const data = base64(await response.arrayBuffer());
      return `@font-face{font-family:'Open Sans';font-style:normal;font-weight:${weight};src:url(data:font/ttf;base64,${data}) format('truetype')}`;
    }),
  )
    .then((faces) => faces.join(''))
    .catch(() => {
      embeddedFaces = null;
      return '';
    });
  return embeddedFaces;
}

/** The serialized graphic with the brand face embedded, ready to hand to a
 *  file or to the rasterizer. */
export async function exportableRoadmapSvg(svg: SVGSVGElement) {
  return serializeRoadmapSvg(svg, await brandFontFaceCss());
}

function base64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function serializeRoadmapSvg(
  svg: SVGSVGElement,
  fontFaceCss = '',
): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy
    .querySelectorAll('[data-preview-only]')
    .forEach((element) => element.remove());
  // Editor affordances stay in the editor; the user's own label rides in the
  // aria-label and must not trip the external-reference scan below.
  copy.removeAttribute('id');
  for (const node of copy.querySelectorAll('[role="button"]')) {
    for (const name of ['role', 'tabindex', 'aria-label', 'class'])
      node.removeAttribute(name);
  }
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const style = copy.querySelector('style');
  if (fontFaceCss && style)
    style.textContent = `${fontFaceCss}${style.textContent ?? ''}`;
  const xml = new XMLSerializer().serializeToString(copy);
  const parsed = new DOMParser().parseFromString(xml, 'image/svg+xml');
  if (parsed.querySelector('parsererror'))
    throw new Error('The generated SVG did not pass validation.');
  const external = findExternalReference(parsed.documentElement);
  if (external)
    throw new Error(
      `The generated SVG references an external resource (${external}).`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}

// Exports must be self-contained: a remote reference would make the file phone
// home every time somebody opens it. Only places that actually fetch are
// checked — attribute values and stylesheet text — so a URL a user types into
// a title stays a harmless string.
function findExternalReference(root: Element): string | undefined {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const found = externalUrlIn(attribute.value);
      if (found) return found;
    }
    if (element.localName?.toLowerCase() === 'style') {
      const found = externalUrlIn(element.textContent ?? '');
      if (found) return found;
    }
  }
  return undefined;
}

// Embedded `data:` payloads are stripped before the scan: base64 uses "/" in
// its alphabet, so an inlined PNG regularly contains "//" and must not be
// mistaken for a remote host.
export function externalUrlIn(value: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/data:[^\s'")]*/gi, '')
    .match(/(?:https?:)?\/\/[^\s'")]+/i)?.[0];
}

export function downloadText(contents: string, filename: string, type: string) {
  const blob = new Blob([contents], { type });
  downloadBlob(blob, filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function rasterizeSvg(
  svg: SVGSVGElement,
  format: RasterFormat,
  filename: string,
) {
  const source = await exportableRoadmapSvg(svg);
  const width = Number(svg.getAttribute('width'));
  const height = Number(svg.getAttribute('height'));
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context)
      throw new Error('Your browser could not create an export canvas.');
    context.drawImage(image, 0, 0, width, height);
    const output = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(
        resolve,
        `image/${format}`,
        format === 'webp' ? 0.94 : undefined,
      ),
    );
    if (!output)
      throw new Error(`Your browser could not encode ${format.toUpperCase()}.`);
    downloadBlob(output, `${filename}.${format}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('The browser could not render the generated SVG.'));
    image.src = source;
  });
}
