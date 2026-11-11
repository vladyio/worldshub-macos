# WorldsHub for macOS

**English** · [Русский](README.ru.md)

> [!NOTE]
> This is a completely vibe-coded and unofficial implementation of WorldHub for macOS. It is provided as is and has been done as a proof-of-concept (and also to help some people play).

[![Download 0.8.5](https://img.shields.io/badge/Download-0.8.5-blue?style=for-the-badge)](https://github.com/vladyio/worldshub-macos/releases/latest/download/WorldsHub-macOS-arm64.zip)

A thin Electron wrapper around the official WorldsHub web client, with the Windows-only P2P parts rebuilt for macOS. It lets you **join** Minecraft worlds hosted by players running the official Windows app. Hosting is not supported.

Apple Silicon (arm64) only.

## 1. App setup and launch

1. Download `WorldsHub-macOS-arm64.zip` from [Releases](https://github.com/vladyio/worldshub-macos/releases/latest) and unzip it.
2. Drag `WorldsHub.app` into `/Applications`.
3. Launch it. On first launch macOS may block the app — see the fixes below.
4. Log in with your WorldsHub account.
5. Pick a world hosted by someone running the official Windows client and press **Connect**.
6. Allow the local-network permission prompt if macOS shows one.
7. In Minecraft Java Edition: **Multiplayer → Direct Connection → `localhost:25565`**.

### 1.1 Gotchas / errors

- **"WorldsHub.app is damaged" or "Apple cannot check it"** — the build is ad-hoc signed, not notarized. Right-click the app → **Open** → **Open**. If that does not work, run:
  `xattr -dr com.apple.quarantine /Applications/WorldsHub.app`
  or use **System Settings → Privacy & Security → Open Anyway**.
- **Connection to `localhost:25565` fails** — the port must be free. Stop any local Minecraft server using port 25565, then reconnect in the app.
- **"Invalid or expired authorization token"** — log out of WorldsHub and log back in.
- **No worlds listed / host not reachable** — the host must be online in the official Windows WorldsHub client.
- **Local network access denied** — enable it in **System Settings → Privacy & Security → Local Network**. Without it a direct connection may fail (a TURN relay may still work).
- **Join only** — creating worlds is intentionally disabled on macOS.
- **No Intel build** — this release is arm64 only.

## 2. App/source structure and workflow

```
main.js                             Electron main process: window, IPC bridge, app version
preload.js                          contextBridge -> window.electron (sendToProcess/onEvent/invoke)
client.js                           WorldsHub client logic: signaling, WebRTC, local proxy
config.js                           Signaling host, ICE servers, 127.0.0.1:25565
minecraft-datachannel-parser.js     Minecraft packet parser for login/status messages
main-process/utils/turn-servers.js  Fetches TURN credentials from the WorldsHub backend
```

The UI is not bundled. `main.js` loads `https://app.worldshub.io`, exactly like the official app, and exposes the same IPC surface through `preload.js`. The website does the login, world browser, and UI; the Electron side only handles the P2P connection.

Join flow:

1. The web UI calls `window.electron.sendToProcess('connect-to-host', { serverId, token, ... })`.
2. `main.js` forwards it to `client.connectToHost(...)`.
3. `client.js` opens a Socket.IO connection to `app.worldshub.io` and registers as a client with the user's JWT.
4. After `client_authorized`, it creates a WebRTC peer connection with `node-datachannel` and exchanges the offer, answer, and ICE candidates through the signaling server.
5. A TCP proxy on `127.0.0.1:25565` pipes Minecraft traffic over the WebRTC data channel to the host.
6. Logs, status updates, and toasts are forwarded back to the UI as `ui-event` messages.

The Windows host runs the same protocol in reverse and forwards traffic to its local Minecraft server.

### Build from source

Requires macOS arm64 and Node.js.

```bash
npm install
npm start          # development run
npm run build      # -> dist/mac-arm64/WorldsHub.app
codesign --force --deep --sign - dist/mac-arm64/WorldsHub.app
```

If npm blocks install scripts: `npm install-scripts approve electron node-datachannel && npm rebuild`.

### Automatic updates

The [sync workflow](.github/workflows/sync-upstream.yml) checks the official `latest.yml` daily. When the upstream version changes, it verifies and extracts the new installer, copies the client code, re-applies the patches in `patches/`, builds and signs the app, and publishes a new release.

If upstream changes the patched code, the workflow fails before publishing — update the patch and rerun. Manual run: `gh workflow run sync-upstream.yml -f force=true`.

## License

Public domain — see [LICENSE](LICENSE).
