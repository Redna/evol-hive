# Feature: Visualizer Mobile Shell (2/2) — Follow-Camera, Measured HUD & Installable PWA

## Context

- Architecture: [§2 — System Overview (visualizer transport)](../architecture/02-system-overview.md), [§3 — Agent State Schema (`position`)](../architecture/03-agent-state-schema.md)
- Related specs: [062 — Visualizer World View (1/2)](062-visualizer-world-view.md) (the pure `layoutWorld` seam, the mobile world renderer, DPR/resize fixes and measured HUD insets this spec builds on), [023 — Canvas 2D Visualizer](023-visual-output-canvas-renderer.md) (the browser contract, amended here by Decision 5), [042 — Visualizer Single Renderer](042-visualizer-single-renderer.md) (single inline page), [027 — Real-LLM Visualizer Demo](027-real-llm-visualizer-demo.md) (launch path)
- Package: `visualizer` (served page, client shell, server routes). `shared`/`engine`/`memory` untouched.
- Issue: [#232](https://github.com/Redna/evol-hive/issues/232)
- Depends on: [#231](https://github.com/Redna/evol-hive/issues/231) (spec 062)
- Status: 📝 Drafted

## Problem Summary

Spec 062 makes the world readable on a phone, but the shell around it is still a desktop page: the world is framed once and cannot follow an agent as the sim grows; there is no way to install it, so observing a run means typing a URL and keeping a browser tab alive; and the observation workflow has no "watch this one agent" affordance beyond a transient detail card.

Two environment facts shape the design and were verified before writing:

1. **Service workers and PWA install require a secure context** — `https://` or `localhost`. The prototype's phone URL is `http://<LAN-IP>:<port>`, which is **not** a secure context, so a service worker will not register and the browser will not offer install. The dev harness must therefore gain an HTTPS path (or the phone must use a tunnel), or the offline/install ACs cannot be met. This is a first-class constraint, not an afterthought.
2. **The spec-023 browser contract says "zero external requests."** A manifest link and a service worker are, by definition, additional same-origin requests. The contract is amended deliberately (Decision 5), not violated silently.

## Requirements

### R1 — Follow-camera, as a pure function (`visualizer`)

- Add a pure camera resolver, e.g. `cameraFor(selection, layout: WorldLayout, previous: Camera | null): Camera`, and reuse the spec-062 smoother for the pan. `Camera` is a `{ scale, offsetX, offsetY }` transform applied to the world layer only (HUD is unaffected).
- **Selection**: tapping an agent selects it; tapping empty space clears the selection. The selection is camera state, never a simulation command.
- **Follow**: when an agent is selected, the camera centres it and pans smoothly as it moves; the camera **clamps** so no empty space beyond the world bounds is shown; when the selection is cleared the camera returns to the fit-all view.
- **No rotation, no user zoom, no free pan** in this spec — the camera is a follow tool, not a map browser (Out of Scope).
- Deterministic and pure: no clock, no I/O; the same inputs give the same camera; a single frame with no selection yields the fit-all view exactly.

### R2 — Installable PWA, hand-written, no dependency (`visualizer`)

- `VisualizerServer` serves **`GET /manifest.webmanifest`** (valid web-app manifest: `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, and icons covering 192px and 512px masks) and **`GET /sw.js`** (a service worker at root scope).
- `GET /` gains `<link rel="manifest">`, a `theme-color` meta and an apple-touch icon link; the inline page JS registers the service worker.
- The service worker caches the **app shell** (the `/` response plus the two new resources) so a reload with no network still renders the page. It **never** caches or intercepts the WebSocket upgrade, and it never caches simulation state.
- The shell cache is versioned so a changed page is picked up on the next load.

### R3 — Mobile observation workflow (`visualizer`)

- The selected-agent card (from the prototype) is wired to camera selection: selecting an agent shows its drives/plan/phase; clearing hides it.
- The bottom control sheet exposes the view controls that matter while watching (play/pause, speed, fog, scene) with the ≥44px targets and safe-area insets delivered by spec 062; an install affordance appears when the browser fires `beforeinstallprompt` and is hidden otherwise.
- Controls stay usable while the camera pans — the camera transform must not move the HUD.

### R4 — Dev harness can serve a secure context (`visualizer` harness, docs)

- The prototype/demo harness (`examples/visualizer-prototype/serve.mts`, and the documented launch path) gains an **optional HTTPS mode** (or documents a tunnel) so a phone on the LAN is a secure context and the PWA ACs are reachable. Default HTTP behaviour is unchanged.

### R5 — Regression discipline (`visualizer`)

- All visualizer tests pass; the spec-023 page contract is still single-HTML inline JS/CSS with no external **script**; only `packages/visualizer` (and the examples harness/docs) change; `pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass.

## Acceptance Criteria

- [ ] **AC-1** (R1): `cameraFor` is unit-tested — no selection ⇒ identity/fit-all view; with a selection, the selected agent's projected position maps to the viewport centre; the camera clamps at every world edge; equal inputs ⇒ deep-equal output.
- [ ] **AC-2** (R1): camera panning reuses the frame-rate-independent smoother and is monotonic (no overshoot), asserted by the same partition test used in spec 062 AC-4.
- [ ] **AC-3** (R2): `GET /manifest.webmanifest` returns `200` with JSON containing `name`, `short_name`, `start_url`, `display: "standalone"` and icons at ≥192px and ≥512px; `GET /` contains `<link rel="manifest"` and a `theme-color` meta.
- [ ] **AC-4** (R2): `GET /sw.js` returns `200` with a JavaScript content type; the served page's JS registers it; the shell cache name is versioned and the cache list contains only shell resources (never a WebSocket URL).
- [ ] **AC-5** (R1, R3): executing the **served page** in a sandbox with a mock canvas/DOM shows that a `pointerdown` on an agent selects it (card shown + camera targets it) and a `pointerdown` on empty space clears both; the world layer transform changes while the HUD DOM does not.
- [ ] **AC-6** (R3): at 360×640 with safe-area insets applied, the top status, the selected-agent card and the bottom control sheet do not overlap each other or the world's room rects (extends spec 062 AC-2).
- [ ] **AC-7** (R4): the documented phone workflow reaches a **secure context** (HTTPS or tunnel) and the browser offers install; the default HTTP path still works for look-and-feel iteration.
- [ ] **AC-8** (live, issue-owned): on a phone, the page is installed to the home screen, opens offline to the shell, and tapping an agent follows it around the world. Screenshots + device/browser noted on [#232](https://github.com/Redna/evol-hive/issues/232).
- [ ] **AC-9** (R5): all existing visualizer tests pass; `pnpm -r test && pnpm typecheck && pnpm lint` pass; `shared`/`engine`/`memory` have no source changes.

## Constraints

- **Secure context is mandatory for R2** — service worker registration and install only work on `https://` or `localhost`. This is why R4 exists; AC-8 cannot pass on a plain LAN HTTP URL.
- **Package boundary**: only `packages/visualizer` source changes, plus the examples harness and docs. No new runtime dependency — the manifest and service worker are hand-written (no Workbox, no PWA framework).
- **Browser contract (spec 023, amended)**: still a single HTML response with inline CSS/JS and **no external script or stylesheet requests**. The manifest and service worker are same-origin resources explicitly linked/registered by the page (Decision 5).
- **Never cache the live channel**: the service worker must not intercept or cache WebSocket upgrades or snapshot payloads; offline means "the shell renders", not "the sim runs".
- **Camera is view-only**: selection/pan must never send a command to the engine or alter `VisualizerState`.
- **What NOT to do**:
  - Do **not** add a PWA/Workbox dependency or a build step for the service worker.
  - Do **not** cache simulation data or the WebSocket.
  - Do **not** implement pan/zoom/rotation — follow only.
  - Do **not** break the spec-062 pure-layout/skin seam or re-implement layout inside the camera.
  - Do **not** edit `dist/` by hand.

## Design Decisions

**Decision 1 — Camera is a pure resolver plus the existing smoother, not a renderer concern.** Keeping `cameraFor` pure makes clamping and centring assertable without a canvas, exactly as `layoutWorld` did for geometry (spec 062 Decision 2). The renderer applies a transform; it does not decide where the camera should be.

**Decision 2 — Follow only; no pan/zoom/rotation.** The observation need is "watch this agent as the world grows", not map browsing. A single follow mode with clamping is the smallest thing that delivers it; free camera control adds gesture handling, inertia and bounds complexity that a phone-sized world view does not need.

**Decision 3 — Hand-written manifest + service worker.** The visualizer's stated constraint is no external runtime dependencies, and the shell is one inline page plus two tiny resources. A PWA framework would be a larger dependency than the feature.

**Decision 4 — Cache the shell, never the stream.** The page must render offline, but simulation state is live-only and stale state would be misleading. The service worker therefore takes network-first for `/` with a cache fallback and ignores WebSocket.

**Decision 5 — Amend, don't violate, the spec-023 contract.** "Zero external requests" is updated to "no external script/stylesheet requests; same-origin PWA resources are explicitly linked". The anti-duplication and single-page intents of spec 023/042 are preserved; only the manifest link and SW registration are added.

**Decision 6 — HTTPS is a harness concern, surfaced early.** Because AC-8 and install are unreachable over plain LAN HTTP, the secure-context path is part of the spec's deliverable (R4) rather than a surprise discovered during live verification.

## Out of Scope

- **Sprite assets / art pipeline** (spec 062 prepares the skin seam).
- **Offline simulation** — the engine/sim is not run in the browser or the service worker.
- **Push notifications, background sync, periodic refresh.**
- **Free pan/zoom/rotation camera and multi-agent split view.**
- **Multi-user or remote/shared sessions.**

## Notes

- **Depends on spec 062**: the camera consumes `WorldLayout` and the smoother; the HUD consumes the measured insets. This spec should not be built before 062 is merged.
- **Installability check**: Chromium accepts an SVG icon with `sizes="any"` for installability, but PNG 192/512 is the most compatible path. If a real device refuses to install with the SVG-only manifest, generate the two PNGs and re-run AC-7/AC-8; record the outcome on the issue.
- **Secure context options** for the phone: a TLS tunnel, a locally-trusted cert (`mkcert`) served by the harness, or the browser's `localhost` forwarding. Whichever is chosen, the command belongs in the harness docs so the next run is one line.
- **Live ACs** (AC-8) are issue-owned and run on a device, not in CI.
- Verification commands: `pnpm --filter @evol-hive/visualizer test`, then `pnpm -r test && pnpm typecheck && pnpm lint`.
