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
      .qmb-settings .qmb-block {
        display: flex !important;
        width: 100% !important;
        box-sizing: border-box;
        flex-direction: column !important;
        align-items: stretch !important;
        gap: 12px !important;
      }
      .qmb-settings .qmb-copy {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
        gap: 3px;
      }
      .qmb-settings .qmb-heading-row {
        display: flex;
        width: 100%;
        min-width: 0;
        align-items: center;
        gap: 16px;
      }
      .qmb-settings .qmb-path {
        display: block;
        width: 100%;
        height: 36px;
        box-sizing: border-box;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 6px;
        outline: none;
        background: color-mix(in srgb, currentColor 6%, transparent);
        color: inherit;
        padding: 0 11px;
        font: inherit;
      }
      .qmb-settings .qmb-path:focus {
        border-color: #1583e9;
        box-shadow: 0 0 0 1px #1583e9;
      }
      .qmb-settings .qmb-actions {
        display: flex;
        width: 100%;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .qmb-settings .qmb-actions setting-button {
        display: inline-flex !important;
        min-width: 84px;
        flex: 0 0 auto;
        justify-content: center;
        white-space: nowrap;
      }
      .qmb-settings .qmb-status-grid {
        display: grid;
        width: 100%;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .qmb-settings .qmb-status-item {
        display: flex;
        min-width: 0;
        min-height: 44px;
        box-sizing: border-box;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 11px;
        border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
        border-radius: 6px;
        background: color-mix(in srgb, currentColor 4%, transparent);
      }
      .qmb-settings .qmb-status-label { flex: 0 0 auto; opacity: .62; }
      .qmb-settings .qmb-status-value {
        min-width: 0;
        overflow-wrap: anywhere;
        text-align: right;
        font-weight: 500;
        user-select: text;
      }
      .qmb-settings .qmb-status-value[data-state="ok"] { color: #2fca73; }
      .qmb-settings .qmb-status-value[data-state="pending"] { color: #d6a632; }
      .qmb-settings .qmb-status-message {
        display: none;
        width: 100%;
        box-sizing: border-box;
        padding: 8px 11px;
        border-radius: 6px;
        background: color-mix(in srgb, currentColor 5%, transparent);
        overflow-wrap: anywhere;
        user-select: text;
      }
      .qmb-settings .qmb-status-message.is-visible { display: block; }
      .qmb-settings .qmb-footer {
        display: flex;
        width: 100%;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
      }
      @media (max-width: 620px) {
        .qmb-settings .qmb-status-grid { grid-template-columns: 1fr; }
      }
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
            <setting-item data-direction="column" class="qmb-block">
              <div class="qmb-copy">
                <setting-text>ADB 与手机身份</setting-text>
                <setting-text data-type="secondary">选择或临时下载 ADB，从已授权且可提供 Root shell 的手机导入 QQ 身份。导入完成后手机无需保持连接。</setting-text>
              </div>
              <input id="qmb-adb-path" class="qmb-path" type="text" spellcheck="false" placeholder="adb.exe 路径（留空可自动查找）">
              <div class="qmb-actions">
                <setting-button id="qmb-refresh" data-type="secondary">检查连接</setting-button>
                <setting-button id="qmb-select" data-type="secondary">选择 ADB</setting-button>
                <setting-button id="qmb-download" data-type="secondary">临时下载</setting-button>
                <setting-button id="qmb-import" data-type="primary">导入手机身份</setting-button>
              </div>
            </setting-item>
            <setting-item data-direction="column" class="qmb-block">
              <div class="qmb-heading-row">
                <div class="qmb-copy">
                  <setting-text>qsign 服务</setting-text>
                  <setting-text data-type="secondary">由桥接依赖统一管理签名进程，功能插件不再分别启动服务。</setting-text>
                </div>
                <setting-switch id="qmb-qsign-enabled"></setting-switch>
              </div>
              <div class="qmb-actions">
                <setting-button id="qmb-qsign-start" data-type="secondary">启动服务</setting-button>
                <setting-button id="qmb-qsign-stop" data-type="secondary">停止服务</setting-button>
              </div>
            </setting-item>
            <setting-item data-direction="column" class="qmb-block">
              <div class="qmb-copy">
                <setting-text>运行状态</setting-text>
                <setting-text data-type="secondary">显示 ADB、手机身份、qsign 和移动 SSO 的实际状态。</setting-text>
              </div>
              <div class="qmb-status-grid">
                <div class="qmb-status-item"><span class="qmb-status-label">ADB</span><span id="qmb-state-adb" class="qmb-status-value">检查中</span></div>
                <div class="qmb-status-item"><span class="qmb-status-label">设备</span><span id="qmb-state-device" class="qmb-status-value">检查中</span></div>
                <div class="qmb-status-item"><span class="qmb-status-label">手机身份</span><span id="qmb-state-identity" class="qmb-status-value">检查中</span></div>
                <div class="qmb-status-item"><span class="qmb-status-label">qsign</span><span id="qmb-state-qsign" class="qmb-status-value">检查中</span></div>
                <div class="qmb-status-item"><span class="qmb-status-label">移动 SSO</span><span id="qmb-state-sso" class="qmb-status-value">检查中</span></div>
              </div>
              <div id="qmb-status-message" class="qmb-status-message"></div>
              <div class="qmb-footer">
                <setting-button id="qmb-status-refresh" data-type="secondary">刷新状态</setting-button>
                <setting-button id="qmb-save" data-type="primary">保存设置</setting-button>
              </div>
            </setting-item>
          </setting-list>
        </setting-panel>
      </setting-section>`;
    view.append(root);

    const api = bridge();
    const pathInput = root.querySelector('#qmb-adb-path');
    const qsignToggle = root.querySelector('#qmb-qsign-enabled');
    const statusMessage = root.querySelector('#qmb-status-message');
    const stateElements = {
        adb: root.querySelector('#qmb-state-adb'),
        device: root.querySelector('#qmb-state-device'),
        identity: root.querySelector('#qmb-state-identity'),
        qsign: root.querySelector('#qmb-state-qsign'),
        sso: root.querySelector('#qmb-state-sso')
    };
    let config = api?.getConfig ? await api.getConfig() : {};
    pathInput.value = config.adbPath || '';
    qsignToggle.setActive(config.qsignEnabled !== false);

    const setState = (name, text, state = '') => {
        const element = stateElements[name];
        element.textContent = text;
        if (state) element.dataset.state = state;
        else delete element.dataset.state;
    };

    const showMessage = text => {
        statusMessage.textContent = text || '';
        statusMessage.classList.toggle('is-visible', Boolean(text));
    };

    const show = (status, options = {}) => {
        if (!status) return;
        if (status.adbPath) pathInput.value = status.adbPath;
        const device = status.adb?.devices?.find(item => item.state === 'device');
        const identity = status.identity;
        setState('adb', status.adb?.available ? '可用' : '不可用', status.adb?.available ? 'ok' : 'pending');
        setState('device', device ? `${device.serial} · 已授权` : '未连接', device ? 'ok' : 'pending');
        setState('identity', identity ? `QQ ${identity.versionName || '未知版本'}` : '尚未导入', identity ? 'ok' : 'pending');
        setState('qsign', status.qsign?.reachable ? '正在运行' : '未运行', status.qsign?.reachable ? 'ok' : 'pending');
        const ssoText = status.sso?.available ? '可用' : ({
            'identity-missing': '缺少手机身份',
            'qsign-offline': '等待 qsign',
            'transport-missing': '缺少传输后端'
        }[status.sso?.stage] || '不可用');
        setState('sso', ssoText, status.sso?.available ? 'ok' : 'pending');
        stateElements.sso.title = status.sso?.reason || '';
        if (!options.preserveMessage) {
            showMessage(status.adb?.error
                ? `ADB 错误：${status.adb.error}`
                : (!status.sso?.available ? status.sso?.reason : ''));
        }
    };

    const run = async ({ pending, success }, action) => {
        showMessage(pending);
        try {
            const value = await action();
            show(value, { preserveMessage: true });
            showMessage(typeof success === 'function' ? success(value) : success);
            return value;
        } catch (error) {
            showMessage(`失败：${error?.message || error}`);
            return null;
        }
    };

    root.querySelector('#qmb-refresh').addEventListener('click', () => run({ pending: '正在检查 ADB…', success: 'ADB 状态已刷新。' }, () => api.getStatus()));
    root.querySelector('#qmb-select').addEventListener('click', () => run({ pending: '正在选择 ADB…', success: 'ADB 路径已更新。' }, () => api.selectAdb()));
    root.querySelector('#qmb-download').addEventListener('click', () => run({ pending: '正在下载官方 Platform-Tools…', success: 'Platform-Tools 已下载。' }, () => api.downloadAdb()));
    root.querySelector('#qmb-import').addEventListener('click', () => run({
        pending: '正在导入手机身份…',
        success: value => value?.sso?.available
            ? '手机身份已导入，移动 SSO 已可用。'
            : `手机身份已导入。${value?.sso?.reason || '移动 SSO 尚不可用。'}`
    }, () => api.importIdentity(pathInput.value.trim())));
    root.querySelector('#qmb-qsign-start').addEventListener('click', () => run({
        pending: '正在启动 qsign…',
        success: value => value?.sso?.available ? 'qsign 已启动，移动 SSO 已可用。' : `qsign 已启动。${value?.sso?.reason || ''}`
    }, () => api.startQsign()));
    root.querySelector('#qmb-qsign-stop').addEventListener('click', () => run({ pending: '正在停止 qsign…', success: 'qsign 已停止。' }, () => api.stopQsign()));
    root.querySelector('#qmb-status-refresh').addEventListener('click', () => run({
        pending: '正在刷新状态…',
        success: value => value?.sso?.available ? '运行状态已刷新，移动 SSO 可用。' : (value?.sso?.reason || '运行状态已刷新。')
    }, () => api.getStatus()));
    qsignToggle.addEventListener('click', () => qsignToggle.setActive(!qsignToggle.getActive()));
    root.querySelector('#qmb-save').addEventListener('click', async () => {
        config = await api.saveConfig({ ...config, adbPath: pathInput.value.trim(), qsignEnabled: qsignToggle.getActive() });
        show(await api.getStatus());
    });
    api?.getStatus?.().then(show).catch(error => { showMessage(`检查失败：${error?.message || error}`); });
}
