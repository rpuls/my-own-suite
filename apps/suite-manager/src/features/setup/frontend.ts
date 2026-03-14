import fs from 'node:fs';
import path from 'node:path';

const frontendDistRoot = './frontend/dist';
const frontendIndexPath = path.join(process.cwd(), 'frontend', 'dist', 'index.html');

export function hasBuiltFrontend(): boolean {
  return fs.existsSync(frontendIndexPath);
}

export function getFrontendStaticRoot(): string {
  return frontendDistRoot;
}

export function renderFrontendHtml(setupBasePath: string): string {
  const html = fs.readFileSync(frontendIndexPath, 'utf8');
  const bootstrapScript = `<script>window.__MOS_SUITE_MANAGER_SETUP_BASE_PATH__ = ${JSON.stringify(setupBasePath)};</script>`;
  return html.replace('</head>', `${bootstrapScript}</head>`);
}
