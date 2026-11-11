const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');
const host = require('./host');
const client = require('./client');
const { registerIpcHandlers } = require('./main-process/ipc-handlers');
const appState = require('./main-process/state');
const MinecraftServerRunner = require('./main-process/utils/minecraft-server-runner');

let mainWindow = null;
let isQuitting = false;

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

  return mainWindow;
}

function stopMinecraftServer() {
  try {
    if (MinecraftServerRunner.isServerRunning()) {
      console.log('[main] Stopping Minecraft server...');
      MinecraftServerRunner.killMinecraftServerProcess();
    }
  } catch (error) {
    console.error('[main] Error stopping Minecraft server:', error);
  }
}

function shutdownModules(preserveConnecting = false) {
  console.log(`[main] shutdownModules: hosting=${appState.isHosting}, connecting=${appState.isConnecting}`);

  if (!appState.isHosting) {
    stopMinecraftServer();
  }

  if (appState.isHosting) {
    host.stopHosting();
    appState.isHosting = false;
  }

  if (appState.isConnecting && !preserveConnecting) {
    client.disconnect();
    appState.isConnecting = false;
  }
}

app.whenReady().then(() => {
  // Google blocks logins from Electron-branded user agents.
  session.defaultSession.setUserAgent(
    app.userAgentFallback.replace(/\s?(WorldsHub|Electron)\/\S+/g, '')
  );

  const window = createWindow();

  registerIpcHandlers({
    mainWindow: window,
    host,
    client,
    shutdownModules,
    setupUpdates: null
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (isQuitting) return;

  shutdownModules();
  stopMinecraftServer();

  if (MinecraftServerRunner.isServerRunning()) {
    event.preventDefault();
    console.log('[main] Waiting for Minecraft server to stop...');

    const startedAt = Date.now();
    const timer = setInterval(() => {
      const stillRunning = MinecraftServerRunner.isServerRunning();
      if (!stillRunning || Date.now() - startedAt > 10000) {
        clearInterval(timer);
        isQuitting = true;
        app.quit();
      }
    }, 500);
  }
});

process.on('SIGINT', () => {
  MinecraftServerRunner.killMinecraftServerProcess();
  host.stopHosting();
  app.exit(0);
});
