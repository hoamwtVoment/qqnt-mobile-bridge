# QQNT 移动端桥接

供 LiteLoaderQQNT 插件共用的移动端基础设施，不负责具体界面特效。

## 能力

- 查找、选择或临时下载官方 Android Platform-Tools。
- 从已授权且可提供 Root shell 的 Android 设备导入手机 QQ 身份归档。
- 管理独立 qsign 进程。
- 向其他插件提供统一的移动端原始消息拉取接口。
- 手机完成导入后无需一直连接电脑。

## 使用

其他插件在 `manifest.json` 中声明：

```json
{
  "dependencies": ["qqnt_mobile_bridge"]
}
```

渲染进程通过 `window.qqntMobileBridge` 使用；主进程可读取
`globalThis.__qqntMobileBridgeService`，或直接 `require()` 本插件的 `main.js`。

身份归档和配置只保存在 LiteLoader 数据目录，不进入 Git。


## 统一 API

渲染进程使用 `window.qqntMobileBridge`：

- `getStatus()`：获取 ADB、手机身份、qsign 和移动 SSO 状态。
- `selectAdb()` / `downloadAdb()` / `importIdentity()`：统一的手机身份导入流程。
- `startQsign()` / `stopQsign()`：统一管理本地签名服务。
- `fetchRawMessage(request)`：功能插件共用的移动端原始消息入口。

功能插件不应再自行保存 ADB 路径、复制手机身份归档或启动 qsign。
