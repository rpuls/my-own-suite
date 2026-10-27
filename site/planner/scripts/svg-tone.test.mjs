import { describe, expect, it } from 'vitest';
import { svgTone } from './svg-tone.mjs';

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;

describe('svgTone', () => {
  it('reads an unpainted glyph as dark, because SVG fills default to black', () => {
    expect(svgTone(svg('<path d="M0 0h24v24z"/>'))).toBe('dark');
  });

  it('reads a white glyph as light, wherever the fill is declared', () => {
    expect(svgTone(svg('<path fill="#fff" d="M0 0h24v24z"/>'))).toBe('light');
    expect(svgTone(svg('<g fill="white"><path d="M0 0h24v24z"/></g>'))).toBe('light');
    expect(svgTone(svg('<path style="fill:#fafafa;fill-rule:evenodd" d="M0 0h24v24z"/>'))).toBe('light');
    expect(svgTone(svg('<style>.a{fill:#fff}</style><path class="a" d="M0 0h24v24z"/>'))).toBe('light');
  });

  it('reads a logo with any hue as colour', () => {
    expect(svgTone(svg('<path style="fill:#1ed760" d="M0 0h24v24z"/>'))).toBe('colour');
    expect(
      svgTone(svg('<defs><linearGradient id="g"><stop stop-color="#f00"/></linearGradient></defs><path fill="url(#g)" d="M0 0z"/>')),
    ).toBe('colour');
  });

  it('reads a logo that mixes light and dark marks as colour, since it reads on both canvases', () => {
    expect(svgTone(svg('<rect fill="#fff" width="24" height="24"/><path d="M4 4h16v16z"/>'))).toBe('colour');
  });

  it('ignores shapes that are never painted, such as clip paths', () => {
    expect(svgTone(svg('<clipPath id="c"><rect width="24" height="24"/></clipPath><path fill="#fff" d="M0 0z"/>'))).toBe(
      'light',
    );
  });
});
