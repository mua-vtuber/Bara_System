# Notebook Popup Implementation Plan

> Implement with superpowers:subagent-driven-development; the user has approved the design and requested this isolated worktree.

**Goal:** Apply the approved raster notebook design to the existing Pet popup and add a brief, safe page transition.

**Architecture:** Keep existing renderers and service contracts. Style only the main surface with a notebook shell, fixed index tabs, an independently scrolling page, and generated raster materials. An isolated view-transition helper handles visual animation without delaying navigation or cloning interactive content.

**Tech Stack:** Existing TypeScript/Bun, browser DOM/CSS animations, Tauri host, PNG assets. No new dependencies.

**Spec:** `2026-10-08-notebook-popup-design.md`.

## Global constraints

- Work only in `C:/Users/example/.codex/worktrees/pet-notebook-ui/bara_system` on `codex/pet-notebook-ui`; Claude is working in the primary checkout.
- UI strings remain in messages.ts. No user DB, live credentials, service API changes, dependencies, or automatic publishing.
- Keep quick/bubble/pet surfaces unchanged. Use generated PNG textures, real DOM controls, and current UI copy.

## Task 1: Notebook shell and page behavior (executor)

- [x] Read main.ts, settings.ts, style.css, panel-view.ts and existing focused tests.
- [x] Run the UI baseline tests and typecheck before modifications.
- [x] Add meaningful failing regression coverage for transition cancellation/rapid navigation/reduced motion using pure state or existing DOM testing facilities; do not introduce fake interface implementations.
- [x] Add a small notebook UI module and scoped stylesheet; wire the four index tabs to the existing show modes. Keep all original actions reachable.
- [x] Add only useful settings grouping (connection, AI, startup, backup) while retaining existing renderers, disposal and asynchronous guards.
- [x] Support approximately 200ms clipped incoming-page settle (revised after user feedback), same-view preservation, rapid switch cleanup and reduced motion.
- [x] Typecheck, run focused tests, and build UI. Report owned files and evidence.

## Task 2: Raster assets and packaging (primary)

- [x] Generate text-free notebook materials matching the approved reference and inspect them.
- [x] Put final PNGs in `src/ui/assets/notebook/`; record provenance and copy them through scripts/ui-assets.ts.
- [x] Validate that the build contains the assets and no generated control text is used as UI.

## Task 3: Integration and review (primary + independent reviewer)

- [x] Inspect screenshots at 480×700 and a narrow size; compare against the reference and persist visual verdict.
- [x] Exercise main menus, connection modes, AI accordion, scrolling, rapid page changes, reduced motion and keyboard use in an isolated browser preview.
- [x] Run relevant Bun tests, typecheck and UI build; run service build if affected. Obtain independent bounded review of UI lifecycle and style isolation.
- [x] Record results and limitations in Pet docs; update graph if available. Leave a reviewable commit in this worktree without merging/pushing into Claude's checkout.

## Review focus

- Navigation during pending requests must not apply stale UI or lose same-view form state.
- Decorative layers must never intercept controls or duplicate IDs/secret fields.
- Long settings and backup output must scroll without moving fixed tabs off-screen.
- A missing animation API/reduced motion must still render immediately.
- Asset paths and layout must work from the production bundle and default native window dimensions.
