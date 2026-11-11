const fs = require('fs').promises;
const path = require('path');

/**
 * IPC обработчик для работы с конфигурацией Minecraft сервера
 * @param {Electron.IpcMain} ipcMain - IPC main процесс
 */
function setupMinecraftServerConfigHandlers(ipcMain) {
    console.log('[MinecraftServerConfig] Setting up IPC handlers');

    /**
     * Обработчик для получения списка операторов из ops.json
     * @param {Electron.IpcMainInvokeEvent} event - IPC событие
     * @param {string} serverFolderPath - путь к папке сервера
     * @returns {Promise<Array>} массив операторов или пустой массив
     */
    ipcMain.handle('getOpsJson', async (event, serverFolderPath) => {
        try {
            console.log('[MinecraftServerConfig] getOpsJson called with path:', serverFolderPath);

            // Валидация пути
            if (!serverFolderPath || typeof serverFolderPath !== 'string') {
                console.error('[MinecraftServerConfig] Invalid server folder path:', serverFolderPath);
                return [];
            }

            // Проверяем существование папки
            try {
                await fs.access(serverFolderPath);
            } catch (error) {
                console.error('[MinecraftServerConfig] Server folder does not exist:', serverFolderPath);
                return [];
            }

            // Путь к файлу ops.json
            const opsJsonPath = path.join(serverFolderPath, 'ops.json');
            console.log('[MinecraftServerConfig] Looking for ops.json at:', opsJsonPath);

            // Проверяем существование файла ops.json
            try {
                await fs.access(opsJsonPath);
            } catch (error) {
                console.log('[MinecraftServerConfig] ops.json file not found at:', opsJsonPath);
                return [];
            }

            // Читаем содержимое файла
            const fileContent = await fs.readFile(opsJsonPath, 'utf8');
            console.log('[MinecraftServerConfig] ops.json file content length:', fileContent.length);

            // Проверяем что файл не пустой
            if (!fileContent || fileContent.trim() === '') {
                console.log('[MinecraftServerConfig] ops.json file is empty');
                return [];
            }

            // Парсим JSON
            let opsData;
            try {
                opsData = JSON.parse(fileContent);
            } catch (parseError) {
                console.error('[MinecraftServerConfig] Error parsing ops.json:', parseError.message);
                return [];
            }

            // Проверяем что это массив
            if (!Array.isArray(opsData)) {
                console.warn('[MinecraftServerConfig] ops.json does not contain an array:', typeof opsData);
                return [];
            }

            console.log('[MinecraftServerConfig] Successfully loaded', opsData.length, 'operators from ops.json');
            return opsData;

        } catch (error) {
            console.error('[MinecraftServerConfig] Error in getOpsJson handler:', error);
            return [];
        }
    });

    console.log('[MinecraftServerConfig] IPC handlers setup completed');
}

module.exports = {
    setupMinecraftServerConfigHandlers
}; 