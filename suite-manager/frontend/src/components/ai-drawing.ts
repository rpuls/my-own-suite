// Geometry of the AI direction drawings and the two AI icons. This module exists twice, byte for byte
// (test/unit/twin-files.test.cjs): suite-manager/frontend/src/components/ai-drawing.ts for
// AiDirectionPicture and Icon in ui.tsx, and site/src/lib/ai-drawing.ts for AiDirectionPicture.astro and
// IconSprite.astro. The look of the drawing is .mos-ai-pic in branding/styles/mos.css.

export type AiDirection = 'in' | 'out';
export type AiPictureSize = 'lg' | 'md' | 'sm';

export const AI_PICTURE_VIEWBOX: Record<AiPictureSize, string> = {
  lg: '0 0 240 104',
  md: '18 20 208 64',
  sm: '18 20 208 64',
};

export const AI_DIRECTION_WORDS: Record<AiDirection, { label: string; parties: readonly [string, string] }> = {
  in: { label: 'Your AI chat reaching into your suite', parties: ['Your AI chat', 'Your suite'] },
  out: { label: 'Your suite reaching out to an AI service', parties: ['Your suite', 'AI service'] },
};

// The asker is drawn at the origin, the answerer shifted right by `answerer`; party labels sit under each.
export const AI_PICTURE = {
  answerer: 'translate(128 0)',
  beam: 'M102 54 H130',
  chat: 'M36 30 H76 a8 8 0 0 1 8 8 V62 a8 8 0 0 1 -8 8 H52 l-10 10 v-10 h-6 a8 8 0 0 1 -8 -8 V38 a8 8 0 0 1 8 -8 Z',
  chatSpark: 'M56 39 Q57.4 48.6 67 50 Q57.4 51.4 56 61 Q54.6 51.4 45 50 Q54.6 48.6 56 39 Z',
  cloud: 'M40 80 a13 13 0 0 1 -1.5 -25.9 a18.5 18.5 0 0 1 35.5 -3.6 a15 15 0 0 1 -1 29.5 Z',
  cloudFit: 'translate(56 55) scale(1.14) translate(-57 -62)',
  cloudSpark: 'M57 50 Q58.2 58.8 67 60 Q58.2 61.2 57 70 Q55.8 61.2 47 60 Q55.8 58.8 57 50 Z',
  head: 'M130 46 l9 8 -9 8',
  house: 'M28 47 L56 25 L84 47 V76 a4 4 0 0 1 -4 4 H32 a4 4 0 0 1 -4 -4 Z',
  labelX: [56, 184],
  labelY: 100,
} as const;

// The MOS mark inside the house, in its own 100-unit box.
export const SUITE_MARK = {
  core: { height: 26, rx: 3, width: 26, x: 37, y: 37 },
  dots: [[18, 18], [50, 16], [82, 18], [16, 50], [84, 50], [18, 82], [50, 84], [82, 82]],
  place: { height: 28, width: 28, x: 42, y: 45 },
  rays: 'M50 36V24M50 64V76M36 50H24M64 50H76M36 36L26 26M64 36L74 26M36 64L26 74M64 64L74 74',
} as const;

// 24-unit line icons, stroked like every other icon in both icon sets.
export const AI_ICON_PATHS = {
  'chat-spark': [
    'M6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-7A2.5 2.5 0 0 1 6.5 4Z',
    'm12 6.9.75 2.1 2.1.75-2.1.75-.75 2.1-.75-2.1-2.1-.75 2.1-.75z',
  ],
  'chip-spark': [
    'M7.5 5h9A2.5 2.5 0 0 1 19 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 16.5v-9A2.5 2.5 0 0 1 7.5 5Z',
    'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
    'm12 8.6.85 2.55 2.55.85-2.55.85-.85 2.55-.85-2.55-2.55-.85 2.55-.85z',
  ],
} as const;

export type AiIconName = keyof typeof AI_ICON_PATHS;
