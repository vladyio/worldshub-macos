// Minimal end-to-end check for the native WebRTC module used by client.js.
const { PeerConnection } = require('node-datachannel');

const a = new PeerConnection('smoke-a', { iceServers: [] });
const b = new PeerConnection('smoke-b', { iceServers: [] });
const aQueue = [];
const bQueue = [];
let aReady = false;
let bReady = false;
let finished = false;

function finish(ok, message) {
  if (finished) return;
  finished = true;
  console.log(ok ? 'PASS' : 'FAIL', message);
  a.close();
  b.close();
  setTimeout(() => process.exit(ok ? 0 : 1), 100);
}

a.onLocalDescription((sdp, type) => {
  aReady = true;
  b.setRemoteDescription(sdp, type);
  bQueue.splice(0).forEach((c) => b.addRemoteCandidate(c.candidate, c.mid));
});
b.onLocalDescription((sdp, type) => {
  bReady = true;
  a.setRemoteDescription(sdp, type);
  aQueue.splice(0).forEach((c) => a.addRemoteCandidate(c.candidate, c.mid));
});
a.onLocalCandidate((candidate, mid) => {
  if (bReady) b.addRemoteCandidate(candidate, mid);
  else bQueue.push({ candidate, mid });
});
b.onLocalCandidate((candidate, mid) => {
  if (aReady) a.addRemoteCandidate(candidate, mid);
  else aQueue.push({ candidate, mid });
});

const channel = a.createDataChannel('proxy-dc');
channel.onOpen(() => channel.sendMessageBinary(Buffer.from('hello over webrtc')));
b.onDataChannel((dc) => {
  dc.onMessage((message) => {
    const text = Buffer.from(message).toString();
    finish(text === 'hello over webrtc', `binary roundtrip: ${text}`);
  });
});

setTimeout(() => finish(false, 'timeout'), 15000);
