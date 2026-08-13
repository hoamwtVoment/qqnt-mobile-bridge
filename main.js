'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
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
const SSO_HOST = '127.0.0.1';
const SSO_PORT = 18081;
const RUNTIME_VERSION = 'v0.1.0';
const RUNTIME_ASSET = `qqnt-mobile-bridge-runtime-win32-x64-${RUNTIME_VERSION}.zip`;
const RUNTIME_URL = `https://github.com/hoamwtVoment/qqnt-mobile-bridge/releases/download/${RUNTIME_VERSION}/${RUNTIME_ASSET}`;
const RUNTIME_SHA256 = '0c57af5120068cc661f9efc69a992a8dbad65a4b243dd5e0abbe34ecc9b63176';

let configCache = null;
let qsignProcess = null;
let qsignLogStream = null;
let ssoProcess = null;
let ssoLogStream = null;
let runtimeInstallPromise = null;
let runtimeInstallState = { stage: 'idle', message: '' };

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

function runtimeMarkerPath() {
    return path.join(runtimeDirectory(), 'runtime-version.json');
}

function runtimeInstalled() {
    const marker = readJson(runtimeMarkerPath());
    return marker?.version === RUNTIME_VERSION && Boolean(
        existingFile(path.join(runtimeDirectory(), 'qsign', 'bin', 'unidbg-fetch-qsign.bat')) &&
        existingFile(path.join(runtimeDirectory(), 'java', 'bin', 'java.exe')) &&
        existingFile(path.join(runtimeDirectory(), 'mobile-sso', 'qqnt-mobile-sso.exe'))
    );
}

function setRuntimeState(stage, message = '') {
    runtimeInstallState = { stage, message };
    broadcastStatus();
}

function downloadToFile(url, destination, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 8) return reject(new Error('运行时下载重定向过多。'));
        const client = url.startsWith('https:') ? https : http;
        const request = client.get(url, { headers: { 'user-agent': 'qqnt-mobile-bridge' } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume();
                const next = new URL(response.headers.location, url).toString();
                downloadToFile(next, destination, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`运行时下载失败：HTTP ${response.statusCode}`));
                return;
            }
            const output = fs.createWriteStream(destination);
            response.pipe(output);
            output.once('finish', () => output.close(resolve));
            output.once('error', reject);
        });
        request.setTimeout(180_000, () => request.destroy(new Error('运行时下载超时。')));
        request.once('error', reject);
    });
}

async function ensureRuntimeInstalled() {
    if (process.platform !== 'win32') throw new Error('自动运行时目前只支持 Windows x64。');
    if (runtimeInstalled()) return runtimeDirectory();
    if (runtimeInstallPromise) return runtimeInstallPromise;
    runtimeInstallPromise = (async () => {
        const parent = dataDirectory();
        const zip = path.join(parent, `${RUNTIME_ASSET}.download.zip`);
        const staging = path.join(parent, `runtime-staging-${process.pid}`);
        try {
            fs.mkdirSync(parent, { recursive: true });
            setRuntimeState('downloading', '正在从 GitHub Release 下载移动端运行时…');
            try { fs.rmSync(zip, { force: true }); } catch {}
            await downloadToFile(RUNTIME_URL, zip);
            const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
            if (actual !== RUNTIME_SHA256) throw new Error(`运行时校验失败：${actual}`);
            setRuntimeState('installing', '下载完成，正在安装移动端运行时…');
            try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
            fs.mkdirSync(staging, { recursive: true });
            await execFileAsync('tar.exe', ['-xf', zip, '-C', staging],
            { windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
            for (const required of ['qsign/bin/unidbg-fetch-qsign.bat', 'java/bin/java.exe', 'mobile-sso/qqnt-mobile-sso.exe']) {
                if (!existingFile(path.join(staging, ...required.split('/')))) throw new Error(`运行时资源缺失：${required}`);
            }
            fs.mkdirSync(runtimeDirectory(), { recursive: true });
            fs.cpSync(staging, runtimeDirectory(), { recursive: true, force: true });
            fs.writeFileSync(runtimeMarkerPath(), JSON.stringify({ version: RUNTIME_VERSION, installedAt: new Date().toISOString(), sha256: actual }, null, 2));
            setRuntimeState('ready', '移动端运行时已安装。');
            return runtimeDirectory();
        } catch (error) {
            setRuntimeState('error', error?.message || String(error));
            throw error;
        } finally {
            try { fs.rmSync(zip, { force: true }); } catch {}
            try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
            runtimeInstallPromise = null;
        }
    })();
    return runtimeInstallPromise;
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

function requestJson({ host = SSO_HOST, port = SSO_PORT, method = 'GET', requestPath = '/status', body, timeout = 1_200 }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
        const request = http.request({
            host, port, method, path: requestPath, timeout,
            headers: payload ? {
                'content-type': 'application/json; charset=utf-8',
                'content-length': payload.length
            } : undefined
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let value;
                try { value = text ? JSON.parse(text) : {}; } catch { value = { message: text }; }
                if ((response.statusCode || 500) >= 400) {
                    const error = new Error(value?.message || `移动 SSO HTTP ${response.statusCode}`);
                    error.response = value;
                    reject(error);
                    return;
                }
                resolve(value);
            });
        });
        request.on('timeout', () => request.destroy(new Error('移动 SSO 请求超时。')));
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

async function ssoHealth() {
    try {
        return { reachable: true, ...(await requestJson({ timeout: 800 })) };
    } catch {
        return { reachable: false, online: false };
    }
}

function ssoRuntimeDirectory() {
    return path.join(runtimeDirectory(), 'mobile-sso');
}

function ssoExecutable() {
    return existingFile(path.join(ssoRuntimeDirectory(), process.platform === 'win32'
        ? 'qqnt-mobile-sso.exe' : 'qqnt-mobile-sso'));
}

async function startSso() {
    const current = await ssoHealth();
    if (current.reachable) return current;
    await ensureRuntimeInstalled();
    await prepareIdentityRuntime();
    const executable = ssoExecutable();
    const backendConfig = existingFile(path.join(ssoRuntimeDirectory(), 'config.json'));
    if (!executable || !backendConfig) throw new Error('移动 SSO 后端尚未安装完整。');
    if (ssoProcess && ssoProcess.exitCode === null) return ssoHealth();
    ssoLogStream = fs.createWriteStream(path.join(ssoRuntimeDirectory(), 'mobile-sso.log'), { flags: 'a' });
    ssoProcess = spawn(executable, [backendConfig], {
        cwd: ssoRuntimeDirectory(), windowsHide: true, detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    ssoProcess.stdout.pipe(ssoLogStream);
    ssoProcess.stderr.pipe(ssoLogStream);
    ssoProcess.once('exit', () => {
        ssoProcess = null;
        ssoLogStream?.end();
        ssoLogStream = null;
        broadcastStatus();
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8_000) {
        const status = await ssoHealth();
        if (status.reachable) return status;
        if (!ssoProcess || ssoProcess.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('移动 SSO 后端启动失败，请查看 mobile-sso.log。');
}

async function getStatus() {
    const adbPath = await resolveAdbPath();
    const identity = await enrichIdentityManifest(readIdentityManifest());
    const qsign = {
        managedProcess: Boolean(qsignProcess && !qsignProcess.killed),
        ...(await qsignHealth())
    };
    const backend = await ssoHealth();
    let sso;
    if (!identity) {
        sso = { available: false, stage: 'identity-missing', reason: '尚未导入手机身份。' };
    } else if (!qsign.reachable) {
        sso = { available: false, stage: 'qsign-offline', reason: '手机身份已导入，但 qsign 尚未运行。' };
    } else if (!ssoExecutable()) {
        sso = { available: false, stage: 'transport-missing', reason: '移动 SSO 后端尚未安装。' };
    } else {
        sso = {
            available: backend.reachable,
            stage: backend.reachable ? (backend.online ? 'online' : 'ready') : 'backend-stopped',
            reason: backend.reachable ? (backend.error || '移动 SSO 后端已就绪。') : '移动 SSO 后端尚未启动。',
            ...backend
        };
    }
    return {
        config: { ...loadConfig(), qsignKey: loadConfig().qsignKey ? 'configured' : '' },
        adbPath,
        adb: await inspectAdb(adbPath),
        identity,
        runtime: {
            version: RUNTIME_VERSION,
            installed: runtimeInstalled(),
            ...runtimeInstallState
        },
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
    await ensureRuntimeInstalled();
    await prepareIdentityRuntime(true);
    return getStatus();
}

async function prepareIdentityRuntime(force = false) {
    const identity = await enrichIdentityManifest(readIdentityManifest());
    if (!identity?.archive || !identity.authenticatedUin) throw new Error('手机身份归档不完整，请重新导入。');
    await ensureRuntimeInstalled();
    const sessionFile = path.join(ssoRuntimeDirectory(), 'mobile-session.json');
    const basePath = path.join(runtimeDirectory(), 'qsign-base');
    const prepared = readJson(path.join(basePath, 'prepared.json'));
    if (!force && existingFile(sessionFile) && existingFile(path.join(basePath, 'config.json')) &&
        prepared?.archiveSha256 === identity.archiveSha256) return;

    const temporary = path.join(dataDirectory(), `identity-prepare-${process.pid}`);
    try {
        fs.rmSync(temporary, { recursive: true, force: true });
        fs.mkdirSync(temporary, { recursive: true });
        await execFileAsync('tar.exe', ['-xzf', identity.archive, '-C', temporary], {
            windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024
        });
        const uidDirectory = path.join(temporary, 'private', 'files', 'uid');
        const uid = fs.readdirSync(uidDirectory).map(name => name.split('###'))
            .find(parts => parts[0] === String(identity.authenticatedUin))?.[1] || '';
        if (!uid) throw new Error('身份归档中没有找到当前认证 QQ 的 UID。');
        const executable = existingFile(path.join(ssoRuntimeDirectory(), 'qqnt-mobile-sso.exe'));
        if (!executable) throw new Error('移动 SSO 后端缺失。');
        fs.mkdirSync(ssoRuntimeDirectory(), { recursive: true });
        await execFileAsync(executable, ['build-session', temporary, sessionFile,
            String(identity.authenticatedUin), uid], { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });

        fs.mkdirSync(basePath, { recursive: true });
        for (const name of ['libfekit.so', 'libwtecdh.so']) {
            const source = path.join(temporary, 'native', name);
            if (!existingFile(source)) throw new Error(`手机身份中缺少 ${name}。`);
            fs.copyFileSync(source, path.join(basePath, name));
        }
        for (const name of ['dtconfig.json']) {
            const source = path.join(runtimeDirectory(), 'templates', name);
            if (existingFile(source)) fs.copyFileSync(source, path.join(basePath, name));
        }
        for (const name of ['stdin', 'stdout', 'stderr']) fs.closeSync(fs.openSync(path.join(basePath, name), 'a'));
        const session = readJson(sessionFile);
        const qsignConfig = {
            server: { host: loadConfig().qsignHost, port: loadConfig().qsignPort },
            share_token: false,
            key: loadConfig().qsignKey,
            auto_register: true,
            protocol: {
                package_name: loadConfig().packageName,
                qua: session.qua,
                version: session.versionName,
                code: String(session.versionCode)
            },
            unidbg: { dynarmic: false, unicorn: true, kvm: false, debug: false },
            black_list: []
        };
        fs.writeFileSync(path.join(basePath, 'config.json'), JSON.stringify(qsignConfig, null, 2), 'utf8');
        fs.writeFileSync(path.join(basePath, 'prepared.json'), JSON.stringify({
            archiveSha256: identity.archiveSha256, preparedAt: new Date().toISOString(), runtimeVersion: RUNTIME_VERSION
        }, null, 2), 'utf8');
        const backendConfig = {
            listen: `${SSO_HOST}:${SSO_PORT}`,
            sessionFile,
            qsignUrl: `http://${loadConfig().qsignHost}:${loadConfig().qsignPort}`,
            qsignKey: loadConfig().qsignKey
        };
        fs.writeFileSync(path.join(ssoRuntimeDirectory(), 'config.json'), JSON.stringify(backendConfig, null, 2), 'utf8');
    } finally {
        try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
    }
}

function qsignLauncher() {
    const windows = path.join(runtimeDirectory(), 'qsign', 'bin', 'unidbg-fetch-qsign.bat');
    const unix = path.join(runtimeDirectory(), 'qsign', 'bin', 'unidbg-fetch-qsign');
    return existingFile(process.platform === 'win32' ? windows : unix);
}

async function startQsign() {
    const current = await qsignHealth();
    if (current.reachable) return getStatus();
    await ensureRuntimeInstalled();
    await prepareIdentityRuntime();
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
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, JAVA_HOME: path.join(runtimeDirectory(), 'java') }
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
    let status = await getStatus();
    if (!status.identity) {
        return {
            ok: false,
            code: 'MOBILE_IDENTITY_MISSING',
            stage: 'identity-missing',
            message: '尚未导入手机 QQ 身份，请先导入手机身份。'
        };
    }
    if (!status.qsign.reachable && loadConfig().qsignEnabled) {
        await startQsign();
        status = await getStatus();
    }
    if (!status.sso.available && status.sso.stage === 'backend-stopped') {
        await startSso();
        status = await getStatus();
    }
    if (!status.sso.available) {
        return {
            ok: false,
            code: 'MOBILE_SSO_TRANSPORT_UNAVAILABLE',
            stage: status.sso.stage || 'transport-missing',
            message: status.sso.reason || '移动 SSO 后端尚未就绪。'
        };
    }
    return requestJson({ method: 'POST', requestPath: '/pull', body: request, timeout: 45_000 });
}
const service = Object.freeze({
    getStatus,
    getConfig: () => ({ ...loadConfig() }),
    saveConfig,
    resolveAdbPath,
    importIdentity,
    startQsign,
    stopQsign,
    fetchRawMessage,
    ensureRuntimeInstalled
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

// Bring the bridge back silently after QQ starts or the plugin is reloaded.
// Both child processes use windowsHide, so no qsign console needs to remain
// open on the desktop.
queueMicrotask(async () => {
    try {
        const current = loadConfig();
        if (!current.qsignEnabled || !readIdentityManifest()) return;
        await startQsign();
        await startSso();
        broadcastStatus();
    } catch (error) {
        console.error('[qqnt-mobile-bridge] automatic startup failed:', error);
        broadcastStatus();
    }
});

module.exports = service;
