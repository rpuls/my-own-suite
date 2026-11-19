// Recognises well-known AIs by the name the owner gave them, so their avatar
// wears the brand's colours: colours and initials only, never a logo.

export type AiBrand = {
  background: string;
  id: string;
  // Where the brand's own mark reads as letters, those letters, whatever the owner typed.
  initials?: string;
  ink: string;
  keywords: string[];
  label: string;
};

const WHITE = '#ffffff';
const BLACK = '#0d0d0d';

// First match wins, so a more specific brand comes before one whose keyword it contains.
export const AI_BRANDS: AiBrand[] = [
  { background: '#d97757', id: 'claude', ink: WHITE, keywords: ['claude', 'anthropic'], label: 'Claude' },
  { background: '#10a37f', id: 'chatgpt', ink: WHITE, keywords: ['chatgpt', 'gpt'], label: 'ChatGPT' },
  { background: BLACK, id: 'openai', ink: WHITE, keywords: ['openai', 'codex'], label: 'OpenAI' },
  { background: 'linear-gradient(135deg, #4285f4 0%, #9b72cb 55%, #d96570 100%)', id: 'gemini', ink: WHITE, keywords: ['gemini', 'gemma', 'bard'], label: 'Gemini' },
  { background: 'linear-gradient(135deg, #0078d4 0%, #2bb5a8 45%, #8661c5 100%)', id: 'copilot', ink: WHITE, keywords: ['copilot'], label: 'Copilot' },
  { background: 'linear-gradient(135deg, #6d5dfc 0%, #3a2fb8 100%)', id: 'lmstudio', initials: 'LM', ink: WHITE, keywords: ['lmstudio'], label: 'LM Studio' },
  { background: WHITE, id: 'ollama', ink: BLACK, keywords: ['ollama'], label: 'Ollama' },
  { background: BLACK, id: 'openwebui', ink: WHITE, keywords: ['openwebui'], label: 'Open WebUI' },
  { background: 'linear-gradient(135deg, #ffd800 0%, #fa500f 55%, #e10500 100%)', id: 'mistral', ink: WHITE, keywords: ['mistral', 'lechat'], label: 'Mistral' },
  { background: '#0668e1', id: 'llama', ink: WHITE, keywords: ['llama', 'metaai'], label: 'Meta Llama' },
  { background: '#20808d', id: 'perplexity', ink: WHITE, keywords: ['perplexity'], label: 'Perplexity' },
  { background: BLACK, id: 'grok', ink: WHITE, keywords: ['grok', 'xai'], label: 'Grok' },
  { background: '#4d6bfe', id: 'deepseek', ink: WHITE, keywords: ['deepseek'], label: 'DeepSeek' },
  { background: '#615ced', id: 'qwen', ink: WHITE, keywords: ['qwen'], label: 'Qwen' },
  { background: BLACK, id: 'cursor', ink: WHITE, keywords: ['cursor'], label: 'Cursor' },
  { background: '#ea4b71', id: 'n8n', ink: WHITE, keywords: ['n8n'], label: 'n8n' },
  { background: '#18bcf2', id: 'homeassistant', ink: WHITE, keywords: ['homeassistant'], label: 'Home Assistant' },
];

function squashed(text: string) {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/gu, '');
}

// Optimal string alignment distance: one insert, delete, substitute or swap of neighbours each counts 1.
function distance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

// From five letters on, one typo is forgiven.
function containsNearly(text: string, keyword: string) {
  if (keyword.length < 5) return false;
  for (let size = keyword.length - 1; size <= keyword.length + 1; size += 1) {
    for (let start = 0; start + size <= text.length; start += 1) {
      if (distance(text.slice(start, start + size), keyword) <= 1) return true;
    }
  }
  return false;
}

// An exact keyword anywhere beats a typo-forgiven one, so "Llama" never reads as a misspelt "Ollama".
export function brandOf(name: string): AiBrand | null {
  const text = squashed(name);
  return AI_BRANDS.find((brand) => brand.keywords.some((keyword) => text.includes(keyword)))
    ?? AI_BRANDS.find((brand) => brand.keywords.some((keyword) => containsNearly(text, keyword)))
    ?? null;
}
