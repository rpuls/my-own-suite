// The two ways AI and the suite meet, drawn left to right from who asks to who
// answers. Mint is always the suite and blue always the AI; the arrow takes the
// asker's colour.

function Suite() {
  return <>
    <path className="suite-ai-art-suite" d="M28 47 L56 25 L84 47 V76 a4 4 0 0 1 -4 4 H32 a4 4 0 0 1 -4 -4 Z" />
    <svg className="suite-ai-art-mark" height="28" viewBox="0 0 100 100" width="28" x="42" y="45">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="6.5">
        <path d="M50 36V24M50 64V76M36 50H24M64 50H76M36 36L26 26M64 36L74 26M36 64L26 74M64 64L74 74" />
        <rect height="26" rx="3" width="26" x="37" y="37" />
      </g>
      <g fill="currentColor">
        <circle cx="18" cy="18" r="13" /><circle cx="50" cy="16" r="13" /><circle cx="82" cy="18" r="13" />
        <circle cx="16" cy="50" r="13" /><circle cx="84" cy="50" r="13" />
        <circle cx="18" cy="82" r="13" /><circle cx="50" cy="84" r="13" /><circle cx="82" cy="82" r="13" />
      </g>
    </svg>
  </>;
}

function Chat() {
  return <>
    <path className="suite-ai-art-ai" d="M36 30 H76 a8 8 0 0 1 8 8 V62 a8 8 0 0 1 -8 8 H52 l-10 10 v-10 h-6 a8 8 0 0 1 -8 -8 V38 a8 8 0 0 1 8 -8 Z" />
    <path className="suite-ai-art-spark" d="M56 39 Q57.4 48.6 67 50 Q57.4 51.4 56 61 Q54.6 51.4 45 50 Q54.6 48.6 56 39 Z" />
  </>;
}

function Service() {
  return <g transform="translate(56 55) scale(1.14) translate(-57 -62)">
    <path className="suite-ai-art-ai" d="M40 80 a13 13 0 0 1 -1.5 -25.9 a18.5 18.5 0 0 1 35.5 -3.6 a15 15 0 0 1 -1 29.5 Z" />
    <path className="suite-ai-art-spark" d="M57 50 Q58.2 58.8 67 60 Q58.2 61.2 57 70 Q55.8 61.2 47 60 Q55.8 58.8 57 50 Z" />
  </g>;
}

export function AiDirectionPicture({ direction }: { direction: 'in' | 'out' }) {
  const inward = direction === 'in';
  return <svg aria-label={inward ? 'An AI chat reaching into your suite' : 'Your suite reaching out to an AI service'} className={`suite-ai-art suite-ai-art-${direction}`} role="img" viewBox="0 0 240 104">
    {inward ? <Chat /> : <Suite />}
    <path className="suite-ai-art-beam" d="M102 54 H130" />
    <path className="suite-ai-art-head" d="M130 46 l9 8 -9 8" />
    <g transform="translate(128 0)">{inward ? <Suite /> : <Service />}</g>
    <text x="56" y="100">{inward ? 'Your AI chat' : 'Your suite'}</text>
    <text x="184" y="100">{inward ? 'Your suite' : 'AI service'}</text>
  </svg>;
}
