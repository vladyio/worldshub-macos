const { PeerConnection } = require('node-datachannel');
const net = require('net');
const { io } = require('socket.io-client');
const crypto = require('crypto');
const config = require('./config');
const MinecraftDataChannelParser = require('./minecraft-datachannel-parser');
const MinecraftServerManager = require('./minecraft-server-manager');
const { fetchTurnServersFromBackend } = require('./main-process/utils/turn-servers');

// --- Module State ---
const LOCAL_PROXY_PORT = 25565;

let socket = null;
let clients = new Map();
let authToken = null;
let minecraftManager = new MinecraftServerManager();

let hostTurnServers = null;
let hostTurnServersFetchedAt = null;

let callbacks = {
    onLog: (message) => console.log(message)
};

const log = (message, level = 'info') => {
    // Сокращаем логирование - только важные сообщения
    if (level === 'error' || level === 'warn' || message.includes('✅') || message.includes('❌') || message.includes('🚫')) {
        callbacks.onLog(`[host] ${message}`);
    }
};

// Глобальный кэш для валидации username
const usernameValidationCache = new Map();

function updateAndBroadcastPlayerCount() {
    const clientIds = Array.from(clients.keys());
    const playerCount = clientIds.length;
    if (socket && socket.connected) {
        socket.emit('update-player-count', { 
            playerCount,
            clientIds 
        });
    }
}

function getClientsList() {
    return Array.from(clients.entries()).map(([id, data]) => ({
        id,
        connectedAt: data.connectedAt,
        isOnline: data.isOnline,
        minecraftConnected: data.minecraftConnected,
        minecraftUsername: data.minecraftUsername,
        hasDataChannel: !!data.dc && data.dc.isOpen()
    }));
}

function broadcastClientListToAll() {
    const clientList = getClientsList();
    clients.forEach((clientData, clientId) => {
        if (clientData.dc && clientData.dc.isOpen()) {
            try {
                const message = JSON.stringify({
                    type: 'client-list',
                    clients: clientList
                });
                clientData.dc.sendMessage(message);
            } catch (e) {
                log(`Error sending client list to ${clientId}: ${e.message}`, 'error');
            }
        }
    });
}

/**
 * Регистрирует хост на signaling сервере
 * @param {boolean} isReconnect - является ли это переподключением
 */
function registerHostWithSignaling(isReconnect = false) {
    log(`Socket.IO ${isReconnect ? 're' : ''}connected. Registering as HOST...`);
    
    if (callbacks?.onStatusUpdate) {
        callbacks.onStatusUpdate('connected', `Connected to signaling server${isReconnect ? ' (reconnected)' : ''}`);
    }
    
    const serverConfig = global.serverConfig || {
        visibility: 'public',
        maxPlayers: 3
    };
    
    const registerData = { 
        clientType: 'host',
        maxPlayers: serverConfig.maxPlayers || 3,
        visibility: serverConfig.visibility || 'public',
        onlineMode: serverConfig.onlineMode || false,
        viaVersion: serverConfig.viaVersion || null
    };
    
    if (serverConfig.visibility === 'private' && serverConfig.password) {
        registerData.password = serverConfig.password;
    }
    
    if (serverConfig.hidden) {
        registerData.hidden = true;
    }
    
    if (serverConfig.minecraftUsername) {
        registerData.minecraftUsername = serverConfig.minecraftUsername;
    }
    
    if (authToken) {
        registerData.token = authToken;
    }
    
    if (registerData.onlineMode) {
        log(`⚠️  Server will run in ONLINE MODE - players need legitimate Minecraft accounts`);
    } else {
        log(`✅ Server will run in OFFLINE MODE - players can use any username`);
    }
    
    if (registerData.viaVersion) {
        log(`🚀 ViaVersion detected: ${registerData.viaVersion}`);
    }
    
    const serverInfo = minecraftManager.getServerInfoForSignaling();
    if (serverInfo) {
        registerData.minecraftServer = serverInfo;
    }
    
    socket.emit('register', registerData);
    
    if (isReconnect) {
        clients.forEach((clientData, clientId) => {
            if (clientData.dc && clientData.dc.isOpen()) {
                try {
                    const message = JSON.stringify({
                        type: 'signaling-reconnected',
                        message: 'Signaling server reconnected'
                    });
                    clientData.dc.sendMessage(message);
                } catch (e) {
                    log(`Error notifying client ${clientId}: ${e.message}`, 'error');
                }
            }
        });
        
        if (callbacks?.onClientListUpdate) {
            callbacks.onClientListUpdate(getClientsList());
        }
    }
}

async function onHostAuthorized(authToken) {
    try {
        const result = await fetchTurnServersFromBackend(authToken);
        hostTurnServers = result.iceServers;
        hostTurnServersFetchedAt = new Date();
    } catch (error) {
        log(`Failed to fetch TURN servers from backend: ${error.message}`, 'warn');
        hostTurnServers = null;
        hostTurnServersFetchedAt = null;
    }
}

function shouldRefreshTurnServers() {
    if (!hostTurnServersFetchedAt) return true;
    
    const now = new Date();
    const hoursDiff = (now - hostTurnServersFetchedAt) / (1000 * 60 * 60);
    return hoursDiff > 1;
}

async function getCurrentIceServers() {
    if (shouldRefreshTurnServers() && authToken) {
        try {
            const result = await fetchTurnServersFromBackend(authToken);
            hostTurnServers = result.iceServers;
            hostTurnServersFetchedAt = new Date();
        } catch (error) {
            log(`Failed to refresh TURN servers: ${error.message}`, 'warn');
        }
    }
    
    const combinedServers = [...config.iceServers];
    
    if (hostTurnServers && hostTurnServers.length > 0) {
        combinedServers.push(...hostTurnServers);
    }
    
    return combinedServers;
}

function connectToSignalingAsHost() {
    if (socket && socket.connected) {
        log('Already connected to signaling server.');
        return;
    }

    const socketOptions = {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        reconnectionAttempts: 30
    };
    if (process.env.WORLDSHUB_INSECURE_TLS === '1') {
        socketOptions.rejectUnauthorized = false;
    }

    socket = io(`https://${config.serverAddress}`, socketOptions);

    socket.on('connect', () => {
        registerHostWithSignaling(false);
    });

    socket.on('host_registered', async (data) => {
        const { success, inviteCode, hostId, message } = data;
        log(`✅ Host successfully registered! Invite Code: ${inviteCode}, Host ID: ${hostId}`);
    
        if (callbacks?.onHostRegistered) {
            callbacks.onHostRegistered({ inviteCode, hostId, message });
        }

        if (data.success && authToken) {
            await onHostAuthorized(authToken);
        }
        
        // Обновляем количество игроков после успешной регистрации
        updateAndBroadcastPlayerCount();
    });

    socket.on('disconnect', (reason) => {
        log(`Socket.IO disconnected: ${reason}`);
        log(`Signaling server disconnected, but P2P connections remain active. Clients: ${Array.from(clients.keys()).join(', ')}`);
        
        clients.forEach((clientData, clientId) => {
            if (clientData.dc && clientData.dc.isOpen()) {
                try {
                    const message = JSON.stringify({
                        type: 'signaling-disconnected',
                        message: 'Signaling server disconnected, but P2P connection remains active'
                    });
                    clientData.dc.sendMessage(message);
                } catch (e) {
                    log(`Error notifying client ${clientId}: ${e.message}`, 'error');
                }
            }
        });
        
        if (callbacks?.onClientListUpdate) {
            callbacks.onClientListUpdate(getClientsList());
        }
    });

    socket.on('connect_error', (error) => {
        log(`Socket.IO connection error: ${error.message}`, 'error');
        
        if (callbacks?.onStatusUpdate) {
            callbacks.onStatusUpdate('error', `Connection error: ${error.message}`);
        }
    });

    socket.on('reconnect', (attemptNumber) => {
        log(`Reconnected to signaling server after ${attemptNumber} attempts`);
        registerHostWithSignaling(true);
    });

    socket.on('offer', (data) => {
        const { from: clientId, data: offerData } = data;
        
        if (clients.has(clientId)) {
            cleanupClient(clientId);
        }
        createPeerConnection(clientId).then(pc => {
            pc.setRemoteDescription(offerData.sdp, offerData.type);
        }).catch(error => {
            log(`Error creating PeerConnection for client ${clientId}: ${error.message}`, 'error');
        });
    });

    socket.on('candidate', (data) => {
        const { from: clientId, data: candidateData } = data;
        if (clients.has(clientId)) {
            clients.get(clientId).pc.addRemoteCandidate(candidateData.candidate, candidateData.mid);
        }
    });

    socket.on('client_disconnect', (data) => {
        const { clientId } = data;
        log(`Client ${clientId} explicitly disconnected from server`);
        cleanupClient(clientId);
    });

    socket.on('username-bound', (data) => {
        const { success, clientId, username, error } = data;
        if (success) {
            log(`✅ Username "${username}" successfully bound to client ${clientId}`);
            onUsernameBound({ success: true, clientId, username });
        } else {
            log(`❌ Failed to bind username "${username}" to client ${clientId}: ${error}`);
            onUsernameBound({ success: false, clientId, username, error });
        }
    });

    socket.on('username-conflict', (data) => {
        const { clientId, username, error, scenario, existingUsername, existingClientId } = data;
        
        let kickReason = 'Username validation failed. Please try again with a different username.';
        
        if (scenario === 2) {
            log(`!!! CLIENT ${clientId} IS TRYING TO LOGIN WITH NEW USERNAME "${username}" BUT ALREADY HAS USERNAME "${existingUsername}" !!!`);
            kickReason = `You already have username "${existingUsername}". Please use your original username.`;
        } else if (scenario === 3) {
            log(`!!! CLIENT ${clientId} IS TRYING TO LOGIN WITH SOMEONE ELSE'S USERNAME "${username}" WHICH IS ALREADY BOUND TO CLIENT ${existingClientId} !!!`);
            kickReason = `Username "${username}" is already taken by another player. Please choose a different username.`;
        } else {
            log(`!!! USERNAME CONFLICT: ${error} !!!`);
        }
        
        const clientData = clients.get(clientId);
        if (clientData?.dc?.isOpen()) {
            try {
                const kickMessage = JSON.stringify({
                    type: 'kicked',
                    reason: kickReason
                });
                clientData.dc.sendMessage(kickMessage);
            } catch (e) {
                log(`Error sending kick message to ${clientId}: ${e.message}`, 'error');
            }
        }
        
        setTimeout(() => {
            cleanupClient(clientId);
        }, 1000);
    });

    socket.on('host_registration_failed', (data) => {
        const { reason } = data;
        log(`❌ Host registration failed: ${reason}`, 'error');
        
        if (callbacks?.onStatusUpdate) {
            callbacks.onStatusUpdate('error', `Host registration failed: ${reason}`);
        }
        
        if (callbacks?.onHostRegistrationFailed) {
            callbacks.onHostRegistrationFailed(reason);
        }
        
        if (socket) {
            socket.disconnect();
            socket = null;
        }
        
        authToken = null;
    });
}

async function createPeerConnection(clientId) {
    const iceServers = await getCurrentIceServers();
    
    const pc = new PeerConnection('host-pc', { iceServers });
    const clientData = {
        pc,
        dc: null,
        mcSocket: null,
        connectedAt: new Date(),
        isOnline: true,
        minecraftConnected: false,
        minecraftParser: new MinecraftDataChannelParser(),
        pendingMinecraftPackets: [],
        isUsernameBound: false
    };
    clients.set(clientId, clientData);

    pc.onStateChange(state => {
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            cleanupClient(clientId);
        }
    });

    pc.onLocalDescription((sdp, type) => {
        socket.emit('answer', { from: 'host', to: clientId, data: { sdp, type } });
    });

    pc.onLocalCandidate((candidate, mid) => {
        setTimeout(() => {
            socket.emit('candidate', { from: 'host', to: clientId, data: { candidate, mid } });
        }, 100);
    });

    pc.onDataChannel(channel => {
        clientData.dc = channel;
        setupDataChannel(clientId, channel);
    });
    
    return pc;
}

function setupDataChannel(clientId, channel) {
    const clientData = clients.get(clientId);
    if (!clientData) {
        log(`❌ Client ${clientId} not found for DataChannel setup`, 'error');
        return;
    }

    clientData.dc = channel;
    clientData.hasDataChannel = true;

    channel.onOpen(() => {
        log(`DataChannel opened for ${clientId}`);
        updateAndBroadcastPlayerCount();
        broadcastClientListToAll();
        
        clientData.isOnline = true;
        clientData.mcSocket = connectToMinecraft(clientId);
        
        if (callbacks?.onClientListUpdate) {
            callbacks.onClientListUpdate(getClientsList());
        }
    });

    channel.onClosed(() => {
        log(`DataChannel closed for ${clientId}`);
        clientData.hasDataChannel = false;
        
        if (clientData.minecraftParser) {
            clientData.minecraftParser.reset();
        }
        
        if (clientData.mcSocket && !clientData.mcSocket.destroyed) {
            clientData.mcSocket.destroy();
        }
        
        cleanupClient(clientId);
    });

    channel.onError(err => {
        log(`DataChannel error for ${clientId}: ${err}`, 'error');
        
        if (clientData.minecraftParser) {
            clientData.minecraftParser.reset();
        }
        
        cleanupClient(clientId);
    });

    channel.onMessage((msg) => {
        try {
            if (Buffer.isBuffer(msg)) {
                handleMinecraftPacketWithValidation(clientId, msg);
            } else {
                handleJsonMessage(clientId, msg);
            }
        } catch (error) {
            log(`Error handling DataChannel message for ${clientId}: ${error.message}`, 'error');
        }
    });
}

function handleMinecraftPacketWithValidation(clientId, message) {
    const clientData = clients.get(clientId);
    if (!clientData) {
        return;
    }

    const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
    
    clientData.minecraftParser.onPlayerLogin = (username) => {
        // Проверяем OnlineMode из глобальной конфигурации
        const onlineMode = global.serverConfig?.onlineMode !== false; // По умолчанию true
        
        if (onlineMode) {
            // OnlineMode = true: пропускаем валидацию имени игрока, пускаем в любом случае
            if (!clientData.minecraftUsername) {
                clientData.minecraftUsername = username;
            }
            
            clientData.isUsernameBound = false;

            if (socket && socket.connected) {
                socket.emit('bind-username', { clientId, username });
            }
        } else {
            // OnlineMode = false: используем старую логику валидации
            if (clientData.minecraftUsername && clientData.minecraftUsername !== username) {
                log(`🚫 BLOCK: ${clientId} trying to login with different username "${username}" instead of "${clientData.minecraftUsername}"`);
                
                if (callbacks?.onShowToast) {
                    const toastMessage = `Player ${clientId} tried to use username "${username}" instead of their original "${clientData.minecraftUsername}"`;
                    callbacks.onShowToast('warn', 'Username Mismatch', toastMessage);
                }
                
                blockClientMinecraftConnection(clientId, `You must use your original username "${clientData.minecraftUsername}"`);
                return;
            }
            
            const result = checkUsernameLocally(username, clientId);
            if (result.conflict) {
                log(`🚫 BLOCK: ${username} for ${clientId}: ${result.reason}`);
                
                if (callbacks?.onShowToast) {
                    const toastMessage = `Player ${clientId} tried to use username "${username}" which conflicts with another player`;
                    callbacks.onShowToast('warn', 'Local Username Conflict', toastMessage);
                }
                
                blockClientMinecraftConnection(clientId, result.reason);
                return;
            }
            
            if (!clientData.minecraftUsername) {
                clientData.minecraftUsername = username;
            }
            
            clientData.isUsernameBound = false;

            if (socket && socket.connected) {
                socket.emit('bind-username', { clientId, username });
            }
        }
    };

    clientData.minecraftParser.onPlayerDisconnect = (reason) => {
        const username = clientData.minecraftUsername || 'Unknown';
        log(`🚪 Player "${username}" (${clientId}) disconnected from Minecraft server: ${reason}`);
        
        clientData.isUsernameBound = false;
        clientData.minecraftConnected = false;
        
        if (callbacks?.onPlayerDisconnect) {
            callbacks.onPlayerDisconnect({ username, clientId, reason });
        }
        
        if (callbacks?.onClientListUpdate) {
            callbacks.onClientListUpdate(getClientsList());
        }
    };

    clientData.minecraftParser.onStatusRequest = () => {
        const username = clientData.minecraftUsername || 'unknown';
        log(`📡 Client ${clientId} requested server status (MOTD)`);
    };
    
    clientData.minecraftParser.onPingRequest = (ping) => {
        log(`📶 Client ${clientId} sent ping request: ${ping}`);
    };
    
    clientData.minecraftParser.parseData(buffer);
    
    // Проверяем OnlineMode из глобальной конфигурации
    const onlineMode = global.serverConfig?.onlineMode !== false; // По умолчанию true
    
    if (onlineMode) {
        // OnlineMode = true: отправляем пакеты сразу без задержки
        if (clientData.mcSocket && !clientData.mcSocket.destroyed) {
            clientData.mcSocket.write(buffer);
        } else {
            if (!clientData.mcSocket || clientData.mcSocket.destroyed) {
                const mcSocket = connectToMinecraft(clientId);
                if (mcSocket) {
                    mcSocket.write(buffer);
                } else {
                    clientData.pendingMinecraftPackets.push(buffer);
                }
            }
        }
    } else {
        // OnlineMode = false: используем старую логику с задержкой пакетов
        if (clientData.isUsernameBound) {
            if (clientData.mcSocket && !clientData.mcSocket.destroyed) {
                clientData.mcSocket.write(buffer);
            } else {
                if (!clientData.mcSocket || clientData.mcSocket.destroyed) {
                    const mcSocket = connectToMinecraft(clientId);
                    if (mcSocket) {
                        mcSocket.write(buffer);
                    } else {
                        clientData.pendingMinecraftPackets.push(buffer);
                    }
                }
            }
        } else {
            clientData.pendingMinecraftPackets.push(buffer);
            
            if (clientData.mcSocket) {
                clientData.mcSocket.destroy();
                clientData.mcSocket = null;
            }
        }
    }
}

function checkUsernameLocally(username, clientId) {
    for (const [otherId, data] of clients.entries()) {
        if (otherId !== clientId && data.minecraftUsername === username) {
            return { conflict: true, reason: 'Username already taken' };
        }
    }
    return { conflict: false };
}

function blockClientMinecraftConnection(clientId, reason) {
    const clientData = clients.get(clientId);
    if (!clientData) return;
    
    log(`🚫 Blocking Minecraft connection for ${clientId}: ${reason}`);
    
    if (callbacks?.onShowToast) {
        const toastMessage = `Player ${clientId} was blocked: ${reason}`;
        callbacks.onShowToast('warn', 'Connection Blocked', toastMessage);
    }
    
    if (clientData.pendingMinecraftPackets.length > 0) {
        clientData.pendingMinecraftPackets = [];
    }
    
    if (clientData.mcSocket) clientData.mcSocket.destroy();
    if (clientData.minecraftParser) clientData.minecraftParser.reset();
    
    if (clientData.dc && clientData.dc.isOpen()) {
        clientData.dc.sendMessage(JSON.stringify({
            type: 'kicked',
            reason
        }));
    }
    
    setTimeout(() => cleanupClient(clientId), 500);
}

function handleJsonMessage(clientId, message) {
    try {
        const data = JSON.parse(message);
        
        switch (data.type) {
            case 'ping':
                const clientData = clients.get(clientId);
                if (clientData?.dc?.isOpen()) {
                    clientData.dc.sendMessage(JSON.stringify({ type: 'pong' }));
                }
                break;
                
            case 'disconnect_request':
                log(`Client ${clientId} requested disconnect: ${data.reason}`);
                
                const clientDataForDisconnectRequest = clients.get(clientId);
                if (clientDataForDisconnectRequest?.dc?.isOpen()) {
                    try {
                        const kickMessage = JSON.stringify({
                            type: 'kicked',
                            reason: data.reason || 'Disconnected by user request'
                        });
                        clientDataForDisconnectRequest.dc.sendMessage(kickMessage);
                    } catch (e) {
                        log(`Error sending kick message to ${clientId}: ${e.message}`, 'error');
                    }
                }
                
                setTimeout(() => {
                    cleanupClient(clientId);
                }, 500);
                break;
                
            case 'minecraft_disconnect':
                const clientDataForDisconnect = clients.get(clientId);
                if (clientDataForDisconnect) {
                    clientDataForDisconnect.minecraftConnected = false;
                    
                    if (clientDataForDisconnect.mcSocket && !clientDataForDisconnect.mcSocket.destroyed) {
                        clientDataForDisconnect.mcSocket.destroy();
                        clientDataForDisconnect.mcSocket = null;
                    }
                    
                    if (clientDataForDisconnect.minecraftParser) {
                        clientDataForDisconnect.minecraftParser.reset();
                    }
                    
                    clientDataForDisconnect.pendingMinecraftPackets = [];
                    clientDataForDisconnect.isUsernameBound = false;
                    
                    if (callbacks?.onClientListUpdate) {
                        callbacks.onClientListUpdate(getClientsList());
                    }
                }
                break;
                
            case 'minecraft_connect':
                const clientDataForConnect = clients.get(clientId);
                if (clientDataForConnect) {
                    clientDataForConnect.minecraftConnected = true;
                    
                    if (!clientDataForConnect.mcSocket || clientDataForConnect.mcSocket.destroyed) {
                        const mcSocket = connectToMinecraft(clientId);
                        if (mcSocket) {
                            clientDataForConnect.mcSocket = mcSocket;
                        }
                    }
                    
                    if (callbacks?.onClientListUpdate) {
                        callbacks.onClientListUpdate(getClientsList());
                    }
                }
                break;
                
            default:
                log(`Unknown message type from ${clientId}: ${data.type}`, 'warn');
        }
    } catch (error) {
        log(`Error parsing JSON message from ${clientId}: ${error.message}`, 'error');
    }
}

function connectToMinecraft(clientId) {
    const clientData = clients.get(clientId);
    if (!clientData) {
        return null;
    }
    
    const mcSocket = net.createConnection({ 
        port: config.minecraftServerPort, 
        host: config.minecraftHost,
        timeout: 10000
    });
    
    let connectionEstablished = false;
    
    mcSocket.on('connect', () => {
        connectionEstablished = true;
        
        // Проверяем OnlineMode из глобальной конфигурации
        const onlineMode = global.serverConfig?.onlineMode !== false; // По умолчанию true
        
        if (onlineMode) {
            // OnlineMode = true: отправляем отложенные пакеты сразу
            if (clientData.pendingMinecraftPackets.length > 0) {
                for (const packet of clientData.pendingMinecraftPackets) {
                    mcSocket.write(packet);
                }
                log(`📤 Sent ${clientData.pendingMinecraftPackets.length} queued packets for ${clientId} on connect (OnlineMode: true)`);
                clientData.pendingMinecraftPackets = [];
            }
        } else {
            // OnlineMode = false: используем старую логику
            if (clientData.isUsernameBound && clientData.pendingMinecraftPackets.length > 0) {
                for (const packet of clientData.pendingMinecraftPackets) {
                    mcSocket.write(packet);
                }
                log(`📤 Sent ${clientData.pendingMinecraftPackets.length} queued packets for ${clientId} on connect (OnlineMode: false)`);
                clientData.pendingMinecraftPackets = [];
            }
        }
    });
    
    mcSocket.on('data', data => {
        if (clientData.mcSocket !== mcSocket) {
            return;
        }
        
        if (clientData.dc && clientData.dc.isOpen() && clientData.minecraftConnected) {
            try {
                clientData.dc.sendMessageBinary(data);
            } catch (e) {
                mcSocket.destroy();
                return;
            }
        }
    });
    
    mcSocket.on('error', err => {
        if (!connectionEstablished) {
            if (clientData.mcSocket === mcSocket) {
                clientData.mcSocket = null;
            }
        }
    });
    
    mcSocket.on('close', () => {
        const username = clientData.minecraftUsername || 'Unknown';
        log(`🚪 Player "${username}" disconnected from Minecraft server`);
        
        clientData.isUsernameBound = false;
        
        if (clientData.mcSocket === mcSocket) {
            clientData.mcSocket = null;
        }
    });
    
    mcSocket.on('timeout', () => {
        mcSocket.destroy();
    });
    
    clientData.mcSocket = mcSocket;
    return mcSocket;
}

function cleanupClient(clientId) {
    const data = clients.get(clientId);
    if (!data) {
        return;
    }
    
    log(`🧹 Cleaning up client ${clientId}`);
    
    if (data.dc) data.dc.close();
    if (data.pc) data.pc.close();
    if (data.mcSocket) data.mcSocket.destroy();
    if (data.minecraftParser) data.minecraftParser.reset();
    data.pendingMinecraftPackets = [];
    data.isUsernameBound = false;
    clients.delete(clientId);
    
    updateAndBroadcastPlayerCount();
    broadcastClientListToAll();
    
    if (callbacks?.onClientListUpdate) {
        callbacks.onClientListUpdate(getClientsList());
    }
    
    log(`✅ Client ${clientId} cleanup completed`);
}

// --- Public API ---

async function startHosting(token, cb) {
    if (socket && socket.connected) {
        log('Host is already running.');
        return;
    }
    
    authToken = token;
    log(`Starting up host with authorization token`);
    
    const serverConfig = cb?.serverConfig || {
        visibility: 'public',
        maxPlayers: 3
    };
    
    if (cb) {
        callbacks = { ...callbacks, ...cb };
    }
    
    if (callbacks?.onStatusUpdate) {
        callbacks.onStatusUpdate('starting', 'Checking Minecraft server...');
    }
    
    const serverInfo = await minecraftManager.checkServer();
    
    if (!serverInfo) {
        log(`❌ ERROR: Minecraft server is not available!`, 'error');
        
        if (callbacks?.onStatusUpdate) {
            callbacks.onStatusUpdate('error', 'Minecraft server is not available');
        }
        
        return;
    }
    
    log(`✅ Minecraft server is available! Proceeding with host startup...`);
    
    if (callbacks?.onStatusUpdate) {
        callbacks.onStatusUpdate('connecting', 'Connecting to signaling server...');
    }
    
    global.serverConfig = serverConfig;
    
    // Логируем OnlineMode настройку
    const onlineMode = serverConfig?.onlineMode !== false; // По умолчанию true
    log(`🔧 Server config loaded - OnlineMode: ${onlineMode ? 'ENABLED' : 'DISABLED'}`);
    if (onlineMode) {
        log(`✅ OnlineMode enabled - packets will be sent immediately without delay`);
    } else {
        log(`⏳ OnlineMode disabled - packets will be delayed until username binding`);
    }
    
    connectToSignalingAsHost();
}

function stopHosting() {
    log('Stopping host...');
    
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    
    if (clients.size > 0) {
        clients.forEach((_, clientId) => {
            cleanupClient(clientId);
        });
    }
    
    authToken = null;
    log('Host stopped');
}

function kickClient(clientId) {
    const clientData = clients.get(clientId);
    if (!clientData) {
        log(`Cannot kick client ${clientId}: not found.`, 'warn');
        return;
    }
    
    log(`Kicking client ${clientId}...`);

    if (clientData.dc && clientData.dc.isOpen()) {
        try {
            const kickMessage = JSON.stringify({ type: 'kicked', reason: 'You were kicked by the host.' });
            clientData.dc.sendMessage(kickMessage);
        } catch (e) {
            log(`Error sending kick message to ${clientId}: ${e.message}`, 'error');
        }
    }

    cleanupClient(clientId);
}

function onUsernameBound({ success, clientId, username, error }) {
    const clientData = clients.get(clientId);
    if (!clientData) {
        return;
    }

    if (success) {
        clientData.isUsernameBound = true;
        log(`✅ Username ${username} confirmed by signaling server for ${clientId}`);
        
        if (!clientData.minecraftUsername) {
            clientData.minecraftUsername = username;
        }
        
        // Проверяем OnlineMode из глобальной конфигурации
        const onlineMode = global.serverConfig?.onlineMode !== false; // По умолчанию true
        
        if (onlineMode) {
            // OnlineMode = true: отправляем отложенные пакеты сразу
            if (clientData.pendingMinecraftPackets.length > 0 && clientData.mcSocket && !clientData.mcSocket.destroyed) {
                for (const buf of clientData.pendingMinecraftPackets) {
                    clientData.mcSocket.write(buf);
                }
                log(`📤 Sent ${clientData.pendingMinecraftPackets.length} queued packets for ${clientId} (OnlineMode: true)`);
                clientData.pendingMinecraftPackets = [];
            }
        } else {
            // OnlineMode = false: используем старую логику
            if (!clientData.mcSocket || clientData.mcSocket.destroyed) {
                const mcSocket = connectToMinecraft(clientId);
                if (mcSocket) {
                    // Socket created successfully
                }
            }
            
            if (clientData.pendingMinecraftPackets.length > 0 && clientData.mcSocket && !clientData.mcSocket.destroyed) {
                for (const buf of clientData.pendingMinecraftPackets) {
                    clientData.mcSocket.write(buf);
                }
                log(`📤 Sent ${clientData.pendingMinecraftPackets.length} queued packets for ${clientId} (OnlineMode: false)`);
                clientData.pendingMinecraftPackets = [];
            }
        }
        
        if (callbacks?.onClientListUpdate) {
            callbacks.onClientListUpdate(getClientsList());
        }
    } else {
        // Проверяем OnlineMode из глобальной конфигурации
        const onlineMode = global.serverConfig?.onlineMode !== false; // По умолчанию true
        
        if (onlineMode) {
            // В OnlineMode игнорируем ошибку — Mojang уже проверил имя
            log(`⚠️ Username ${username} was rejected by signaling server for ${clientId}, but OnlineMode is enabled. Allowing player.`);
            
            clientData.isUsernameBound = true;
            
            if (!clientData.minecraftUsername) {
                clientData.minecraftUsername = username;
            }
            
            if (!clientData.mcSocket || clientData.mcSocket.destroyed) {
                const mcSocket = connectToMinecraft(clientId);
                if (mcSocket) {
                    // Соединение создано
                }
            }
            
            if (clientData.pendingMinecraftPackets.length > 0 && clientData.mcSocket && !clientData.mcSocket.destroyed) {
                for (const buf of clientData.pendingMinecraftPackets) {
                    clientData.mcSocket.write(buf);
                }
                log(`📤 Sent ${clientData.pendingMinecraftPackets.length} queued packets for ${clientId} (OnlineMode fallback)`);
                clientData.pendingMinecraftPackets = [];
            }
            
            if (callbacks?.onClientListUpdate) {
                callbacks.onClientListUpdate(getClientsList());
            }
        } else {
            // В OfflineMode — старое поведение
            log(`❌ Username ${username} rejected by signaling for ${clientId}: ${error}`);
            
            if (callbacks?.onShowToast) {
                const toastMessage = `Player ${clientId} tried to use username "${username}" which is already taken`;
                callbacks.onShowToast('warn', 'Username Conflict', toastMessage);
            }
            
            if (clientData.dc && clientData.dc.isOpen()) {
                try {
                    const kickMessage = JSON.stringify({
                        type: 'kicked',
                        reason: error || `Username "${username}" was rejected. Please use your registered username.`
                    });
                    clientData.dc.sendMessage(kickMessage);
                } catch (e) {
                    log(`Error sending kick message to ${clientId}: ${e.message}`, 'error');
                }
            }
            
            setTimeout(() => {
                cleanupClient(clientId);
            }, 500);
        }
    }
}

module.exports = {
    startHosting,
    stopHosting,
    kickClient
};