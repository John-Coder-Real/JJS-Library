# JSON Skill Library

A static, browser-local library for complete movesets, reusable skills, dependencies, presets, and mesh/audio/texture IDs.

## Features

- Stores the working library in IndexedDB on the current browser/device.
- Backs up and restores the complete library as a portable JSON file.
- Imports raw JSON, base64 JSON, raw Zstandard files, and base64-encoded Zstandard data.
- Routes imports to a new moveset, an existing moveset, or the dependency/skill/preset libraries.
- Navigates left-to-right from kind to item to skill to isolated skill-data section.
- Preserves unknown fields and keeps `DATA` stringified when isolated sections are changed.
- Exports complete movesets, individual skills, or isolated sections as base64.
- Includes dependencies by matching `TAG` and `VALUE`; supports skill-only export.
- Supports multi-select, drag selection, range selection, clipboard actions, duplication, and deletion.
- Stores mesh, audio, and texture IDs with optional image data.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The static site is written to `dist/`.

## Publish on GitHub Pages

1. Create a GitHub repository and push this folder to its `main` branch.
2. In the repository, open **Settings > Pages**.
3. Set **Source** to **GitHub Actions**.
4. The included workflow builds and publishes the site after each push to `main`.

The website files live on GitHub. Library contents stay in each visitor's browser and are not committed or uploaded.
