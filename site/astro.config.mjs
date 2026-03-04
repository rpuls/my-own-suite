import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import mermaid from 'astro-mermaid'

export default defineConfig({
  site: 'https://myownsuite.org',
  output: 'static',
  vite: {
    server: {
      fs: {
        allow: ['..']
      }
    }
  },
  integrations: [
    mermaid({
      theme: 'base',
      autoTheme: false,
      mermaidConfig: {
        flowchart: {
          useMaxWidth: false
        },
        themeVariables: {
          fontSize: 18,
          edgeLabelBackground: '#00000000'
        }
      }
    }),
    starlight({
      title: 'My Own Suite',
      description: 'Your Big Tech exit kit.',
      customCss: ['./src/styles/docs-theme.css'],
      sidebar: [
        {
          label: 'Docs',
          items: ['docs', 'docs/getting-started']
        },
        {
          label: 'Apps',
          items: [
            'docs/apps/homepage',
            'docs/apps/seafile',
            'docs/apps/onlyoffice',
            'docs/apps/immich',
            'docs/apps/stirling-pdf',
            'docs/apps/radicale',
            'docs/apps/vaultwarden'
          ]
        },
        {
          label: 'Project',
          items: ['docs/releases']
        }
      ]
    })
  ]
})


