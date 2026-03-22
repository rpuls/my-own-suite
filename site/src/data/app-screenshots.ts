import type { ImageMetadata } from 'astro'

import onlyofficeScreenshotExample from '../assets/screenshots/onlyoffice/onlyoffice-screenshot-example.png'
import seafileScreenshotExample from '../assets/screenshots/seafile/seafile-screenshot-example.png'

export interface AppScreenshot {
  id: string
  src: ImageMetadata
  alt: string
  title: string
  caption: string
  group?: string
  hiddenFromGrid?: boolean
  lead?: boolean
}

export const seafileScreenshots: AppScreenshot[] = [
  {
    id: 'seafile-example',
    src: seafileScreenshotExample,
    alt: 'Seafile screenshot example showing the private cloud file browser in use.',
    title: 'Seafile inside My Own Suite',
    caption: 'This example screenshot shows the private cloud drive experience people get when browsing and organizing files in the suite.',
    lead: true
  }
]

export const onlyofficeScreenshots: AppScreenshot[] = [
  {
    id: 'onlyoffice-example',
    src: onlyofficeScreenshotExample,
    alt: 'ONLYOFFICE screenshot example showing browser-based document editing inside My Own Suite.',
    title: 'ONLYOFFICE inside My Own Suite',
    caption: 'This example screenshot shows the in-browser editing experience for documents, spreadsheets, and presentations.',
    lead: true
  }
]
