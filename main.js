'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { BrowserWindow, dialog, ipcMain } = require('electron');
const channels = require('./ipc-channels.js');

const execFileAsync = promisify(execFile);
const PLUGIN_SLUG = 'qqnt_mobile_bridge';
const DEFAULT_CONFIG = Object.freeze({
    adbPath: '',
    packageName: 'com.tencent.mobileqq',
    qsignEnabled: true,
    qsignHost: '127.0.0.1',
    qsignPort: 18080,
    qsignKey: 'local'
});

let configCache = null;
let qsignProcess = null;
let qsignLogStream = null;

function dataDirectory() {
    const base = globalThis.LiteLoader?.path?.data || path.join(process.cwd(), 'data');
    return path.join(base, PLUGIN_SLUG);
}

function configPath() {
    return path.join(dataDirectory(), 'config.json');
}

function identityDirectory() {
    return path.join(dataDirectory(), 'mobile-identity');
}

function runtimeDirectory() {
    return path.join(dataDirectory(), 'runtime');
}

function downloadedAdbPath() {
    return path.join(dataDirectory(), 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

function normalizeConfig(value) {
    const port = Number(value?.qsignPort);
    return {
        adbPath: typeof value?.adbPath === 'string' ? value.adbPath.trim() : '',
        packageName: typeof value?.packageName === 'string' && /^[A-Za-z0-9._]+$/.test(value.packageName)
            ? value.packageName : DEFAULT_CONFIG.packageName,
        qsignEnabled: value?.qsignEnabled !== false,
        qsignHost: typeof value?.qsignHost === 'string' && value.qsignHost.trim()
            ? value.qsignHost.trim() : DEFAULT_CONFIG.qsignHost,
        qsignPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONFIG.qsignPort,
        qsignKey: typeof value?.qsignKey === 'string' && value.qsignKey ? value.qsignKey : DEFAULT_CONFIG.qsignKey
    };
}

function loadConfig() {
    if (configCache) return configCache;
    try {
        configCache = normalizeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '')));
    } catch {
        configCache = { ...DEFAULT_CONFIG };
    }
    return configCache;
}

function broadcastStatus() {
    getStatus().then(status => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send(channels.STATUS_CHANGED, status);
        }
    }).catch(() => {});
}

function saveConfig(value) {
    configCache = normalizeConfig(value);
    fs.mkdirSync(dataDirectory(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(configCache, null, 2), 'utf8');
    broadcastStatus();
    return { ...configCache };
}

function existingFile(candidate) {
    if (!candidate || typeof candidate !== 'string') return '';
    try {
        const resolved = path.resolve(candidate.trim().replace(/^"|"$/g, ''));
        return fs.statSync(resolved).isFile() ? resolved : '';
    } catch {
        return '';
    }
}

async function adbFromPath() {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
        const { stdout } = await execFileAsync(command, ['adb'], { windowsHide: true, timeout: 5_000 });
        return String(stdout).split(/\r?\n/).map(existingFile).find(Boolean) || '';
    } catch {
        return '';
    }
}

async function resolveAdbPath(requestedPath = '') {
    for (const candidate of [
        requestedPath,
        loadConfig().adbPath,
        process.env.ADB,
        downloadedAdbPath(),
        path.join(__dirname, 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
    ]) {
        const found = existingFile(candidate);
        if (found) return found;
    }
    return adbFromPath();
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function readIdentityManifest() {
    return readJson(path.join(identityDirectory(), 'manifest.json'));
}

async function enrichIdentityManifest(identity) {
    if (!identity?.archive || (identity.authenticatedUin && identity.deviceName)) return identity;
    try {
        const { stdout: names } = await execFileAsync('tar.exe', ['-tzf', identity.archive], {
            windowsHide: true, timeout: 8_000, maxBuffer: 2 * 1024 * 1024
        });
        const current = String(names).match(/(?:^|\n)\.\/private\/files\/user\/u_(\d+)_t(?:\r?\n|$)/)?.[1] || '';
        let device = {};
        try {
            const { stdout } = await execFileAsync('tar.exe', ['-xOzf', identity.archive, './device.json'], {
                windowsHide: true, timeout: 8_000, maxBuffer: 512 * 1024
            });
            device = JSON.parse(String(stdout).replace(/^\uFEFF/, ''));
        } catch {}
        let authenticatedUin = '';
        try {
            const { stdout } = await execFileAsync('tar.exe', ['-xOzf', identity.archive,
                './private/files/msfCore/.MSFSDKDataDir/.MSFAuthUin/.MSFAuthUinsV1.dat'], {
                windowsHide: true, timeout: 8_000, maxBuffer: 512 * 1024
            });
            authenticatedUin = String(stdout).match(/\d{5,12}/)?.[0] || '';
        } catch {}
        const enriched = {
            ...identity,
            authenticatedUin: identity.authenticatedUin || authenticatedUin || current,
            deviceManufacturer: identity.deviceManufacturer || device.deviceManufacturer || '',
            deviceModel: identity.deviceModel || device.deviceModel || '',
            deviceName: identity.deviceName || device.deviceName || ''
        };
        if (enriched.authenticatedUin || enriched.deviceName) {
            fs.writeFileSync(path.join(identityDirectory(), 'manifest.json'), JSON.stringify(enriched, null, 2), 'utf8');
        }
        return enriched;
    } catch {
        return identity;
    }
}

async function inspectAdb(adbPath) {
    if (!adbPath) return { available: false, version: '', devices: [] };
    try {
        const versionResult = await execFileAsync(adbPath, ['version'], { windowsHide: true, timeout: 8_000 });
        const devicesResult = await execFileAsync(adbPath, ['devices', '-l'], { windowsHide: true, timeout: 8_000 });
        const devices = String(devicesResult.stdout).split(/\r?\n/).slice(1).map(line => line.trim())
            .filter(Boolean).map(line => {
                const [serial, state = ''] = line.split(/\s+/, 2);
                const model = line.match(/(?:^|\s)model:([^\s]+)/)?.[1]?.replace(/_/g, ' ') || '';
                const product = line.match(/(?:^|\s)product:([^\s]+)/)?.[1]?.replace(/_/g, ' ') || '';
                return { serial, state, model, product, detail: line };
            });
        return {
            available: true,
            version: String(versionResult.stdout).split(/\r?\n/)[0]?.trim() || '',
            devices
        };
    } catch (error) {
        return { available: false, version: '', devices: [], error: error?.message || String(error) };
    }
}

function qsignHealth() {
    const config = loadConfig();
    return new Promise(resolve => {
        const request = http.get({
            host: config.qsignHost,
            port: config.qsignPort,
            path: '/',
            timeout: 800
        }, response => {
            response.resume();
            resolve({ reachable: true, statusCode: response.statusCode || 0 });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve({ reachable: false, statusCode: 0 }));
    });
}

async function getStatus() {
    const adbPath = await resolveAdbPath();
    const identity = await enrichIdentityManifest(readIdentityManifest());
    const qsign = {
        managedProcess: Boolean(qsignProcess && !qsignProcess.killed),
        ...(await qsignHealth())
    };
    let sso;
    if (!identity) {
        sso = { available: false, stage: 'identity-missing', reason: '尚未导入手机身份。' };
    } else if (!qsign.reachable) {
        sso = { available: false, stage: 'qsign-offline', reason: '手机身份已导入，但 qsign 尚未运行。' };
    } else {
        sso = {
            available: false,
            stage: 'transport-missing',
            reason: '手机身份和 qsign 已就绪；移动协议传输后端尚未接入。'
        };
    }
    return {
        config: { ...loadConfig(), qsignKey: loadConfig().qsignKey ? 'configured' : '' },
        adbPath,
        adb: await inspectAdb(adbPath),
        identity,
        qsign,
        sso
    };
}

async function selectAdb(event) {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner || undefined, {
        title: '选择 adb 可执行文件',
        properties: ['openFile'],
        filters: process.platform === 'win32'
            ? [{ name: 'Android Debug Bridge', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]
            : [{ name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const adbPath = existingFile(result.filePaths[0]);
    saveConfig({ ...loadConfig(), adbPath });
    return { canceled: false, ...(await getStatus()) };
}

async function downloadAdb() {
    if (process.platform !== 'win32') throw new Error('临时下载目前只支持 Windows。');
    const tools = path.join(dataDirectory(), 'tools');
    const zip = path.join(tools, 'platform-tools.zip');
    fs.mkdirSync(tools, { recursive: true });
    const script = [
        "$ErrorActionPreference='Stop'",
        "$ProgressPreference='SilentlyContinue'",
        `Invoke-WebRequest -UseBasicParsing -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile '${zip.replace(/'/g, "''")}'`,
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tools.replace(/'/g, "''")}' -Force`,
        `Remove-Item -LiteralPath '${zip.replace(/'/g, "''")}' -Force`
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024
    });
    const adbPath = existingFile(downloadedAdbPath());
    if (!adbPath) throw new Error('下载完成，但没有找到 adb.exe。');
    saveConfig({ ...loadConfig(), adbPath });
    return getStatus();
}

function parseLastJsonLine(output) {
    const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
        try { return JSON.parse(lines[index].replace(/^\uFEFF/, '')); } catch {}
    }
    throw new Error('身份导入脚本没有返回有效结果。');
}

async function importIdentity(requestedPath = '') {
    if (process.platform !== 'win32') throw new Error('手机身份导入目前只支持 Windows。');
    const adbPath = await resolveAdbPath(requestedPath);
    if (!adbPath) throw new Error('没有找到 adb.exe。');
    const script = path.join(__dirname, 'tools', 'Import-MobileQQIdentity.ps1');
    if (!fs.existsSync(script)) throw new Error('缺少身份导入脚本。');
    fs.mkdirSync(identityDirectory(), { recursive: true });
    const config = loadConfig();
    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-AdbPath', adbPath, '-OutputDirectory', identityDirectory(), '-PackageName', config.packageName
    ], { windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    parseLastJsonLine(stdout);
    saveConfig({ ...config, adbPath });
    return getStatus();
}

function qsignLauncher() {
    const windows = path.join(runtimeDirectory(), 'qsign', 'bin', 'unidbg-fetch-qsign.bat');
    const unix = path.join(runtimeDirectory(), 'qsign', 'bin', 'unidbg-fetch-qsign');
    return existingFile(process.platform === 'win32' ? windows : unix);
}

async function startQsign() {
    const current = await qsignHealth();
    if (current.reachable) return getStatus();
    const launcher = qsignLauncher();
    if (!launcher) throw new Error('尚未安装 qsign 运行时。');
    if (qsignProcess && !qsignProcess.killed) return getStatus();
    fs.mkdirSync(runtimeDirectory(), { recursive: true });
    qsignLogStream = fs.createWriteStream(path.join(runtimeDirectory(), 'qsign.log'), { flags: 'a' });
    const basePath = path.join(runtimeDirectory(), 'qsign-base');
    if (!fs.existsSync(path.join(basePath, 'config.json'))) throw new Error('qsign 基础文件尚未安装。');
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : launcher;
    const args = process.platform === 'win32'
        ? ['/d', '/c', 'call', launcher, `--basePath=${basePath}`]
        : [`--basePath=${basePath}`];
    qsignProcess = spawn(command, args, {
        cwd: path.dirname(path.dirname(launcher)),
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    qsignProcess.stdout.pipe(qsignLogStream);
    qsignProcess.stderr.pipe(qsignLogStream);
    qsignProcess.once('exit', () => {
        qsignProcess = null;
        qsignLogStream?.end();
        qsignLogStream = null;
        broadcastStatus();
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
        if ((await qsignHealth()).reachable) break;
        if (!qsignProcess || qsignProcess.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    broadcastStatus();
    const status = await getStatus();
    if (!status.qsign.reachable) throw new Error('qsign 启动失败，请查看运行时日志。');
    return status;
}

async function stopQsign() {
    const processId = qsignProcess?.pid;
    if (processId && !qsignProcess.killed) {
        if (process.platform === 'win32') {
            try {
                await execFileAsync('taskkill.exe', ['/pid', String(processId), '/t', '/f'], {
                    windowsHide: true,
                    timeout: 8_000
                });
            } catch {
                qsignProcess.kill();
            }
        } else {
            qsignProcess.kill('SIGTERM');
        }
    }
    qsignProcess = null;
    qsignLogStream?.end();
    qsignLogStream = null;
    broadcastStatus();
    return getStatus();
}

async function fetchRawMessage(request) {
    if (!request || typeof request !== 'object') throw new TypeError('拉取请求必须是对象。');
    const status = await getStatus();
    if (!status.identity) throw new Error('尚未导入手机 QQ 身份。');
    if (!status.sso.available) {
        const error = new Error('移动端 SSO 运行时仍在配置中。');
        error.code = 'MOBILE_SSO_NOT_READY';
        throw error;
    }
    throw new Error('移动端 SSO 未初始化。');
}

const service = Object.freeze({
    getStatus,
    getConfig: () => ({ ...loadConfig() }),
    saveConfig,
    resolveAdbPath,
    importIdentity,
    startQsign,
    stopQsign,
    fetchRawMessage
});

function installIpc() {
    for (const channel of [
        channels.GET_STATUS, channels.GET_CONFIG, channels.SAVE_CONFIG,
        channels.SELECT_ADB, channels.DOWNLOAD_ADB, channels.IMPORT_IDENTITY,
        channels.START_QSIGN, channels.STOP_QSIGN, channels.FETCH_RAW_MESSAGE
    ]) ipcMain.removeHandler(channel);
    ipcMain.handle(channels.GET_STATUS, () => getStatus());
    ipcMain.handle(channels.GET_CONFIG, () => ({ ...loadConfig() }));
    ipcMain.handle(channels.SAVE_CONFIG, (_event, value) => saveConfig(value));
    ipcMain.handle(channels.SELECT_ADB, event => selectAdb(event));
    ipcMain.handle(channels.DOWNLOAD_ADB, () => downloadAdb());
    ipcMain.handle(channels.IMPORT_IDENTITY, (_event, adbPath) => importIdentity(adbPath));
    ipcMain.handle(channels.START_QSIGN, () => startQsign());
    ipcMain.handle(channels.STOP_QSIGN, () => stopQsign());
    ipcMain.handle(channels.FETCH_RAW_MESSAGE, (_event, request) => fetchRawMessage(request));
}

loadConfig();
installIpc();
globalThis.__qqntMobileBridgeService = service;

module.exports = service;
