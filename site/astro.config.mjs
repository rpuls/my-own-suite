import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import mermaid from 'astro-mermaid'

const umamiAnalyticsScript = {
  tag: 'script',
  attrs: {
    defer: true,
    src: 'https://umami-my.up.railway.app/script.js',
    'data-website-id': '0fe6ba10-ae90-46d2-ae05-f488a8716fe2'
  }
}

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
      favicon: '/favicon.ico',
      logo: {
        src: './src/assets/brand/my-own-suite-mark.png',
        alt: 'My Own Suite logo'
      },
      head: [umamiAnalyticsScript],
      customCss: ['./src/styles/docs-theme.css'],
      sidebar: [
        {
          label: 'Docs',
          items: [
            'docs',
            'docs/why-your-own-cloud',
            'docs/getting-started',
            'docs/deploy-on-railway',
            'docs/deploy-on-vps',
            'docs/deploy-on-your-own-hardware',
            'docs/optional-email-with-smtp'
          ]
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


