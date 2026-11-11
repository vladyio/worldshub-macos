/**
 * 📡 S4E - IPC Handlers Module (Socket.IO Version)
 * 
 * Универсальная архитектура IPC:
 * 
 * 1. process-action - для работы с P2P процессами (client.js, host.js)
 * 
 * Electron работает как "тупая прокладка" между Angular и Server
 */

const { ipcMain } = require('electron');
const appState = require('./state');
const { setupMinecraftServerConfigHandlers } = require('./utils/electron-minecraft-server-config');
const { setupMinecraftInstallerHandlers } = require('./utils/minecraft-installer');
const { findInstalledJdks, getSystemJavaInfo, getRecommendedJdk, downloadAndInstallJdk21, getLocalJdks } = require('./utils/jdk-utils');
const MinecraftServerRunner = require('./utils/minecraft-server-runner');
const serverProps = require('./utils/server-properties');

/**
 * Throttle функция для ограничения частоты вызовов
 * @param {Function} fn - функция для throttling
 * @param {number} ms - интервал в миллисекундах
 * @returns {Function} throttled функция
 */
function throttle(fn, ms) {
    let last = 0;
    return (...args) => {
        const now = Date.now();
        if (now - last > ms) {
            last = now;
            fn(...args);
        }
    };
}

/**
 * Отправляет событие в Angular UI
 * @param {BrowserWindow} mainWindow - главное окно
 * @param {string} type - тип события
 * @param {any} data - данные события
 */
function sendToUI(mainWindow, type, data) {
    console.log(`[main] sendToUI called with type: ${type}, data:`, data);
    if (mainWindow && !mainWindow.isDestroyed()) {
        // console.log(`[main] Sending ui-event to Angular:`, { type, data });
        mainWindow.webContents.send('ui-event', { type, data });
    } else {
        console.warn(`[main] Cannot send to UI: mainWindow is ${!mainWindow ? 'null' : 'destroyed'}`);
    }
}

/**
 * Регистрирует все IPC обработчики
 * @param {Object} params - параметры для обработчиков
 * @param {BrowserWindow} params.mainWindow - главное окно приложения
 * @param {Object} params.host - модуль хоста с флагом isHosting
 * @param {Object} params.client - модуль клиента с флагом isConnecting
 * @param {Function} params.shutdownModules - функция очистки ресурсов
 */
function registerIpcHandlers({ mainWindow, host, client, shutdownModules, setupUpdates }) {
  console.log('[main] registerIpcHandlers called');
  console.log('[main] Registering IPC handlers...');
  
  // === AUTO-UPDATE HANDLERS ===
  
  // Обработчик для повторной попытки обновления
  ipcMain.on('retry-update', () => {
    console.log('[main] IPC: Retry update requested');
    if (setupUpdates) {
      setupUpdates(true);
    }
  });
  
  // Регистрируем обработчики для Minecraft Server Config
  setupMinecraftServerConfigHandlers(ipcMain);
  
  // Регистрируем обработчики для Minecraft Server Installer
  setupMinecraftInstallerHandlers({ mainWindow });
  
  // === JDK HANDLERS ===
  
  // Получить список установленных JDK
  ipcMain.handle('get-installed-jdks', async () => {
    try {
      console.log('[main] IPC: Getting installed JDKs...');
      const jdks = await findInstalledJdks();
      console.log('[main] IPC: Found JDKs:', jdks);
      return { success: true, jdks };
    } catch (error) {
      console.error('[main] IPC: Error getting installed JDKs:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Получить системную Java по умолчанию
  ipcMain.handle('get-system-java', async () => {
    try {
      console.log('[main] IPC: Getting system Java...');
      const systemJava = await getSystemJavaInfo();
      console.log('[main] IPC: System Java:', systemJava);
      return { success: true, java: systemJava };
    } catch (error) {
      console.error('[main] IPC: Error getting system Java:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Получить рекомендуемую JDK для версии Minecraft
  ipcMain.handle('get-recommended-jdk', async (event, minecraftVersion) => {
    try {
      console.log('[main] IPC: Getting recommended JDK for Minecraft version:', minecraftVersion);
      const jdks = await findInstalledJdks();
      const recommendedJdk = getRecommendedJdk(jdks, minecraftVersion);
      console.log('[main] IPC: Recommended JDK:', recommendedJdk);
      return { success: true, recommendedJdk, availableJdks: jdks };
    } catch (error) {
      console.error('[main] IPC: Error getting recommended JDK:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Скачать и установить JDK 21
  ipcMain.handle('download-jdk21', async (event) => {
    try {
      console.log('[main] IPC: Starting JDK 21 download...');
      
      // Функция для отправки прогресса в Angular (с throttling - не чаще чем раз в 0.3 секунды)
      const onProgress = throttle((progress, downloaded, total) => {
        // console.log(`[main] IPC: JDK download progress: ${progress}% (${downloaded}/${total} bytes)`);
        sendToUI(mainWindow, 'jdk-download-progress', {
          progress: Math.round(progress),
          downloaded,
          total,
          downloadedMB: Math.round(downloaded / 1024 / 1024),
          totalMB: Math.round(total / 1024 / 1024)
        });
      }, 100);
      
      const jdkInfo = await downloadAndInstallJdk21(onProgress);
      console.log('[main] IPC: JDK 21 download completed:', jdkInfo);
      
      // Отправляем событие о завершении
      sendToUI(mainWindow, 'jdk-download-completed', { jdkInfo });
      
      return { success: true, jdkInfo };
    } catch (error) {
      console.error('[main] IPC: Error downloading JDK 21:', error);
      
      // Отправляем событие об ошибке
      sendToUI(mainWindow, 'jdk-download-error', { error: error.message });
      
      return { success: false, error: error.message };
    }
  });
  
  // Получить локальные JDK папки
  ipcMain.handle('get-local-jdks', async () => {
    try {
      console.log('[main] IPC: Getting local JDKs...');
      const localJdks = await getLocalJdks();
      console.log('[main] IPC: Found local JDKs:', localJdks);
      return { success: true, jdks: localJdks };
    } catch (error) {
      console.error('[main] IPC: Error getting local JDKs:', error);
      return { success: false, error: error.message };
    }
  });

  // Проверить версию Java (надежный способ)
  ipcMain.handle('get-java-version', async () => {
    return new Promise((resolve) => {
      function getJavaVersion(callback) {
        const { spawn } = require('child_process');
        const javaProcess = spawn('java', ['-version']);
        let javaVersionReceived = false;

        javaProcess.on('error', function (err) {
          console.log('[main] IPC: Java process error:', err.message);
          callback(err, null);
        });

        javaProcess.stderr.on('data', function (data) {
          if (!javaVersionReceived) {
            data = data.toString().split('\n')[0];
            console.log('[main] IPC: Java version data:', data);
            
            const javaVersion = new RegExp('(java|openjdk) version').test(data) 
              ? data.split(' ')[2].replace(/"/g, '') 
              : false;
              
            if (javaVersion) {
              javaVersionReceived = true;
              console.log('[main] IPC: Parsed Java version:', javaVersion);
              callback(null, javaVersion);
              javaProcess.kill(); // Закрыть процесс после получения версии
            }
          }
        });

        javaProcess.on('exit', function (code) {
          if (code !== 0 && !javaVersionReceived) {
            console.log('[main] IPC: Java process exited with code:', code);
            callback(new Error(`Java process exited with code ${code}`), null);
          }
        });
      }

      getJavaVersion((error, javaVersion) => {
        if (error) {
          console.log('[main] IPC: Error getting Java version:', error.message);
          resolve({ success: false, error: error.message });
        } else {
          console.log('[main] IPC: Java Version found:', javaVersion);
          resolve({ success: true, version: javaVersion });
              }
    });
  });

  });
  
  // === APP VERSION HANDLER ===
  ipcMain.handle('get-app-version', async () => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Читаем версию из package.json
      const packagePath = path.join(__dirname, '../package.json');
      const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const appVersion = packageData.version;
      
      console.log('[main] IPC: get-app-version => version:', appVersion);
      return { success: true, version: appVersion };
    } catch (error) {
      console.error('[main] IPC: Error getting app version:', error);
      return { success: false, error: error.message };
    }
  });
  
  // === MINECRAFT SERVER HANDLERS ===
  
  // Запустить Minecraft сервер
  ipcMain.handle('start-minecraft-server', async (event, { serverJarPath, jdkPath, serverName, serverDir, javaArgs, serverArgs, xmx, xms }) => {
    try {
      console.log('[main] IPC: Starting Minecraft server...', { serverJarPath, jdkPath, serverName });
      
      // Сразу отправляем статус "starting"
      const startingStatus = {
        serverId: serverName || 'minecraft-server',
        serverName: serverName || 'Minecraft Server',
        status: 'starting',
        startTime: new Date(),
        message: 'Server is starting...'
      };
      sendToUI(mainWindow, 'minecraft-server-status', startingStatus);
      
      // Функция для отправки обновлений статуса в Angular
      const onStatusUpdate = (statusInfo) => {
        console.log('[main] IPC: Minecraft server status update:', statusInfo);
        sendToUI(mainWindow, 'minecraft-server-status', statusInfo);
        
        // Отправляем toast уведомления для важных событий
        if (statusInfo.status === 'running') {
          sendToUI(mainWindow, 'show-toast', {
            severity: 'success',
            summary: 'Minecraft Server',
            detail: 'Server started successfully!'
          });
        } else if (statusInfo.status === 'error') {
          sendToUI(mainWindow, 'show-toast', {
            severity: 'error',
            summary: 'Minecraft Server Error',
            detail: statusInfo.message
          });
        } else if (statusInfo.status === 'stopped') {
          sendToUI(mainWindow, 'show-toast', {
            severity: 'info',
            summary: 'Minecraft Server',
            detail: 'Server stopped'
          });
        }
      };
      
      // Извлекаем xmx и xms из javaArgs, если есть
      let xmxValue = xmx || '2G';
      let xmsValue = xms || '1G';
      if (Array.isArray(javaArgs)) {
        const xmxArg = javaArgs.find(arg => arg.startsWith('-Xmx'));
        const xmsArg = javaArgs.find(arg => arg.startsWith('-Xms'));
        if (xmxArg) xmxValue = xmxArg.replace('-Xmx', '');
        if (xmsArg) xmsValue = xmsArg.replace('-Xms', '');
      }
      
      const result = await MinecraftServerRunner.process(
        serverJarPath,
        xmxValue,
        xmsValue,
        event,
        jdkPath,
        onStatusUpdate
      );
      
      console.log('[main] IPC: Minecraft server start result:', result);
      return result;
    } catch (error) {
      console.error('[main] IPC: Error starting Minecraft server:', error);
      
      // Отправляем статус ошибки
      const errorStatus = {
        serverId: serverName || 'minecraft-server',
        serverName: serverName || 'Minecraft Server',
        status: 'error',
        message: error.message
      };
      sendToUI(mainWindow, 'minecraft-server-status', errorStatus);
      
      return { success: false, error: error.message };
    }
  });
  
  // Остановить Minecraft сервер
  ipcMain.handle('stop-minecraft-server', async (event, serverId) => {
    try {
      console.log('[main] IPC: Stopping Minecraft server:', serverId);
      const result = await MinecraftServerRunner.killMinecraftServerProcess(serverId);
      console.log('[main] IPC: Minecraft server stop result:', result);
      return result;
    } catch (error) {
      console.error('[main] IPC: Error stopping Minecraft server:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Получить статус Minecraft сервера
  ipcMain.handle('get-minecraft-server-status', async (event, serverId) => {
    try {
      console.log('[main] IPC: Getting Minecraft server status:', serverId);
      const status = MinecraftServerRunner.isServerRunning();
      console.log('[main] IPC: Minecraft server status:', status);
      return { success: true, status };
    } catch (error) {
      console.error('[main] IPC: Error getting Minecraft server status:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Получить список активных серверов
  ipcMain.handle('get-active-minecraft-servers', async () => {
    try {
      console.log('[main] IPC: Getting active Minecraft servers...');
      const servers = []; // (или реализовать если нужно)
      console.log('[main] IPC: Active Minecraft servers:', servers);
      return { success: true, servers };
    } catch (error) {
      console.error('[main] IPC: Error getting active Minecraft servers:', error);
      return { success: false, error: error.message };
    }
  });

  // Отправить команду на Minecraft сервер
  ipcMain.handle('send-minecraft-command', async (event, command) => {
    try {
      console.log('[main] IPC: Sending command to Minecraft server:', command);
      
      // Проверяем, что сервер запущен
      const isRunning = MinecraftServerRunner.isServerRunning();
      if (!isRunning) {
        console.log('[main] IPC: Minecraft server is not running');
        return { success: false, error: 'Minecraft server is not running' };
      }

      // Получаем процесс сервера
      const serverProcess = MinecraftServerRunner.getMinecraftServerProcess();
      if (!serverProcess) {
        console.log('[main] IPC: Minecraft server process not found');
        return { success: false, error: 'Minecraft server process not found' };
      }

      // Отправляем команду в stdin процесса
      serverProcess.stdin.write(command + '\n');
      
      console.log('[main] IPC: Command sent successfully to Minecraft server');
      return { success: true, message: 'Command sent successfully' };
    } catch (error) {
      console.error('[main] IPC: Error sending command to Minecraft server:', error);
      return { success: false, error: error.message };
    }
  });
  
  // === MINECRAFT SERVER OUTPUT HANDLER ===
  
  // Обработчик для логов Minecraft сервера
  ipcMain.on('minecraftServerOutput', (event, data) => {
    console.log('[main] IPC: Received minecraftServerOutput:', data);
    console.log('[main] IPC: minecraftServerOutput data type:', typeof data);
    console.log('[main] IPC: minecraftServerOutput data length:', data?.length);
    sendToUI(mainWindow, 'minecraftServerOutput', data);
    console.log('[main] IPC: minecraftServerOutput sent to UI');
  });

  // Обработчик для проверки статуса Minecraft сервера
  ipcMain.on('checkMinecraftServerStatus', (event, data) => {
    console.log('[main] IPC: Received checkMinecraftServerStatus:', data);
    sendToUI(mainWindow, 'checkMinecraftServerStatus', data);
  });

  // === HOST CLIENT LIST UPDATE HANDLER ===
  
  // Обработчик для обновления списка клиентов хоста из Minecraft логов
  ipcMain.on('host-client-list-update', (event, { clients }) => {
    console.log('[main] IPC: Received host-client-list-update:', clients);
    
    // Отправляем обновление в Angular UI
    sendToUI(mainWindow, 'host-client-list-update', { clients });
    console.log('[main] IPC: host-client-list-update sent to UI');
  });

  // === PROCESS ACTION HANDLER (P2P логика) ===
  
  ipcMain.on('process-action', (event, { action, data }) => {
    console.log(`[main] IPC: Received process-action: ${action}`, data);
    console.log(`[main] IPC: Available actions: start-hosting, stop-hosting, kick-client, connect-to-host, disconnect-from-host`);
    
    switch (action) {
      // === HOST ACTIONS ===
      case 'start-hosting':
        appState.isHosting = true;
        shutdownModules();
        // shutdownModules clears the flag while stopping an old host.
        appState.isHosting = true;
        
        // Извлекаем токен и конфигурацию сервера из данных
        const { token: hostToken, serverConfig } = data;
        console.log('[main] IPC: Starting host with token:', hostToken);
        console.log('[main] IPC: Server config:', serverConfig);
        
        host.startHosting(hostToken, {
          serverConfig: serverConfig || {
            visibility: 'public',
            maxPlayers: 3
          },
          onLog: (message) => {
            console.log(message);
            sendToUI(mainWindow, 'log', message);
          },
          onStatusUpdate: (status, message) => {
            console.log('[main] IPC: Received status update from host:', status, message);
            sendToUI(mainWindow, 'status-update', { status, message });
          },
          onClientListUpdate: (clients) => {
            console.log('[main] IPC: Received client list update from host:', clients);
            sendToUI(mainWindow, 'host-client-list-update', { clients });
          },
          onHostRegistrationFailed: (reason) => {
            console.log('[main] IPC: Host registration failed:', reason);
            sendToUI(mainWindow, 'host_registration_failed', { reason });
          },
          onHostRegistered: ({ inviteCode, hostId, message }) => {
            console.log('[main] IPC: Host successfully registered with invite code:', inviteCode);
            console.log('[main] IPC: Sending host_registered event to Angular with data:', { inviteCode, hostId, message });
            sendToUI(mainWindow, 'host_registered', { inviteCode, hostId, message });
          },
          onPlayerDisconnect: ({ username, clientId, reason }) => {
            console.log('[main] IPC: Player disconnected:', { username, clientId, reason });
            sendToUI(mainWindow, 'player-disconnect', { username, clientId, reason });
          },
          onShowToast: (severity, summary, detail) => {
            console.log('[main] IPC: Host showing toast notification:', { severity, summary, detail });
            sendToUI(mainWindow, 'show-toast', { severity, summary, detail });
          }
        });
        break;
        
      case 'stop-hosting':
        // Останавливаем только хостинг, НЕ Minecraft сервер
        console.log('[main] IPC: stop-hosting case entered');
        console.log('[main] IPC: Current appState.isHosting:', appState.isHosting);
        
        if (appState.isHosting) {
          console.log('[main] IPC: Stopping host only (preserving Minecraft server)...');
          host.stopHosting();
          appState.isHosting = false;
          console.log('[main] IPC: Host stopped, Minecraft server preserved');
        } else {
          console.log('[main] IPC: Host is not running, but calling stopHosting() anyway for cleanup...');
          host.stopHosting();
          console.log('[main] IPC: Cleanup completed');
        }
        break;
        
      case 'kick-client':
        console.log('[main] IPC: kick-client case entered');
        console.log('[main] IPC: Current appState.isHosting:', appState.isHosting);
        console.log('[main] IPC: Client ID to kick:', data);
        
        // Убираем проверку appState.isHosting - хост может быть активен даже если флаг сброшен
        console.log('[main] IPC: Kicking client...');
        host.kickClient(data);
        console.log('[main] IPC: kickClient() called');
        break;
        
      // === CLIENT ACTIONS ===
      case 'connect-to-host':
        try {
          console.log('[main] IPC: Processing connect-to-host');
          appState.isConnecting = true;
          console.log('[main] IPC: Set isConnecting to true');
          shutdownModules(true); // preserveConnecting = true
          console.log('[main] IPC: shutdownModules completed for connect-to-host');
          
          // Извлекаем serverId, токен, пароль и invite code из данных
          const { serverId, token: clientToken, password: serverPassword, inviteCode: serverInviteCode } = data;
          console.log('[main] IPC: Connecting to host with serverId:', serverId, 'and token:', clientToken);
          console.log('[main] IPC: Server password:', serverPassword ? 'provided' : 'not provided');
          console.log('[main] IPC: Server invite code:', serverInviteCode ? 'provided' : 'not provided');
          
          client.connectToHost(serverId, clientToken, {
            onLog: (message) => {
              console.log(message);
              sendToUI(mainWindow, 'log', message);
            },
            onStatusUpdate: (status) => {
              sendToUI(mainWindow, 'status-update', { status, message: status });
            },
            onSignalingStatusUpdate: (status) => {
              console.log('[main] IPC: Received signaling status update from client:', status);
              sendToUI(mainWindow, status, null);
            },
            onClientListUpdate: (clients, hostId) => {
              console.log('[main] IPC: Received client list update from client:', clients);
              sendToUI(mainWindow, 'client-list-update', { clients, hostId });
            },
            onShowToast: (severity, summary, detail) => {
              console.log('[main] IPC: Showing toast notification:', { severity, summary, detail });
              sendToUI(mainWindow, 'show-toast', { severity, summary, detail });
            }
          }, serverPassword, serverInviteCode);
          
          // Сохраняем пароль в client.js если он предоставлен
          if (serverPassword) {
            console.log('[main] IPC: Setting server password in client.js');
            // Пароль будет сохранен в localStorage в client.js
          }
          
          // Логируем информацию о Minecraft сервере если есть
          if (data.minecraftServer) {
              // console.log(`[MAIN] 🏗️  Minecraft Server Info:`);
              // console.log(`   MOTD: ${data.minecraftServer.motd}`);
              // console.log(`   Core: ${data.minecraftServer.core}`);
              // console.log(`   Core Version: ${data.minecraftServer.coreVersion}`);
              // console.log(`   Protocol: ${data.minecraftServer.protocol}`);
              // console.log(`   Max Players: ${data.minecraftServer.maxServerPlayers}`);
              // console.log(`   Real Players: ${data.minecraftServer.realServerPlayers}`);
              // console.log(`   Map: ${data.minecraftServer.map}`);
              // console.log(`   Game Type: ${data.minecraftServer.gametype}`);
              // console.log(`   Software: ${data.minecraftServer.software}`);
              if (data.minecraftServer.plugins) {
                  console.log(`   Plugins: ${data.minecraftServer.plugins}`);
              }
          } else {
              console.log(`[MAIN] ⚠️  No Minecraft server information provided`);
          }
        } catch (error) {
          console.error('[main] IPC: Error in connect-to-host:', error);
          appState.isConnecting = false;
          sendToUI(mainWindow, 'show-toast', { 
            severity: 'error', 
            summary: 'Connection Error', 
            detail: 'Failed to connect to server. Please try again.' 
          });
        }
        break;
        
      case 'host-client-list-update':
        console.log('[main] IPC: Processing host-client-list-update:', data);
        // Отправляем обновление списка клиентов хоста в Angular UI
        sendToUI(mainWindow, 'host-client-list-update', data);
        console.log('[main] IPC: host-client-list-update sent to UI');
        break;
        
      case 'disconnect-from-host':
        console.log('[main] IPC: Processing disconnect-from-host');
        console.log('[main] IPC: Current state - isHosting:', appState.isHosting, 'isConnecting:', appState.isConnecting);
        console.log('[main] IPC: About to call shutdownModules()');
        
        // Принудительно отключаем клиента независимо от состояния isConnecting
        // Это принудительное отключение пользователя
        console.log('[main] IPC: Force disconnecting client...');
        client.disconnect();
        appState.isConnecting = false;
        console.log('[main] IPC: Client force disconnected');
        
        shutdownModules();
        console.log('[main] IPC: shutdownModules completed for disconnect-from-host');
        break;
        
      default:
        console.warn(`[main] Unknown process action: ${action}`);
    }
  });

  // === SERVER PROPERTIES HANDLERS ===
  ipcMain.handle('get-server-properties', (event, folderPath) => {
    try {
      const props = serverProps.getServerProperties(folderPath);
      console.log('[main] IPC: get-server-properties => folderPath:', folderPath);
      return { success: true, properties: props };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-server-property', (event, { folderPath, key, value }) => {
    console.log('[main] IPC: set-server-property => key, value:', key, value);
    try {
      const result = serverProps.setServerProperty(folderPath, key, value);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // === VIAVERSION HANDLER ===
  ipcMain.handle('check-viaversion', (event, folderPath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      const pluginsPath = path.join(folderPath, 'plugins');
      console.log('[main] IPC: check-viaversion => pluginsPath:', pluginsPath);
      
      if (!fs.existsSync(pluginsPath)) {
        console.log('[main] IPC: Plugins folder not found');
        return { success: false, error: 'Plugins folder not found' };
      }
      
      const files = fs.readdirSync(pluginsPath);
      console.log('[main] IPC: Files in plugins folder:', files);
      
      // Дополнительная отладка для ViaVersion файлов
      const viaVersionFiles = files.filter(file => 
        file.toLowerCase().includes('viaversion') && file.endsWith('.jar')
      );
      console.log('[main] IPC: Potential ViaVersion files found:', viaVersionFiles);
      
      // Ищем файл ViaVersion (регистронезависимо)
      const viaVersionFile = files.find(file => 
        file.toLowerCase().startsWith('viaversion') && file.endsWith('.jar')
      );
      
      if (viaVersionFile) {
        console.log('[main] IPC: ViaVersion file found:', viaVersionFile);
        
        // Извлекаем версию из названия файла
        // Пример: ViaVersion-5.4.1.jar -> 5.4.1
        // Поддерживаем разные варианты названий: ViaVersion-5.4.1.jar, viaversion-5.4.1.jar, etc.
        console.log('[main] IPC: Trying to extract version from filename:', viaVersionFile);
        
        const versionMatch = viaVersionFile.match(/viaversion-([^.]+)\.jar/i);
        console.log('[main] IPC: First regex match result:', versionMatch);
        
        if (versionMatch && versionMatch[1]) {
          const version = versionMatch[1];
          console.log('[main] IPC: ViaVersion version extracted:', version);
          return { success: true, version: version };
        } else {
          console.log('[main] IPC: Could not extract version from filename, trying alternative pattern');
          // Попробуем альтернативный паттерн для случаев, когда название может отличаться
          const altVersionMatch = viaVersionFile.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
          console.log('[main] IPC: Alternative regex match result:', altVersionMatch);
          
          if (altVersionMatch && altVersionMatch[1]) {
            const version = altVersionMatch[1];
            console.log('[main] IPC: ViaVersion version extracted with alternative pattern:', version);
            return { success: true, version: version };
          } else {
            console.log('[main] IPC: Could not extract version from filename');
            return { success: true, version: 'unknown' };
          }
        }
      } else {
        console.log('[main] IPC: ViaVersion not found');
        return { success: false, error: 'ViaVersion not found' };
      }
    } catch (error) {
      console.error('[main] IPC: Error checking ViaVersion:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerIpcHandlers }; 