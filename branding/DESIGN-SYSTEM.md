# MOS Design System

This document defines the shared visual framework for My Own Suite.

The goal is consistency, not rigidity. Shared branding should provide the MOS grammar that all surfaces can speak, while each app still owns its own layout and product-specific composition.

## Audit Summary

The first audit pass across `branding/styles/mos.css`, `site/src/styles/`, and `apps/suite-manager/frontend/src/styles/` found a consistent brand direction but an inconsistent implementation layer:

- Typography drift:
  - Many near-duplicate sizes were used for the same role, including `0.78rem`, `0.8rem`, `0.82rem`, `0.84rem`, `0.85rem`, `0.86rem`, `0.88rem`, `0.92rem`, `0.96rem`, `0.98rem`, `1.02rem`, `1.03rem`, `1.08rem`, and `1.35rem`.
  - Small labels, meta text, and card titles were especially inconsistent.
- Spacing drift:
  - Shared surfaces used many hand-tuned values such as `0.35rem`, `0.45rem`, `0.55rem`, `0.65rem`, `0.7rem`, `0.75rem`, `0.8rem`, `0.82rem`, `0.85rem`, `0.9rem`, `0.95rem`, `1.15rem`, `1.25rem`, and `1.35rem`.
  - Several of these represent the same visual spacing tier.
- Radius drift:
  - Repeated radius values included `0.8rem`, `0.85rem`, `0.9rem`, `0.95rem`, `1rem`, `1.3rem`, `1.4rem`, `14px`, `16px`, `18px`, and `22px`.
- Repeated local patterns:
  - Uppercase small labels and status pills
  - Muted helper/meta text
  - Card and panel treatments
  - Card-title plus muted-body pairings
  - Accent links used as inline CTAs
- Ownership issues:
  - `branding/styles/mos.css` was too thin, which pushed real design decisions into app-local CSS.
  - Some cross-app concepts, especially label/meta/card-role patterns, existed only in `site` or Suite Manager.

## Shared Token System

Shared tokens live in `branding/styles/mos.css`.

### Color Roles

- `--mos-color-bg`: base page background
- `--mos-color-bg-soft`: supporting background tone
- `--mos-color-surface`: default translucent panel fill
- `--mos-color-surface-strong`: stronger inset/input fill
- `--mos-color-surface-elevated`: elevated popover/modal-style fill
- `--mos-color-surface-border`: standard panel border
- `--mos-color-hairline`: subtle separators
- `--mos-color-text`: default body text
- `--mos-color-text-strong`: stronger heading text
- `--mos-color-text-muted`: secondary/meta text
- `--mos-color-accent`: primary teal accent
- `--mos-color-accent-strong`: stronger CTA accent stop
- `--mos-color-accent-soft`: soft accent wash for pills and highlights
- `--mos-color-danger`: error/destructive text

Rule:
- Use role tokens, not raw color literals, when the concept is shared.
- Keep raw colors local only when they are part of a one-off illustration or product-specific visualization.

### Spacing Scale

- `--mos-space-1`: `0.25rem`
- `--mos-space-2`: `0.5rem`
- `--mos-space-3`: `0.75rem`
- `--mos-space-4`: `1rem`
- `--mos-space-5`: `1.25rem`
- `--mos-space-6`: `1.5rem`
- `--mos-space-7`: `2rem`
- `--mos-space-8`: `3rem`

Usage:
- `1-3` for tight internal spacing
- `4-6` for card padding and component gaps
- `7-8` for larger app-level separation
- Very large hero and section spacing can stay local if it is layout-specific

### Radius Scale

- `--mos-radius-sm`: `0.75rem`
- `--mos-radius-md`: `1rem`
- `--mos-radius-lg`: `1.25rem`
- `--mos-radius-xl`: `1.5rem`
- `--mos-radius-pill`: `999px`

Usage:
- `sm`: inputs, compact fields, standard buttons
- `md`: default panels, cards, compact menus
- `lg`: larger cards and feature panels
- `xl`: large showcase containers
- `pill`: status chips, badges, compact CTA pills

### Typography Roles

- `--mos-text-display`: large homepage hero display
- `--mos-text-page-title`: primary page title
- `--mos-text-section-title`: section headline
- `--mos-text-card-title`: card, panel, and step title
- `--mos-text-body-lg`: lead paragraph or major supporting copy
- `--mos-text-body`: default paragraph/body size
- `--mos-text-small`: supporting small copy
- `--mos-text-label`: compact labels, pills, table headers, field labels
- `--mos-text-eyebrow`: uppercase MOS eyebrow copy

Related shared letter/line rules:

- `--mos-line-height-tight`
- `--mos-line-height-body`
- `--mos-letter-spacing-title`
- `--mos-letter-spacing-label`
- `--mos-letter-spacing-eyebrow`

## Shared Primitives

These classes are intentionally small and reusable:

- `.mos-btn`
- `.mos-btn-primary`
- `.mos-btn-secondary`
- `.mos-panel`
- `.mos-panel-subtle`
- `.mos-panel-strong`
- `.mos-badge`
- `.mos-pill`
- `.mos-pill-accent`
- `.mos-label`
- `.mos-eyebrow`
- `.mos-meta`
- `.mos-link`
- `.mos-page-title`
- `.mos-section-title`
- `.mos-card-title`
- `.mos-body-lg`
- `.mos-body`
- `.mos-small`

### Surface Guidance

- Use `.mos-panel` for the default MOS card/panel treatment.
- Use `.mos-panel-subtle` for quieter nested surfaces where a full shadow would feel heavy.
- Use `.mos-panel-strong` for elevated menus, popovers, or auth-style featured containers.

### Text Role Guidance

- `display`: homepage-scale statement only
- `page-title`: the main heading for an app page or major flow
- `section-title`: section-level heading within a page
- `card-title`: titles inside cards, steps, panels, or feature blocks
- `body`: default paragraph copy
- `small`: supporting copy when body would feel too heavy
- `label`: compact uppercase metadata or field labels
- `eyebrow`: short accent-tinted section kicker, not full sentences
- `meta`: subdued explanatory or secondary status text

### Metrics and Secondary Text

- Prefer `label` for short descriptors like `Setup time`, `Status`, or field names.
- Prefer `meta` for secondary context, helper copy, or signed-in state.
- Prefer `small` for compact descriptive text that still needs normal sentence casing.

### CTA Hierarchy

- Primary CTA: `.mos-btn.mos-btn-primary`
- Secondary CTA: `.mos-btn.mos-btn-secondary`
- Inline/tertiary CTA: `.mos-link` or a local alias built from the same role

Do not invent separate CTA styles for each section unless the interaction meaning is genuinely different.

## Shared vs Local Ownership

### Belongs In Shared Branding

- Core color, spacing, typography, radius, border, and shadow tokens
- Standard MOS panel language
- Standard button hierarchy
- Reusable text roles: eyebrow, label, meta, small, card/page/section titles
- Generic pill/badge patterns
- Generic accent link treatment

Why:
- These define the shared MOS visual grammar.
- Both the public site and Suite Manager already need them.
- Leaving them local increases theme drift risk.

### Belongs In App-Local Styles

- Page grids and section composition
- Hero artwork and decorative network nodes
- Starlight docs table/lightbox/gallery behavior
- Suite Manager onboarding step choreography
- Product-specific state styling that only exists in one surface
- Surface-specific responsive rearrangements

Why:
- These are layout or product behaviors, not reusable visual primitives.
- Promoting them to branding would turn `branding/` into a site stylesheet dump.

## Naming Conventions

- Shared token prefix: `--mos-*`
- Shared primitive prefix: `.mos-*`
- App-local classes keep the app prefix:
  - `.suite-*` for Suite Manager
  - site-specific names for the marketing/docs surface

Rule:
- If the concept should be reusable across surfaces, promote it and name it `mos-*`.
- If it is tied to one page, one product flow, or one layout composition, keep it local.

## Practical Examples

Use `eyebrow`:
- Short section intros like `Why it exists`
- Product identity kicker like `My Own Suite`

Use `label`:
- Field labels
- Status chips
- Table column headers
- Metric descriptors

Use `small`:
- Secondary descriptive text inside compact cards
- Sub-lines under logos or brand names

Use `meta`:
- Signed-in status
- Muted explanatory copy
- Quiet helper text under stronger UI elements

Use `panel`:
- Feature cards
- Onboarding steps
- Auth containers
- Screenshot/card wrappers when the same MOS surface language is appropriate

## Contribution Rule Of Thumb

Before adding a new CSS value or pattern, ask:

1. Is this already represented by a MOS token or primitive?
2. Is this concept needed across more than one surface?
3. Is this a shared visual role, or just a local layout choice?

If the answer is shared, add or reuse it in `branding/styles/mos.css`.
If the answer is local, keep it in the app stylesheet and build it from shared tokens where possible.
