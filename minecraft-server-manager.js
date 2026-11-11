const { status, query } = require('minecraft-server-util');
const config = require('./config');

/**
 * Minecraft Server Manager
 * Отвечает за проверку и получение информации о Minecraft сервере
 */
class MinecraftServerManager {
    constructor() {
        this.serverInfo = null;
    }

    /**
     * Проверяет доступность Minecraft сервера и получает информацию
     * @returns {Promise<Object>} Информация о сервере или null если недоступен
     */
    async checkServer() {
        try {
            console.log(`[Minecraft Manager] Checking server at ${config.minecraftHost}:${config.minecraftServerPort}...`);
            
            const statusResult = await status(config.minecraftHost, config.minecraftServerPort);
            console.log('[Minecraft Manager] === Server Status ===');
            console.log(`MOTD: ${statusResult.motd.clean}`);
            console.log(`Version: ${statusResult.version.name}`);
            console.log(`Players: ${statusResult.players.online}/${statusResult.players.max}`);
            console.log(`Sample Players: ${(statusResult.players.sample || []).map(p => p.name).join(', ') || 'None'}`);
            console.log(`Protocol: ${statusResult.version.protocol}`);
            console.log(`Icon: ${statusResult.favicon ? 'Yes' : 'No'}`);
            
            // Собираем базовую информацию
            this.serverInfo = {
                motd: statusResult.motd.clean,
                version: statusResult.version.name,
                protocol: statusResult.version.protocol,
                players: {
                    online: statusResult.players.online,
                    max: statusResult.players.max,
                    sample: (statusResult.players.sample || []).map(p => p.name)
                },
                favicon: !!statusResult.favicon
            };
            
            // Пытаемся получить Query информацию
            try {
                const queryResult = await query(config.minecraftHost, config.minecraftServerPort);
                console.log('[Minecraft Manager] === Query Protocol Info ===');
                console.log(`Host: ${queryResult.host}`);
                console.log(`Port: ${queryResult.port}`);
                console.log(`MOTD: ${queryResult.motd}`);
                console.log(`Game Type: ${queryResult.gametype}`);
                console.log(`Map: ${queryResult.map}`);
                console.log(`Plugins: ${queryResult.plugins || 'None'}`);
                console.log(`Players: ${queryResult.players.online}/${queryResult.players.max}`);
                console.log(`Online Players: ${(queryResult.players.list || []).join(', ') || 'None'}`);
                console.log(`Software: ${queryResult.software || 'Unknown'}`);
                
                // Добавляем Query информацию
                this.serverInfo.query = {
                    host: queryResult.host,
                    port: queryResult.port,
                    gametype: queryResult.gametype,
                    map: queryResult.map,
                    plugins: queryResult.plugins,
                    software: queryResult.software,
                    players: {
                        online: queryResult.players.online,
                        max: queryResult.players.max,
                        list: queryResult.players.list || []
                    }
                };
            } catch (qerr) {
                console.log(`[Minecraft Manager] Query Protocol not available: ${qerr.message}`);
            }
            
            console.log(`[Minecraft Manager] ✅ Server is available!`);
            return this.serverInfo;
            
        } catch (err) {
            console.log(`[Minecraft Manager] ❌ Server is not available: ${err.message}`);
            return null;
        }
    }

    /**
     * Получает информацию о сервере для передачи на signaling
     * @returns {Object|null} Форматированная информация о сервере
     */
    getServerInfoForSignaling() {
        if (!this.serverInfo) {
            return null;
        }

        // Парсим версию для извлечения ядра и версии
        const versionInfo = this.parseVersion(this.serverInfo.version);
        
        return {
            motd: this.serverInfo.motd,
            core: versionInfo.core,
            coreVersion: versionInfo.version,
            protocol: this.serverInfo.protocol,
            maxServerPlayers: this.serverInfo.players.max,
            realServerPlayers: this.serverInfo.players.online,
            map: this.serverInfo.query?.map || 'world',
            gametype: this.serverInfo.query?.gametype || 'SMP',
            plugins: this.serverInfo.query?.plugins || null,
            software: this.serverInfo.query?.software || 'Unknown'
        };
    }

    /**
     * Парсит версию сервера для извлечения ядра и версии
     * @param {string} versionString - строка версии (например "Paper 1.21")
     * @returns {Object} объект с core и version
     */
    parseVersion(versionString) {
        if (!versionString) {
            return { core: 'Unknown', version: 'Unknown' };
        }

        // Убираем лишние пробелы и приводим к нижнему регистру
        const cleanVersion = versionString.trim().toLowerCase();
        
        // Определяем ядро
        let core = 'Unknown';
        if (cleanVersion.includes('paper')) {
            core = 'Paper';
        } else if (cleanVersion.includes('spigot')) {
            core = 'Spigot';
        } else if (cleanVersion.includes('bukkit')) {
            core = 'Bukkit';
        } else if (cleanVersion.includes('forge')) {
            core = 'Forge';
        } else if (cleanVersion.includes('fabric')) {
            core = 'Fabric';
        } else if (cleanVersion.includes('vanilla')) {
            core = 'Vanilla';
        } else if (cleanVersion.includes('bungee') || cleanVersion.includes('waterfall')) {
            core = 'BungeeCord';
        } else if (cleanVersion.includes('velocity')) {
            core = 'Velocity';
        }

        // Извлекаем версию Minecraft
        const versionMatch = cleanVersion.match(/(\d+\.\d+(?:\.\d+)?)/);
        const version = versionMatch ? versionMatch[1] : 'Unknown';

        return { core, version };
    }

    /**
     * Проверяет, доступен ли сервер
     * @returns {boolean}
     */
    isServerAvailable() {
        return this.serverInfo !== null;
    }

    /**
     * Получает максимальное количество игроков
     * @returns {number}
     */
    getMaxPlayers() {
        return this.serverInfo?.players?.max || 8;
    }

    /**
     * Получает версию сервера
     * @returns {string}
     */
    getVersion() {
        return this.serverInfo?.version || 'Unknown';
    }

    /**
     * Получает ядро сервера (Paper, Spigot, etc.)
     * @returns {string}
     */
    getSoftware() {
        return this.serverInfo?.query?.software || 'Unknown';
    }

    /**
     * Очищает информацию о сервере
     */
    clear() {
        this.serverInfo = null;
    }
}

module.exports = MinecraftServerManager; 