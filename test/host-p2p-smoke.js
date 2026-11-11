/*
 * Local end-to-end host test: real Minecraft server + local signaling +
 * fake WebRTC client. Not part of the default test suite because it starts
 * a real Java server.
 */
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { PeerConnection } = require('node-datachannel');
const { io } = require('socket.io-client');
const { Server } = require('socket.io');
const MinecraftServerRunner = require('../main-process/utils/minecraft-server-runner');

const ROOT = path.join(__dirname, '..');
const JAVA_HOME = process.env.WORLDSHUB_TEST_JAVA_HOME || '';
const SERVER_DIR = process.env.WORLDSHUB_TEST_SERVER_DIR || '/tmp/wh-mc-server';
const SERVER_JAR = path.join(SERVER_DIR, 'server.jar');
const PORT = 3443;

function varint(value) {
  const bytes = [];
  while ((value & ~0x7f) !== 0) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function packet(payload) {
  return Buffer.concat([varint(payload.length), payload]);
}

function statusRequest() {
  const host = Buffer.from('localhost', 'utf8');
  const handshake = Buffer.concat([
    Buffer.from([0x00]),
    varint(765),
    varint(host.length),
    host,
    Buffer.from([0x63, 0xdd]), // 25565
    varint(1)
  ]);
  return Buffer.concat([packet(handshake), packet(Buffer.from([0x00]))]);
}

function readVarInt(buffer, offset) {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < buffer.length; i++) {
    const byte = buffer[i];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, size: i - offset + 1 };
    shift += 7;
  }
  return null;
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout waiting for ${label}`));
      }
    }, 200);
  });
}

async function main() {
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  if (!fs.existsSync(SERVER_JAR)) {
    console.log(`SKIP host P2P test: missing ${SERVER_JAR}`);
    return;
  }

  let javaHome = JAVA_HOME;
  if (!javaHome) {
    const { getSystemJavaInfo } = require('../main-process/utils/jdk-utils');
    const java = await getSystemJavaInfo();
    if (!java) throw new Error('No system Java found');
    javaHome = java.path;
  }

  const serverStatus = [];
  const fakeEvent = { sender: { send: () => {} } };
  console.log('Starting Minecraft server...');
  await MinecraftServerRunner.process(
    SERVER_JAR, '1G', '512M', fakeEvent, javaHome, (s) => serverStatus.push(s)
  );
  await waitFor(() => serverStatus.some((s) => s.status === 'running'), 120000, 'Minecraft running');
  console.log('Minecraft server is up');

  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-signal-'));
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1'
  ], { stdio: 'ignore' });

  const httpServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  });
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  const hosts = new Map();
  const clients = new Map();

  ioServer.on('connection', (socket) => {
    socket.on('register', (data) => {
      if (data.clientType === 'host') {
        hosts.set('host-test', socket);
        socket.emit('host_registered', {
          success: true, inviteCode: 'TEST', hostId: 'host-test', message: 'ok'
        });
      } else {
        clients.set(socket.id, socket);
        socket.emit('client_authorized', { success: true });
      }
    });
    socket.on('offer', ({ to, data }) => {
      const host = hosts.get(to);
      if (host) host.emit('offer', { from: socket.id, data });
    });
    socket.on('answer', ({ to, data }) => {
      const client = clients.get(to);
      if (client) client.emit('answer', { from: 'host', data });
    });
    socket.on('candidate', ({ to, data }) => {
      const target = hosts.get(to) || clients.get(to);
      if (target) target.emit('candidate', { from: socket.id, data });
    });
  });

  await new Promise((resolve) => httpServer.listen(PORT, '127.0.0.1', resolve));
  console.log('Local signaling server listening');

  process.env.WORLDSHUB_INSECURE_TLS = '1';
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  // Point the host at the local signaling server before it is loaded.
  require('../config').serverAddress = `127.0.0.1:${PORT}`;
  const host = require('../host');
  let registered = false;
  await host.startHosting('test-token', {
    serverConfig: { visibility: 'public', maxPlayers: 3, onlineMode: true },
    onLog: (m) => console.log('[host]', m),
    onStatusUpdate: (s) => console.log('[host-status]', s),
    onClientListUpdate: (c) => console.log('[host-clients]', JSON.stringify(c)),
    onHostRegistered: () => { registered = true; },
    onHostRegistrationFailed: (r) => console.error('[host-registration-failed]', r)
  });
  await waitFor(() => registered, 20000, 'host registration');
  console.log('Host registered');

  const client = io(`https://127.0.0.1:${PORT}`, {
    transports: ['websocket'],
    rejectUnauthorized: false
  });

  const result = await new Promise((resolve, reject) => {
    let pc = null;
    let dc = null;
    let mcConnected = false;

    client.on('connect', () => {
      client.emit('register', { clientType: 'client', token: 'test-token' });
    });
    client.on('connect_error', reject);

    client.on('client_authorized', () => {
      pc = new PeerConnection('test-client', { iceServers: [] });
      pc.onStateChange((state) => console.log('[test-client] pc state', state));

      pc.onLocalDescription((sdp, type) => {
        console.log('[test-client] local description', type);
        client.emit('offer', { to: 'host-test', data: { sdp, type } });
      });
      pc.onLocalCandidate((candidate, mid) => {
        client.emit('candidate', { to: 'host-test', data: { candidate, mid } });
      });

      client.on('answer', ({ data }) => {
        console.log('[test-client] answer received');
        pc.setRemoteDescription(data.sdp, data.type);
      });
      client.on('candidate', ({ data }) => pc.addRemoteCandidate(data.candidate, data.mid));

      dc = pc.createDataChannel('proxy-dc');
      console.log('[test-client] created data channel');

      dc.onOpen(() => {
        console.log('[test-client] datachannel open');
        dc.sendMessage(JSON.stringify({ type: 'minecraft_connect' }));
        setTimeout(() => {
          mcConnected = true;
          console.log('[test-client] sending status request');
          dc.sendMessageBinary(statusRequest());
        }, 500);
      });

      let buffer = Buffer.alloc(0);
      dc.onMessage((message) => {
        if (!mcConnected) return;
        buffer = Buffer.concat([buffer, Buffer.from(message)]);
        if (buffer.length < 5) return;
        const length = readVarInt(buffer, 0);
        if (!length || buffer.length < length.size + length.value) return;
        const payload = buffer.slice(length.size, length.size + length.value);
        if (payload[0] !== 0x00) {
          reject(new Error(`Unexpected packet id ${payload[0].toString(16)}`));
          return;
        }
        const strLen = readVarInt(payload, 1);
        const start = 1 + strLen.size;
        const json = payload.slice(start, start + strLen.value).toString('utf8');
        try {
          const status = JSON.parse(json);
          resolve({ status, pc, dc });
        } catch (error) {
          reject(new Error(`Bad status JSON: ${error.message}`));
        }
      });
    });

    setTimeout(() => reject(new Error('Timeout waiting for Minecraft status')), 30000);
  });

  assert.ok(result.status.version, 'status has version');
  assert.ok(result.status.description, 'status has description');
  console.log('PASS host P2P reached the Minecraft server:', result.status.version.name);

  result.dc.close();
  result.pc.close();
  client.close();
  host.stopHosting();
  MinecraftServerRunner.killMinecraftServerProcess();
  ioServer.close();
  httpServer.close();
  await new Promise((r) => setTimeout(r, 2000));
  console.log('DONE');
  process.exit(0);
}

main().catch((error) => {
  console.error('FAIL', error);
  MinecraftServerRunner.killMinecraftServerProcess();
  process.exit(1);
});
