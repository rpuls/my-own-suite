import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

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
        }
      ]
    })
  ]
})


