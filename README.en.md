# Antigravity SSH Proxy (ATP)

**English** · [简体中文](README.md)

> **Note**: This repository is a maintained fork of [dinobot22/antigravity-ssh-proxy](https://github.com/dinobot22/antigravity-ssh-proxy) (originally based on [wang-muhan/antigravity-interface](https://github.com/wang-muhan/antigravity-interface)). It adds support for **Antigravity IDE 2.6+ / 2.7+ (`~/.gemini/bin/agy`)** while preserving backward compatibility with legacy `language_server_linux_*` backends.

An extension for **Antigravity IDE** that routes remote Linux server traffic through a local proxy over an SSH reverse tunnel — no root privileges required.

---

## Key Changes in This Fork (v0.0.18 ~ v0.0.19)

- **Antigravity 2.6+ / 2.7+ Backend Support (`~/.gemini/bin/agy --hub`)**:
  - Automatically detects `~/.gemini/bin/agy` and installs a lightweight `env-proxy` wrapper (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` + `NO_PROXY=127.0.0.1,localhost,::1`) instead of `mgraftcp-fakedns`, avoiding hangs on Go binaries.
  - Preserves legacy `mgraftcp-fakedns` wrapping for `language_server_linux_*`.
- **Fresh Server Bootstrap Fix**:
  - Automatically syncs remote IDE `http.proxy` and `http.proxySupport` (`syncRemoteHttpProxy`, enabled by default) so the remote `extensionHost` can download `agy` from `storage.googleapis.com` through the SSH tunnel.
  - Watches `~/.gemini/bin/agy` when not yet installed on a fresh server, and automatically wraps and restarts `agy --hub` once the ELF binary finishes downloading.
- **Fixes & Improvements**:
  - Refreshes `.bak` backups automatically when auto-updates replace the wrapped binary with a new ELF executable.
  - `Rollback` restores `~/.gemini/bin/agy.bak` and cleans up the managed remote `http.proxy`.
  - Diagnostics and process checks detect `AGY Hub` and verify live proxy env vars via `/proc/<pid>/environ`.
  - Connectivity tests use `curl -I --max-time 14` (HEAD requests) to avoid false timeouts over slower tunnels.

---

## ⚠️ Important: Dual Installation Required

This extension must be installed on **BOTH** your local machine and the remote server:

| Location | Role |
|----------|------|
| **Local** | Manages SSH reverse port forwarding (`~/.ssh/config.antigravity`) |
| **Remote** | Syncs remote `http.proxy` and wraps `agy` (2.x+) or `language_server` (1.x) |

---

## Quick Start

### Prerequisites

- A local proxy (e.g., Clash, V2Ray) is running and local Antigravity AI features work normally
- A Linux remote server (`x86_64/amd64`; `arm64` is experimentally supported)

### Installation (via VSIX)

Download the latest `.vsix` from this repository's Releases page (or build locally with `npm ci && npm run package && npx vsce package`).

> **Windows Note**: Do **not** double-click the `.vsix` file in Explorer (that launches Visual Studio Installer). Install it from inside Antigravity IDE instead.

1. **Local Setup**
   - Open a local Antigravity IDE window → `Ctrl+Shift+X` → click `...` in the top-right of Extensions → **Install from VSIX...** → select the `.vsix` file.
   - Click **ATP** in the status bar and make sure `localProxyPort` matches your local proxy port (e.g., `7890`) with forwarding enabled.
2. **Remote Setup**
   - Connect to your remote Linux server via Remote-SSH from the local window (or add `RemoteForward 7890 127.0.0.1:7890` to your host in `~/.ssh/config`).
   - In the remote window, open Extensions → `...` → **Install from VSIX...** (click **Show Local** in the file picker) and install the same `.vsix`.
3. **Reload & Verify**
   - On a fresh server, click **Reload Now** (or **Try again** in the sidebar) if the initial `agy` download timed out; once `agy` finishes downloading, ATP will wrap and restart `agy --hub` automatically.
   - Open the **ATP** panel and run **Diagnostics** to confirm forwarding, wrapper, process proxy, and external connectivity are all green.

---

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `enableLocalForwarding` | Manage `~/.ssh/config.antigravity` for SSH reverse forwarding | `true` |
| `localProxyPort` | Local proxy port on your machine | `7890` |
| `remoteProxyHost` | Proxy host address on the remote server | `127.0.0.1` |
| `remoteProxyPort` | Remote SSH tunnel listening port | `7890` |
| `proxyType` | Proxy protocol (`http` or `socks5`) | `http` |
| `syncRemoteHttpProxy` | Auto-sync remote IDE `http.proxy` for initial `agy` downloads | `true` |
| `showStatusOnStartup` | Show startup status notification on remote connection | `true` |

---

## Troubleshooting

Check the `Antigravity` and `Antigravity SSH Proxy` channels in the Output panel, and verify on the remote server:

```bash
# 1. Verify reverse tunnel and external connectivity
ss -tlnp | grep 7890
curl -I -x http://127.0.0.1:7890 https://www.google.com

# 2. Verify agy --hub process and its proxy environment variables (Antigravity 2.x+)
ps aux | grep -E "bin/agy|language_server" | grep -v grep
for p in $(pgrep -f "bin/agy.*--hub"); do tr '\0' '\n' < /proc/$p/environ | grep -i proxy; done
```

---

## Uninstall

Before uninstalling, run **Antigravity SSH Proxy: Rollback Remote Environment** (or click Rollback in the ATP panel) to restore `~/.gemini/bin/agy` (or legacy `language_server`) and clear the managed `http.proxy`.

---

## Acknowledgements

- [dinobot22/antigravity-ssh-proxy](https://github.com/dinobot22/antigravity-ssh-proxy): Upstream original repository.
- [wang-muhan/antigravity-interface](https://github.com/wang-muhan/antigravity-interface): Original extension implementation.
- [graftcp](https://github.com/hmgle/graftcp): Core process proxying for legacy backends.
