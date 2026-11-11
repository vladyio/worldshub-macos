class MinecraftDataChannelParser {
    constructor() {
        this.reset();
    }

    reset() {
        this.buffer = Buffer.alloc(0);
        this.packetLength = null;
        this.packetId = null;
        this.state = MinecraftDataChannelParser.State.WAITING_LENGTH;
        this.hasLoggedIn = false;
        this.protocolState = 'handshaking'; // Возможные состояния: handshaking → status → login
    }

    static State = {
        WAITING_LENGTH: 'waiting_length',
        WAITING_PACKET: 'waiting_packet'
    };

    log(message) {
        console.log(`[MinecraftParser] ${message}`);
    }

    parseData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);

        while (this.buffer.length > 0) {
            if (this.state === MinecraftDataChannelParser.State.WAITING_LENGTH) {
                const result = this.readVarInt(this.buffer);
                if (!result) break;

                this.packetLength = result.value;
                this.buffer = this.buffer.slice(result.bytesRead);
                this.state = MinecraftDataChannelParser.State.WAITING_PACKET;
            } else if (this.state === MinecraftDataChannelParser.State.WAITING_PACKET) {
                if (this.buffer.length < this.packetLength) break;

                const packetData = this.buffer.slice(0, this.packetLength);
                this.buffer = this.buffer.slice(this.packetLength);
                this.parsePacket(packetData);
                this.state = MinecraftDataChannelParser.State.WAITING_LENGTH;
            }
        }
    }

    parsePacket(packetData) {
        if (packetData.length === 0) return;

        const packetIdResult = this.readVarInt(packetData);
        if (!packetIdResult) return;

        this.packetId = packetIdResult.value;
        const remainingData = packetData.slice(packetIdResult.bytesRead);

        this.handlePacket(this.packetId, remainingData);
    }

    readVarInt(buffer) {
        let value = 0;
        let shift = 0;

        for (let i = 0; i < buffer.length; i++) {
            const byte = buffer[i];
            value |= (byte & 0x7F) << shift;

            if ((byte & 0x80) === 0) {
                return { value, bytesRead: i + 1 };
            }

            shift += 7;
            if (shift >= 32) throw new Error('VarInt too large');
        }

        return null;
    }

    readString(buffer) {
        const lengthResult = this.readVarInt(buffer);
        if (!lengthResult) return null;

        const length = lengthResult.value;
        const start = lengthResult.bytesRead;
        const end = start + length;

        if (end > buffer.length) return null;

        const value = buffer.slice(start, end).toString('utf8');
        return {
            value,
            bytesRead: end
        };
    }

    readPing(buffer) {
        if (buffer.length < 8) return null;
        return buffer.readBigInt64BE();
    }

    readNextStateFromHandshake(buffer) {
        const protocolVersion = this.readVarInt(buffer);
        if (!protocolVersion) return null;

        const addressResult = this.readString(buffer.slice(protocolVersion.bytesRead));
        if (!addressResult) return null;

        const portStart = protocolVersion.bytesRead + addressResult.bytesRead;
        if (buffer.length < portStart + 2) return null;

        const port = buffer.readUInt16BE(portStart);

        const nextState = this.readVarInt(buffer.slice(portStart + 2));
        if (!nextState) return null;

        return nextState.value; // 1 = status, 2 = login
    }

    handlePacket(packetId, data) {
        switch (this.protocolState) {
            case 'handshaking':
                if (packetId === 0x00) {
                    const nextState = this.readNextStateFromHandshake(data);
                    if (nextState === 1) {
                        this.protocolState = 'status';
                        this.log('Handshake complete → перешли в статус-режим');
                    } else if (nextState === 2) {
                        this.protocolState = 'login';
                        this.log('Handshake complete → перешли в логин-режим');
                    } else {
                        this.log('⚠️ Неизвестное nextState, сбрасываем парсер');
                        this.reset();
                    }
                }
                break;
    
            case 'status':
                if (packetId === 0x00) {
                    this.log('⬅️ Получен Status Request от клиента (MOTD-запрос)');
                    this.onStatusRequest();
                } else if (packetId === 0x01) {
                    const ping = this.readPing(data);
                    this.log(`⬅️ Получен Ping Request от клиента: ${ping}`);
                    this.onPingRequest(ping);
                }
                break;
    
            case 'login':
                if (packetId === 0x00 && !this.hasLoggedIn) {
                    this.log('Processing Login Start packet');
                    this.handleLoginStart(data);
                } else if (packetId === 0x1B) {
                    this.log('Processing Disconnect packet');
                    this.handleDisconnect(data);
                }
                break;
        }
    }

    handleLoginStart(data) {
        try {
            const usernameResult = this.readString(data);
            if (usernameResult && !this.hasLoggedIn) {
                this.hasLoggedIn = true;
                this.log(`👤 Игрок вошёл: ${usernameResult.value}`);
                this.onPlayerLogin(usernameResult.value);
            } else {
                this.log('❌ Не удалось получить имя игрока или он уже вошёл');
            }
        } catch (error) {
            this.log(`Ошибка разбора Login Start: ${error.message}`);
        }
    }

    handleDisconnect(data) {
        try {
            const reasonResult = this.readString(data);
            const reason = reasonResult ? reasonResult.value : 'Unknown reason';
            this.log(`❌ Игрок отключён: ${reason}`);
            this.onPlayerDisconnect(reason);
        } catch (error) {
            this.log(`Ошибка разбора Disconnect: ${error.message}`);
            this.onPlayerDisconnect('Ошибка разбора Disconnect');
        }
    }

    // Методы, которые можно переопределить
    onPlayerLogin(username) {
        console.log(`[Callback] Игрок вошёл: ${username}`);
    }

    onPlayerDisconnect(reason) {
        console.log(`[Callback] Игрок отключён: ${reason}`);
    }

    onStatusRequest() {
        console.log(`[Callback] ⚡ Запрос статуса сервера (MOTD)`);
    }

    onPingRequest(ping) {
        console.log(`[Callback] ⚡ Запрос ping: ${ping}`);
    }
}

module.exports = MinecraftDataChannelParser;
