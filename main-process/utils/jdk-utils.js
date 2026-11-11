/**
 * JDK Utils Module (macOS)
 *
 * Finds installed JDKs and installs a Temurin JDK 21 on demand.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const fsSync = require('fs');
const https = require('https');
const http = require('http');
const { createWriteStream } = require('fs');

const execFileAsync = promisify(execFile);

const JDK_BUNDLE_HOME = path.join('Contents', 'Home');
const JDK_DOWNLOAD_URL = (arch) =>
    `https://api.adoptium.net/v3/binary/latest/21/ga/mac/${arch}/jdk/hotspot/normal/eclipse`;

/**
 * JDK info
 * @typedef {Object} JdkInfo
 * @property {string} version - JDK version (e.g. "17.0.15")
 * @property {string} path - JDK home containing bin/java
 * @property {string} javaHome - JAVA_HOME value
 * @property {boolean} isDefault - whether this is the system default
 * @property {string} [javaPath] - full path to the java executable
 */

/**
 * Persistent app data directory. Falls back to the standard macOS location
 * when running outside Electron (e.g. the smoke test).
 * @returns {string}
 */
function getUserDataDir() {
    try {
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
            return app.getPath('userData');
        }
    } catch (error) {
        // not running inside Electron
    }
    return path.join(os.homedir(), 'Library', 'Application Support', 'WorldsHub');
}

/** @returns {string} directory holding app-managed JDKs */
function getJdksDir() {
    return path.join(getUserDataDir(), 'jdks');
}

/**
 * Parses the version out of `java -version` output.
 * @param {string} output
 * @returns {string|null}
 */
function parseJavaVersion(output) {
    if (!output) return null;
    const match = output.match(/(?:java|openjdk)\s+version\s+"([^"]+)"/i) ||
        output.match(/version\s+"([^"]+)"/i);
    return match ? match[1] : null;
}

/**
 * Runs `java -version` (output goes to stderr).
 * @param {string} javaPath
 * @returns {Promise<string|null>}
 */
async function readJavaVersion(javaPath) {
    try {
        const { stdout, stderr } = await execFileAsync(javaPath, ['-version'], { timeout: 10000 });
        return parseJavaVersion(`${stderr}\n${stdout}`);
    } catch (error) {
        return parseJavaVersion(`${error.stderr || ''}\n${error.stdout || ''}`);
    }
}

/**
 * Reads JAVA_VERSION from the JDK `release` file.
 * @param {string} javaHome
 * @returns {Promise<string|null>}
 */
async function readReleaseVersion(javaHome) {
    try {
        const content = await fs.readFile(path.join(javaHome, 'release'), 'utf8');
        const match = content.match(/^JAVA_VERSION="([^"]+)"/m);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

/**
 * Finds the JDK home inside an installed bundle or extracted archive.
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function findJdkHome(root) {
    for (const home of [path.join(root, JDK_BUNDLE_HOME), root]) {
        if (fsSync.existsSync(path.join(home, 'bin', 'java'))) {
            return home;
        }
    }
    return null;
}

/**
 * Builds JdkInfo for a JDK home if it contains a working java.
 * @param {string} home
 * @param {boolean} isDefault
 * @returns {Promise<JdkInfo|null>}
 */
async function describeJdkHome(home, isDefault) {
    const javaPath = path.join(home, 'bin', 'java');
    if (!fsSync.existsSync(javaPath)) return null;

    const version = (await readJavaVersion(javaPath)) || (await readReleaseVersion(home));
    if (!version) return null;

    return { version, path: home, javaHome: home, isDefault };
}

/**
 * Downloads a file, following HTTP redirects.
 * @param {string} url
 * @param {string} destination
 * @param {Function|null} onProgress - (percent, downloaded, total)
 * @param {number} redirectsLeft
 * @returns {Promise<void>}
 */
function downloadFile(url, destination, onProgress = null, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https:') ? https : http;
        const request = protocol.get(url, { headers: { 'User-Agent': 'WorldsHub' } }, (response) => {
            const status = response.statusCode || 0;

            if ([301, 302, 303, 307, 308].includes(status)) {
                response.resume();
                const location = response.headers.location;
                if (!location) return reject(new Error(`HTTP ${status} without Location header`));
                if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                const nextUrl = new URL(location, url).toString();
                return downloadFile(nextUrl, destination, onProgress, redirectsLeft - 1).then(resolve, reject);
            }

            if (status !== 200) {
                response.resume();
                return reject(new Error(`HTTP ${status}: ${response.statusMessage}`));
            }

            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            const fileStream = createWriteStream(destination);

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (onProgress && !isNaN(totalSize) && totalSize > 0) {
                    onProgress((downloadedSize / totalSize) * 100, downloadedSize, totalSize);
                }
            });

            response.on('error', reject);
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);

            response.pipe(fileStream);
        });

        request.on('error', reject);
        request.setTimeout(30000, () => {
            request.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

/** Throttles progress callbacks to at most once per `ms`. */
function throttle(fn, ms) {
    let last = 0;
    return (...args) => {
        const now = Date.now();
        if (now - last > ms) {
            last = now;
            fn(...args);
        }
    };
}

/**
 * Downloads and installs Temurin JDK 21 into <userData>/jdks/jdk-21.
 * @param {Function|null} onProgress - (percent, downloaded, total)
 * @returns {Promise<JdkInfo>}
 */
async function downloadAndInstallJdk21(onProgress = null) {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const url = JDK_DOWNLOAD_URL(arch);
    let tempDir = null;

    try {
        console.log('[JDK Utils] Starting JDK 21 download and installation...');
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldshub-jdk21-'));
        const archivePath = path.join(tempDir, 'jdk21.tar.gz');
        const throttledProgress = onProgress ? throttle(onProgress, 300) : null;

        console.log(`[JDK Utils] Downloading JDK 21 (${arch}) from: ${url}`);
        await downloadFile(url, archivePath, throttledProgress);

        console.log('[JDK Utils] Extracting JDK 21...');
        await execFileAsync('tar', ['-xzf', archivePath, '-C', tempDir], { timeout: 300000 });

        const entries = await fs.readdir(tempDir, { withFileTypes: true });
        let sourceRoot = null;
        let sourceHome = null;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const root = path.join(tempDir, entry.name);
            const home = await findJdkHome(root);
            if (home) {
                sourceRoot = root;
                sourceHome = home;
                break;
            }
        }
        if (!sourceHome) {
            throw new Error('Java executable not found in extracted JDK archive');
        }

        const version = (await readReleaseVersion(sourceHome)) ||
            (await readJavaVersion(path.join(sourceHome, 'bin', 'java'))) || '21';

        const jdksDir = getJdksDir();
        const targetRoot = path.join(jdksDir, 'jdk-21');
        await fs.mkdir(jdksDir, { recursive: true });
        await fs.rm(targetRoot, { recursive: true, force: true });
        try {
            await fs.rename(sourceRoot, targetRoot);
        } catch (error) {
            // e.g. cross-device rename
            await fs.cp(sourceRoot, targetRoot, { recursive: true });
        }

        const home = await findJdkHome(targetRoot);
        if (!home) {
            throw new Error(`Installed JDK contains no java executable in ${targetRoot}`);
        }
        const javaPath = path.join(home, 'bin', 'java');

        const jdkInfo = { version, path: home, javaHome: '', isDefault: false, javaPath };
        console.log('[JDK Utils] JDK 21 installation completed:', jdkInfo);
        return jdkInfo;
    } catch (error) {
        console.error('[JDK Utils] Error downloading/installing JDK 21:', error);
        throw error;
    } finally {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

/**
 * Lists JDKs managed by the app in <userData>/jdks/jdk-*.
 * @returns {Promise<JdkInfo[]>}
 */
async function getLocalJdks() {
    try {
        const jdksDir = getJdksDir();
        const entries = await fs.readdir(jdksDir, { withFileTypes: true }).catch(() => []);
        const localJdks = [];

        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('jdk-')) continue;

            const home = await findJdkHome(path.join(jdksDir, entry.name));
            if (!home) {
                console.warn(`[JDK Utils] No java found in ${path.join(jdksDir, entry.name)}`);
                continue;
            }

            const version = (await readJavaVersion(path.join(home, 'bin', 'java'))) ||
                (await readReleaseVersion(home)) ||
                entry.name.replace(/^jdk-/, '');

            localJdks.push({
                version,
                path: home,
                javaHome: '',
                isDefault: false,
                javaPath: path.join(home, 'bin', 'java')
            });
            console.log(`[JDK Utils] Added local JDK: ${version} at ${home}`);
        }

        return localJdks;
    } catch (error) {
        console.error('[JDK Utils] Error getting local JDKs:', error);
        return [];
    }
}

/**
 * Resolves the system default JDK: JAVA_HOME, then /usr/libexec/java_home,
 * then `which java`.
 * @returns {Promise<JdkInfo|null>}
 */
async function getSystemJavaInfo() {
    try {
        const envJavaHome = process.env.JAVA_HOME || '';

        if (envJavaHome) {
            const info = await describeJdkHome(envJavaHome, true);
            if (info) return info;
            console.warn('[JDK Utils] JAVA_HOME does not contain a usable java:', envJavaHome);
        }

        try {
            const { stdout } = await execFileAsync('/usr/libexec/java_home', [], { timeout: 10000 });
            const home = stdout.trim().split('\n')[0];
            if (home) {
                const info = await describeJdkHome(home, true);
                if (info) return info;
                console.warn('[JDK Utils] /usr/libexec/java_home returned an unusable JDK:', home);
            }
        } catch (error) {
            console.warn('[JDK Utils] /usr/libexec/java_home found no JDK:', error.message);
        }

        try {
            const { stdout } = await execFileAsync('/usr/bin/which', ['java'], { timeout: 10000 });
            const javaExecutablePath = stdout.trim().split('\n')[0];
            if (javaExecutablePath) {
                const version = await readJavaVersion(javaExecutablePath);
                if (version) {
                    const realPath = await fs.realpath(javaExecutablePath).catch(() => javaExecutablePath);
                    const home = path.dirname(path.dirname(realPath));
                    console.log('[JDK Utils] JDK path from PATH:', home);
                    return { version, path: home, javaHome: home, isDefault: true };
                }
            }
        } catch (error) {
            console.warn('[JDK Utils] Could not find java in PATH:', error.message);
        }

        console.warn('[JDK Utils] No system Java found');
        return null;
    } catch (error) {
        console.error('[JDK Utils] Error getting system Java info:', error);
        return null;
    }
}

/**
 * Lists system, app-managed and macOS-installed JDKs, deduplicated by path.
 * @returns {Promise<JdkInfo[]>}
 */
async function findInstalledJdks() {
    const jdks = [];

    try {
        console.log('[JDK Utils] Searching for installed JDKs...');

        const systemJava = await getSystemJavaInfo();
        if (systemJava) {
            jdks.push(systemJava);
        }

        jdks.push(...(await getLocalJdks()));

        const searchPaths = [
            '/Library/Java/JavaVirtualMachines',
            path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines')
        ];

        for (const searchPath of searchPaths) {
            const entries = await fs.readdir(searchPath, { withFileTypes: true }).catch(() => []);
            if (entries.length === 0) {
                console.log(`[JDK Utils] No JDKs in: ${searchPath}`);
            }

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const jdkPath = path.join(searchPath, entry.name, JDK_BUNDLE_HOME);
                const info = await describeJdkHome(
                    jdkPath,
                    systemJava ? systemJava.path === jdkPath : false
                );

                if (info) {
                    jdks.push({
                        version: info.version,
                        path: info.path,
                        javaHome: info.isDefault ? process.env.JAVA_HOME || '' : '',
                        isDefault: info.isDefault
                    });
                    console.log(`[JDK Utils] Added JDK: ${info.version} at ${info.path}`);
                } else {
                    console.log(`[JDK Utils] Skipping ${jdkPath}: no usable java`);
                }
            }
        }

        const uniqueJdks = jdks.filter((jdk, index, self) =>
            index === self.findIndex(j => j.path === jdk.path)
        );

        console.log(`[JDK Utils] Found ${uniqueJdks.length} unique JDKs:`,
            uniqueJdks.map(j => `${j.version} at ${j.path}`));
        return uniqueJdks;
    } catch (error) {
        console.error('[JDK Utils] Error finding installed JDKs:', error);
        return jdks;
    }
}

/**
 * Checks whether a JDK version can run a Minecraft version.
 * @param {string} jdkVersion
 * @param {string} minecraftVersion
 * @returns {boolean}
 */
function isJdkCompatibleWithMinecraft(jdkVersion, minecraftVersion) {
    const jdkMajor = parseInt(jdkVersion.split('.')[0], 10);
    const minecraftMajor = parseInt(minecraftVersion.split('.')[1], 10);

    if (minecraftMajor >= 17) {
        return jdkMajor >= 16;
    } else if (minecraftMajor >= 12) {
        return jdkMajor >= 8 && jdkMajor <= 11;
    }
    return jdkMajor >= 8;
}

/**
 * Picks the best JDK for a Minecraft version.
 * @param {JdkInfo[]} jdks
 * @param {string} minecraftVersion
 * @returns {JdkInfo|null}
 */
function getRecommendedJdk(jdks, minecraftVersion) {
    const defaultJdk = jdks.find(jdk => jdk.isDefault);
    if (defaultJdk && isJdkCompatibleWithMinecraft(defaultJdk.version, minecraftVersion)) {
        return defaultJdk;
    }

    const compatibleJdks = jdks.filter(jdk =>
        isJdkCompatibleWithMinecraft(jdk.version, minecraftVersion)
    );

    if (compatibleJdks.length === 0) {
        return null;
    }

    return compatibleJdks.sort((a, b) => {
        const versionA = a.version.split('.').map(Number);
        const versionB = b.version.split('.').map(Number);

        for (let i = 0; i < Math.max(versionA.length, versionB.length); i++) {
            const numA = versionA[i] || 0;
            const numB = versionB[i] || 0;
            if (numA !== numB) {
                return numB - numA;
            }
        }
        return 0;
    })[0];
}

module.exports = {
    getSystemJavaInfo,
    findInstalledJdks,
    isJdkCompatibleWithMinecraft,
    getRecommendedJdk,
    downloadAndInstallJdk21,
    getLocalJdks
};
