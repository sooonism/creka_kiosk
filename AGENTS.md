# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Creka Kiosk — frontend for a cartoon-selfie photobooth kiosk (OrangePi + camera + vertical display, see `DESIGN-SNAPSHOT.md` and `HARDWARE-KIOSK-SETUP.md`). Currently in a design/prototyping phase: `src/pages/admin/` holds a growing set of standalone MediaPipe computer-vision experiments (hand/face/pose tracking, gesture recognition, segmentation, etc.), tracked in `PAGES.md` with a done/WIP status per route.

## Commands

| Command | Action |
|---|---|
| `npm run dev` | Start local dev server at `localhost:4321` |
| `npm run build` | Build production site to `./dist/` |
| `npm run preview` | Preview build locally |
| `npm run astro ...` | Run CLI commands like `astro add`, `astro check` |
| `bash deploy.sh` | Build and deploy to the production server (see Deployment below) |

There is no lint or test script configured in this repo.

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Architecture

- **Astro + Svelte**: Astro handles routing/pages; interactive experiments are Svelte 5 components (runes: `$state`, etc.) mounted with `client:load`.
- **Routing convention**: every route under `src/pages/admin/*.astro` is a thin wrapper — import an `AdminLayout` and one Svelte component, pass `client:load` (and `fullscreen` on the layout if the component owns the whole viewport):
  ```astro
  ---
  import AdminLayout from '../../layouts/AdminLayout.astro';
  import Foo from '../../components/Foo.svelte';
  ---
  <AdminLayout title="Foo" fullscreen>
    <Foo client:load />
  </AdminLayout>
  ```
  `src/layouts/AdminLayout.astro` also owns the hardcoded nav bar linking every admin page — add a new `<a>` there when adding a page. The root `/` route uses the separate, plain `src/layouts/Layout.astro` (no nav).
- **MediaPipe CV components** (`src/components/*.svelte`): each is self-contained and follows the same pattern — load `@mediapipe/tasks-vision` dynamically in `onMount`, fetch the WASM runtime and a `.task` model from Google's CDN (`FilesetResolver.forVisionTasks`, model URLs like `.../hand_landmarker/...`), create a **hidden** `<video>` element in JS (never appended to the DOM) fed by `getUserMedia`, then run a detection loop that draws everything — video frame plus overlays — onto one `<canvas>`. Always tear down the stream/model in `onDestroy`. New CV experiments should copy the closest existing component rather than building the MediaPipe boilerplate from scratch.
- **Camera requires a secure context**: `getUserMedia` needs HTTPS (or localhost). This matters for the deployed kiosk (see `HARDWARE-KIOSK-SETUP.md`) more than local dev.
- **Static assets**: images referenced by components live in `public/img/` (referenced as `/img/*.png`); `src/assets/` holds Astro-processed assets (svg/png imported directly into components).

## Deployment

`deploy.sh` builds with `npm run build` and ships `dist/` via SCP to a remote server, then restarts the `creka-kiosk` Docker container. Credentials come from a gitignored `.env` (see `.env.example` for required vars: `DEPLOY_SERVER`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_REMOTE_PATH`, `DEPLOY_CONTAINER`). The live site is `https://kiosk.creka.online`.

## Documentation

Full Astro documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
