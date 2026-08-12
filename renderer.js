'use strict';

const STYLE_ID = 'qqnt-mobile-bridge-settings-style';

function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .qmb-settings .qmb-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .qmb-settings .qmb-path { width: 100%; box-sizing: border-box; border: 1px solid var(--border_standard, #4b4b4b); border-radius: 6px; background: var(--fill_standard, #1f1f1f); color: inherit; padding: 8px 10px; outline: none; }
      .qmb-settings .qmb-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .qmb-settings .qmb-status { white-space: pre-wrap; overflow-wrap: anywhere; }
    `;
    document.head.append(style);
}

function bridge() {
    return window.qqntMobileBridge;
}

export async function onSettingWindowCreated(view) {
    installStyle();
    const root = document.createElement('setting-item');
    root.className = 'qmb-settings';
    root.innerHTML = `
      <setting-section data-title="QQNT 移动端桥接">
        <setting-panel>
          <setting-list data-direction="column">
            <setting-item data-direction="column">
              <div class="qmb-copy">
                <setting-text>ADB 与手机身份</setting-text>
                <setting-text data-type="secondary">选择或临时下载 ADB，从已授权且可提供 Root shell 的手机导入 QQ 身份。导入完成后手机无需保持连接。</setting-text>
              </div>
              <input id="qmb-adb-path" class="qmb-path" type="text" spellcheck="false" placeholder="adb.exe 路径（留空可自动查找）">
              <div class="qmb-actions">
                <setting-button id="qmb-refresh">检查</setting-button>
                <setting-button id="qmb-select">选择 ADB</setting-button>
                <setting-button id="qmb-download">临时下载 ADB</setting-button>
                <setting-button id="qmb-import" data-type="primary">导入手机身份</setting-button>
              </div>
            </setting-item>
            <setting-item data-direction="row">
              <div class="qmb-copy">
                <setting-text>qsign 服务</setting-text>
                <setting-text data-type="secondary">由桥接依赖统一管理签名进程，功能插件不再分别启动服务。</setting-text>
              </div>
              <setting-switch id="qmb-qsign-enabled"></setting-switch>
            </setting-item>
            <setting-item data-direction="row">
              <setting-text id="qmb-status" class="qmb-status" data-type="secondary">正在检查…</setting-text>
              <setting-button id="qmb-save" data-type="primary">保存</setting-button>
            </setting-item>
          </setting-list>
        </setting-panel>
      </setting-section>`;
    view.append(root);

    const api = bridge();
    const pathInput = root.querySelector('#qmb-adb-path');
    const qsignToggle = root.querySelector('#qmb-qsign-enabled');
    const statusText = root.querySelector('#qmb-status');
    let config = api?.getConfig ? await api.getConfig() : {};
    pathInput.value = config.adbPath || '';
    qsignToggle.setActive(config.qsignEnabled !== false);

    const show = status => {
        if (!status) return;
        if (status.adbPath) pathInput.value = status.adbPath;
        const device = status.adb?.devices?.find(item => item.state === 'device');
        const identity = status.identity;
        const pieces = [
            status.adb?.available ? 'ADB 可用' : 'ADB 不可用',
            device ? `设备 ${device.serial}` : '未连接授权设备',
            identity ? `已导入 QQ ${identity.versionName || ''}`.trim() : '尚未导入身份',
            status.qsign?.reachable ? 'qsign 已运行' : 'qsign 未运行',
            status.sso?.available ? '移动 SSO 可用' : '移动 SSO 待完成'
        ];
        statusText.textContent = pieces.join(' · ');
    };

    const run = async (label, action) => {
        statusText.textContent = label;
        try {
            const value = await action();
            show(value);
            return value;
        } catch (error) {
            statusText.textContent = `失败：${error?.message || error}`;
            return null;
        }
    };

    root.querySelector('#qmb-refresh').addEventListener('click', () => run('正在检查…', () => api.getStatus()));
    root.querySelector('#qmb-select').addEventListener('click', () => run('正在选择 ADB…', () => api.selectAdb()));
    root.querySelector('#qmb-download').addEventListener('click', () => run('正在下载官方 Platform-Tools…', () => api.downloadAdb()));
    root.querySelector('#qmb-import').addEventListener('click', () => run('正在导入手机身份…', () => api.importIdentity(pathInput.value.trim())));
    qsignToggle.addEventListener('click', () => qsignToggle.setActive(!qsignToggle.getActive()));
    root.querySelector('#qmb-save').addEventListener('click', async () => {
        config = await api.saveConfig({ ...config, adbPath: pathInput.value.trim(), qsignEnabled: qsignToggle.getActive() });
        show(await api.getStatus());
    });
    api?.getStatus?.().then(show).catch(error => { statusText.textContent = `检查失败：${error?.message || error}`; });
}
