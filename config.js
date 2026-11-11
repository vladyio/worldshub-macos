/**
 * ⚙️ S4E - Configuration Module
 * 
 * Этот файл содержит все настройки приложения.
 * Изменения здесь влияют на работу как signaling server, так и Electron приложения.
 * 
 * Настройки:
 * - serverAddress: адрес signaling server для подключения
 * - Порт по умолчанию: 3001 (signaling server)
 * - Angular dev server: localhost:тп 
 * 
 * Архитектура подключений:
 * Electron App → WebSocket → Signaling Server
 * Angular UI → HTTP → Signaling Server
 * WebRTC Peers ↔ Signaling Server ↔ WebRTC Peers
 */

// IMPORTANT: Replace this with your actual public server address and port.
// Example for public server: 'YOUR_PUBLIC_IP:3001'

// const serverAddress = '91.245.75.12:3001';
const serverAddress = 'app.worldshub.io';

// Default ICE servers (Google STUN + OpenRelay TURN)
// Note: TURN servers are now managed by the backend service
const defaultIceServers = [
  'stun:stun.l.google.com:19302'
];

const config = {
  // Адрес signaling server для WebSocket подключений
  // Используется в main-process/signaling.js для подключения к серверу
  serverAddress,
  
  // The host address for the Minecraft server (for the host) and the local proxy (for the client)
  minecraftHost: "127.0.0.1",
  minecraftServerPort: 25565,

  // ICE servers configuration
  // Note: TURN servers are now managed by the backend service
  iceServers: defaultIceServers, // Legacy property for backward compatibility
  defaultIceServers,
};

module.exports = config; 