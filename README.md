# BIA RO-Crate Fix Helper

A small, independent test website for reviewing BIA RO-Crate validation findings and editing `ro-crate-metadata.json`.

## Current features

- BIA-inspired blue, white, and charcoal styling with a clear **In development · For testing only** banner. It does not use the BIA logo or spell out the archive name.
- Select a crate folder containing `ro-crate-metadata.json` and, when present, `file_list.tsv`.
- Run the official [`bia-ro-crate-validator`](https://github.com/BioImage-Archive/bia-ro-crate-validator) package (version 0.3.1) in the browser using [Pyodide 314.0.7](https://pyodide.org/). The validator report is shown by severity and clicking a finding selects a nearby JSON location.
- Review a JSON entity in a dialog, make edits, undo them, and download the edited metadata.
- Load a passing crate as an optional reference. Similar entity types can provide missing fields as editable starting points; the tool does not copy changes until the user asks it to.
- Includes a small demo crate. A golden example slot is present for a later example supplied by the curator.

## Privacy and runtime

The app has no application server. Crate metadata and the file list are read in the browser and placed in the Pyodide virtual filesystem for validation. They are not sent to a BIA or app server. On first validation, the browser downloads the Python runtime from jsDelivr and Python packages from PyPI; the app reports this before running. A network connection is needed for those downloads.

The official validator's report provides messages, severities, and textual location descriptions. The helper matches entity IDs and property names where it can; some findings do not include a machine-readable JSON path, so their highlighted line is only a nearby guide. Always treat the validator output and your own review as authoritative.

## Run locally

Open `index.html` in a modern browser and choose **Explore a demo** or select an RO-Crate folder. Run validation needs an internet connection to load Pyodide and the pinned validator package.

## Publish with GitHub Pages

Upload the project files to a public GitHub repository and enable GitHub Pages from the `main` branch, using the repository root. Updates are published from commits to that branch.

## Validator attribution

The browser runtime installs `bia-ro-crate-validator==0.3.1` from PyPI. The validator source is maintained by BioImage-Archive and is available under the license declared by its repository. The app does not bundle or modify the validator source.
