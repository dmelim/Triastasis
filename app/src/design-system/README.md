# Triastasis design system

Triastasis is a compact dark desktop tool for long 3D workflows. The system is intentionally small: one system sans, one technical mono, neutral near-black surfaces, and the logo's teal accent.

## Foundations

- Interface type: `Segoe UI Variable`, then `Segoe UI` and the system sans fallback.
- Technical values: `Cascadia Mono`, then the system mono fallback.
- Theme: one dark palette with canvas, viewer, panel, control, raised, and inset surfaces.
- Accent: logo teal (`#2dd4bfff`) for primary actions, active states, focus, and progress.
- Spacing: a 4 px base unit. Use the `--space-*` tokens instead of new one-off gaps.
- Shape: `--radius-control` for controls, `--radius-card` for cards, `--radius-panel` for panels, and `--radius-modal` for dialogs.
- Elevation: use the named `--elevation-*` tokens only where a surface floats above another surface.
- Icons: the vendored Lucide 0.468.0 set in `public/icons`, rendered through the shared icon mask classes. Keep the 2 px rounded stroke style and retain the bundled ISC license when adding icons.

All foundations and semantic aliases live in `tokens.css`. Product CSS should consume semantic names such as `--surface-panel`, `--content-primary`, `--border-default`, `--status-danger`, and `--font-family-sans` rather than adding literal values.

## Buttons

Use the `.button` primitive with one variant and an optional size:

- `.button--primary`: the main action in a local context.
- `.button--secondary`: ordinary controls, toolbar actions, and dialog actions.
- `.button--ghost`: low-emphasis actions.
- `.button--danger`: destructive actions.
- `.button--icon`: square icon-only actions with an accessible label.
- `.button--sm` and `.button--md`: compact and standard control sizes.

Dynamic controls use `createButton()` from `button.ts`. Static markup uses the same classes. Every icon-only button has an `aria-label` and `title`. Keep legacy `.primary` and `.tool-btn` aliases only while an untouched feature still needs them.

## Interaction rules

- Keep one primary action per panel or dialog.
- Keep hover, active, disabled, and `:focus-visible` states readable and keyboard accessible.
- Do not use color alone to communicate status.
- Respect reduced-motion preferences.
- Use spacing, alignment, typography, and surface contrast to group content.

## Composition rule

**NO SEPARATORS.** Do not add decorative divider lines, rules, or bordered rows between adjacent content. Necessary component outlines, input borders, card boundaries, and focus rings are still allowed. When a section needs more hierarchy, use spacing or a surface change.
