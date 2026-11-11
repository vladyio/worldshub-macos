const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const client = require('./client');
const { version } = require('./package.json');

let mainWindow = null;

function send(type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ui-event', { type, data });
  }
}

function clientCallbacks() {
  return {
    onLog: (message) => send('log', message),
    onStatusUpdate: (status, message) => send('status-update', { status, message: message || status }),
    onSignalingStatusUpdate: (status) => send(status, null),
    onClientListUpdate: (clients, hostId) => send('client-list-update', { clients, hostId }),
    onShowToast: (severity, summary, detail) => send('show-toast', { severity, summary, detail })
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('https://app.worldshub.io');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const oauthHosts = /^(https?:\/\/)?(accounts\.google\.com|appleid\.apple\.com|discord\.com|www\.discord\.com)\//i;
    if (oauthHosts.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true }
      };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Google blocks logins from Electron-branded user agents.
  session.defaultSession.setUserAgent(
    app.userAgentFallback.replace(/\s?(WorldsHub|Electron)\/\S+/g, '')
  );

  ipcMain.on('process-action', async (_event, payload) => {
    const { action, data } = payload || {};
    try {
      switch (action) {
        case 'connect-to-host':
          client.connectToHost(data.serverId, data.token, clientCallbacks(), data.password, data.inviteCode);
          break;
        case 'disconnect-from-host':
          await client.disconnect();
          break;
        case 'start-hosting':
        case 'stop-hosting':
        case 'kick-client':
          send('show-toast', {
            severity: 'warn',
            summary: 'Not supported',
            detail: 'This macOS build can join worlds, but cannot host them.'
          });
          break;
        default:
          // host-client-list-update and misc host chatter
          break;
      }
    } catch (error) {
      console.error('[main] process-action failed:', error);
      send('show-toast', {
        severity: 'error',
        summary: 'Error',
        detail: error.message
      });
    }
  });

  ipcMain.handle('get-app-version', () => ({ success: true, version }));

  const unsupported = [
    'get-installed-jdks', 'get-system-java', 'get-recommended-jdk', 'download-jdk21',
    'get-local-jdks', 'get-java-version', 'start-minecraft-server', 'stop-minecraft-server',
    'get-minecraft-server-status', 'get-active-minecraft-servers', 'send-minecraft-command',
    'get-server-properties', 'set-server-property', 'check-viaversion', 'getOpsJson',
    'minecraft-create-eula', 'minecraft-delete-folder', 'minecraft-install-server',
    'minecraft-open-folder', 'minecraft-select-folder'
  ];
  for (const channel of unsupported) {
    ipcMain.handle(channel, () => ({
      success: false,
      error: 'Hosting is not supported by this macOS build.'
    }));
  }

  createWindow();

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

app.on('before-quit', () => {
  client.disconnect().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
