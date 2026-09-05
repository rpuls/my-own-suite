import { describe, expect, it } from 'vitest';
import {
  cloneRoadmap,
  initialRoadmap,
  validateRoadmap,
} from './roadmap-model';
import { decodeShareFragment, encodeShareFragment } from './share-link';

describe('share links', () => {
  it('round-trips a plan through the URL fragment', () => {
    const doc = cloneRoadmap(initialRoadmap);
    doc.metadata.title = 'Shared journey';
    doc.timeline.viewDate = '2026-09-05';
    const fragment = encodeShareFragment(doc);
    expect(fragment.startsWith('#plan=')).toBe(true);
    const decoded = decodeShareFragment(fragment);
    const expected = validateRoadmap(doc);
    expect(expected.ok).toBe(true);
    if (expected.ok) expect(decoded).toEqual(expected.value);
  });

  it('drops re-hydratable artwork but keeps uploaded artwork', () => {
    const doc = cloneRoadmap(initialRoadmap);
    doc.migrations[0].source.icons[0].dataUrl = 'data:image/svg+xml,<svg/>';
    doc.migrations[0].replacement.icons.push({
      id: 'upload-1',
      name: 'My icon',
      source: 'upload',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    const decoded = decodeShareFragment(encodeShareFragment(doc));
    expect(decoded).not.toBeNull();
    expect(decoded!.migrations[0].source.icons[0].dataUrl).toBeUndefined();
    expect(decoded!.migrations[0].replacement.icons.at(-1)!.dataUrl).toBe(
      'data:image/png;base64,AAAA',
    );
  });

  it('rejects fragments that are not plans', () => {
    expect(decodeShareFragment('')).toBeNull();
    expect(decodeShareFragment('#other=abc')).toBeNull();
    expect(decodeShareFragment('#plan=not-a-real-payload')).toBeNull();
  });
});
