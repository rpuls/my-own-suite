import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The Apps docs section is generated from the app packages in apps/:
// one sidebar link per package, read from each manifest at build time,
// so new app packages appear in the docs automatically.
const appsRoot = fileURLToPath(new URL('../apps', import.meta.url))
const appSidebarLinks = readdirSync(appsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    try {
      const manifest = JSON.parse(readFileSync(`${appsRoot}/${entry.name}/manifest.json`, 'utf8'))
      return manifest?.id && manifest?.name
        ? [{ label: manifest.name, link: `/docs/apps/${manifest.id}/` }]
        : []
    } catch {
      return []
    }
  })
  .sort((a, b) => a.label.localeCompare(b.label))

export default defineConfig({
  site: 'https://myownsuite.org',
  output: 'static',
  vite: {
    server: {
      fs: {
        // The app catalog on the landing page and the app docs pages import
        // manifests, icons, and READMEs straight from the repo's apps/
        // packages at build time.
        allow: ['..']
      }
    }
  },
  integrations: [
    starlight({
      title: 'My Own Suite',
      description: 'Your own private cloud, made simple.',
      favicon: '/brand/favicon.ico',
      logo: { src: './public/brand/my-own-suite-mark.svg', alt: '' },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/rpuls/my-own-suite' }
      ],
      customCss: ['./generated/branding/mos.css', './src/styles/docs-theme.css'],
      sidebar: [
        {
          label: 'Start here',
          items: ['docs', 'docs/why-your-own-cloud', 'docs/getting-started']
        },
        {
          label: 'Install',
          items: [
            'docs/install/digitalocean',
            'docs/install/cloud-server',
            'docs/install/own-hardware',
            'docs/install/first-start'
          ]
        },
        {
          label: 'Everyday use',
          items: [
            'docs/guides/suite-manager',
            'docs/guides/apps',
            'docs/guides/customize-homepage',
            'docs/guides/https-domain',
            'docs/guides/backup-restore',
            'docs/guides/updates'
          ]
        },
        {
          label: 'Apps',
          items: [{ label: 'App catalog', link: '/docs/apps/' }, ...appSidebarLinks]
        },
        {
          label: 'Under the hood',
          items: [
            'docs/reference/architecture',
            'docs/reference/host-agents',
            'docs/reference/app-packages',
            'docs/privacy/how-we-assess'
          ]
        },
        {
          label: 'Legal',
          items: ['docs/terms', 'docs/privacy']
        }
      ]
    })
  ]
})
