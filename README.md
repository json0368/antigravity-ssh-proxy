# Antigravity SSH Proxy (ATP)

**简体中文** · [English](README.en.md)

> **说明**：本项目基于原仓库 [dinobot22/antigravity-ssh-proxy](https://github.com/dinobot22/antigravity-ssh-proxy) 进行二次开发与独立维护（原项目基于 [wang-muhan/antigravity-interface](https://github.com/wang-muhan/antigravity-interface)），主要补充了对 **Antigravity IDE 2.6+ / 2.7+（`~/.gemini/bin/agy` 后端）** 的适配，同时保留对旧版 `language_server_linux_*` 的兼容。

这是一个专为 **Antigravity IDE** 设计的远程代理扩展，用于通过 SSH 反向隧道将远程 Linux 服务器的流量路由到本地代理，无需 root 权限即可恢复远程服务器上的 AI 功能。

---

## 本分支主要改动（v0.0.18 ~ v0.0.19）

- **适配 Antigravity 2.6+ / 2.7+ 后端（`~/.gemini/bin/agy --hub`）**：
  - 自动识别 `~/.gemini/bin/agy` 并生成轻量 `env-proxy` wrapper（注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 与 `NO_PROXY=127.0.0.1,localhost,::1`），替代容易在 Go 二进制上挂死的 `mgraftcp-fakedns`；
  - 完整保留旧版 `language_server_linux_*` 的 `mgraftcp-fakedns` 逻辑。
- **解决空白服务器首次下载死循环**：
  - 远程端激活时自动将远程 IDE 的 `http.proxy` 同步为隧道地址（`syncRemoteHttpProxy`，默认开启），让远程 `extensionHost` 能直接通过隧道从 `storage.googleapis.com` 下载 `agy`；
  - 当检测到 `~/.gemini/bin/agy` 尚未下载完成时，后台监听其 ELF 二进制落盘并在下载完成后自动套壳并重启无代理的 `agy --hub`。
- **修复与优化**：
  - 修复 `agy` 自动更新写入新二进制后 `.bak` 备份未同步更新的问题；
  - `Rollback` 回滚命令同步恢复 `~/.gemini/bin/agy.bak` 并清理托管的 `http.proxy`；
  - 诊断面板和进程检测全面支持 `AGY Hub`（通过 `/proc/<pid>/environ` 校验代理是否生效）；
  - 连通性检查改用 `curl -I --max-time 14`，减少跨隧道测速超时误报。

---

## ⚠️ 重要：需要双端安装

此插件需要同时安装在 **本地** 和 **远程服务器** 上：

| 位置 | 职责 |
|------|------|
| **本地** | 管理 SSH 反向端口转发配置（`~/.ssh/config.antigravity`） |
| **远程** | 配置远程 `http.proxy` 并包装 `agy`（2.x+）或 `language_server`（1.x） |

---

## 快速开始

### 前置条件

- 本地代理软件（如 Clash、V2Ray）已启动，且本地 Antigravity AI 功能可正常使用（注意选择非受限地区节点）
- 远程服务器为 Linux（支持 `x86_64/amd64`，`arm64` 为实验性支持）

### 安装步骤（通过 VSIX）

从本仓库的 Releases 页面下载最新的 `.vsix` 安装包（或自行执行 `npm ci && npm run package && npx vsce package` 打包）。

> **Windows 用户注意**：不要在资源管理器中直接双击 `.vsix` 文件（会误调起 Visual Studio Installer），请在 Antigravity IDE 内部安装。

1. **本地安装与配置**
   - 打开一个本地 Antigravity IDE 窗口，按 `Ctrl+Shift+X` 打开扩展面板 → 点击右上角 `...` → **从 VSIX 安装（Install from VSIX...）** 选择 `.vsix`；
   - 点击左下角 **ATP** 状态栏打开面板，确认 `localProxyPort` 与本地代理端口一致（如 `7890`）并开启转发。
2. **远程安装**
   - 从本地窗口通过 Remote-SSH 连接到远程 Linux 服务器（也可直接在本地 `~/.ssh/config` 对应 `Host` 下配置 `RemoteForward 7890 127.0.0.1:7890`）；
   - 在远程窗口同样通过扩展面板右上角 `...` → **从 VSIX 安装** 安装同一个 `.vsix`（远程目录弹窗中点击 **显示本地 / Show Local** 选中本地文件）。
3. **重载并验证**
   - 若为空白服务器首次下载 `agy`，按提示点击 **Reload Now** 或侧边栏 **Try again**，待 `agy` 下载完成后插件会自动套壳并重启 `agy --hub`；
   - 点击状态栏 **ATP** → **运行检查**，确认端口转发、Wrapper、进程代理与外部连通性均通过；
   - 首次在新远程服务器上使用时，按侧边栏提示在本地浏览器完成一次 Google 登录授权即可。

---

## 扩展设置

| 设置 | 说明 | 默认值 |
|------|------|--------|
| `enableLocalForwarding` | 在本地管理 `~/.ssh/config.antigravity` 启用 SSH 反向隧道转发 | `true` |
| `localProxyPort` | 本地代理软件监听端口 | `7890` |
| `remoteProxyHost` | 远程服务器访问代理的地址 | `127.0.0.1` |
| `remoteProxyPort` | SSH 反向隧道在远程监听的端口 | `7890` |
| `proxyType` | 代理协议类型（`http` 或 `socks5`） | `http` |
| `syncRemoteHttpProxy` | 自动同步远程 IDE 的 `http.proxy` 以便首次下载 `agy` | `true` |
| `showStatusOnStartup` | 连接远程服务器时自动检查并显示状态通知 | `true` |

---

## 故障排查

排查时可以查看 Output 面板中的 `Antigravity` 和 `Antigravity SSH Proxy` 日志，并在远程终端运行以下命令检查状态：

```bash
# 1. 检查反向隧道端口及外网连通性
ss -tlnp | grep 7890
curl -I -x http://127.0.0.1:7890 https://www.google.com

# 2. 检查 agy --hub 进程及其代理环境变量（Antigravity 2.x+）
ps aux | grep -E "bin/agy|language_server" | grep -v grep
for p in $(pgrep -f "bin/agy.*--hub"); do tr '\0' '\n' < /proc/$p/environ | grep -i proxy; done
```

---

## 卸载说明

卸载前请先在远程窗口执行 **Antigravity SSH Proxy: Rollback Remote Environment** 命令（或在 ATP 面板点击回滚），以恢复原始的 `~/.gemini/bin/agy`（或旧版 `language_server`）并清理托管的 `http.proxy`。

---

## 致谢

- [dinobot22/antigravity-ssh-proxy](https://github.com/dinobot22/antigravity-ssh-proxy)：本仓库的上游原项目。
- [wang-muhan/antigravity-interface](https://github.com/wang-muhan/antigravity-interface)：提供了最初的插件实现。
- [graftcp](https://github.com/hmgle/graftcp)：为旧版后端提供了核心进程代理能力。
