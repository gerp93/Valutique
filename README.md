![Valutique logo](assets/logo.png)

# Valutique

Photo-driven collection manager with AI appraisal. Drop photos of an item into a collection and Valutique identifies it, writes a description, fills in that collection's custom fields, grades condition from the images, and appraises it against comparable listings — saving a reference link for every comp it used. Built for farm toys first, but the data model is collection-agnostic: define any collection, give it any custom fields, and the same pipeline applies.

This repo follows the shared conventions in [gerp93/KVG_Standards](https://github.com/gerp93/KVG_Standards) (theming, release/CI, update-check, licensing, DB location) — see that repo for the rules this one is expected to keep up with.

## How it works

1. **Create a collection** with a name and any custom fields you want (Scale, Brand, Model Brand, Packaging…). Valutique can propose a starting field set from a one-line description of what you collect.
2. **Add photos.** Each item can have many; you choose whether a batch of photos is one item or one item per photo.
3. **Valutique goes to work automatically.** Every new item is queued for identification and then appraisal. The queue survives restarts, so a 300-item import can run overnight.
4. **Review.** Every AI-filled field is editable, every appraisal keeps its rationale, confidence, and comp links, and nothing is overwritten silently.

Re-run appraisal any time, on one item or on a filtered batch.

## AI connectors

Valutique is deliberately model-agnostic. You add 1..N connectors in Settings and bind each AI task (describe, appraise, suggest fields) to whichever connector you want — they can share one or use different ones.

| Connector | How it bills |
| --- | --- |
| Claude Code CLI (`claude -p`) | Your Claude Pro/Max **subscription** quota. No API credits. |
| Gemini CLI (`gemini -p`) | Your Google account's Gemini CLI allowance. No API credits. |
| Anthropic API | Pay-per-token API credits |
| Google Gemini API | Pay-per-token API credits |
| OpenAI-compatible endpoint | Depends on the endpoint — covers OpenAI, OpenRouter, GitHub Models, and **local** servers (Ollama, LM Studio, llama.cpp, vLLM, HF TGI), which are free |

The CLI connectors are the reason this app can run at zero incremental cost: they shell out to an agent CLI you're already signed into, so the work draws on a subscription you already pay for instead of metered API credits. Settings shows each connector's billing model, and the app tracks tokens, searches, and estimated spend per connector so you can see exactly what a batch cost — or that it cost nothing.

Local Hugging Face models are reached through the OpenAI-compatible connector: run the model behind any OpenAI-shaped server and point Valutique at the URL.

## Appraisal and comps

Appraisal quality depends on the connector's ability to search. Connectors that support web search (Claude, Gemini, and the CLIs) find and cite live comparable listings. Every comp URL is verified with a request before it's saved and flagged if it doesn't resolve, because a vision model asked for comp links *without* search will confidently invent them. Connectors with no search — local models in particular — are fine for identification and description but are warned against when bound to the appraise task.

Optionally add eBay Browse API credentials for structured listing data alongside search. Note that eBay's free Browse API returns **active listings only** — asking prices, not realized sale prices. Sold data requires Marketplace Insights API approval, which is rarely granted.

**Valuations are estimates, not appraisals.** Every number is a model's read of your photos against comps it found, stored with its confidence and rationale so you can judge it. Useful for insurance inventory and knowing what you have; not an authority.

## Your data

The SQLite database and the photo library are both relocatable from Settings — point them at a cloud-synced folder for backup. API keys are deliberately **not** stored in that database; they live in the OS keychain via Electron's `safeStorage`, so syncing your collection never syncs your credentials.

## Development

```
npm install
npm run dev
```

Regenerate icons after editing `assets/logo.svg`:

```
npm run icons
```

## Build

```
npm run build
npm run package
```

## Releases

Every push to `main` triggers [Auto Release](.github/workflows/auto-release.yml), which bumps a semantic version tag and calls [KVG_Standards' `release-electron.yml`](https://github.com/gerp93/KVG_Standards/blob/main/.github/workflows/release-electron.yml) to package Valutique for Windows, macOS, and Linux via `electron-builder` and publish the installers to a new [GitHub Release](../../releases). [Cut Release](.github/workflows/cut-release.yml) is also available for a manually chosen version instead of the auto-bump. Since `auto-release.yml` bumps on every push regardless of content, a release with no real code change (e.g. picking up an updated KVG_Standards workflow) should go through a dated entry in [`VERSION_BUMP.md`](VERSION_BUMP.md) instead of an empty commit.

To download a build, go to the [Releases page](../../releases) and grab the installer for your platform from the latest release's assets:

- `*.exe` — Windows installer
- `*.dmg` — macOS disk image (initial install)
- `*.AppImage` — Linux AppImage

These builds are unsigned (no code-signing certificate is configured), so Windows SmartScreen and macOS Gatekeeper will warn about an unrecognized publisher — you'll need to click through ("More info" → "Run anyway" on Windows, or right-click → "Open" on macOS) to launch it.

### Auto-updates

Once installed, the packaged app checks this repo's Releases on launch and silently downloads any newer version via `electron-updater`. When a download finishes, you'll get a prompt to restart and install now, or it installs automatically the next time you quit. You only need to manually download from Releases for the very first install (or if you skip enough updates that a manual re-download is easier).
