// Minimal end-to-end check for the Minecraft server runner on macOS.
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runner = require('../main-process/utils/minecraft-server-runner');

const JAVA_SOURCE = `
public class SmokeServer {
    public static void main(String[] args) throws Exception {
        System.out.println("Done (0.123s)!");
        java.io.BufferedReader reader = new java.io.BufferedReader(
            new java.io.InputStreamReader(System.in));
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.trim().equals("stop")) {
                System.out.println("Stopping server");
                return;
            }
        }
    }
}
`;

function waitFor(predicate, timeoutMs) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs).unref()
    )
  ]);
}

async function main() {
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
    execFileSync('jar', ['--version'], { stdio: 'ignore' });
  } catch (error) {
    console.log('SKIP server runner test: javac/jar not available');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldshub-runner-'));
  const classesDir = path.join(dir, 'classes');
  const jarPath = path.join(dir, 'smoke-server.jar');

  try {
    fs.mkdirSync(classesDir);
    fs.writeFileSync(path.join(dir, 'SmokeServer.java'), JAVA_SOURCE);
    const javacArgs = ['-encoding', 'UTF-8', '-d', classesDir, path.join(dir, 'SmokeServer.java')];
    execFileSync('javac', javacArgs, { stdio: 'inherit' });

    const jarArgs = [
      '--create', '--file', jarPath, '--main-class', 'SmokeServer', '-C', classesDir, '.'
    ];
    execFileSync('jar', jarArgs, { stdio: 'inherit' });

    const events = [];
    const event = { sender: { send: (...args) => events.push(args) } };

    const result = await withTimeout(runner.process(jarPath, '64M', '32M', event), 20000);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.serverId, 'smoke-server');
    assert.strictEqual(result.serverName, 'smoke-server');
    assert.ok(result.message, 'start result has a message');

    const uiEvents = (type) =>
      events
        .filter(([channel, payload]) => channel === 'ui-event' && payload.type === type)
        .map(([, payload]) => payload.data);

    const getStatuses = () => uiEvents('minecraft-server-status');
    const output = uiEvents('minecraftServerOutput').join('');

    assert.ok(
      getStatuses().some((status) => status.status === 'running'),
      'running status event arrived'
    );
    assert.ok(output.includes('Done ('), 'server output event arrived');
    assert.strictEqual(runner.isServerRunning(), true);

    const killResult = runner.killMinecraftServerProcess();
    assert.strictEqual(killResult.success, true);

    await waitFor(() => !runner.isServerRunning(), 8000);
    assert.strictEqual(runner.isServerRunning(), false);
    assert.ok(
      getStatuses().some((status) => status.status === 'stopped'),
      'stopped status event arrived'
    );

    console.log('PASS server runner smoke test');
  } finally {
    if (runner.isServerRunning()) {
      runner.killMinecraftServerProcess();
      await waitFor(() => !runner.isServerRunning(), 9000).catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL server runner smoke test:', error);
  process.exitCode = 1;
});
