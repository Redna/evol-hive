# Feature: Visualizer Mobile Shell (2/2) — Secure Origin, Follow-Camera, Measured HUD & Installable PWA

## Context

- Architecture: [§2 — System Overview (visualizer transport)](../architecture/02-system-overview.md), [§3 — Agent State Schema (`position`)](../architecture/03-agent-state-schema.md)
- Related specs: [062 — Visualizer World View (1/2)](062-visualizer-world-view.md) (the pure `layoutWorld` seam, the mobile world renderer, DPR/resize fixes and measured HUD insets this spec builds on), [023 — Canvas 2D Visualizer](023-visual-output-canvas-renderer.md) (the browser contract, amended here by Decision 5), [042 — Visualizer Single Renderer](042-visualizer-single-renderer.md) (single inline page), [027 — Real-LLM Visualizer Demo](027-real-llm-visualizer-demo.md) (launch path)
- Package: `visualizer` (served page, client shell, server routes). `shared`/`engine`/`memory` untouched.
- Issue: [#232](https://github.com/Redna/evol-hive/issues/232)
- Depends on: [#231](https://github.com/Redna/evol-hive/issues/231) (spec 062)
- Status: 📝 Drafted

## Problem Summary

Spec 062 makes the world readable on a phone, but the shell around it is still a desktop page: the world is framed once and cannot follow an agent as the sim grows; there is no way to install it, so observing a run means typing a URL and keeping a browser tab alive; and the observation workflow has no "watch this one agent" affordance beyond a transient detail card.

An earlier draft claimed the phone was stuck on plain `http://<LAN-IP>` with no secure context. **That was wrong.** A check of the deployment host found that a **local certificate authority and a TLS-terminating reverse proxy already exist and already work** for the machine's LAN and overlay-network addresses. The spec therefore *reuses* that setup rather than inventing one.

**Environment values are deliberately not recorded in this document.** This is a public repository: the concrete hostnames, IP addresses, certificate paths, ports and service names are operator-specific and MUST be delivered out-of-band (the #232 build packet / local run notes), never committed. The requirements below are therefore stated in terms of roles — "the environment's local CA", "the reverse proxy's TLS endpoint" — which are enough to build and test against, with the values supplied separately.

### The two real constraints

1. **Mixed content.** An `https://` page cannot open a `ws://` socket — the browser blocks it. Production `client/main.ts` hardcodes `ws://${location.host}/`, which works over plain HTTP and is **blocked the moment the page is served over TLS**. The WebSocket scheme must follow the page scheme, and the socket must be **same-origin** with the page.
2. **One origin, not two ports.** `VisualizerServer` already serves the page **and** the WebSocket on one port, so a single reverse-proxy route to that port carries both (the proxy handles the upgrade transparently). The prototype harness split them across two ports (page and sim on different ports), which cannot survive TLS. The production path must stay single-origin.

## Requirements

### R1 — Secure origin by reusing the environment's existing local CA and reverse proxy (`visualizer` + harness/docs)

- The documented phone path is: install the **environment's local root CA** on the device, then open the visualizer through the **existing TLS-terminating reverse proxy**, which reverse-proxies to the `VisualizerServer` port.
- The harness/docs ship a generic, path-prefixed reverse-proxy snippet so the visualizer sits beside the existing site without duplicating its address, e.g. (placeholders, not real values):
  ```
  # inside the existing TLS site block
  handle_path /viz/* { reverse_proxy 127.0.0.1:<visualizer-port> }
  ```
- Applying the snippet is a **documented, reversible** step; it must not alter the existing application's own route.
- **Concrete environment values (host, port, cert paths, CA filename) are supplied out-of-band and MUST NOT be committed** — not in this spec, not in the harness, not in the docs.
- Plain HTTP on the LAN remains available for look-and-feel iteration (a secure context is only required for the install/offline ACs).

### R2 — The WebSocket scheme follows the page scheme (`visualizer` client)

- `client/main.ts` selects `wss:` when `location.protocol === 'https:'`, else `ws:`, and connects to **`location.host`** (same origin). No separate WS port may be hardcoded.
- The served page and the socket must remain same-origin, so one reverse-proxy route covers both page and live stream.

### R3 — Follow-camera, as a pure function (`visualizer`)

- Add a pure camera resolver, e.g. `cameraFor(selection, layout: WorldLayout, previous: Camera | null): Camera`, and reuse the spec-062 smoother for the pan. `Camera` is a `{ scale, offsetX, offsetY }` transform applied to the world layer only (HUD is unaffected).
- **Selection**: tapping an agent selects it; tapping empty space clears the selection. The selection is camera state, never a simulation command.
- **Follow**: when an agent is selected, the camera centres it and pans smoothly as it moves; the camera **clamps** so no empty space beyond the world bounds is shown; when the selection is cleared the camera returns to the fit-all view.
- **No rotation, no user zoom, no free pan** in this spec — the camera is a follow tool, not a map browser (Out of Scope).
- Deterministic and pure: no clock, no I/O; the same inputs give the same camera; a single frame with no selection yields the fit-all view exactly.

### R4 — Installable PWA, hand-written, no dependency (`visualizer`)

- `VisualizerServer` serves **`GET /manifest.webmanifest`** (valid web-app manifest: `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, and icons covering 192px and 512px masks) and **`GET /sw.js`** (a service worker at root scope).
- `GET /` gains `<link rel="manifest">`, a `theme-color` meta and an apple-touch icon link; the inline page JS registers the service worker.
- The service worker caches the **app shell** (the `/` response plus the two new resources) so a reload with no network still renders the page. It **never** caches or intercepts the WebSocket upgrade, and it never caches simulation state.
- The shell cache is versioned so a changed page is picked up on the next load.

### R5 — Mobile observation workflow (`visualizer`)

- The selected-agent card (from the prototype) is wired to camera selection: selecting an agent shows its drives/plan/phase; clearing hides it.
- The bottom control sheet exposes the view controls that matter while watching (play/pause, speed, fog, scene) with the ≥44px targets and safe-area insets delivered by spec 062; an install affordance appears when the browser fires `beforeinstallprompt` and is hidden otherwise.
- Controls stay usable while the camera pans — the camera transform must not move the HUD.

### R6 — Regression discipline (`visualizer`)

- All visualizer tests pass; the spec-023 page contract is still single-HTML inline JS/CSS with no external **script**; only `packages/visualizer` (and the examples harness/docs) change; `pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass.

## Acceptance Criteria

- [ ] **AC-1** (R1): the documented workflow reaches a secure context — the reverse-proxy TLS endpoint resolves with a valid chain (`ssl_verify_result=0`) for the CA the device trusts, and the same URL in a phone browser shows a valid lock and offers install. The snippet is in the docs with **placeholders only** and does not duplicate the existing site address.
- [ ] **AC-2** (R2): the served page's JS chooses `wss:` under `https:` and `ws:` under `http:`, and builds the URL from `location.host` (asserted on the served bundle / sandbox-executed page); no hardcoded `ws://` + separate port remains.
- [ ] **AC-3** (R3): `cameraFor` is unit-tested — no selection ⇒ identity/fit-all view; with a selection, the selected agent's projected position maps to the viewport centre; the camera clamps at every world edge; equal inputs ⇒ deep-equal output.
- [ ] **AC-4** (R3): camera panning reuses the frame-rate-independent smoother and is monotonic (no overshoot), asserted by the same partition test used in spec 062 AC-4.
- [ ] **AC-5** (R4): `GET /manifest.webmanifest` returns `200` with JSON containing `name`, `short_name`, `start_url`, `display: "standalone"` and icons at ≥192px and ≥512px; `GET /` contains `<link rel="manifest"` and a `theme-color` meta.
- [ ] **AC-6** (R4): `GET /sw.js` returns `200` with a JavaScript content type; the served page's JS registers it; the shell cache name is versioned and the cache list contains only shell resources (never a WebSocket URL).
- [ ] **AC-7** (R3, R5): executing the **served page** in a sandbox with a mock canvas/DOM shows that a `pointerdown` on an agent selects it (card shown + camera targets it) and a `pointerdown` on empty space clears both; the world layer transform changes while the HUD DOM does not.
- [ ] **AC-8** (R5): at 360×640 with safe-area insets applied, the top status, the selected-agent card and the bottom control sheet do not overlap each other or the world's room rects (extends spec 062 AC-2).
- [ ] **AC-9** (live, issue-owned): on a phone, the page is installed to the home screen, opens offline to the shell, and tapping an agent follows it around the world **over `wss://` through the reverse-proxy endpoint**. Screenshots + device/browser noted on [#232](https://github.com/Redna/evol-hive/issues/232).
- [ ] **AC-10** (R6): all existing visualizer tests pass; `pnpm -r test && pnpm typecheck && pnpm lint` pass; `shared`/`engine`/`memory` have no source changes.

## Constraints

- **Reuse the environment's existing CA and certificate; do not generate a second one.** The host already has a local CA whose leaf covers its LAN and overlay-network addresses, and the chain verifies. A new self-signed CA would add a second thing every device must trust.
- **No environment specifics in the repository.** Hostnames, IPs, certificate paths/filenames, ports and service names are operator-specific and belong in the out-of-band build packet, not in a public repo. Placeholders only.
- **Same-origin is mandatory.** The page and the WebSocket must share one origin and one reverse-proxy route. A separate WS port produces mixed content under TLS and is therefore forbidden.
- **Package boundary**: only `packages/visualizer` source changes, plus the examples harness and docs. No new runtime dependency — the manifest and service worker are hand-written (no Workbox, no PWA framework).
- **Browser contract (spec 023, amended)**: still a single HTML response with inline CSS/JS and **no external script or stylesheet requests**. The manifest and service worker are same-origin resources explicitly linked/registered by the page (Decision 5).
- **Never cache the live channel**: the service worker must not intercept or cache WebSocket upgrades or snapshot payloads; offline means "the shell renders", not "the sim runs".
- **Camera is view-only**: selection/pan must never send a command to the engine or alter `VisualizerState`.
- **Do not disturb the existing application's route**: the proxy change is an added path route, documented and reversible; the existing upstream stays byte-identical.
- **What NOT to do**:
  - Do **not** add a PWA/Workbox dependency or a build step for the service worker.
  - Do **not** cache simulation data or the WebSocket.
  - Do **not** hardcode `ws://` or a second port; do **not** assume `https` without selecting `wss`.
  - Do **not** commit any concrete environment value (host, IP, cert path, port).
  - Do **not** implement pan/zoom/rotation — follow only.
  - Do **not** break the spec-062 pure-layout/skin seam or re-implement layout inside the camera.
  - Do **not** edit `dist/` by hand.

## Design Decisions

**Decision 1 — Reuse the environment's existing TLS endpoint; the secure context already exists.** The deployment host already terminates TLS with a local CA that covers its LAN and overlay addresses. The cheapest correct path is to reverse-proxy the visualizer behind that same site (a path-prefixed route), so a device that already trusts the CA needs no new certificate. Building a separate HTTPS harness would add a second trust root for no benefit. *Alternative considered*: minting certs in the dev harness. Rejected — it duplicates trust material that is already installed and working.

**Decision 2 — Environment specifics stay out of the public repo.** The spec, harness and docs carry placeholders; the concrete values travel in the out-of-band build packet. This keeps the spec reproducible (it names roles and constraints) without publishing one machine's addressing and PKI layout.

**Decision 3 — Same-origin `wss://` is a correctness requirement, not a nicety.** An HTTPS page cannot open `ws://`; the current hardcoded scheme silently breaks the live view the moment TLS is enabled. The client must derive the scheme from `location.protocol` and dial `location.host`, which also keeps page + socket on one route and one backend port.

**Decision 4 — Camera is a pure resolver plus the existing smoother, not a renderer concern.** Keeping `cameraFor` pure makes clamping and centring assertable without a canvas, exactly as `layoutWorld` did for geometry (spec 062 Decision 2). The renderer applies a transform; it does not decide where the camera should be.

**Decision 5 — Follow only; no pan/zoom/rotation.** The observation need is "watch this agent as the world grows", not map browsing. A single follow mode with clamping is the smallest thing that delivers it; free camera control adds gesture handling, inertia and bounds complexity that a phone-sized world view does not need.

**Decision 6 — Hand-written manifest + service worker; amend the spec-023 contract explicitly.** The visualizer's stated constraint is no external runtime dependencies, and the shell is one inline page plus two tiny resources. "Zero external requests" is updated to "no external script/stylesheet requests; same-origin PWA resources are explicitly linked" — the anti-duplication and single-page intents of spec 023/042 are preserved.

**Decision 7 — Cache the shell, never the stream.** The page must render offline, but simulation state is live-only and stale state would be misleading. The service worker therefore takes network-first for `/` with a cache fallback and ignores WebSocket.

## Out of Scope

- **Sprite assets / art pipeline** (spec 062 prepares the skin seam).
- **Offline simulation** — the engine/sim is not run in the browser or the service worker.
- **Push notifications, background sync, periodic refresh.**
- **Free pan/zoom/rotation camera and multi-agent split view.**
- **Multi-user or remote/shared sessions.**
- **Changing or re-issuing the environment's CA/cert** — reused as-is.

## Notes

- **Depends on spec 062**: the camera consumes `WorldLayout` and the smoother; the HUD consumes the measured insets. This spec should not be built before 062 is merged.
- **Device setup (one-time)**: install the environment's local root CA on the device, then open the reverse proxy's TLS URL for the visualizer. The concrete host, port, CA filename and cert paths are provided in the #232 build packet / local run notes — not here.
- **Proxy snippet placement**: add the path route *inside* the existing TLS site block; adding a second site block with the same address is a duplicate and the proxy will reject it. Reload through the proxy's admin interface is graceful and does not drop the existing route.
- **Installability check**: Chromium accepts an SVG icon with `sizes="any"` for installability, but PNG 192/512 is the most compatible path. If a real device refuses to install with the SVG-only manifest, generate the two PNGs and re-run AC-1/AC-9.
- **Live ACs** (AC-9) are issue-owned and run on a device, not in CI.
- Verification commands: `pnpm --filter @evol-hive/visualizer test`, then `pnpm -r test && pnpm typecheck && pnpm lint`.
