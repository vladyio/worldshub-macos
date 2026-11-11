/**
 * Minecraft Server Installer Service (macOS)
 */

const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REDIRECT_CODES = [301, 302, 303, 307, 308];

function sendToUI(mainWindow, type, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ui-event', { type, data });
    } else {
        console.warn(`[minecraft-installer] Cannot send to UI: mainWindow is ${!mainWindow ? 'null' : 'destroyed'}`);
    }
}

async function selectInstallationFolder(mainWindow) {
    try {
        const options = {
            title: 'Select the folder to install the Minecraft server',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Select folder'
        };
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options);

        if (result.canceled) throw new Error('Folder selection was canceled');
        return result.filePaths[0];
    } catch (error) {
        console.error('[minecraft-installer] Error selecting folder:', error);
        throw error;
    }
}

async function prepareInstallationFolder(folderPath) {
    try {
        await fs.access(folderPath).catch(() => fs.mkdir(folderPath, { recursive: true }));
        const items = await fs.readdir(folderPath);

        if (items.length > 0) {
            const subfolder = path.join(folderPath, 'minecraft-server');
            await fs.access(subfolder).catch(() => fs.mkdir(subfolder, { recursive: true }));
            return subfolder;
        }
        return folderPath;
    } catch (error) {
        console.error('[minecraft-installer] Error preparing installation folder:', error);
        throw error;
    }
}

/**
 * Downloads a file, following HTTP redirects (Paper/Mojang CDN URLs).
 * Emits `minecraft-download-progress` ui-events.
 */
function downloadFile(url, destinationPath, mainWindow, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https:') ? https : http;

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Minecraft Installer)'
            }
        };

        const request = protocol.get(url, options, (response) => {
            const status = response.statusCode || 0;

            if (REDIRECT_CODES.includes(status)) {
                response.resume();
                const location = response.headers.location;
                if (!location) return reject(new Error(`HTTP ${status} without Location header`));
                if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                const nextUrl = new URL(location, url).toString();
                console.log(`[minecraft-installer] Following redirect to: ${nextUrl}`);
                return downloadFile(nextUrl, destinationPath, mainWindow, redirectsLeft - 1)
                    .then(resolve, reject);
            }

            if (status !== 200) {
                response.resume();
                return reject(new Error(`HTTP ${status}: ${response.statusMessage}`));
            }

            const totalSize = parseInt(response.headers['content-length'], 10);
            const hasTotal = !isNaN(totalSize);
            if (!hasTotal) {
                console.warn('[minecraft-installer] content-length is missing; fallback to byte-based progress');
            }

            const fileStream = fsSync.createWriteStream(destinationPath);
            let downloaded = 0;
            let lastReported = 0;

            response.on('data', (chunk) => {
                downloaded += chunk.length;

                const shouldUpdate = hasTotal
                    ? (downloaded - lastReported >= 1024 * 1024 || (downloaded / totalSize * 100 - lastReported / totalSize * 100 >= 5))
                    : (downloaded - lastReported >= 1024 * 1024);

                if (shouldUpdate) {
                    lastReported = downloaded;
                    sendToUI(mainWindow, 'minecraft-download-progress', {
                        progress: hasTotal ? Math.round((downloaded / totalSize) * 100) : null,
                        downloaded,
                        total: hasTotal ? totalSize : null
                    });
                }
            });

            response.on('error', reject);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close(() => {
                    sendToUI(mainWindow, 'minecraft-download-progress', {
                        progress: 100,
                        downloaded,
                        total: hasTotal ? totalSize : downloaded
                    });
                    resolve(destinationPath);
                });
            });

            fileStream.on('error', (err) => {
                reject(err);
            });
        });

        request.on('error', reject);
        request.setTimeout(30000, () => {
            request.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

async function createEulaFile(serverPath) {
    try {
        const eulaPath = path.join(serverPath, 'eula.txt');
        await fs.writeFile(eulaPath, 'eula=true\n', 'utf8');
        return eulaPath;
    } catch (error) {
        console.error('[minecraft-installer] Error creating eula.txt:', error);
        throw error;
    }
}

async function installMinecraftServer(downloadUrl, installDirectory, mainWindow) {
    try {
        if (!installDirectory) throw new Error('Installation path was not provided');

        const folder = await prepareInstallationFolder(installDirectory);
        const fileName = path.basename(downloadUrl) || 'minecraft-server.jar';
        const filePath = path.join(folder, fileName);

        await downloadFile(downloadUrl, filePath, mainWindow);
        await createEulaFile(folder);

        return filePath;
    } catch (error) {
        console.error('[minecraft-installer] Installation failed:', error);
        throw error;
    }
}

function openFolderInExplorer(targetPath) {
    let openPath = targetPath;
    if (fsSync.existsSync(targetPath) && fsSync.lstatSync(targetPath).isFile()) {
        openPath = path.dirname(targetPath);
    }
    shell.openPath(openPath);
}

async function deleteFolder(folderPath) {
    try {
        await fs.rm(folderPath, { recursive: true, force: true });
        console.log('[minecraft-installer] Folder deleted');
    } catch (error) {
        console.error('[minecraft-installer] Error deleting folder:', error.message);
    }
}

function setupMinecraftInstallerHandlers({ mainWindow }) {
    ipcMain.handle('minecraft-select-folder', async () => {
        try {
            const folderPath = await selectInstallationFolder(mainWindow);
            return { success: true, folderPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('minecraft-install-server', async (_event, { downloadUrl, installDirectory }) => {
        try {
            if (!downloadUrl) throw new Error('Download URL was not provided');
            if (!installDirectory) throw new Error('Installation path was not provided');

            const filePath = await installMinecraftServer(downloadUrl, installDirectory, mainWindow);
            return { success: true, filePath, message: 'Minecraft server installed successfully' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('minecraft-create-eula', async (_event, { serverPath }) => {
        try {
            if (!serverPath) throw new Error('Server path was not provided');
            const eulaPath = await createEulaFile(serverPath);
            return { success: true, eulaPath, message: 'eula.txt created successfully' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('minecraft-open-folder', async (_event, { folderPath }) => {
        try {
            console.log('[minecraft-installer] Opening folder:', folderPath);
            if (!folderPath) throw new Error('Folder path was not provided');
            openFolderInExplorer(folderPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('minecraft-delete-folder', async (_event, { folderPath }) => {
        try {
            if (!folderPath) throw new Error('Folder path was not provided');
            await deleteFolder(folderPath);
            return { success: true, message: 'Server folder deleted successfully' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    setupMinecraftInstallerHandlers,
    selectInstallationFolder,
    prepareInstallationFolder,
    downloadFile,
    createEulaFile,
    installMinecraftServer
};
