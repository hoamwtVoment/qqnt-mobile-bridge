# QQNT 移动端桥接

供 LiteLoaderQQNT 插件共用的移动端基础设施，不负责具体界面特效。

## 能力

- 查找、选择或临时下载官方 Android Platform-Tools。
- 从已授权且可提供 Root shell 的 Android 设备导入手机 QQ 身份归档。
- 管理独立 qsign 进程。
- 向其他插件提供统一的移动端原始消息拉取接口。
- 手机完成导入后无需一直连接电脑。

## 安装

从 [最新 Release](https://github.com/hoamwtVoment/qqnt-mobile-bridge/releases/latest)
下载插件压缩包，
解压到 LiteLoaderQQNT 的 `plugins` 目录后重载插件或重启 QQ。

移动 SSO 运行时无需手工安装：首次导入手机身份或启动服务时，插件会从同一
Release 自动下载并校验运行时文件。

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

## 自动安装运行时

Windows 上首次导入手机身份或启动 qsign 时，插件会从本仓库的 GitHub
Release 下载经过 SHA-256 校验的运行时。Release 只包含 qsign、精简 Java
运行环境和移动 SSO 后端，不包含任何人的 QQ 登录 Token、GUID、QIMEI、
手机身份归档、`mobile-session.json` 或本地路径。

导入完成后，插件会在本机从当前用户自己的手机归档生成会话文件和 qsign
基础目录，手机之后无需保持连接。


## 统一 API

渲染进程使用 `window.qqntMobileBridge`：

- `getStatus()`：获取 ADB、手机身份、qsign 和移动 SSO 状态。
- `selectAdb()` / `downloadAdb()` / `importIdentity()`：统一的手机身份导入流程。
- `startQsign()` / `stopQsign()`：统一管理本地签名服务。
- `fetchRawMessage(request)`：功能插件共用的移动端原始消息入口。

`fetchRawMessage()` 会在后端解析每页原始 protobuf，并按 `msgSeq` 与非零
`msgRandom` 匹配目标；当前页未命中时会自动沿群聊序号或私聊时间游标继续
翻页，返回的 wire bytes 只包含命中的单条消息。

功能插件不应再自行保存 ADB 路径、复制手机身份归档或启动 qsign。
