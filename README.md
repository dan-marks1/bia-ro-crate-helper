# BIA Crate Helper

A browser-only starter for reviewing BIA RO-Crate metadata. The prototype lets a user open a crate folder, inspect JSON, navigate from findings to entity IDs, apply a few suggested metadata additions, undo them, and download the edited JSON.

## Current prototype scope

- Reads `ro-crate-metadata.json` and detects whether `file_list.tsv` is present.
- Keeps the selected files in the browser; it does not upload them.
- Runs a small set of illustrative local checks: missing study keywords, missing dataset descriptions, duplicate entity IDs, and dangling local fragment references.
- Offers editable suggestions for adding `keywords` and `description` values.
- Supports undoing a suggestion and downloading the resulting JSON.
- Includes a demo crate for trying the interface.

**These local checks are not the official BIA RO-Crate validator.** Connecting the official validator and mapping its results to exact JSON locations is a future step. The reference-crate comparison feature is also a future step.

## Open locally

Open `index.html` in a modern browser. Choose **Explore a demo** to see the example, or choose a crate folder containing `ro-crate-metadata.json` and `file_list.tsv`.

## Publish with GitHub Pages

Create a repository in your GitHub account, add these project files, and enable GitHub Pages in the repository's **Settings → Pages**. For GitHub Free, use a public repository for Pages hosting. A public repository means the source code is visible to everyone; crate contents are not included in this project and user-selected files stay in their browser.
