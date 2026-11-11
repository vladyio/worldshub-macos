const { PeerConnection } = require('node-datachannel');
const net = require('net');
const { io } = require('socket.io-client');
const config = require('./config');
const { fetchTurnServersFromBackend } = require('./main-process/utils/turn-servers');

// --- Module State ---
const LOCAL_PROXY_PORT = 25565;

let hostId = null;
let authToken = null;

let pc = null;
let dc = null;
let socket = null;
let localProxyServer = null;
let minecraftSocket = null;
let wasKicked = false;
let savedPasswords = new Map(); // Хранилище паролей для приватных серверов

// TURN серверы для клиента
let clientTurnServers = null;
let clientTurnServersFetchedAt = null;

// Счетчик попыток подключения
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 3;

// Очередь ICE-кандидатов
let pendingCandidates = [];
let remoteDescriptionSet = false;

// Флаг для отслеживания процесса очистки
let isCleaningUp = false;

// Флаг для перехвата статусных запросов
let interceptStatusRequests = false; // Включаем обратно

let callbacks = {
    onLog: (message) => console.log(message),
    onStatusUpdate: (status) => console.log(`STATUS: ${status}`)
};

const log = (message) => {
    callbacks.onLog(`[client] ${message}`);
};

const setStatus = (status) => {
    callbacks.onStatusUpdate(status);
};

// Функция для детального логирования состояния подключения
function logConnectionState(context = '') {
    const state = {
        hostId: !!hostId,
        socketConnected: socket?.connected,
        pcExists: !!pc,
        pcState: pc && typeof pc.getState === 'function' ? pc.getState() : 'N/A',
        dcExists: !!dc,
        dcOpen: dc && typeof dc.isOpen === 'function' ? dc.isOpen() : false,
        pendingCandidates: pendingCandidates.length,
        remoteDescriptionSet,
        connectionAttempts,
        context
    };
    
    console.log(`[CLIENT] 🔍 Connection state${context ? ` (${context})` : ''}:`, state);
    return state;
}

// --- Private Functions ---

/**
 * Получает TURN серверы с бекенда для клиента
 */
async function onClientAuthorized(token) {
    try {
        const result = await fetchTurnServersFromBackend(token);
        clientTurnServers = result.iceServers;
        clientTurnServersFetchedAt = new Date();
        console.log(`[CLIENT] Successfully fetched TURN servers from backend at ${clientTurnServersFetchedAt.toISOString()}`);
    } catch (error) {
        console.warn('[CLIENT] Failed to fetch TURN servers from backend:', error.message);
        clientTurnServers = null;
        clientTurnServersFetchedAt = null;
    }
}

/**
 * Проверяет, нужно ли обновить TURN серверы (если прошло больше 12 часов)
 */
function shouldRefreshTurnServers() {
    if (!clientTurnServersFetchedAt) return true;
    
    const now = new Date();
    const hoursDiff = (now - clientTurnServersFetchedAt) / (1000 * 60 * 60);
    const shouldRefresh = hoursDiff > 1; // 1 час, как на бекенде
    
    if (shouldRefresh) {
        console.log(`[CLIENT] TURN servers cache expired (${hoursDiff.toFixed(1)} hours old), will refresh`);
    }
    
    return shouldRefresh;
}

/**
 * Получает актуальный список ICE серверов (стандартные + с бекенда)
 */
async function getCurrentIceServers() {
    // Проверяем, нужно ли обновить TURN серверы
    if (shouldRefreshTurnServers() && authToken) {
        try {
            console.log('[CLIENT] Refreshing TURN servers from backend...');
            const result = await fetchTurnServersFromBackend(authToken);
            clientTurnServers = result.iceServers;
            clientTurnServersFetchedAt = new Date();
            console.log(`[CLIENT] Successfully refreshed TURN servers at ${clientTurnServersFetchedAt.toISOString()}`);
        } catch (error) {
            console.warn('[CLIENT] Failed to refresh TURN servers from backend:', error.message);
            // Не сбрасываем старые серверы при ошибке обновления
        }
    }
    
    // Объединяем стандартные серверы с полученными с бекенда
    const combinedServers = [...config.iceServers];
    
    if (clientTurnServers && clientTurnServers.length > 0) {
        combinedServers.push(...clientTurnServers);
        console.log(`[CLIENT] Combined ICE servers: ${config.iceServers.length} default + ${clientTurnServers.length} from backend = ${combinedServers.length} total`);
    } else {
        console.log(`[CLIENT] Using only default ICE servers: ${config.iceServers.length} servers (no backend servers available)`);
    }
    
    return combinedServers;
}

function cleanUpP2P() {
    console.log('=== CLEANUP P2P CALLED ===');
    log('Cleaning up P2P connections...');
    logConnectionState('cleanUpP2P start');
    
    // Закрываем DataChannel
    if (dc) {
        console.log('Closing DataChannel...');
        try { 
            dc.close(); 
            console.log('DataChannel closed successfully');
        } catch(e) { 
            console.log('Error closing DataChannel:', e.message);
        }
        // Принудительно обнуляем ссылку
        dc = null;
    }
    
    // Закрываем PeerConnection
    if (pc) {
        console.log('Closing PeerConnection...');
        try { 
            pc.close(); 
            console.log('PeerConnection closed successfully');
        } catch(e) { 
            console.log('Error closing PeerConnection:', e.message);
        }
        // Принудительно обнуляем ссылку
        pc = null;
    }
    
    // Сбрасываем все флаги состояния
    wasKicked = false;
    pendingCandidates = [];
    remoteDescriptionSet = false;
    connectionAttempts = 0;
    
    console.log('[CLIENT] Reset ICE candidates queue and remote description flag');
    console.log(`[CLIENT] Cleaned up ${pendingCandidates.length} pending candidates`);
    
    // Безопасно логируем состояние после очистки
    try {
        logConnectionState('cleanUpP2P completed');
    } catch (error) {
        console.log('[CLIENT] Error logging state after cleanup:', error.message);
    }
    console.log('=== CLEANUP P2P COMPLETED ===');
}

/**
 * Полная очистка всех соединений и состояний
 * Используется при переподключении к новому хосту
 */
async function completeCleanup() {
    if (isCleaningUp) {
        console.log('[CLIENT] Cleanup already in progress, skipping...');
        return;
    }
    
    isCleaningUp = true;
    console.log('=== COMPLETE CLEANUP STARTED ===');
    
    try {
        logConnectionState('completeCleanup start');
        
        // 1. Уведомляем сервер о нашем отключении от хоста
        if (socket && socket.connected && hostId) {
            console.log('[CLIENT] Notifying server about disconnection from host...');
            try {
                socket.emit('client_disconnect', { hostId: hostId });
                console.log('[CLIENT] Disconnect notification sent to server');
            } catch (error) {
                console.warn('[CLIENT] Failed to send disconnect notification:', error.message);
            }
        }
        
        // 2. Закрываем Minecraft соединение
        if (minecraftSocket) {
            console.log('[CLIENT] Closing Minecraft socket...');
            try {
                minecraftSocket.destroy();
                console.log('[CLIENT] Minecraft socket closed');
            } catch (error) {
                console.warn('[CLIENT] Error closing Minecraft socket:', error.message);
            }
            minecraftSocket = null;
        }
        
        // 3. Закрываем локальный прокси сервер
        if (localProxyServer) {
            console.log('[CLIENT] Stopping local proxy server...');
            try {
                stopLocalProxy();
                console.log('[CLIENT] Local proxy server stopped');
            } catch (error) {
                console.warn('[CLIENT] Error stopping local proxy server:', error.message);
            }
        }
        
        // 4. Очищаем P2P соединения
        console.log('[CLIENT] Cleaning up P2P connections...');
        cleanUpP2P();
        
        // 5. Сбрасываем все переменные состояния
        console.log('[CLIENT] Resetting state variables...');
        hostId = null;
        authToken = null;
        wasKicked = false;
        pendingCandidates = [];
        remoteDescriptionSet = false;
        connectionAttempts = 0;
        
        // 6. Небольшая задержка для стабилизации
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log('[CLIENT] Complete cleanup finished');
        logConnectionState('completeCleanup completed');
        
    } catch (error) {
        console.error('[CLIENT] Error during complete cleanup:', error);
    } finally {
        isCleaningUp = false;
        // interceptStatusRequests = true; // Включаем обратно
        console.log('=== COMPLETE CLEANUP FINISHED ===');
    }
}

// --- Minecraft Protocol Functions ---

function writeVarInt(value) {
    const bytes = [];
    do {
        let temp = value & 0x7F;
        value >>>= 7;
        if (value !== 0) temp |= 0x80;
        bytes.push(temp);
    } while (value !== 0);
    return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
    let result = 0;
    let shift = 0;
    let size = 0;

    while (true) {
        if (offset + size >= buffer.length) return null;
        const byte = buffer[offset + size];
        result |= (byte & 0x7F) << shift;
        shift += 7;
        size++;
        if ((byte & 0x80) === 0) break;
        if (size > 5) throw new Error('VarInt слишком большой');
    }

    return { value: result, size };
}

// Переменная для хранения версии клиента
let clientVersion = {
    name: "1.21.3",
    protocol: 765
};

// Карта соответствия protocol <-> version name (можно расширить)
const protocolVersionMap = {
    768: "1.21.8",
    767: "1.21.7",
    766: "1.21.6",
    765: "1.21.5",
    764: "1.21.4",
    763: "1.21.3",
    762: "1.21.2",
    761: "1.21.1",
    760: "1.21",
    761: "1.20.6",
    760: "1.20.5",
    759: "1.20.4",
    758: "1.20.3",
    757: "1.20.2",
    756: "1.20.1",
    755: "1.20",
    754: "1.19.4",
    753: "1.19.3",
    752: "1.19.2",
    751: "1.19.1",
    750: "1.19",
    749: "1.18.2",
    748: "1.18.1",
    747: "1.18",
    738: "1.17.1",
    736: "1.17",
    735: "1.16.5",
    734: "1.16.4",
    733: "1.16.3",
    732: "1.16.2",
    731: "1.16.1",
    730: "1.16",
    578: "1.15.2",
    575: "1.15.1",
    573: "1.15",
    498: "1.14.4",
    490: "1.14.3",
    485: "1.14.2",
    480: "1.14.1",
    477: "1.14",
    404: "1.13.2",
    401: "1.13.1",
    393: "1.13",
    340: "1.12.2",
    338: "1.12.1",
    335: "1.12",
    316: "1.11.2",
    315: "1.11",
    210: "1.10.2",
    110: "1.9.4",
    109: "1.9.2",
    108: "1.9.1",
    107: "1.9",
    47: "1.8"
};

function parseHandshakePacket(data) {
    try {
        let offset = 0;
        const lengthResult = readVarInt(data, offset);
        if (!lengthResult) return null;
        offset += lengthResult.size;
        const packetIdResult = readVarInt(data, offset);
        if (!packetIdResult || packetIdResult.value !== 0x00) return null;
        offset += packetIdResult.size;
        // protocol version
        const protoResult = readVarInt(data, offset);
        if (!protoResult) return null;
        offset += protoResult.size;
        // server address (String)
        const strLenResult = readVarInt(data, offset);
        if (!strLenResult) return null;
        offset += strLenResult.size;
        const strLen = strLenResult.value;
        offset += strLen;
        // server port (unsigned short)
        offset += 2;
        // next state (VarInt)
        const nextStateResult = readVarInt(data, offset);
        if (!nextStateResult) return null;
        // protocol version number
        const protocol = protoResult.value;
        // version name (по карте)
        const name = protocolVersionMap[protocol] || `Unknown (${protocol})`;
        return { protocol, name };
    } catch (e) {
        return null;
    }
}

function createStatusResponse() {
    const json = JSON.stringify({
        version: {
            name: clientVersion.name, // Динамически
            protocol: clientVersion.protocol // Динамически
        },
        players: {
            max: 100,
            online: 20,
            sample: [
                { name: "Steve", id: "00000000-0000-0000-0000-000000000000" },
                { name: "Alex", id: "00000000-0000-0000-0000-000000000001" }
            ]
        },
        description: {
            text: "§bPowered by WorldsHub.io 🎮"
        },
        favicon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    });

    const jsonBuffer = Buffer.from(json, 'utf8');
    const packetId = writeVarInt(0x00);
    const jsonLength = writeVarInt(jsonBuffer.length);
    const packetData = Buffer.concat([packetId, jsonLength, jsonBuffer]);
    const packetLength = writeVarInt(packetData.length);

    return Buffer.concat([packetLength, packetData]);
}

function createPongResponse(pingPayload) {
    const packetId = writeVarInt(0x01);
    const packetData = Buffer.concat([packetId, pingPayload]);
    const packetLength = writeVarInt(packetData.length);
    return Buffer.concat([packetLength, packetData]);
}

function isStatusRequest(data) {
    try {
        let offset = 0;
        
        // Читаем длину пакета
        const lengthResult = readVarInt(data, offset);
        if (!lengthResult) return false;
        offset += lengthResult.size;
        
        // Читаем ID пакета
        const packetIdResult = readVarInt(data, offset);
        if (!packetIdResult) return false;
        
        // Статусный запрос имеет ID 0x00, но нужно проверить содержимое
        if (packetIdResult.value === 0x00) {
            offset += packetIdResult.size;
            
            // Проверяем, есть ли данные после ID пакета
            if (offset < data.length) {
                // Если есть данные после ID, это может быть handshake
                // Статусный запрос обычно не содержит дополнительных данных
                return false;
            }
            
            // Если нет данных после ID, это статусный запрос
            return true;
        }
        
        return false;
    } catch (error) {
        return false;
    }
}

function isPingRequest(data) {
    try {
        let offset = 0;
        
        // Читаем длину пакета
        const lengthResult = readVarInt(data, offset);
        if (!lengthResult) return false;
        offset += lengthResult.size;
        
        // Читаем ID пакета
        const packetIdResult = readVarInt(data, offset);
        if (!packetIdResult) return false;
        
        // Ping запрос имеет ID 0x01
        return packetIdResult.value === 0x01;
    } catch (error) {
        return false;
    }
}

function extractPingPayload(data) {
    try {
        let offset = 0;
        
        // Читаем длину пакета
        const lengthResult = readVarInt(data, offset);
        if (!lengthResult) return null;
        offset += lengthResult.size;
        
        // Читаем ID пакета
        const packetIdResult = readVarInt(data, offset);
        if (!packetIdResult) return null;
        offset += packetIdResult.size;
        
        // Возвращаем payload (8 байт для ping)
        return data.slice(offset, offset + 8);
    } catch (error) {
        return null;
    }
}

async function createPeerConnection() {
    console.log('[CLIENT] createPeerConnection called');
    console.log('[CLIENT] 🔍 Detailed createPeerConnection state check:');
    console.log('[CLIENT] - hostId:', hostId);
    console.log('[CLIENT] - socket exists:', !!socket);
    console.log('[CLIENT] - socket.connected:', socket?.connected);
    console.log('[CLIENT] - pc exists:', !!pc);
    console.log('[CLIENT] - dc exists:', !!dc);
    console.log('[CLIENT] - dc.isOpen():', dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A');
    
    try {
        logConnectionState('createPeerConnection start');
    } catch (error) {
        console.log('[CLIENT] Error logging state at createPeerConnection start:', error.message);
    }
    
    // Проверяем все необходимые условия перед созданием PeerConnection
    console.log('[DEBUG] Attempting createPeerConnection with hostId:', hostId, 'socket.connected:', socket?.connected);
    
    if (!hostId || !socket?.connected) {
        console.warn('[CLIENT] ❌ Cannot create PeerConnection: missing hostId or disconnected socket.');
        setStatus('Cannot create connection: missing host or signaling connection');
        return;
    }
    
    if (pc) {
        console.log('[CLIENT] PeerConnection already exists. Skipping creation.');
        log('PeerConnection already exists. Skipping creation.');
        return;
    }
    
    // Проверяем, есть ли уже активный DataChannel
    if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
        console.log('[CLIENT] DataChannel is already open, skipping PeerConnection creation');
        try {
            logConnectionState('DataChannel already open');
        } catch (error) {
            console.log('[CLIENT] Error logging state when DataChannel already open:', error.message);
        }
        return;
    }
    
    // Сбрасываем счетчик попыток при начале нового подключения
    if (connectionAttempts === 0) {
        console.log('[CLIENT] 🚀 Starting new connection attempt');
    }
    
    setStatus('Requesting connection to host...');
    
    // Добавляем таймаут для ожидания авторизации
    const authorizationTimeout = setTimeout(() => {
        console.log('[CLIENT] ⏰ Authorization timeout - no client_authorized event received');
        console.log('[CLIENT] This might indicate that the host is not responding or there is an authorization issue');
        setStatus('Authorization timeout - host may not be responding');
    }, 10000); // 10 секунд на авторизацию
    
    // Получаем актуальный список ICE серверов (стандартные + с бекенда)
    const iceServers = await getCurrentIceServers();
    
    // Подсчитываем количество TURN серверов
    const turnServersCount = iceServers.filter(server => server.includes('turn:')).length;
    const stunServersCount = iceServers.filter(server => server.includes('stun:')).length;
    
    console.log(`[CLIENT] ICE servers: ${iceServers.length} total (${stunServersCount} STUN, ${turnServersCount} TURN)`);
    
    pc = new PeerConnection('client-pc', { 
        iceServers,
        portRangeBegin: 50000,
        portRangeEnd: 59999
    });

    pc.onStateChange(state => {
        log(`Connection state: ${state}`);
        console.log(`[CLIENT] PeerConnection state changed to: ${state}`);
        try {
            logConnectionState(`PeerConnection state: ${state}`);
        } catch (error) {
            console.log('[CLIENT] Error logging state on PeerConnection state change:', error.message);
        }
        
        if (state === 'connected') {
            console.log('[CLIENT] 🎉 PeerConnection CONNECTED!');
            setStatus('connected');
            
            // Log selected candidate pair when connected
            try {
                const selectedPair = pc.getSelectedCandidatePair();
                if (selectedPair) {
                    console.log('[CLIENT] 🎯 Selected candidate pair:', {
                        local: {
                            address: selectedPair.local.address,
                            port: selectedPair.local.port,
                            type: selectedPair.local.type,
                            transportType: selectedPair.local.transportType
                        },
                        remote: {
                            address: selectedPair.remote.address,
                            port: selectedPair.remote.port,
                            type: selectedPair.remote.type,
                            transportType: selectedPair.remote.transportType
                        }
                    });
                    
                    // Log connection type
                    if (selectedPair.local.type === 'relay' || selectedPair.remote.type === 'relay') {
                        console.log('[CLIENT] 🔄 Connection established via TURN relay');
                    } else if (selectedPair.local.type === 'srflx' || selectedPair.remote.type === 'srflx') {
                        console.log('[CLIENT] 🌐 Connection established via STUN reflexive');
                    } else if (selectedPair.local.type === 'host' && selectedPair.remote.type === 'host') {
                        console.log('[CLIENT] 🏠 Connection established directly (local network)');
                    } else {
                        console.log('[CLIENT] 🔄 Connection established via peer reflexive');
                    }
                }
            } catch (error) {
                console.log('[CLIENT] Could not get selected candidate pair:', error.message);
            }
        } else if (state === 'disconnected' || state === 'failed') {
            console.log(`[CLIENT] ❌ PeerConnection ${state}`);
            setStatus('disconnected');
        }
    });

    pc.onLocalDescription((sdp, type) => {
        console.log('[DEBUG] Sending offer to hostId:', hostId, 'socket connected:', socket.connected);
        
        if (!hostId) {
            console.warn('[CLIENT] ❌ Host ID is not set. Cannot send offer.');
            return;
        }
        
        if (!socket || !socket.connected) {
            console.warn('[CLIENT] ❌ Socket.IO not connected. Cannot send offer.');
            return;
        }
        
        const offerData = { to: hostId, data: { sdp, type } };
        
        // Добавляем пароль для приватных серверов
        const savedPassword = savedPasswords.get(hostId);
        if (savedPassword) {
            offerData.data.password = savedPassword;
            console.log(`[CLIENT] Including password for private server ${hostId}`);
        } else {
            console.log(`[CLIENT] No password found for server ${hostId}, treating as public server`);
        }
        
        // Добавляем invite code если он есть
        const savedInviteCode = savedPasswords.get(`${hostId}_invite`);
        if (savedInviteCode) {
            offerData.data.inviteCode = savedInviteCode;
            console.log(`[CLIENT] Including invite code for server ${hostId}`);
        }
        
        console.log(`[CLIENT] Sending offer to host ${hostId}:`, {
            hasPassword: !!savedPassword,
            hasInviteCode: !!savedInviteCode,
            sdpType: type,
            sdpLength: sdp.length
        });
        
        socket.emit('offer', offerData);
    });

    pc.onLocalCandidate((candidate, mid) => {
        console.log(`[CLIENT] Found local ICE candidate: ${JSON.stringify(candidate)}`);
        
        // Log connection type based on candidate
        if (candidate && candidate.candidate) {
            const candidateStr = candidate.candidate;
            if (candidateStr.includes('typ relay')) {
                console.log('[CLIENT] 🔄 Using TURN relay connection');
            } else if (candidateStr.includes('typ srflx')) {
                console.log('[CLIENT] 🌐 Using STUN reflexive connection');
            } else if (candidateStr.includes('typ host')) {
                console.log('[CLIENT] 🏠 Using local host connection');
            } else if (candidateStr.includes('typ prflx')) {
                console.log('[CLIENT] 🔄 Using peer reflexive connection');
            }
        }
        
        // Добавляем небольшую задержку для лучшей синхронизации
        setTimeout(() => {
            socket.emit('candidate', { from: 'client', to: hostId, data: { candidate, mid } });
        }, 100);
    });

    dc = pc.createDataChannel('proxy-dc');

    // Добавляем таймаут для PeerConnection с улучшенной логикой
    const connectionTimeout = setTimeout(() => {
        console.log('[CLIENT] ⏰ PeerConnection timeout triggered');
        console.log('[CLIENT] Current PeerConnection state:', pc ? (typeof pc.getState === 'function' ? pc.getState() : 'unknown') : 'no pc');
        
        if (pc && typeof pc.getState === 'function' && pc.getState() === 'connecting') {
            connectionAttempts++;
            console.log(`[CLIENT] ⏰ PeerConnection timeout - attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}`);
            log(`Connection timeout - attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}`);
            
            if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
                setStatus(`Connection timeout. Retrying automatically (${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS})...`);
                
                // Автоматический retry с улучшенной логикой
                console.log('[CLIENT] 🔄 Auto-retrying connection...');
                cleanUpP2P();
                
                // Уменьшаем задержку retry для более быстрого восстановления
                const retryDelay = Math.min(1000 + (connectionAttempts * 500), 3000); // 1-3 секунды
                console.log(`[CLIENT] 🔄 Retry delay: ${retryDelay}ms`);
                
                setTimeout(() => {
                    console.log('[CLIENT] 🔄 Checking conditions for retry...');
                    console.log('[CLIENT] Retry check - hostId:', !!hostId, 'socket.connected:', socket?.connected);
                    
                    if (hostId && socket && socket.connected) {
                        console.log('[CLIENT] 🔄 All conditions met, retrying PeerConnection creation...');
                        createPeerConnection().catch(error => {
                            console.error('[CLIENT] Retry failed:', error);
                            setStatus('Connection failed after retry. Please try manually.');
                        });
                    } else {
                        console.log('[CLIENT] ❌ Retry conditions not met, giving up');
                        setStatus('Cannot retry: missing host or signaling connection');
                    }
                }, retryDelay);
            } else {
                setStatus('Connection failed after multiple attempts. Please try manually.');
                console.log('[CLIENT] ❌ Max connection attempts reached, giving up');
                cleanUpP2P();
            }
        } else {
            console.log('[CLIENT] ⏰ Timeout triggered but PeerConnection is not in connecting state');
            console.log('[CLIENT] This might indicate that the host is not responding to the offer');
        }
    }, 15000); // Уменьшаем с 30 до 15 секунд для более быстрого обнаружения проблем

    // Очищаем таймаут при успешном подключении
    pc.onStateChange(state => {
        if (state === 'connected' || state === 'failed' || state === 'closed' || state === 'disconnected') {
            clearTimeout(connectionTimeout);
        }
    });

    dc.onOpen(() => {
        log('DataChannel opened');
        console.log('[CLIENT] 🎉 DataChannel OPENED!');
        setStatus('connected');
        
        // Сбрасываем счетчик попыток при успешном подключении
        connectionAttempts = 0;
        console.log('[CLIENT] ✅ Connection successful, resetting attempt counter');
        
        // Отправляем P2P_CONNECTION_ACTIVE сразу после успешного подключения
        if (callbacks && callbacks.onStatusUpdate) {
            console.log(`[CLIENT] DataChannel opened, sending P2P_CONNECTION_ACTIVE`);
            callbacks.onStatusUpdate('P2P_CONNECTION_ACTIVE');
        }
        
        startLocalProxy();
    });

    dc.onClosed(() => {
        log('DataChannel closed');
        console.log('[CLIENT] ❌ DataChannel CLOSED');
        setStatus('disconnected');
        stopLocalProxy();
        cleanUpP2P();
        
        // НЕ запускаем retryConnectLater при принудительном закрытии
        // Retry нужен только при неожиданном разрыве соединения
        // При выходе из Minecraft сервера пользователь сам решит, когда подключаться
        console.log('[CLIENT] DataChannel closed, skipping automatic retry (user will reconnect manually)');
    });

    dc.onError((error) => {
        console.log('[CLIENT] ❌ DataChannel ERROR:', error);
        log(`DataChannel error: ${error}`);
    });

    dc.onMessage((msg) => {
        // Логирование входящих пакетов от хоста
        try {
            const length = readVarInt(msg, 0);
            if (length) {
                const packetId = readVarInt(msg, length.size);
                if (packetId) {
                    // console.log(`[CLIENT] Receiving packet from host: ID=${packetId.value}, length=${length.value}`);
                }
            }
        } catch (e) {
            // console.log(`[CLIENT] ⚠️ Could not parse incoming packet for logging: ${e.message}`);
        }
        try {
            const data = JSON.parse(msg);
            console.log('[CLIENT] Received message from host:', data);
            
            // Обработка ошибок Minecraft сервера
            if (data.type === 'minecraft_server_error') {
                log(`❌ Minecraft server error: ${data.reason}`);
                console.log(`[CLIENT] ❌ Minecraft server error: ${data.reason}`);
                if (data.details) {
                    console.log(`[CLIENT] Details: ${data.details}`);
                }
                setStatus(`Minecraft server error: ${data.reason}`);
                
                // Закрываем локальное соединение при ошибке сервера
                if (minecraftSocket) {
                    minecraftSocket.destroy();
                    minecraftSocket = null;
                }
                return;
            }
            
            // Обработка ошибки unknown packet id
            if (data.type === 'minecraft_protocol_error') {
                log(`❌ Minecraft protocol error: ${data.reason}`);
                console.log(`[CLIENT] ❌ Minecraft protocol error: ${data.reason}`);
                setStatus(`Protocol error: ${data.reason}. Restarting connection...`);
                
                // Перезапускаем прокси сервер при ошибке протокола
                restartLocalProxy();
                return;
            }
            
            if (data.type === 'kicked') {
                log(`Kicked by host: ${data.reason}`);
                setStatus(`You were kicked by the host.`);
                
                // Уведомляем Angular о кике
                if (callbacks && callbacks.onShowToast) {
                    callbacks.onShowToast('warn', 'Kicked', data.reason || 'You were kicked by the host');
                }
                
                disconnectFromHost();
                return;
            }
            
            if (data.type === 'client-list') {
                log(`👥 Received client list from host: ${data.clients.map(c => c.id).join(', ')}`);
                console.log('[CLIENT] Connected players:', data.clients.map(c => c.id).join(', '));
                
                if (callbacks && callbacks.onClientListUpdate) {
                    callbacks.onClientListUpdate(data.clients, hostId);
                }
                return;
            }
            
            if (data.type === 'signaling-disconnected') {
                log(`Signaling server disconnected: ${data.message}`);
                setStatus('Signaling server disconnected, but P2P connection remains active');
                return;
            }
            
            if (data.type === 'signaling-reconnected') {
                log(`Signaling server reconnected: ${data.message}`);
                setStatus('Signaling server reconnected');
                return;
            }
            
            if (data.type === 'pong') {
                // Игнорируем pong сообщения
                return;
            }
            
            log(`Unknown message type from host: ${data.type}`);
            
        } catch (error) {
            // Если это не JSON, то это бинарные данные от Minecraft сервера
            if (minecraftSocket && !minecraftSocket.destroyed) {
                try {

                    
                    minecraftSocket.write(msg);
                } catch (e) {
                    log(`Error writing to Minecraft socket: ${e.message}`);
                    console.log(`[CLIENT] Error writing to Minecraft socket: ${e.message}`);
                    
                    // Если произошла ошибка записи, закрываем соединение
                    minecraftSocket.destroy();
                    minecraftSocket = null;
                }
            } else {
                // Игнорируем бинарные данные если нет активного Minecraft сокета
                // Это нормально после отключения от сервера
                // log('Received binary data but no Minecraft socket available');
                // console.log('[CLIENT] Received binary data but no Minecraft socket available');
            }
        }
    });
}

function startLocalProxy() {
    console.log('[CLIENT] startLocalProxy() called');
    
    if (localProxyServer) {
        console.log('[CLIENT] Local proxy server is already running, stopping it first');
        stopLocalProxy();
        // Небольшая задержка перед запуском нового сервера
        setTimeout(() => {
            startLocalProxy();
        }, 100);
        return;
    }

    localProxyServer = net.createServer(socket => {
        // Проверка: открыт ли DataChannel
        if (!dc || !(typeof dc.isOpen === 'function' && dc.isOpen())) {
            log('Minecraft client tried to connect before DataChannel was open. Closing connection.');
            socket.destroy();
            return;
        }

        log('Minecraft client connected to local proxy.');

        // Закрываем предыдущее соединение, если есть
        if (minecraftSocket) {
            log('Replacing existing Minecraft socket with new connection.');
            minecraftSocket.destroy();
            minecraftSocket = null;
        }

        // Назначаем новое соединение
        minecraftSocket = socket;
        minecraftSocket.minecraftConnectedNotified = false;

        // Добавляем обработку ошибок для предотвращения ECONNABORTED
        minecraftSocket.on('error', (err) => {
            if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
                log(`Minecraft socket error (${err.code}): ${err.message}`);
                console.log(`[CLIENT] Minecraft socket error (${err.code}): ${err.message}`);
                
                // Очищаем ссылку на сокет при ошибке
                if (minecraftSocket === socket) {
                    minecraftSocket = null;
                }
                
                // Уведомляем хост об отключении
                if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
                    try {
                        const disconnectMessage = JSON.stringify({ type: 'minecraft_disconnect' });
                        dc.sendMessage(disconnectMessage);
                        log('Sent minecraft_disconnect notification to host');
                    } catch (e) {
                        log(`Error sending minecraft_disconnect: ${e.message}`);
                    }
                }
            } else {
                log(`Minecraft socket error: ${err.message}`);
                console.log(`[CLIENT] Minecraft socket error: ${err.message}`);
                
                // При любых других ошибках также очищаем сокет
                if (minecraftSocket === socket) {
                    minecraftSocket = null;
                }
            }
        });

        minecraftSocket.on('close', () => {
            log('Local game connection closed.');
            
            // Очищаем ссылку на сокет при закрытии
            if (minecraftSocket === socket) {
                minecraftSocket = null;
            }
            
            // Уведомляем хост об отключении
            if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
                try {
                    const disconnectMessage = JSON.stringify({ type: 'minecraft_disconnect' });
                    dc.sendMessage(disconnectMessage);
                    log('Sent minecraft_disconnect notification to host');
                } catch (e) {
                    log(`Error sending minecraft_disconnect: ${e.message}`);
                }
            }
            
            // Сбрасываем флаг для следующего подключения
            if (minecraftSocket) {
                minecraftSocket.minecraftConnectedNotified = false;
            }
        });

        minecraftSocket.on('data', (data) => {
            // Определяем версию клиента из handshake пакета
            if (interceptStatusRequests) {
                const handshakeInfo = parseHandshakePacket(data);
                if (handshakeInfo) {
                    clientVersion.protocol = handshakeInfo.protocol;
                    clientVersion.name = handshakeInfo.name;
                    // console.log(`[CLIENT] 🎯 Detected client version: ${handshakeInfo.name} (protocol ${handshakeInfo.protocol})`);
                }
            }

            if (!minecraftSocket.minecraftConnectedNotified) {
                // Отправляем уведомление о подключении при первом получении данных
                if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
                    try {
                        const connectMessage = JSON.stringify({ type: 'minecraft_connect' });
                        dc.sendMessage(connectMessage);
                        log('Sent minecraft_connect notification to host (first data received)');
                        minecraftSocket.minecraftConnectedNotified = true;
                    } catch (e) {
                        log(`Error sending minecraft_connect: ${e.message}`);
                    }
                }
            }

            // Добавляем детальное логирование для отладки
            try {
                let offset = 0;
                const lengthResult = readVarInt(data, offset);
                if (lengthResult) {
                    offset += lengthResult.size;
                    const packetIdResult = readVarInt(data, offset);
                    if (packetIdResult) {
                        // console.log(`[CLIENT] 📦 Received packet: ID=${packetIdResult.value} (0x${packetIdResult.value.toString(16)}), Length=${lengthResult.value}`);
                    }
                }
            } catch (e) {
                console.log(`[CLIENT] ⚠️ Could not parse packet header: ${e.message}`);
            }

            // Проверяем, является ли это статусным запросом
            if (interceptStatusRequests && isStatusRequest(data)) {
                // Дополнительная проверка - анализируем содержимое пакета
                let shouldIntercept = true;
                try {
                    let offset = 0;
                    const lengthResult = readVarInt(data, offset);
                    if (lengthResult) {
                        offset += lengthResult.size;
                        const packetIdResult = readVarInt(data, offset);
                        if (packetIdResult) {
                            offset += packetIdResult.size;
                            console.log(`[CLIENT] 📤 Packet analysis: Length=${lengthResult.value}, ID=${packetIdResult.value}, Remaining data: ${data.length - offset} bytes`);
                            
                            if (data.length - offset > 0) {
                                shouldIntercept = false; // Не перехватываем пакеты с дополнительными данными
                            }
                        }
                    }
                } catch (e) {
                    // Игнорируем ошибки анализа пакетов
                }
                
                if (shouldIntercept) {
                    log('📤 Перехвачен статусный запрос, отправляем фейковый ответ');
                    
                    try {
                        const statusResponse = createStatusResponse();
                        minecraftSocket.write(statusResponse);
                        log('📤 Отправлен фейковый статус сервера');
                        return; // Не отправляем на хост
                    } catch (e) {
                        log(`Error sending fake status response: ${e.message}`);
                    }
                }
            }

            // Проверяем, является ли это ping запросом
            if (interceptStatusRequests && isPingRequest(data)) {
                log('🏓 Перехвачен ping запрос, отправляем pong ответ');
                
                try {
                    const pingPayload = extractPingPayload(data);
                    if (pingPayload) {
                        const pongResponse = createPongResponse(pingPayload);
                        minecraftSocket.write(pongResponse);
                        log('🏓 Отправлен pong ответ');
                        return; // Не отправляем на хост
                    }
                } catch (e) {
                    log(`Error sending pong response: ${e.message}`);
                }
            }

            // Отправляем остальные данные на хост
            if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
                try {
                    
                    
                    dc.sendMessageBinary(data);
                } catch (e) {
                    log(`Error sending data to host: ${e.message}`);
                    
                    // Если произошла ошибка отправки, закрываем соединение
                    if (minecraftSocket === socket) {
                        minecraftSocket.destroy();
                        minecraftSocket = null;
                    }
                }
            }
        });

        // Добавляем задержку перед началом передачи данных для стабилизации
        setTimeout(() => {
            // Повторная проверка DataChannel после задержки
            if (!dc || !(typeof dc.isOpen === 'function' && dc.isOpen())) {
                log('DataChannel not ready after delay, closing connection.');
                socket.destroy();
                return;
            }
            
            log('Starting data transfer after stabilization delay.');
        }, 200);
    });

    localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
        log(`Local proxy server listening on 127.0.0.1:${LOCAL_PROXY_PORT}`);
    });

    localProxyServer.on('error', (err) => {
        log(`Local proxy server error: ${err.message}`);
        
        // Если порт занят, попробуем перезапустить сервер
        if (err.code === 'EADDRINUSE') {
            setTimeout(() => {
                stopLocalProxy();
                setTimeout(() => {
                    startLocalProxy();
                }, 100);
            }, 100);
        }
    });
}

function stopLocalProxy() {
    if (minecraftSocket) {
        minecraftSocket.destroy();
        minecraftSocket = null;
    }
    
    if (localProxyServer) {
        localProxyServer.close(() => {
            // Прокси сервер закрыт
        });
        localProxyServer = null;
    }
}

function restartLocalProxy() {
    log('Restarting local proxy server...');
    
    // Закрываем существующий прокси сервер
    if (localProxyServer) {
        localProxyServer.close();
        localProxyServer = null;
    }
    
    // Закрываем существующее Minecraft соединение
    if (minecraftSocket) {
        minecraftSocket.destroy();
        minecraftSocket = null;
    }
    
    // Запускаем новый прокси сервер
    setTimeout(() => {
        startLocalProxy();
        log('Local proxy server restarted');
    }, 1000); // Небольшая задержка для стабилизации
}

function disconnectFromHost() {
    log('Disconnecting from host...');
    setStatus('Disconnecting from host...');
    if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
        dc.close();
        dc = null;
    }
    if (pc) {
        pc.close();
        pc = null;
    }
    minecraftSocket = null;
    log('Disconnected from host.');
    setStatus('Disconnected from host.');
}

function connectToSignalingAsClient() {
    setStatus('Connecting to signaling server as CLIENT...');
    
    // Проверяем, не в процессе ли уже подключения к signaling серверу
    if (socket && (socket.connected || socket.connecting)) {
        log('Already connected or connecting to signaling server.');
        console.log('[CLIENT] Socket already connected/connecting, checking P2P connection state...');
        console.log('[CLIENT] - hostId:', hostId);
        console.log('[CLIENT] - pc exists:', !!pc);
        console.log('[CLIENT] - dc exists:', !!dc);
        console.log('[CLIENT] - dc.isOpen():', dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A');
        
        // Проверяем, есть ли активное соединение с хостом
        if (hostId && (!pc || !dc || !(typeof dc.isOpen === 'function' && dc.isOpen()))) {
            log('Connected to signaling server but no active P2P connection, creating new connection...');
            console.log('[CLIENT] ✅ Creating PeerConnection from connectToSignalingAsClient');
            createPeerConnection().catch(error => {
                console.error('[CLIENT] Error creating PeerConnection:', error);
                setStatus('Failed to create connection');
            });
        } else if (hostId && !pc) {
            // Специальный случай для повторных подключений: если есть hostId, но нет PeerConnection
            log('Connected to signaling server, hostId exists but no PeerConnection, creating new connection...');
            console.log('[CLIENT] ✅ Creating PeerConnection for reconnection from connectToSignalingAsClient');
            createPeerConnection().catch(error => {
                console.error('[CLIENT] Error creating PeerConnection for reconnection:', error);
                setStatus('Failed to create connection for reconnection');
            });
        } else {
            console.log('[CLIENT] ❌ Not creating PeerConnection - conditions not met');
            console.log('[CLIENT] hostId:', hostId, 'pc:', !!pc, 'dc:', !!dc, 'dc.isOpen():', dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A');
        }
        return;
    }

    // Создаем Socket.IO клиент
    socket = io(`https://${config.serverAddress}`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000, // 10 секунд максимум
        reconnectionAttempts: 30 // 30 попыток для 5 минут (1+2+4+8+10*26 = ~5 минут)
    });

    socket.on('connect', () => {
        log('Socket.IO connected. Registering as CLIENT...');
        
        // Логируем токен перед отправкой
        console.log('[CLIENT] Connecting to signaling server with token:', authToken ? 'provided' : 'not provided');
        
        const registerData = { clientType: 'client' };
        
        // Добавляем токен если он есть
        if (authToken) {
            registerData.token = authToken;
            log('Including authorization token in registration');
        } else {
            log('No authorization token provided for registration');
        }
        
        socket.emit('register', registerData);
        
        // Уведомляем Angular о подключении к signaling серверу
        if (callbacks && callbacks.onSignalingStatusUpdate) {
            callbacks.onSignalingStatusUpdate('signaling-connected');
        }
    });

    socket.on('disconnect', (reason) => {
        log(`Socket.IO disconnected: ${reason}`);
        console.log(`[CLIENT] Socket.IO disconnected: ${reason}`);
        console.log(`[CLIENT] dc exists: ${!!dc}, dc.isOpen(): ${dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A'}`);
        console.log(`[CLIENT] pc exists: ${!!pc}`);
        
        // Уведомляем Angular о отключении signaling сервера
        if (callbacks && callbacks.onSignalingStatusUpdate) {
            if (socket.io.opts.reconnection && socket.io.opts.reconnectionAttempts > 0) {
                callbacks.onSignalingStatusUpdate('signaling-reconnecting');
            } else {
                callbacks.onSignalingStatusUpdate('signaling-disconnected');
            }
        }
        
        // Проверяем, есть ли активное P2P соединение
        if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
            log(`Signaling server disconnected, but P2P connection is still active. Continuing game session.`);
            console.log(`[CLIENT] P2P connection is active, sending P2P_CONNECTION_ACTIVE`);
            setStatus('Signaling server disconnected, but game connection remains active.');
            
            // Уведомляем Angular о том, что P2P соединение активно
            if (callbacks && callbacks.onStatusUpdate) {
                console.log(`[CLIENT] Calling callbacks.onStatusUpdate('P2P_CONNECTION_ACTIVE')`);
                callbacks.onStatusUpdate('P2P_CONNECTION_ACTIVE');
            } else {
                console.log(`[CLIENT] callbacks or callbacks.onStatusUpdate is not available`);
            }
        } else {
            log(`Signaling server disconnected and no active P2P connection.`);
            console.log(`[CLIENT] No active P2P connection, but preserving connection state`);
            setStatus('Disconnected from signaling server.');
            if (!wasKicked) {
                setStatus('Connection lost. Please try connecting again.');
                // НЕ вызываем disconnect() здесь, чтобы не сбрасывать состояние в Angular
                // Просто очищаем P2P соединения, но сохраняем информацию о сервере
                if (dc) {
                    try { dc.close(); } catch(e) { }
                    dc = null;
                }
                if (pc) {
                    try { pc.close(); } catch(e) { }
                    pc = null;
                }
                
                console.log(`[CLIENT] P2P connection is not active, not sending P2P_CONNECTION_ACTIVE`);
            }
        }
    });

    socket.on('connect_error', (error) => {
        log(`Socket.IO connection error: ${error.message}`);
        setStatus('Server connection error.');
    });

    socket.on('registration_failed', (data) => {
        const reason = data.reason || 'Invalid or expired authorization token';
        log(`Registration failed: ${reason}`);
        setStatus(`Registration failed: ${reason}`);
        if (callbacks && callbacks.onShowToast) {
            callbacks.onShowToast('error', 'Connection failed', reason);
        }
    });

    socket.on('client_unauthorized', (data) => {
        log(`Client unauthorized: ${data.reason || 'Invalid or missing authorization token'}`);
        setStatus(`Unauthorized: ${data.reason || 'Invalid or missing authorization token'}`);
        
        // Показываем уведомление пользователю
        if (callbacks && callbacks.onShowToast) {
            callbacks.onShowToast('error', 'Unauthorized', data.reason || 'Invalid or missing authorization token');
        }
        
        // Отключаемся от сервера
        wasKicked = true;
        disconnect();
    });

    socket.on('player-banned', (data) => {
        log(`You have been banned from the server: ${data.reason || 'No reason provided'}`);
        setStatus(`Banned: ${data.reason || 'No reason provided'}`);
        
        // Показываем уведомление пользователю
        if (callbacks && callbacks.onShowToast) {
            callbacks.onShowToast('error', 'Banned', data.message || 'You have been banned from the server');
        }
        
        // Отключаемся от сервера
        wasKicked = true;
        disconnect();
    });

    socket.on('player-kicked', (data) => {
        log(`You have been kicked from the server: ${data.reason || 'No reason provided'}`);
        setStatus(`Kicked: ${data.reason || 'No reason provided'}`);
        
        // Показываем уведомление пользователю
        if (callbacks && callbacks.onShowToast) {
            callbacks.onShowToast('warn', 'Kicked', data.message || 'You have been kicked from the server');
        }
        
        // Отключаемся от сервера
        wasKicked = true;
        disconnect();
    });

    socket.on('connection_rejected', (data) => {
        const { reason, message } = data;
        log(`Connection rejected: ${reason} - ${message}`);
        setStatus(`Connection rejected: ${message}`);
        
        // Очищаем ресурсы
        cleanUpP2P();
        
        // Уведомляем Angular об ошибке
        if (callbacks && callbacks.onShowToast) {
            let severity = 'error';
            let summary = 'Connection Failed';
            
            if (reason === 'password_required') {
                summary = 'Password Required';
            } else if (reason === 'wrong_password') {
                summary = 'Wrong Password';
            } else if (reason === 'banned') {
                summary = 'Access Denied';
            }
            
            callbacks.onShowToast(severity, summary, message);
        }
        
        // Уведомляем Angular о статусе
        if (callbacks && callbacks.onStatusUpdate) {
            callbacks.onStatusUpdate('error', `Connection failed: ${message}`);
        }
    });

    socket.on('reconnect', (attemptNumber) => {
        log(`Reconnected to signaling server after ${attemptNumber} attempts`);
        console.log(`[CLIENT] Signaling server reconnected, attempt ${attemptNumber}`);
        console.log(`[CLIENT] Current state - pc: ${!!pc}, dc: ${!!dc}, dc.isOpen(): ${dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A'}`);
        
        // Перерегистрируемся после переподключения
        const registerData = { clientType: 'client' };
        
        // Добавляем токен если он есть
        if (authToken) {
            registerData.token = authToken;
        }
        
        socket.emit('register', registerData);
        
        // Уведомляем Angular о восстановлении signaling сервера
        if (callbacks && callbacks.onSignalingStatusUpdate) {
            callbacks.onSignalingStatusUpdate('signaling-connected');
        }
        
        // Если P2P соединение активно, просто уведомляем о восстановлении
        if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
            log('P2P connection is still active, signaling server restored');
            setStatus('Signaling server reconnected. Game connection remains active.');
            
            // Уведомляем Angular о том, что соединение полностью восстановлено
            if (callbacks && callbacks.onStatusUpdate) {
                callbacks.onStatusUpdate('FULL_CONNECTION_RESTORED');
            }
        } else if (!dc && !pc) {
            // Если нет активных соединений, пытаемся восстановить
            log('No active P2P connection, attempting to reconnect...');
            setStatus('Reconnecting to host...');
            createPeerConnection().catch(error => {
                console.error('[CLIENT] Error creating PeerConnection:', error);
                setStatus('Failed to create connection');
            });
        } else if (pc && !dc) {
            // Если есть PeerConnection но нет DataChannel, очищаем и создаем новое
            log('PeerConnection exists but DataChannel is closed, cleaning up and reconnecting...');
            setStatus('Reconnecting to host...');
            cleanUpP2P();
            createPeerConnection().catch(error => {
                console.error('[CLIENT] Error creating PeerConnection:', error);
                setStatus('Failed to create connection');
            });
        } else {
            // Если есть частичные соединения, ждем их завершения
            log('Partial connections detected, waiting for completion...');
            setStatus('Signaling server reconnected, waiting for connection completion...');
        }
    });

    // Обработка WebRTC signaling
    socket.on('answer', async ({ data }) => {
        console.log('[CLIENT] 📥 Answer event received');
        console.log('[CLIENT] Answer data:', data);
        
        if (!pc) {
            console.log('[CLIENT] ❌ No PeerConnection to apply answer to.');
            log('No PeerConnection to apply answer to.');
            return;
        }

        try {
            console.log(`[CLIENT] 📥 Received answer, setting remote description...`);
            await pc.setRemoteDescription(data.sdp, data.type);
            remoteDescriptionSet = true;
            console.log(`[CLIENT] ✅ Remote description set successfully`);

            // Обрабатываем отложенные кандидаты с улучшенной обработкой ошибок
            console.log(`[CLIENT] 📋 Processing ${pendingCandidates.length} pending candidates`);
            const processedCount = pendingCandidates.length;
            let successCount = 0;
            let errorCount = 0;
            
            pendingCandidates.forEach(({ candidate, mid }, index) => {
                try {
                    pc.addRemoteCandidate(candidate, mid);
                    successCount++;
                } catch (err) {
                    errorCount++;
                    console.warn(`[CLIENT] ⚠️ Failed to add pending candidate ${index + 1}:`, err.message);
                }
            });
            
            console.log(`[CLIENT] ✅ Processed ${successCount} candidates successfully, ${errorCount} failed`);
            pendingCandidates = [];
        } catch (err) {
            console.error('[CLIENT] ❌ Failed to set remote description:', err);
            // Сбрасываем флаг при ошибке
            remoteDescriptionSet = false;
        }
    });

    socket.on('candidate', ({ data }) => {
        console.log('[CLIENT] 📥 Candidate event received');
        console.log('[CLIENT] Candidate data:', data);
        
        if (!pc) {
            console.log('[CLIENT] ❌ No PeerConnection for candidate.');
            log('No PeerConnection for candidate.');
            return;
        }

        // Log remote connection type
        if (data && data.candidate) {
            const candidateStr = data.candidate;
            if (candidateStr.includes('typ relay')) {
                console.log('[CLIENT] 🔄 Remote peer using TURN relay');
            } else if (candidateStr.includes('typ srflx')) {
                console.log('[CLIENT] 🌐 Remote peer using STUN reflexive');
            } else if (candidateStr.includes('typ host')) {
                console.log('[CLIENT] 🏠 Remote peer using local host');
            } else if (candidateStr.includes('typ prflx')) {
                console.log('[CLIENT] 🔄 Remote peer using peer reflexive');
            }
        }

        // Добавляем небольшую задержку для лучшей синхронизации
        setTimeout(() => {
            if (remoteDescriptionSet) {
                pc.addRemoteCandidate(data.candidate, data.mid);
                console.log(`[CLIENT] ✅ Added remote candidate immediately (remote description set)`);
            } else {
                pendingCandidates.push(data);
                // Ограничиваем размер очереди для предотвращения утечек памяти
                if (pendingCandidates.length > 50) {
                    console.log(`[CLIENT] ⚠️ Pending candidates queue limit reached, removing oldest candidate`);
                    pendingCandidates.shift();
                }
                console.log(`[CLIENT] 📋 Queued remote candidate (${pendingCandidates.length} pending)`);
            }
        }, 100);
    });

    // Обработка отключения хоста
    socket.on('host_disconnected', (data) => {
        log('Host disconnected from server.');
        setStatus('Host disconnected from server.');
        
        // Проверяем, есть ли активное P2P соединение
        if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
            log('Host disconnected from signaling server, but P2P connection is still active.');
            setStatus('Host disconnected from signaling server, but game connection remains active.');
            
            // Уведомляем Angular о том, что P2P соединение активно
            if (callbacks && callbacks.onStatusUpdate) {
                callbacks.onStatusUpdate('P2P_CONNECTION_ACTIVE');
            }
        } else {
            // Только если нет активного P2P соединения, отключаемся полностью
            log('No active P2P connection, performing full disconnect');
            disconnect();
        }
    });

    // Обработка авторизации от сервера
    socket.on('client_authorized', async (data) => {
        log(`Authorized by signaling server`);
        console.log('[CLIENT] 🎉 Authorized by signaling server');
        console.log('[CLIENT] client_authorized event data:', data);
        console.log('[CLIENT] Current hostId at client_authorized:', hostId);
        console.log('[CLIENT] Detailed state check:');
        console.log('[CLIENT] - hostId exists:', !!hostId);
        console.log('[CLIENT] - pc exists:', !!pc);
        console.log('[CLIENT] - dc exists:', !!dc);
        console.log('[CLIENT] - dc.isOpen():', dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A');
        console.log('[CLIENT] - Condition check:', hostId && (!pc || !dc || !(typeof dc.isOpen === 'function' && dc.isOpen())));
        
        // Если у нас есть hostId и нет активного соединения, создаем PeerConnection
        // Также создаем PeerConnection если есть hostId, но нет pc (для повторных подключений)
        if (hostId && (!pc || !dc || !(typeof dc.isOpen === 'function' && dc.isOpen()))) {
            console.log('[CLIENT] ✅ All conditions met, creating PeerConnection after authorization');
            try {
                await createPeerConnection();
            } catch (error) {
                console.error('[CLIENT] Error creating PeerConnection after authorization:', error);
                setStatus('Failed to create connection after authorization');
            }
        } else if (hostId && !pc) {
            // Специальный случай для повторных подключений: если есть hostId, но нет PeerConnection
            console.log('[CLIENT] ✅ HostId exists but no PeerConnection, creating new connection for reconnection');
            try {
                await createPeerConnection();
            } catch (error) {
                console.error('[CLIENT] Error creating PeerConnection for reconnection:', error);
                setStatus('Failed to create connection for reconnection');
            }
        } else {
            console.log('[CLIENT] No hostId set or already have active connection, skipping PeerConnection creation');
            console.log('[CLIENT] hostId:', hostId, 'pc:', !!pc, 'dc:', !!dc, 'dc.isOpen():', dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A');
        }
    });
}

// --- Public API ---

async function connectToHost(hostIdToConnect, token, cb, password, inviteCode) {
    console.log('=== CLIENT CONNECT TO HOST CALLED ===');
    try {
        logConnectionState('connectToHost start');
    } catch (error) {
        console.log('[CLIENT] Error logging state at connectToHost start:', error.message);
    }
    console.log('[CLIENT] hostId:', hostId, 'new hostId:', hostIdToConnect);
    console.log('[CLIENT] token:', token ? 'provided' : 'not provided');
    console.log('[CLIENT] password:', password ? 'provided' : 'not provided');
    console.log('[CLIENT] inviteCode:', inviteCode ? 'provided' : 'not provided');
    
    // Проверяем, есть ли уже активное соединение с тем же хостом
    if (hostId === hostIdToConnect && dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
        console.log('[CLIENT] Already connected to this host, skipping connection');
        log('Already connected to this host');
        return;
    }
    
    // Если подключаемся к другому хосту, выполняем полную очистку
    if (hostId && hostId !== hostIdToConnect) {
        console.log('[CLIENT] Connecting to different host, performing complete cleanup...');
        log('Disconnecting from current host and cleaning up for new connection...');
        await completeCleanup();
    }
    
    // Проверяем, есть ли уже PeerConnection в процессе
    if (pc && !dc) {
        console.log('[CLIENT] Connection already in progress, skipping new connection');
        log('Connection already in progress');
        return;
    }
    
    log(`Connecting to host: ${hostIdToConnect}`);
    hostId = hostIdToConnect;
    console.log(`[CLIENT] hostId set to: ${hostId}`);
    console.log(`[CLIENT] hostId variable after assignment:`, hostId);
    authToken = token;
    
    // Получаем TURN серверы с бекенда при подключении к хосту
    if (token) {
        await onClientAuthorized(token);
    }
    
    // Сохраняем пароль в localStorage если он предоставлен
    if (password) {
        savedPasswords.set(hostId, password);
        console.log(`[CLIENT] Password saved for server ${hostId}`);
    }
    
    // Сохраняем invite code если он предоставлен
    if (inviteCode) {
        savedPasswords.set(`${hostId}_invite`, inviteCode);
        console.log(`[CLIENT] Invite code saved for server ${hostId}`);
    }
    
    if (cb) {
        callbacks = { ...callbacks, ...cb };
    }

    // Всегда перезапускаем локальный прокси сервер для нового подключения
    console.log('[CLIENT] Restarting local proxy server for new connection');
    if (localProxyServer) {
        stopLocalProxy();
        // Небольшая задержка для полного закрытия старого сервера
        setTimeout(() => {
            startLocalProxy();
            // Создаем PeerConnection после запуска прокси сервера
            createPeerConnectionAfterProxyStart();
        }, 200);
    } else {
        startLocalProxy();
        // Создаем PeerConnection после запуска прокси сервера
        createPeerConnectionAfterProxyStart();
    }
    
    function createPeerConnectionAfterProxyStart() {
        console.log('[CLIENT] createPeerConnectionAfterProxyStart called');
        console.log('[CLIENT] - socket exists:', !!socket);
        console.log('[CLIENT] - socket.connected:', socket?.connected);
        console.log('[CLIENT] - hostId:', hostId);
        console.log('[CLIENT] - pc exists:', !!pc);
        console.log('[CLIENT] - dc exists:', !!dc);
        console.log('[CLIENT] - dc.isOpen():', dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A');
        
        // Если signaling сервер уже подключен, сразу создаем PeerConnection
        if (socket && socket.connected) {
            console.log('[CLIENT] Signaling server already connected, creating PeerConnection directly');
            createPeerConnection().catch(error => {
                console.error('[CLIENT] Error creating PeerConnection:', error);
                setStatus('Failed to create connection');
            });
        } else {
            console.log('[CLIENT] Connecting to signaling server first');
            connectToSignalingAsClient();
        }
    }
    
    try {
        logConnectionState('connectToHost completed');
    } catch (error) {
        console.log('[CLIENT] Error logging state at connectToHost completed:', error.message);
    }
    console.log('=== CLIENT CONNECT TO HOST COMPLETED ===');
}

async function disconnect() {
    console.log('=== CLIENT DISCONNECT CALLED ===');
    console.log('[CLIENT] Disconnect reason: User requested disconnect');
    console.log('[CLIENT] hostId before disconnect:', hostId);
    try {
        logConnectionState('disconnect start');
    } catch (error) {
        console.log('[CLIENT] Error logging state at disconnect start:', error.message);
    }
    log('Disconnecting from host...');
    
    // Выполняем полную очистку, но сохраняем Socket.IO соединение
    await completeCleanup();
    
    // НЕ отключаем Socket.IO соединение с signaling сервером!
    // Signaling сервер должен оставаться подключенным для возможности
    // переподключения к другим хостам или восстановления соединения
    console.log('[CLIENT] Keeping Socket.IO connection to signaling server for future connections');
    
    setStatus('Disconnected from host');
    
    // Уведомляем Angular об отключении
    if (callbacks && callbacks.onStatusUpdate) {
        callbacks.onStatusUpdate('disconnected', 'Disconnected from host');
    }
    
    log('Disconnect from host completed');
    console.log('=== CLIENT DISCONNECT COMPLETED ===');
}

async function sendDisconnectRequest() {
    console.log('[CLIENT] sendDisconnectRequest called');
    console.log('[CLIENT] DataChannel state - dc:', !!dc, 'isOpen:', dc && typeof dc.isOpen === 'function' ? dc.isOpen() : 'N/A');
    
    if (dc && typeof dc.isOpen === 'function' && dc.isOpen()) {
        try {
            const disconnectRequestMessage = JSON.stringify({
                type: 'disconnect_request',
                reason: 'User requested disconnect',
                timestamp: new Date().toISOString()
            });
            console.log('[CLIENT] Sending disconnect request message:', disconnectRequestMessage);
            dc.sendMessage(disconnectRequestMessage);
            log("Sent disconnect request to host");
            console.log('[CLIENT] Disconnect request sent to host successfully');
        } catch (e) {
            log(`Error sending disconnect request: ${e.message}`);
            console.error('[CLIENT] Error sending disconnect request:', e);
        }
    } else {
        log("Cannot send disconnect request: DataChannel not open");
        console.log('[CLIENT] DataChannel not open, performing direct disconnect');
        await disconnect();
    }
}

function retryConnectLater() {
    log('Retrying connection in 30 seconds...');
    console.log('[CLIENT] 🔄 Scheduling retry in 30 seconds...');
    
    setTimeout(async () => {
        if (hostId && socket?.connected) {
            console.log('[CLIENT] 🔄 Reattempting createPeerConnection...');
            log('Reattempting connection...');
            try {
                await createPeerConnection();
            } catch (error) {
                console.error('[CLIENT] Retry failed:', error);
                log('Retry failed, will try again later');
                retryConnectLater(); // Рекурсивно планируем следующую попытку
            }
        } else {
            console.log('[CLIENT] ❌ Still no hostId or socket not connected. Skipping retry.');
            log('Cannot retry: missing host or signaling connection');
            // Если условия не выполнены, планируем еще одну попытку позже
            retryConnectLater();
        }
    }, 30000);
}

function disconnectFromHost() {
    log('Disconnecting from host...');
    console.log('[CLIENT] disconnectFromHost() called');
    
    // Закрываем локальный прокси сервер (это также закроет minecraftSocket)
    stopLocalProxy();
    
    // Закрываем DataChannel
    if (dc) {
        dc.close();
        dc = null;
    }
    
    // Закрываем PeerConnection
    if (pc) {
        pc.close();
        pc = null;
    }
    
    // Отключаемся от signaling сервера
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    
    // Сбрасываем состояние
    hostId = null;
    isConnecting = false;
    
    setStatus('Disconnected from host');
    
    // Уведомляем Angular об отключении
    if (callbacks && callbacks.onStatusUpdate) {
        callbacks.onStatusUpdate('disconnected', 'Disconnected from host');
    }
    
    log('Disconnected from host');
    console.log('[CLIENT] Disconnected from host');
}

module.exports = {
    connectToHost,
    disconnect,
    sendDisconnectRequest,
    completeCleanup,
    setStatusInterception: (enabled) => {
        interceptStatusRequests = enabled;
        log(`Status interception ${enabled ? 'enabled' : 'disabled'}`);
        console.log(`[CLIENT] Status interception ${enabled ? 'enabled' : 'disabled'}`);
    },
    getStatusInterception: () => interceptStatusRequests,
};