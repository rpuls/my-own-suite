export type RasterFormat = 'png' | 'webp';

export function serializeRoadmapSvg(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy
    .querySelectorAll('[data-preview-only]')
    .forEach((element) => element.remove());
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const xml = new XMLSerializer().serializeToString(copy);
  const parsed = new DOMParser().parseFromString(xml, 'image/svg+xml');
  if (parsed.querySelector('parsererror'))
    throw new Error('The generated SVG did not pass validation.');
  if (
    /\b(?:https?:)?\/\//i.test(
      xml
        .replace('http://www.w3.org/2000/svg', '')
        .replace('http://www.w3.org/1999/xlink', ''),
    )
  ) {
    throw new Error('The generated SVG contains an external resource.');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
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
  const source = serializeRoadmapSvg(svg);
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
