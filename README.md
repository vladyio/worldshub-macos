# WorldsHub for macOS

**English** · [Русский](README.ru.md)

> [!NOTE]
> This is a completely vibe-coded and unofficial implementation of WorldHub for macOS. It is provided as is and has been done as a proof-of-concept (and also to help some people play).

[![Download 0.9.0](https://img.shields.io/badge/Download-0.9.0-blue?style=for-the-badge)](https://github.com/vladyio/worldshub-macos/releases/latest/download/WorldsHub-macOS-arm64.zip)

A thin Electron wrapper around the official WorldsHub web client, with the Windows-only parts rebuilt for macOS. It lets you **join and host** Minecraft worlds. The P2P transport is WebRTC; no port forwarding is required.

Apple Silicon (arm64) only.

## 1. App setup and launch

1. Download `WorldsHub-macOS-arm64.zip` from [Releases](https://github.com/vladyio/worldshub-macos/releases/latest) and unzip it.
2. Drag `WorldsHub.app` into `/Applications`.
3. Launch it. On first launch macOS may block the app — see the fixes below.

### 1.1 Join a world

1. Log in with your WorldsHub account.
2. Pick a world hosted by someone running WorldsHub and press **Connect**.
3. Allow the local-network permission prompt if macOS shows one.
4. In Minecraft Java Edition: **Multiplayer → Direct Connection → `localhost:25565`**.

### 1.2 Host a world

1. In WorldsHub, create a Minecraft server: choose the version and folder, accept the EULA, and let the app download the server jar.
2. Java 17 or newer is required. If the app reports no compatible Java, use **Install JDK 21** in the server dialog.
3. Start the server and wait until it is running.
4. Press **Host**, choose visibility and max players, and share the invite code or world listing.
5. Other players join with WorldsHub and connect to `localhost:25565` in Minecraft.
6. Keep the app open while hosting — quitting it stops the server.

### 1.3 Gotchas / errors

- **"WorldsHub.app is damaged" or "Apple cannot check it"** — the build is ad-hoc signed, not notarized. Right-click the app → **Open** → **Open**. If that does not work, run:
  `xattr -dr com.apple.quarantine /Applications/WorldsHub.app`
  or use **System Settings → Privacy & Security → Open Anyway**.
- **Connection to `localhost:25565` fails** — the port must be free. Stop any other Minecraft server using port 25565, then reconnect.
- **"Invalid or expired authorization token"** — log out of WorldsHub and log back in.
- **No worlds listed / host not reachable** — the host must be online and still hosting.
- **Local network access denied** — enable it in **System Settings → Privacy & Security → Local Network**. Without it a direct connection may fail (a TURN relay may still work).
- **Server will not start** — check that Java 17+ is installed, port 25565 is free, and the server log in the app shows no error.
- **Closing the app stops hosting** — the Minecraft server is a child process of the app.
- **No Intel build** — this release is arm64 only.

## 2. App/source structure and workflow

```
main.js                                  Electron main process: window, IPC bridge, lifecycle
preload.js                               contextBridge -> window.electron (sendToProcess/onEvent/invoke)
client.js                                client signaling, WebRTC, localhost proxy
host.js                                  host signaling, WebRTC, client management
minecraft-server-manager.js              queries the local Minecraft server
minecraft-datachannel-parser.js          Minecraft packet parser for login/status messages
main-process/ipc-handlers.js             IPC handlers for both client and host flows
main-process/utils/jdk-utils.js          Java detection and JDK 21 installation
main-process/utils/minecraft-installer.js    server jar download and EULA
main-process/utils/minecraft-server-runner.js  Java process lifecycle
main-process/utils/server-properties.js  server.properties read/write
main-process/utils/electron-minecraft-server-config.js  ops.json
main-process/utils/turn-servers.js       TURN credentials from the backend
```

The UI is not bundled. `main.js` loads `https://app.worldshub.io`, exactly like the official app, and exposes the same IPC surface through `preload.js`. The website does the login, world browser, server installer, and UI; the Electron side handles the P2P connection and the local Minecraft server process.

Join flow:

1. The web UI calls `window.electron.sendToProcess('connect-to-host', { serverId, token, ... })`.
2. `main.js` forwards it to `client.connectToHost(...)` via the IPC handler.
3. `client.js` opens a Socket.IO connection to `app.worldshub.io` and registers as a client with the user's JWT.
4. After `client_authorized`, it creates a WebRTC peer connection with `node-datachannel` and exchanges the offer, answer, and ICE candidates through the signaling server.
5. A TCP proxy on `127.0.0.1:25565` pipes Minecraft traffic over the WebRTC data channel to the host.
6. Logs, status updates, and toasts are forwarded back to the UI as `ui-event` messages.

Host flow:

1. The UI installs and starts a Minecraft server with `start-minecraft-server`; the process runs under the app.
2. `Host` sends `start-hosting` with the user's token and server config.
3. `host.js` checks `127.0.0.1:25565`, registers as a host, and accepts WebRTC offers from clients.
4. Each client gets its own data channel; `host.js` pipes it to a TCP connection to the local Minecraft server.
5. Client lists, player counts, invites, kicks, and status updates are forwarded to the UI.

### Build from source

Requires macOS arm64 and Node.js.

```bash
npm install
npm test           # RTC, JDK detection, server runner
npm start          # development run
npm run build      # -> dist/mac-arm64/WorldsHub.app
codesign --force --deep --sign - dist/mac-arm64/WorldsHub.app
```

`npm run test:host` is a heavier end-to-end test: it starts a real Minecraft server and a local signaling server, then connects a fake WebRTC client through the host. It expects a server jar at `/tmp/wh-mc-server/server.jar` (override with `WORLDSHUB_TEST_SERVER_JAR`).

If npm blocks install scripts: `npm install-scripts approve electron node-datachannel && npm rebuild`.

### Automatic updates

The [sync workflow](.github/workflows/sync-upstream.yml) checks the official `latest.yml` daily. When the upstream version changes, it verifies and extracts the new installer, copies the upstream client/host code, re-applies the patches in `patches/`, installs dependencies, runs the tests, builds and signs the app, and publishes a new release. The app version is bumped independently; `package.json` keeps the upstream version in `upstreamVersion`.

If upstream changes the patched code, the workflow fails before publishing — update the patch and rerun. Manual run: `gh workflow run sync-upstream.yml -f force=true`.

## License

Public domain — see [LICENSE](LICENSE).
