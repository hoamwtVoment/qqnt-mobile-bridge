'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const channels = require('./ipc-channels.js');

contextBridge.exposeInMainWorld('qqntMobileBridge', Object.freeze({
    getStatus: () => ipcRenderer.invoke(channels.GET_STATUS),
    getConfig: () => ipcRenderer.invoke(channels.GET_CONFIG),
    saveConfig: value => ipcRenderer.invoke(channels.SAVE_CONFIG, value),
    selectAdb: () => ipcRenderer.invoke(channels.SELECT_ADB),
    downloadAdb: () => ipcRenderer.invoke(channels.DOWNLOAD_ADB),
    importIdentity: adbPath => ipcRenderer.invoke(channels.IMPORT_IDENTITY, adbPath),
    startQsign: () => ipcRenderer.invoke(channels.START_QSIGN),
    stopQsign: () => ipcRenderer.invoke(channels.STOP_QSIGN),
    fetchRawMessage: request => ipcRenderer.invoke(channels.FETCH_RAW_MESSAGE, request),
    onStatusChanged: callback => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on(channels.STATUS_CHANGED, listener);
        return () => ipcRenderer.removeListener(channels.STATUS_CHANGED, listener);
    }
}));
