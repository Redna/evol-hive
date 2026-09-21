# Mobile visualizer — secure origin, follow-camera, installable PWA

> Operator notes for spec 063 ([#232](https://github.com/Redna/evol-hive/issues/232)).
> **Environment-specific values are deliberately not recorded here.** This is a
> public repository: the hostname, IP addresses, TLS port, certificate paths and
> the local CA filename live in the out-of-band run notes / build packet, never
> in the repo. The recipe below uses placeholders.

## What you get

- **Follow-camera** — tap an agent to select it; the camera pans to keep it
  centred and clamps at the world bounds. Tap empty space (or the × on the card)
  to return to the fit-all view. No pan/zoom/rotation.
- **Selected-agent card** — drives, PPER phase and current plan for the selected
  agent.
- **Installable PWA** — add to home screen; the app shell renders offline (the
  live simulation does **not** run offline).

## 1. Serve it over a secure origin

A service worker and PWA install require a **secure context**: `https://` or
`localhost`. A plain `http://<lan-ip>:<port>` URL will not register a service
worker or offer install.

The deployment host already terminates TLS with a local CA whose leaf covers its
LAN and overlay-network addresses, so **reuse that endpoint** rather than minting
a second trust root. Add a path-prefixed route **inside the existing TLS site
block** (adding a second site block with the same address is a duplicate and the
proxy will reject it):

```
# inside the existing TLS site block — placeholders, not real values
handle_path /viz/* {
    reverse_proxy 127.0.0.1:<visualizer-port>
}
```

Why path-prefixed and same-origin:

- `VisualizerServer` serves the page **and** the WebSocket on one port, so one
  route carries both (the proxy handles the upgrade transparently).
- The client dials `location.host` and picks `wss:` when the page is `https:`
  — an `https` page **cannot** open `ws://` (mixed content), so page and socket
  must share one origin.

Reload the proxy through its admin interface (graceful; it does not drop the
existing route).

## 2. On the phone

1. Install the host's **local root CA** on the device (the same CA the rest of
   the environment already uses).
2. Open `https://<host>:<tls-port>/viz/` (LAN or overlay address). A valid lock
   confirms the CA is trusted.
3. Browser menu → **Add to Home screen** / **Install**. The in-page **Install**
   button appears when the browser fires `beforeinstallprompt`.

## 3. Plain-HTTP iteration

For look-and-feel work without TLS, the visualizer still serves plain HTTP on
its own port; the world, camera and card all work. Only the install/offline
path needs the secure origin.

## Verifying

```bash
# routes exist and are same-origin relative
curl -s http://localhost:<visualizer-port>/manifest.webmanifest | head
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:<visualizer-port>/sw.js
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:<visualizer-port>/icon.svg

# served page links the manifest and registers the worker
curl -s http://localhost:<visualizer-port>/ | grep -E 'rel="manifest"|serviceWorker'
```
