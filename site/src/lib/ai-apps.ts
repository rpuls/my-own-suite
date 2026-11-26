// Which catalog apps meet AI, and how, read from the same package files Suite Manager reads, so the AI
// guides and the app pages follow the packages. COUSIN LOGIC: toolSpecOf in
// suite-manager/backend/src/ai/ai-tool-catalog.cjs.

import type { AiDirection, AiIconName } from './ai-drawing'
import { catalogApps, type CatalogApp } from './app-catalog'

// Each direction's Settings card and its guide, named the same in Settings, the sidebar and the app pages.
export const AI_SIDES: Record<AiDirection, { card: string; guide: string; guideTitle: string; icon: AiIconName }> = {
  in: { card: 'AI assistants', guide: '/docs/guides/ai-assistants/', guideTitle: 'Use your apps from your AI chat', icon: 'chat-spark' },
  out: { card: 'AI in your apps', guide: '/docs/guides/ai-in-your-apps/', guideTitle: 'Turn on AI features in your apps', icon: 'chip-spark' }
}

const toolFileModules = import.meta.glob('../../../apps/*/ai-tools.json', {
  eager: true,
  import: 'default'
}) as Record<string, any>

export type AiTool = { note: string; title: string }
export type AiApp = {
  app: CatalogApp
  asksService: boolean
  changeTools: AiTool[]
  // A privacy-review-invalidated advisory on the current version: the one signal, never the app id.
  experimental: boolean
  lookUpTools: AiTool[]
  offersTools: boolean
}

const LOOK_UP_KINDS = new Set(['read'])
const CHANGE_KINDS = new Set(['add', 'change'])

// Keyed by app id, like appReadmes: a package folder is named after its id.
const toolFiles: Record<string, any> = Object.fromEntries(
  Object.entries(toolFileModules).flatMap(([path, file]) => {
    const id = path.match(/apps[/\\]([^/\\]+)[/\\]ai-tools\.json$/)?.[1]
    return id ? [[id, file]] : []
  })
)

function toolsOfKinds(toolFile: any, kinds: Set<string>): AiTool[] {
  return Object.entries(toolFile?.tools ?? {}).flatMap(([name, entry]: [string, any]) => {
    const spec = typeof entry === 'string' ? { kind: entry } : entry ?? {}
    return kinds.has(spec.kind) ? [{ note: typeof spec.note === 'string' ? spec.note : '', title: typeof spec.title === 'string' ? spec.title : name }] : []
  })
}

function aiAppOf(app: CatalogApp): AiApp {
  const toolFile = toolFiles[app.id] ?? null
  return {
    app,
    asksService: app.asksAiService,
    changeTools: toolsOfKinds(toolFile, CHANGE_KINDS),
    experimental: app.advisories.some((advisory) => advisory.type === 'privacy-review-invalidated'),
    lookUpTools: toolsOfKinds(toolFile, LOOK_UP_KINDS),
    offersTools: app.mcpServer && Boolean(toolFile)
  }
}

export const aiApps: AiApp[] = catalogApps.map(aiAppOf).filter((entry) => entry.offersTools || entry.asksService)

export const aiAppFor = (id: string): AiApp | null => aiApps.find((entry) => entry.app.id === id) ?? null
