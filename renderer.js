'use strict';

const STYLE_ID = 'qqnt-mobile-bridge-settings-style';

function installStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.append(style);
    }
    style.textContent = `
      .qmb-settings .qmb-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .qmb-settings .qmb-heading-row { display: flex; width: 100%; min-width: 0; align-items: center; gap: 12px; }
      .qmb-settings .qmb-path { width: 100%; box-sizing: border-box; border: 1px solid var(--border_standard, #4b4b4b); border-radius: 6px; background: var(--fill_standard, #1f1f1f); color: inherit; padding: 8px 10px; outline: none; }
      .qmb-settings .qmb-actions { display: flex; width: 100%; flex-wrap: wrap; gap: 8px; }
      .qmb-settings .qmb-actions setting-button { flex: 0 0 auto; white-space: nowrap; }
      .qmb-settings .qmb-status-box { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
      .qmb-settings .qmb-status { display: block; width: 100%; min-width: 0; line-height: 1.65; white-space: normal; overflow: visible; overflow-wrap: anywhere; user-select: text; }
      .qmb-settings .qmb-footer { display: flex; width: 100%; justify-content: flex-end; }
    `;
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
            <setting-item data-direction="column">
              <div class="qmb-heading-row">
                <div class="qmb-copy">
                  <setting-text>qsign 服务</setting-text>
                  <setting-text data-type="secondary">由桥接依赖统一管理签名进程，功能插件不再分别启动服务。</setting-text>
                </div>
                <setting-switch id="qmb-qsign-enabled"></setting-switch>
              </div>
              <div class="qmb-actions">
                <setting-button id="qmb-qsign-start">启动 qsign</setting-button>
                <setting-button id="qmb-qsign-stop">停止 qsign</setting-button>
              </div>
            </setting-item>
            <setting-item data-direction="column">
              <div class="qmb-copy">
                <setting-text>运行状态</setting-text>
                <setting-text data-type="secondary">显示 ADB、手机身份、qsign 和移动 SSO 的实际状态。</setting-text>
              </div>
              <div class="qmb-status-box"><div id="qmb-status" class="qmb-status">正在检查状态…</div></div>
              <div class="qmb-footer"><setting-button id="qmb-save" data-type="primary">保存</setting-button></div>
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
        const lines = [
            `ADB：${status.adb?.available ? '可用' : '不可用'}`,
            `设备：${device ? `${device.serial}（已授权）` : '未连接已授权设备'}`,
            `手机身份：${identity ? `已导入 QQ ${identity.versionName || '未知版本'}` : '尚未导入'}`,
            `qsign：${status.qsign?.reachable ? '正在运行' : '未运行'}`,
            `移动 SSO：${status.sso?.available ? '可用' : '尚未接入完成'}`
        ];
        if (status.adb?.error) lines.push(`ADB 错误：${status.adb.error}`);
        statusText.textContent = lines.join('　｜　');
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
    root.querySelector('#qmb-qsign-start').addEventListener('click', () => run('正在启动 qsign…', () => api.startQsign()));
    root.querySelector('#qmb-qsign-stop').addEventListener('click', () => run('正在停止 qsign…', () => api.stopQsign()));
    qsignToggle.addEventListener('click', () => qsignToggle.setActive(!qsignToggle.getActive()));
    root.querySelector('#qmb-save').addEventListener('click', async () => {
        config = await api.saveConfig({ ...config, adbPath: pathInput.value.trim(), qsignEnabled: qsignToggle.getActive() });
        show(await api.getStatus());
    });
    api?.getStatus?.().then(show).catch(error => { statusText.textContent = `检查失败：${error?.message || error}`; });
}
