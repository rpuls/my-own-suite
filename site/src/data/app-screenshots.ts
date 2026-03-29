import type { ImageMetadata } from 'astro'

import homepageDashboard from '../assets/screenshots/homepage/my-own-suite-homepage-dashboard-private-cloud-launchpad.png'
import onlyofficeDocumentAi from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-document-editor-ai-writing-spell-check-productivity.png'
import onlyofficeDocumentComments from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-document-editor-comments-review-workflow-collaboration.png'
import onlyofficeDocumentFormatting from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-document-editor-formatting-toolbar-word-processing.png'
import onlyofficeDocumentCollaboration from '../assets/screenshots/onlyoffice/onlyoffice-open-source-self-hosted-office-suite-word-document-real-time-collaboration-editor.png'
import onlyofficeMarkdownDownload from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-markdown-editor-download-export-workflow.png'
import onlyofficeMarkdownHeading from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-markdown-editor-heading-formatting-knowledge-base-writing.png'
import onlyofficeMarkdownHyperlink from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-markdown-editor-hyperlink-insert-content-authoring.png'
import onlyofficePresentationCollaboration from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-presentation-editor-real-time-collaboration-slide-deck-workflow.png'
import onlyofficePresentationText from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-presentation-editor-slide-text-editing-design-workflow.png'
import onlyofficePresentationTemplate from '../assets/screenshots/onlyoffice/onlyoffice-open-source-self-hosted-office-suite-presentation-design-template-editor.png'
import onlyofficePresentationTransition from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-presentation-editor-slide-transitions-animation-controls.png'
import onlyofficeSpreadsheetValidation from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-spreadsheet-editor-data-validation-business-workflow.png'
import onlyofficeSpreadsheetPassword from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-spreadsheet-editor-password-protection-security-controls.png'
import onlyofficeSpreadsheetFunction from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-spreadsheet-editor-insert-function-formula-productivity.png'
import onlyofficeSpreadsheetCollaboration from '../assets/screenshots/onlyoffice/onlyoffice-open-source-self-hosted-office-suite-spreadsheet-real-time-collaboration-editor.png'
import onlyofficeSpreadsheetHistory from '../assets/screenshots/onlyoffice/onlyoffice-private-cloud-spreadsheet-editor-version-history-audit-recovery.png'
import railwayPublicUrl from '../assets/screenshots/railway/railway-my-own-suite-public-url-open-deployment-domain-hosted-private-cloud.png'
import railwayServiceOverview from '../assets/screenshots/railway/railway-my-own-suite-hosted-private-cloud-template-service-map-overview.png'
import seafilePermissions from '../assets/screenshots/seafile/seafile-secure-private-cloud-file-access-permissions-sharing-controls-self-hosted.png'
import seafileBulkCopy from '../assets/screenshots/seafile/seafile-private-cloud-bulk-copy-file-management-productivity-workflow.png'
import seafileBulkDownload from '../assets/screenshots/seafile/seafile-private-cloud-bulk-download-document-library-export-self-hosted.png'
import seafileDownloadMenu from '../assets/screenshots/seafile/seafile-private-cloud-download-file-action-menu-document-management.png'
import seafileDownloadContext from '../assets/screenshots/seafile/seafile-private-cloud-download-file-context-menu-team-workspace-storage.png'
import seafileDownloadToolbar from '../assets/screenshots/seafile/seafile-private-cloud-download-file-toolbar-workspace-file-browser.png'
import seafileHistory from '../assets/screenshots/seafile/seafile-open-source-private-cloud-document-version-history-file-recovery-audit-trail.png'
import seafileProperties from '../assets/screenshots/seafile/seafile-self-hosted-cloud-storage-file-properties-details-metadata-management.png'
import seafileGrid from '../assets/screenshots/seafile/seafile-open-source-self-hosted-private-cloud-drive-file-library-grid-view-collaboration-dashboard.png'
import seafileLibraryHistory from '../assets/screenshots/seafile/seafile-private-cloud-library-history-settings-retention-self-hosted-storage.png'
import seafileNewFolder from '../assets/screenshots/seafile/seafile-private-cloud-create-new-folder-organize-files-team-workspace.png'
import seafileShareDialog from '../assets/screenshots/seafile/seafile-private-cloud-share-file-link-collaboration-dialog-self-hosted.png'
import seafileShareMenu from '../assets/screenshots/seafile/seafile-open-source-self-hosted-private-cloud-drive-secure-file-sharing-collaboration-permissions.png'
import seafileStarred from '../assets/screenshots/seafile/seafile-private-cloud-starred-library-favorites-quick-access-dashboard.png'

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

function pickScreenshots(items: AppScreenshot[], ids: string[]): AppScreenshot[] {
  const lookup = new Map(items.map((item) => [item.id, item]))
  return ids
    .map((id) => lookup.get(id))
    .filter((item): item is AppScreenshot => Boolean(item))
}

function pickGalleryBundles(items: AppScreenshot[], previewIds: string[]): AppScreenshot[] {
  const previewItems = pickScreenshots(items, previewIds)
  const groupKeys = new Set(previewItems.map((item) => item.group ?? item.id))
  return items.filter((item) => groupKeys.has(item.group ?? item.id))
}

const onlyofficeDocumentGroup = 'onlyoffice-document-workflow'
const onlyofficeSpreadsheetGroup = 'onlyoffice-spreadsheet-workflow'
const onlyofficePresentationGroup = 'onlyoffice-presentation-workflow'
const homepageDashboardGroup = 'homepage-dashboard-overview'
const seafileLibraryGroup = 'seafile-library-workflow'
const seafileSharingGroup = 'seafile-sharing-workflow'
const seafileHistoryGroup = 'seafile-history-workflow'

export const homepageScreenshots: AppScreenshot[] = [
  {
    id: 'homepage-dashboard',
    src: homepageDashboard,
    alt: 'My Own Suite Homepage dashboard showing the polished launchpad with app categories, calendar widget, shortcuts, and management links.',
    title: 'Suite Dashboard Launchpad',
    caption: 'Homepage gives the suite a single polished start screen where the active apps, widgets, and management links are gathered into one everyday launchpad.',
    group: homepageDashboardGroup,
    lead: true
  }
]

export const seafileScreenshots: AppScreenshot[] = [
  {
    id: 'seafile-grid',
    src: seafileGrid,
    alt: 'Seafile library grid view showing organized folders inside a self-hosted private cloud workspace.',
    title: 'Private Cloud Library View',
    caption: 'A polished overview of the Seafile workspace, showing how folders, shared libraries, and day-to-day file organization look inside a self-hosted cloud drive.',
    group: seafileLibraryGroup,
    lead: true
  },
  {
    id: 'seafile-new-folder',
    src: seafileNewFolder,
    alt: 'Seafile create new folder dialog used to organize a private cloud workspace.',
    title: 'Organize With New Folders',
    caption: 'Create new folders on the fly to keep projects, departments, or personal files structured instead of dumping everything into one giant library.',
    group: seafileLibraryGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-starred',
    src: seafileStarred,
    alt: 'Seafile starred library view for quick access to important shared folders in a private cloud drive.',
    title: 'Favorite Important Libraries',
    caption: 'Starred libraries give you a faster route back to the folders you open constantly, which keeps the workspace feeling efficient even as it grows.',
    group: seafileLibraryGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-properties',
    src: seafileProperties,
    alt: 'Seafile file properties panel showing metadata details for a document stored in self-hosted cloud storage.',
    title: 'File Properties And Details',
    caption: 'Metadata and file details are easy to inspect when you need to confirm size, timestamps, ownership, or other practical information about a document.',
    group: seafileLibraryGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-share-menu',
    src: seafileShareMenu,
    alt: 'Seafile file browser with the share action selected for a document in a private team workspace.',
    title: 'Secure File Sharing',
    caption: 'Share a document straight from the file browser so clients, teammates, or family members can get access without exposing the rest of your storage.',
    group: seafileSharingGroup
  },
  {
    id: 'seafile-share-dialog',
    src: seafileShareDialog,
    alt: 'Seafile share dialog for generating a secure file link from a private cloud drive.',
    title: 'Share Links For Collaboration',
    caption: 'Generate a share link directly from Seafile when you want a simple handoff flow for external feedback, approvals, or client delivery.',
    group: seafileSharingGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-permissions',
    src: seafilePermissions,
    alt: 'Seafile access permissions dialog for controlling who can view or edit files in a self-hosted cloud drive.',
    title: 'Access Permissions',
    caption: 'Permissions stay manageable inside the app, which matters when you want privacy, clean collaboration boundaries, and less guesswork around who can do what.',
    group: seafileSharingGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-history',
    src: seafileHistory,
    alt: 'Seafile document history screen listing older versions of a file for recovery and auditing.',
    title: 'Version History And Recovery',
    caption: 'Built-in file history makes it easy to review older revisions, recover the right version, and keep a clearer audit trail for important documents.',
    group: seafileHistoryGroup
  },
  {
    id: 'seafile-library-history',
    src: seafileLibraryHistory,
    alt: 'Seafile library history settings panel for controlling file retention and versioning in self-hosted storage.',
    title: 'Library History Settings',
    caption: 'History settings help you tune how much revision data is preserved, which is useful for balancing recovery needs against storage discipline.',
    group: seafileHistoryGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-download-context',
    src: seafileDownloadContext,
    alt: 'Seafile context menu opened on a project document with download and share actions visible.',
    title: 'Context Menu For Project Files',
    caption: 'Project files can be shared, renamed, moved, downloaded, or inspected from one compact context menu instead of scattered controls.',
    group: seafileSharingGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-download-menu',
    src: seafileDownloadMenu,
    alt: 'Seafile file action menu with download selected for a document inside a private cloud workspace.',
    title: 'Quick Download Actions',
    caption: 'Common file actions stay close to the content, so downloading a single document or checking its options does not interrupt the rest of the workflow.',
    group: seafileSharingGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-download-toolbar',
    src: seafileDownloadToolbar,
    alt: 'Seafile toolbar controls for downloading and managing a document in a self-hosted file browser.',
    title: 'Toolbar File Controls',
    caption: 'The toolbar keeps the core file-management actions visible when you are working through a library and need a faster browser-based workflow.',
    group: seafileSharingGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-bulk-copy',
    src: seafileBulkCopy,
    alt: 'Seafile bulk copy workflow for moving or duplicating multiple files in a private cloud library.',
    title: 'Bulk Copy Workflow',
    caption: 'Bulk actions cut down repetitive cleanup work when you need to duplicate, reorganize, or move groups of files inside a larger workspace.',
    group: seafileHistoryGroup,
    hiddenFromGrid: true
  },
  {
    id: 'seafile-bulk-download',
    src: seafileBulkDownload,
    alt: 'Seafile bulk download action for exporting multiple documents from a self-hosted cloud drive.',
    title: 'Bulk Download',
    caption: 'Export multiple files at once when you need a local backup, an offline review bundle, or a quick handoff for another tool.',
    group: seafileHistoryGroup,
    hiddenFromGrid: true
  }
]

export const onlyofficeScreenshots: AppScreenshot[] = [
  {
    id: 'onlyoffice-document-collaboration',
    src: onlyofficeDocumentCollaboration,
    alt: 'ONLYOFFICE document editor showing a browser-based Word-style file with real-time collaborators in a self-hosted office suite.',
    title: 'Real-Time Document Collaboration',
    caption: 'The document editor gives you a modern in-browser writing experience with live collaboration, familiar controls, and files that stay inside your own stack.',
    group: onlyofficeDocumentGroup,
    lead: true
  },
  {
    id: 'onlyoffice-document-comments',
    src: onlyofficeDocumentComments,
    alt: 'ONLYOFFICE document editor showing comment tools for review and feedback inside a private office workspace.',
    title: 'Comments And Review',
    caption: 'Comments and review tools make it easier to collect feedback, approve changes, and keep collaboration inside the document instead of outside it.',
    group: onlyofficeDocumentGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-document-ai',
    src: onlyofficeDocumentAi,
    alt: 'ONLYOFFICE document editor showing AI and spell-check tools in a self-hosted browser office suite.',
    title: 'AI And Writing Assistance',
    caption: 'The editor can layer in AI-assisted writing and proofreading tools for people who want a little extra help while still keeping the suite under their control.',
    group: onlyofficeDocumentGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-document-formatting',
    src: onlyofficeDocumentFormatting,
    alt: 'ONLYOFFICE document editor toolbar with text formatting tools visible in a browser-based word processor.',
    title: 'Rich Text Formatting',
    caption: 'Formatting controls stay close at hand for headings, spacing, typography, and the kind of everyday polish people expect from a serious document editor.',
    group: onlyofficeDocumentGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-spreadsheet-collaboration',
    src: onlyofficeSpreadsheetCollaboration,
    alt: 'ONLYOFFICE spreadsheet editor showing a shared workbook with real-time multi-user collaboration.',
    title: 'Collaborative Spreadsheets',
    caption: 'Spreadsheets support the same browser-based collaboration flow, so teams can work on planning, finance, and operations without passing files around.',
    group: onlyofficeSpreadsheetGroup
  },
  {
    id: 'onlyoffice-spreadsheet-history',
    src: onlyofficeSpreadsheetHistory,
    alt: 'ONLYOFFICE spreadsheet editor showing version history for a workbook in a private cloud office suite.',
    title: 'Workbook Version History',
    caption: 'Version history helps you inspect earlier spreadsheet states, recover work, and understand how a file changed over time.',
    group: onlyofficeSpreadsheetGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-spreadsheet-validation',
    src: onlyofficeSpreadsheetValidation,
    alt: 'ONLYOFFICE spreadsheet editor showing data validation settings for a collaborative workbook.',
    title: 'Spreadsheet Validation Rules',
    caption: 'Validation rules help keep shared spreadsheets cleaner by guiding data entry and reducing the chance of inconsistent inputs.',
    group: onlyofficeSpreadsheetGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-spreadsheet-function',
    src: onlyofficeSpreadsheetFunction,
    alt: 'ONLYOFFICE spreadsheet editor with function insertion tools for formulas and calculations.',
    title: 'Functions And Formulas',
    caption: 'Formula tools make it practical to use ONLYOFFICE for real spreadsheet work instead of treating it like a lightweight viewer.',
    group: onlyofficeSpreadsheetGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-spreadsheet-password',
    src: onlyofficeSpreadsheetPassword,
    alt: 'ONLYOFFICE spreadsheet editor showing password protection options for a workbook in a private office cloud.',
    title: 'Password Protection',
    caption: 'Security-minded workflows can add password protection where needed, which fits well with the broader privacy-first direction of the suite.',
    group: onlyofficeSpreadsheetGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-presentation-template',
    src: onlyofficePresentationTemplate,
    alt: 'ONLYOFFICE presentation editor with design templates visible in a self-hosted slide deck workflow.',
    title: 'Presentation Design Tools',
    caption: 'Slides are not an afterthought here. You can build decks in the browser with themes, layouts, and design controls that feel ready for real work.',
    group: onlyofficePresentationGroup
  },
  {
    id: 'onlyoffice-presentation-collaboration',
    src: onlyofficePresentationCollaboration,
    alt: 'ONLYOFFICE presentation editor showing real-time collaborators on a slide deck in the browser.',
    title: 'Slide Deck Collaboration',
    caption: 'Presentations can be edited together in real time, which is especially useful when slides need quick reviews, rewrites, or last-minute updates.',
    group: onlyofficePresentationGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-presentation-text',
    src: onlyofficePresentationText,
    alt: 'ONLYOFFICE presentation editor with slide text editing tools visible in a self-hosted office suite.',
    title: 'Slide Text Editing',
    caption: 'Text, layout, and slide content can be refined directly in the presentation editor, making quick deck edits feel smooth and immediate.',
    group: onlyofficePresentationGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-presentation-transition',
    src: onlyofficePresentationTransition,
    alt: 'ONLYOFFICE presentation editor showing slide transition controls for a browser-based presentation workflow.',
    title: 'Transitions And Motion',
    caption: 'Transitions are built into the slide workflow for teams who need lightweight polish on demos, reports, and internal presentations.',
    group: onlyofficePresentationGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-markdown-heading',
    src: onlyofficeMarkdownHeading,
    alt: 'ONLYOFFICE markdown editor showing heading formatting options for structured writing in the browser.',
    title: 'Markdown Editing',
    caption: 'Markdown support is handy for notes, lightweight documentation, and knowledge-base writing when you want something faster than a full page layout.',
    group: onlyofficeDocumentGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-markdown-hyperlink',
    src: onlyofficeMarkdownHyperlink,
    alt: 'ONLYOFFICE markdown editor with hyperlink insertion controls in a browser-based writing workflow.',
    title: 'Hyperlinks And Structured Content',
    caption: 'Link creation and structured authoring tools help turn rough drafts into cleaner internal docs, guides, and reference pages.',
    group: onlyofficeDocumentGroup,
    hiddenFromGrid: true
  },
  {
    id: 'onlyoffice-markdown-download',
    src: onlyofficeMarkdownDownload,
    alt: 'ONLYOFFICE markdown editor showing download and export options in a private cloud office setup.',
    title: 'Download And Export',
    caption: 'When you need to move work outside the editor, download and export actions are right there without breaking the overall browser workflow.',
    group: onlyofficeDocumentGroup,
    hiddenFromGrid: true
  }
]

export const railwayDeployScreenshots: AppScreenshot[] = [
  {
    id: 'railway-service-overview',
    src: railwayServiceOverview,
    alt: 'Railway service map showing the My Own Suite deployment with grouped services for photos, storage, passwords, calendar, and the main dashboard.',
    title: 'Railway Service Overview',
    caption: 'This overview helps you recognize how the full hosted suite is laid out in Railway so you can spot the main MOS services and understand the deployment at a glance.',
    lead: true
  },
  {
    id: 'railway-public-url',
    src: railwayPublicUrl,
    alt: 'Railway deployment details page highlighting where to open the public URL for a My Own Suite deployment.',
    title: 'Find Your Public URL',
    caption: 'After deployment finishes, Railway shows the generated public URL for the MOS service here so you can open the suite and begin onboarding.'
  }
]

export const railwayOverviewScreenshots = pickGalleryBundles(railwayDeployScreenshots, ['railway-service-overview'])
export const railwayOpenSuiteScreenshots = pickGalleryBundles(railwayDeployScreenshots, ['railway-public-url'])

export const homepageOverviewScreenshots = pickGalleryBundles(homepageScreenshots, ['homepage-dashboard'])

export const seafileOverviewScreenshots = pickGalleryBundles(seafileScreenshots, ['seafile-grid'])
export const seafileHighlightsScreenshots = pickGalleryBundles(seafileScreenshots, ['seafile-share-menu', 'seafile-history'])

export const onlyofficeOverviewScreenshots = pickGalleryBundles(onlyofficeScreenshots, ['onlyoffice-document-collaboration'])
export const onlyofficeHighlightsScreenshots = pickGalleryBundles(onlyofficeScreenshots, [
  'onlyoffice-spreadsheet-collaboration',
  'onlyoffice-presentation-template'
])
