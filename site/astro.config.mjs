import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://myownsuite.org',
  output: 'static',
  integrations: [
    starlight({
      title: 'My Own Suite',
      description: 'Your Big Tech exit kit.',
      customCss: ['./src/styles/docs-theme.css'],
      sidebar: [
        {
          label: 'Docs',
          items: ['docs', 'docs/getting-started']
        }
      ]
    })
  ]
})


