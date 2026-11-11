const { contextBridge, ipcRenderer } = require('electron');

// Читаем версию из package.json
let appVersion = '0.8.5';
try {
  // Используем относительный путь вместо path.join
  const packagePath = __dirname + '/package.json';
  const fs = require('fs');
  const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  appVersion = packageData.version;
} catch (error) {
  console.error('[preload] Error reading package.json:', error);
}

// Выводим версию в консоль браузера
console.log(`🚀 S4E Signaling Server v${appVersion} loaded`);
console.log(`📦 App Version: ${appVersion}`);
console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);

contextBridge.exposeInMainWorld('electron', {
    appVersion,
    // Для внутренних P2P операций (client.js, host.js)
    sendToProcess: (action, data) => {
        // console.log('[preload] sendToProcess called:', action, data);
        // console.log('[preload] ipcRenderer available:', !!ipcRenderer);
        // console.log('[preload] ipcRenderer.send available:', !!ipcRenderer.send);
        
        try {
            ipcRenderer.send('process-action', { action, data });
            console.log('[preload] ipcRenderer.send(process-action) called successfully');
        } catch (error) {
            console.error('[preload] Error sending process-action:', error);
        }
    },
    
    // Универсальный слушатель для всех событий
    onEvent: (callback) => {
        // console.log('[preload] onEvent callback registered');
        const subscription = (event, data) => {
            // console.log('[preload] Received ui-event:', data);
            callback(data);
        };
        ipcRenderer.on('ui-event', subscription);
        
        // Возвращаем функцию для очистки
        return () => {
            console.log('[preload] Removing ui-event listener');
            ipcRenderer.removeListener('ui-event', subscription);
        };
    },
    
    // Для IPC запросов с ожиданием ответа
    invoke: (channel, data) => {
        console.log('[preload] invoke called:', channel, data);
        return ipcRenderer.invoke(channel, data);
    }
});