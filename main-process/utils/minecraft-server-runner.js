const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const escapeHtml = require('escape-html');
const AnsiToHtml = require('ansi-to-html');

const ansiConverter = new AnsiToHtml();

const OUTPUT_LIMIT = 100000;

let minecraftServerProcess = null;
let outputData = '';

function sendUiEvent(event, type, data) {
  try {
    event.sender.send('ui-event', { type, data });
  } catch (error) {
    console.warn('[MinecraftServerRunner] Failed to send UI event:', error.message);
  }
}

function sendStatus(event, onStatusUpdate, status) {
  if (onStatusUpdate) {
    onStatusUpdate(status);
  } else {
    sendUiEvent(event, 'minecraft-server-status', status);
  }
}

function toHtml(message) {
  return ansiConverter.toHtml(escapeHtml(message));
}

function appendOutput(html) {
  outputData += html;
  if (outputData.length > OUTPUT_LIMIT) {
    outputData = outputData.slice(-OUTPUT_LIMIT);
  }
}

function resolveJavaExecutable(serverDir, jdkPath) {
  const javaIn = (jdkDir) => {
    const candidate = path.join(jdkDir, 'bin', 'java');
    return fs.existsSync(candidate) ? candidate : null;
  };

  if (jdkPath) {
    const customJava = javaIn(jdkPath);
    if (customJava) return customJava;
    console.warn(`[MinecraftServerRunner] No java in ${jdkPath}, falling back to PATH.`);
  }

  try {
    const bundledJdk = fs
      .readdirSync(serverDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('jdk-'));

    if (bundledJdk) {
      const bundledJava = javaIn(path.join(serverDir, bundledJdk.name));
      if (bundledJava) return bundledJava;
    }
  } catch (error) {
    console.warn('[MinecraftServerRunner] Error while searching for a bundled JDK:', error.message);
  }

  return 'java';
}

function killStaleJavaProcesses(absoluteJarPath) {
  const escapedPath = absoluteJarPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `-jar ${escapedPath}( |$)`;

  return new Promise((resolve) => {
    execFile('pkill', ['-f', pattern], () => resolve());
  });
}

function isProcessAlive(child) {
  return !!child && child.pid != null && child.exitCode === null && child.signalCode === null;
}

function runMinecraftServer(serverPath, xmx, xms, event, jdkPath = null, onStatusUpdate = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let runningStatusSent = false;

    const serverId = path.basename(serverPath, '.jar') || 'minecraft-server';
    const serverName = serverId === 'minecraft-server' ? 'Minecraft Server' : serverId;

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    if (!fs.existsSync(serverPath)) {
      rejectOnce(new Error(`Server file not found: ${serverPath}`));
      return;
    }

    const absoluteJarPath = path.resolve(serverPath);
    const serverDir = path.dirname(absoluteJarPath);
    const javaExecutable = resolveJavaExecutable(serverDir, jdkPath);
    const args = [
      `-Xmx${xmx}`,
      `-Xms${xms}`,
      '-Dfile.encoding=UTF-8',
      '-jar',
      absoluteJarPath,
      'nogui'
    ];

    const decoder = new StringDecoder('utf8');

    const handleOutput = (data) => {
      const message = decoder.write(data);
      if (!message) return;

      const html = toHtml(message);
      appendOutput(html);
      sendUiEvent(event, 'minecraftServerOutput', html);

      if (!runningStatusSent && message.includes('Done (')) {
        runningStatusSent = true;

        const runningStatus = {
          serverId,
          serverName,
          status: 'running',
          startTime: new Date(),
          message: 'Server is running'
        };

        sendStatus(event, onStatusUpdate, runningStatus);
        resolveOnce({
          success: true,
          serverId,
          serverName,
          message: 'Server is running'
        });
      }
    };

    const spawnServer = () => {
      if (settled) return;

      try {
        minecraftServerProcess = spawn(javaExecutable, args, {
          cwd: serverDir,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        });
      } catch (error) {
        rejectOnce(error);
        return;
      }

      const child = minecraftServerProcess;

      child.on('error', (error) => {
        console.error('[MinecraftServerRunner] Failed to start server:', error.message);

        sendStatus(event, onStatusUpdate, {
          serverId,
          serverName,
          status: 'error',
          message: `Failed to start server: ${error.message}`
        });

        rejectOnce(new Error(`Failed to start Minecraft server: ${error.message}`));
      });

      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);

      child.on('close', (code, signal) => {
        if (minecraftServerProcess === child) minecraftServerProcess = null;

        if (runningStatusSent) {
          sendStatus(event, onStatusUpdate, {
            serverId,
            serverName,
            status: 'stopped',
            message: `Server stopped with code: ${code}${signal ? ` (${signal})` : ''}`
          });
        }

        if (!settled) {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          rejectOnce(
            new Error(
              `Minecraft server exited before it was ready (${reason}). Check the server log above.`
            )
          );
        }
      });

      child.on('message', (message) => {
        if (message === 'stop') {
          killMinecraftServerProcess();
        }
      });

      console.log(
        `[MinecraftServerRunner] Started ${javaExecutable} with PID ${child.pid} in ${serverDir}`
      );
    };

    killStaleJavaProcesses(absoluteJarPath)
      .catch(() => {})
      .then(spawnServer);
  });
}

function killMinecraftServerProcess() {
  const child = minecraftServerProcess;

  if (!isProcessAlive(child)) {
    return { success: true, message: 'Server is not running' };
  }

  try {
    if (child.stdin && child.stdin.writable) {
      child.stdin.write('stop\n');
    }
  } catch (error) {
    console.warn('[MinecraftServerRunner] Failed to write stop command:', error.message);
  }

  const termTimer = setTimeout(() => {
    if (isProcessAlive(child)) child.kill('SIGTERM');
  }, 5000);

  const killTimer = setTimeout(() => {
    if (isProcessAlive(child)) child.kill('SIGKILL');
  }, 8000);

  termTimer.unref();
  killTimer.unref();

  child.once('close', () => {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
  });

  return { success: true, message: 'Stop command sent to server' };
}

function isServerRunning() {
  return isProcessAlive(minecraftServerProcess);
}

module.exports = {
  process: runMinecraftServer,
  getOutputData: () => outputData,
  getMinecraftServerProcess: () => minecraftServerProcess,
  killMinecraftServerProcess,
  isServerRunning
};
