import { describe, expect, it } from 'vitest';
import { externalUrlIn } from './roadmap-export';

describe('externalUrlIn', () => {
  it('accepts an embedded PNG whose base64 contains a double slash', () => {
    expect(
      externalUrlIn('data:image/png;base64,iVBORw0KGgoAAAA//wBAQSuVORK5CYII='),
    ).toBeUndefined();
  });

  it('accepts an embedded SVG data URL', () => {
    expect(
      externalUrlIn('data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%201%201%22%3E'),
    ).toBeUndefined();
  });

  it('accepts a plain local reference', () => {
    expect(externalUrlIn('#gradient-3')).toBeUndefined();
    expect(externalUrlIn('url(#clip-a)')).toBeUndefined();
  });

  it('reports an absolute remote reference', () => {
    expect(externalUrlIn('https://cdn.example.com/logo.svg')).toBe(
      'https://cdn.example.com/logo.svg',
    );
  });

  it('reports a protocol-relative reference', () => {
    expect(externalUrlIn('//cdn.example.com/logo.svg')).toBe(
      '//cdn.example.com/logo.svg',
    );
  });

  it('reports a remote font behind an embedded payload', () => {
    expect(
      externalUrlIn(
        "@font-face{src:url(data:font/woff2;base64,d09GMgAB//AA) url(https://fonts.example.com/i.woff2)}",
      ),
    ).toBe('https://fonts.example.com/i.woff2');
  });
});
