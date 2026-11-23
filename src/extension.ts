import * as vscode from 'vscode';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generateSetupScript, generateRollbackScript } from './remoteSetup';
import { StatusManager } from './statusManager';
import { DiagnosticPanel } from './diagnostics/diagnosticPanel';
import { TrafficPanel } from './traffic/trafficPanel';

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;
let statusManager: StatusManager;
let diagnosticPanel: DiagnosticPanel;
let trafficPanel: TrafficPanel;

function log(message: string): void {
	const timestamp = new Date().toISOString();
	const location = isRunningLocally() ? '[LOCAL]' : '[REMOTE]';
	outputChannel?.appendLine(`${timestamp} ${location} ${message}`);
}

function isRunningLocally(): boolean {
	return !vscode.env.remoteName;
}

async function checkPortAvailable(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(1000);
		socket.on('connect', () => { socket.destroy(); resolve(true); });
		socket.on('timeout', () => { socket.destroy(); resolve(false); });
		socket.on('error', () => { socket.destroy(); resolve(false); });
		socket.connect(port, host);
	});
}

/**
 * Check if mgraftcp is currently running (i.e., Language Server is using proxy)
 */
async function isMgraftcpRunning(): Promise<boolean> {
	try {
		const { stdout } = await execAsync('pgrep -f mgraftcp');
		return stdout.trim().length > 0;
	} catch {
		// pgrep returns non-zero if no process found
		return false;
	}
}

/**
 * Check if a running process has HTTP_PROXY / HTTPS_PROXY configured in its environment.
 */
async function isProcessUsingEnvProxy(pid: number): Promise<boolean> {
	try {
		const envBuf = await fs.readFile(`/proc/${pid}/environ`);
		const envEntries = envBuf.toString('utf-8').split('\0');
		return envEntries.some(entry =>
			entry.startsWith('HTTPS_PROXY=') ||
			entry.startsWith('HTTP_PROXY=') ||
			entry.startsWith('https_proxy=') ||
			entry.startsWith('http_proxy=')
		);
	} catch {
		return false;
	}
}

/**
 * Get Antigravity backend process info (AGY 2.x+ hub or legacy language_server_linux).
 * Returns PID, whether it's persistent, whether it's using proxy, and backend kind.
 */
async function getLanguageServerProcess(): Promise<{ pid: number; isPersistent: boolean; isUsingProxy: boolean; kind: 'agy' | 'legacy' } | null> {
	// 1. Check Antigravity 2.x+ backend: ~/.gemini/bin/agy --hub
	try {
		const { stdout } = await execAsync('ps aux | grep -E "bin/agy(\\.bak)?[[:space:]].*--hub" | grep -v grep');
		const lines = stdout.trim().split('\n').filter(l => l.length > 0);
		for (const line of lines) {
			const parts = line.split(/\s+/);
			if (parts.length >= 2) {
				const pid = parseInt(parts[1]);
				if (!isNaN(pid)) {
					const isUsingProxy = await isProcessUsingEnvProxy(pid);
					return {
						pid,
						isPersistent: true,
						isUsingProxy,
						kind: 'agy'
					};
				}
			}
		}
	} catch {
		// No agy --hub process found, fall through to legacy check
	}

	// 2. Fallback: legacy Antigravity 1.x language_server_linux
	try {
		const { stdout } = await execAsync('ps aux | grep language_server_linux | grep -v grep');
		const lines = stdout.trim().split('\n').filter(l => l.length > 0);
		
		// First pass: check if mgraftcp is wrapping the LS (indicates proxy is active)
		const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp'));
		
		// Second pass: find the actual LS process (not the mgraftcp line)
		for (const line of lines) {
			// Skip the mgraftcp wrapper line, we want the actual LS binary
			if (line.includes('mgraftcp-fakedns')) {
				continue;
			}
			
			// Look for the actual language_server process (either direct or .bak)
			if (line.includes('language_server_linux')) {
				const parts = line.split(/\s+/);
				if (parts.length >= 2) {
					const pid = parseInt(parts[1]);
					const isPersistent = line.includes('--persistent_mode') || line.includes('persistent_mode');
					
					if (!isNaN(pid)) {
						return { 
							pid, 
							isPersistent, 
							isUsingProxy: hasMgraftcpWrapper,
							kind: 'legacy'
						};
					}
				}
			}
		}
	} catch {
		// No process found
	}
	return null;
}

/**
 * Kill Language Server process to force restart through wrapper
 * This is needed when LS is running in persistent_mode and was started before wrapper was configured
 */
async function killLanguageServer(): Promise<boolean> {
	const lsProcess = await getLanguageServerProcess();
	if (!lsProcess) {
		log('No Language Server process found to kill');
		return false;
	}
	
	try {
		log(`Killing Language Server process (PID: ${lsProcess.pid}, persistent: ${lsProcess.isPersistent})`);
		await execAsync(`kill ${lsProcess.pid}`);
		
		// Wait a bit for process to terminate
		await new Promise(resolve => setTimeout(resolve, 1000));
		
		// Verify it's gone
		const stillRunning = await getLanguageServerProcess();
		if (stillRunning && stillRunning.pid === lsProcess.pid) {
			log('Process still running, using SIGKILL');
			await execAsync(`kill -9 ${lsProcess.pid}`);
		}
		
		log('Language Server process killed successfully');
		return true;
	} catch (error) {
		log(`Failed to kill Language Server: ${error}`);
		return false;
	}
}

/**
 * Show reload window prompt with optional auto-reload after timeout
 */
function promptReloadWindow(message: string): void {
	vscode.window.showInformationMessage(
		message,
		'Reload Now',
		'Later'
	).then(selection => {
		if (selection === 'Reload Now') {
			vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

const ANTIGRAVITY_FILENAME = 'config.antigravity';
const INCLUDE_LINE = `Include ${ANTIGRAVITY_FILENAME}`;

/**
 * Get path to SSH config directory based on platform
 */
function getSSHDir(): string {
	return path.join(os.homedir(), '.ssh');
}

/**
 * Get path to the main SSH config file
 */
function getSSHConfigPath(): string {
	return path.join(getSSHDir(), 'config');
}

/**
 * Get path to our custom SSH config file
 */
function getAntigravityConfigPath(): string {
	return path.join(getSSHDir(), ANTIGRAVITY_FILENAME);
}

/**
 * Update the SSH config files using the Include approach
 */
async function updateSSHConfigFile(remotePort: number, localPort: number, enable: boolean): Promise<void> {
	const mainConfigPath = getSSHConfigPath();
	const antiConfigPath = getAntigravityConfigPath();

	try {
		// Ensure .ssh directory exists
		await fs.mkdir(getSSHDir(), { recursive: true });

		if (enable) {
			// 1. Create/Update the config.antigravity file
			const antiContent = [
				'# Antigravity SSH Proxy Configuration',
				`# Generated at: ${new Date().toISOString()}`,
				'Match all',
				`    RemoteForward ${remotePort} 127.0.0.1:${localPort}`,
				'    ExitOnForwardFailure no',
				'    VisualHostKey no',
				'',
			].join('\n');
			await fs.writeFile(antiConfigPath, antiContent, 'utf-8');
			log(`Updated ${antiConfigPath}`);

			// 2. Ensure Include line exists in main config
			let mainContent = '';
			try {
				mainContent = await fs.readFile(mainConfigPath, 'utf-8');
			} catch (e) { /* ignore if doesn't exist */ }

			if (!mainContent.includes(INCLUDE_LINE)) {
				// Prepend to the top for maximum compatibility
				mainContent = `${INCLUDE_LINE}\n${mainContent}`;
				await fs.writeFile(mainConfigPath, mainContent, 'utf-8');
				log(`Added Include line to ${mainConfigPath}`);
			}
		} else {
			// 1. Remove Include line from main config
			try {
				let mainContent = await fs.readFile(mainConfigPath, 'utf-8');
				if (mainContent.includes(INCLUDE_LINE)) {
					// Simply remove the Include line (we're the only one who writes it)
					mainContent = mainContent.replace(`${INCLUDE_LINE}\n`, '');
					mainContent = mainContent.replace(INCLUDE_LINE, ''); // fallback if no trailing newline
					await fs.writeFile(mainConfigPath, mainContent, 'utf-8');
					log(`Removed Include line from ${mainConfigPath}`);
				}
			} catch (e) { /* ignore */ }

			// 2. Delete the config.antigravity file
			try {
				await fs.unlink(antiConfigPath);
				log(`Deleted ${antiConfigPath}`);
			} catch (e) { /* ignore if already gone */ }
		}

		log(`SSH config updated (enable=${enable})`);
	} catch (error) {
		log(`SSH config update error: ${error}`);
		throw error;
	}
}

/**
 * Check if the forwarding is enabled by looking at the Include line and the sub-config
 */
async function getSSHConfigStatus(): Promise<{ enabled: boolean; port?: number }> {
	try {
		const mainContent = await fs.readFile(getSSHConfigPath(), 'utf-8');
		if (mainContent.includes(INCLUDE_LINE)) {
			const antiContent = await fs.readFile(getAntigravityConfigPath(), 'utf-8');
			const match = antiContent.match(/RemoteForward\s+(\d+)\s+(?:localhost|127\.0\.0\.1):/);
			if (match) {
				return { enabled: true, port: parseInt(match[1]) };
			}
		}
	} catch {
		// Files don't exist
	}
	return { enabled: false };
}

export function activate(context: vscode.ExtensionContext) {
	// 创建专用的 Output Channel
	outputChannel = vscode.window.createOutputChannel('Antigravity SSH Proxy');
	context.subscriptions.push(outputChannel);

	log(`Activating... isLocal=${isRunningLocally()}`);

	// 初始化状态管理器
	statusManager = new StatusManager(isRunningLocally(), context);
	context.subscriptions.push(statusManager);

	// 初始化诊断面板
	diagnosticPanel = new DiagnosticPanel(context);
	context.subscriptions.push({ dispose: () => diagnosticPanel.dispose() });

	// 初始化流量面板
	trafficPanel = new TrafficPanel(context);
	context.subscriptions.push({ dispose: () => trafficPanel.dispose() });

	// 注册显示输出窗口的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showOutput', () => {
			outputChannel.show();
		})
	);

	// 注册显示状态面板的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showStatusPanel', () => {
			statusManager.showStatusPanel();
		})
	);

	// 注册刷新状态的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.refreshStatus', async () => {
			await statusManager.refreshStatus();
		})
	);

	// 注册诊断命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.diagnose', async () => {
			await diagnosticPanel.show();
		})
	);

	// 注册流量监控命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showTrafficPanel', () => {
			trafficPanel.show();
		})
	);

	// 启动自动刷新状态
	statusManager.startAutoRefresh();

	if (isRunningLocally()) {
		activateLocal(context).catch(err => log(`activateLocal error: ${err}`));
	} else {
		activateRemote(context).catch(err => log(`activateRemote error: ${err}`));
	}
}

async function activateLocal(context: vscode.ExtensionContext) {
	// 设置配置变更回调（用于面板中修改配置时触发）
	statusManager.setConfigChangeCallback(async () => {
		const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
		const lp = cfg.get<number>('localProxyPort', 7890);
		const rp = cfg.get<number>('remoteProxyPort', 7890);
		const enabled = cfg.get<boolean>('enableLocalForwarding', true);
		await updateSSHConfigFile(rp, lp, enabled);
		statusManager.updateSSHConfigStatus(enabled, rp);
	});

	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	const enable = config.get<boolean>('enableLocalForwarding', true);
	const localPort = config.get<number>('localProxyPort', 7890);
	const remotePort = config.get<number>('remoteProxyPort', 7890);

	log(`Config: enable=${enable}, localPort=${localPort}, remotePort=${remotePort}`);

	// Auto-setup on activation
	if (enable) {
		await updateSSHConfigFile(remotePort, localPort, true);
		statusManager.updateSSHConfigStatus(true, remotePort);
		if (!await checkPortAvailable('127.0.0.1', localPort)) {
			vscode.window.showWarningMessage(
				`Local proxy at 127.0.0.1:${localPort} is not running. ` +
				`Also check if port ${remotePort} is occupied on the remote server before reconnecting.`
			);
		}
	}

	// 初始刷新状态
	await statusManager.refreshStatus();

	// 同步初始 SSH 配置状态
	const initialStatus = await getSSHConfigStatus();
	statusManager.updateSSHConfigStatus(initialStatus.enabled, initialStatus.port);

	// Watch config changes (from VS Code settings)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('antigravity-ssh-proxy')) {
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const lp = cfg.get<number>('localProxyPort', 7890);
				const rp = cfg.get<number>('remoteProxyPort', 7890);
				const enabled = cfg.get<boolean>('enableLocalForwarding', true);
				await updateSSHConfigFile(rp, lp, enabled);
				statusManager.updateSSHConfigStatus(enabled, rp);
				await statusManager.refreshStatus();
			}
		})
	);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.enableForwarding', async () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const lp = cfg.get<number>('localProxyPort', 7890);
			const rp = cfg.get<number>('remoteProxyPort', 7890);
			await updateSSHConfigFile(rp, lp, true);
			statusManager.updateSSHConfigStatus(true, rp);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage('SSH port forwarding enabled');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.disableForwarding', async () => {
			await updateSSHConfigFile(0, 0, false);
			statusManager.updateSSHConfigStatus(false);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage('SSH port forwarding disabled');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.tunnelStatus', async () => {
			const status = await getSSHConfigStatus();
			statusManager.updateSSHConfigStatus(status.enabled, status.port);
			vscode.window.showInformationMessage(
				status.enabled
					? `Forwarding configured on port: ${status.port}`
					: 'SSH port forwarding is not configured'
			);
		})
	);
}

/**
 * Ensure mgraftcp binary has execute permission
 */
async function ensureMgraftcpExecutable(extensionPath: string): Promise<void> {
	const arch = os.arch();
	let binaryName: string;

	switch (arch) {
		case 'x64':
		case 'amd64':
			binaryName = 'mgraftcp-fakedns-linux-amd64';
			break;
		case 'arm64':
		case 'aarch64':
			binaryName = 'mgraftcp-fakedns-linux-arm64';
			break;
		default:
			log(`Unsupported architecture: ${arch}`);
			return;
	}

	const mgraftcpPath = path.join(extensionPath, 'resources', 'bin', binaryName);

	try {
		await execAsync(`chmod +x "${mgraftcpPath}"`);
		log(`Set execute permission for ${mgraftcpPath}`);
	} catch (error) {
		log(`Failed to set execute permission for mgraftcp: ${error}`);
	}
}

/**
 * Sync remote IDE http.proxy / http.proxySupport settings so the remote extensionHost
 * (Node.js) can download the Antigravity backend (~/.gemini/bin/agy) on fresh servers.
 */
async function syncRemoteHttpProxy(proxyHost: string, proxyPort: number, proxyType: string): Promise<boolean> {
	const atpConfig = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	const shouldSync = atpConfig.get<boolean>('syncRemoteHttpProxy', true);
	if (!shouldSync) {
		return false;
	}

	const proxyUrl = `${proxyType === 'socks5' ? 'socks5' : 'http'}://${proxyHost}:${proxyPort}`;
	const httpConfig = vscode.workspace.getConfiguration('http');
	const currentProxy = httpConfig.get<string>('proxy', '');
	const currentSupport = httpConfig.get<string>('proxySupport', 'override');
	let changed = false;

	try {
		if (currentProxy !== proxyUrl) {
			await httpConfig.update('proxy', proxyUrl, vscode.ConfigurationTarget.Global);
			log(`Synced remote http.proxy to ${proxyUrl}`);
			changed = true;
		}
		if (currentSupport !== 'on' && currentSupport !== 'override') {
			await httpConfig.update('proxySupport', 'override', vscode.ConfigurationTarget.Global);
			log(`Synced remote http.proxySupport to override`);
			changed = true;
		}
	} catch (error) {
		log(`Failed to sync remote http.proxy: ${error}`);
	}

	return changed;
}

/**
 * Clear remote http.proxy on rollback if it matches our configured proxy URL.
 */
async function clearRemoteHttpProxyIfManaged(proxyHost: string, proxyPort: number, proxyType: string): Promise<void> {
	const proxyUrl = `${proxyType === 'socks5' ? 'socks5' : 'http'}://${proxyHost}:${proxyPort}`;
	const httpConfig = vscode.workspace.getConfiguration('http');
	const currentProxy = httpConfig.get<string>('proxy', '');
	if (currentProxy === proxyUrl) {
		try {
			await httpConfig.update('proxy', undefined, vscode.ConfigurationTarget.Global);
			log(`Cleared managed remote http.proxy (${proxyUrl})`);
		} catch (error) {
			log(`Failed to clear remote http.proxy: ${error}`);
		}
	}
}

/**
 * Check whether a file is an unwrapped Linux ELF binary (starts with \x7fELF).
 */
async function isElfBinary(filePath: string): Promise<boolean> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(filePath, 'r');
		const header = Buffer.alloc(4);
		const { bytesRead } = await handle.read(header, 0, 4, 0);
		return bytesRead === 4 &&
			header[0] === 0x7f &&
			header[1] === 0x45 &&
			header[2] === 0x4c &&
			header[3] === 0x46;
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}

/**
 * Watch for ~/.gemini/bin/agy to finish downloading on a fresh remote server.
 * Once the ELF binary appears and is executable, automatically wrap it and restart agy --hub.
 */
function watchForAgyBinary(context: vscode.ExtensionContext, extensionPath: string): void {
	const agyPath = path.join(os.homedir(), '.gemini', 'bin', 'agy');
	const pollIntervalMs = 3000;
	const maxDurationMs = 10 * 60 * 1000; // 10 minutes
	const startedAt = Date.now();
	let busy = false;

	log(`Watching for Antigravity backend binary at ${agyPath}...`);

	const timer = setInterval(async () => {
		if (busy) {
			return;
		}
		if (Date.now() - startedAt > maxDurationMs) {
			clearInterval(timer);
			log('Stopped watching for ~/.gemini/bin/agy (timeout reached)');
			return;
		}

		busy = true;
		try {
			await fs.access(agyPath, fs.constants.X_OK);
			if (await isElfBinary(agyPath)) {
				// Wait briefly so any rename/write settles completely
				await new Promise(resolve => setTimeout(resolve, 1500));
				if (await isElfBinary(agyPath)) {
					clearInterval(timer);
					const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
					const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
					const port = cfg.get<number>('remoteProxyPort', 7890);
					const type = cfg.get<string>('proxyType', 'http');
					log(`Detected downloaded ELF binary at ${agyPath}, running setup...`);
					const success = await runSetupScriptSilently(host, port, type, extensionPath);
					statusManager.updateLanguageServerStatus(success);
					await statusManager.refreshStatus();
				}
			}
		} catch {
			// Binary not present or not executable yet
		} finally {
			busy = false;
		}
	}, pollIntervalMs);

	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function activateRemote(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	// Remote only cares about remoteProxyHost, remoteProxyPort, and proxyType
	const remoteHost = config.get<string>('remoteProxyHost', '127.0.0.1');
	const remotePort = config.get<number>('remoteProxyPort', 7890);
	const proxyType = config.get<string>('proxyType', 'http');

	if (process.platform !== 'linux') {
		log(`Skipping setup: unsupported platform '${process.platform}' (only Linux is supported)`);
		return;
	}

	// Use extensionUri.fsPath for correct remote path resolution
	const extensionPath = context.extensionUri.fsPath;

	// Ensure mgraftcp binary has execute permission before setup
	await ensureMgraftcpExecutable(extensionPath);

	// Sync remote IDE http.proxy so extensionHost itself can download ~/.gemini/bin/agy on fresh servers
	const httpProxySynced = await syncRemoteHttpProxy(remoteHost, remotePort, proxyType);

	// 设置配置变更回调（用于面板中修改配置时触发）
	statusManager.setConfigChangeCallback(async () => {
		const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
		const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
		const port = cfg.get<number>('remoteProxyPort', 7890);
		const type = cfg.get<string>('proxyType', 'http');
		log(`Config changed from panel, re-running setup: ${host}:${port} (${type})`);
		await syncRemoteHttpProxy(host, port, type);
		const success = await runSetupScriptSilently(host, port, type, extensionPath);
		statusManager.updateLanguageServerStatus(success);
	});

	log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);

	// 初始刷新状态
	await statusManager.refreshStatus();

	// Auto-run setup script
	log(`Extension path: ${extensionPath}`);
	log('Auto-running setup script...');
	const setupSuccess = await runSetupScriptSilently(remoteHost, remotePort, proxyType, extensionPath);
	statusManager.updateLanguageServerStatus(setupSuccess);

	// On fresh servers where ~/.gemini/bin/agy hasn't finished downloading yet, watch for it
	if (!setupSuccess) {
		watchForAgyBinary(context, extensionPath);
		if (httpProxySynced) {
			promptReloadWindow(
				`Remote http.proxy configured (${remoteHost}:${remotePort}) for downloading Antigravity backend. Reload window if backend download timed out.`
			);
		}
	}

	// Watch config changes (from VS Code settings)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyHost') ||
				e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyPort') ||
				e.affectsConfiguration('antigravity-ssh-proxy.proxyType') ||
				e.affectsConfiguration('antigravity-ssh-proxy.syncRemoteHttpProxy')) {
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
				const port = cfg.get<number>('remoteProxyPort', 7890);
				const type = cfg.get<string>('proxyType', 'http');
				log(`Config changed, re-running setup: ${host}:${port} (${type})`);
				await syncRemoteHttpProxy(host, port, type);
				const success = await runSetupScriptSilently(host, port, type, extensionPath);
				statusManager.updateLanguageServerStatus(success);
				await statusManager.refreshStatus();
			}
		})
	);

	// Remote commands
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.setup', async () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
			const port = cfg.get<number>('remoteProxyPort', 7890);
			const type = cfg.get<string>('proxyType', 'http');
			await syncRemoteHttpProxy(host, port, type);
			const terminal = vscode.window.createTerminal('Antigravity Setup');
			terminal.show();
			const script = generateSetupScript(host, port, type, extensionPath);
			terminal.sendText(`cat > /tmp/ag_setup.sh << 'EOF'\n${script}\nEOF`);
			terminal.sendText('bash /tmp/ag_setup.sh');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.rollback', async () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
			const port = cfg.get<number>('remoteProxyPort', 7890);
			const type = cfg.get<string>('proxyType', 'http');
			await clearRemoteHttpProxyIfManaged(host, port, type);
			const terminal = vscode.window.createTerminal('Antigravity Rollback');
			terminal.show();
			terminal.sendText(generateRollbackScript());
			statusManager.updateLanguageServerStatus(false);
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.checkProxy', async () => {
			const ok = await checkPortAvailable(remoteHost, remotePort);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage(ok ? `Proxy OK` : `Proxy NOT reachable`);
		})
	);

	// Show startup status notification if enabled
	const showStatusOnStartup = config.get<boolean>('showStatusOnStartup', true);
	if (showStatusOnStartup) {
		// Delay slightly to let setup complete
		setTimeout(async () => {
			await showStartupStatus(remoteHost, remotePort);
		}, 2000);
	}
}

/**
 * Show detailed warning when proxy is not reachable on the remote side.
 * Covers three possible causes: SSH tunnel not established, port mismatch, local proxy not running.
 */
async function showSSHTunnelNotEstablishedWarning(proxyHost: string, proxyPort: number): Promise<void> {
	const detailMessage =
		`Proxy not reachable at ${proxyHost}:${proxyPort}\n\n` +
		`This can happen for several reasons. Please check each one:\n\n` +
		`─── Cause 1: SSH tunnel not established ───\n` +
		`You may have connected directly via Antigravity's "Recent Connections"\n` +
		`without opening a local window first.\n` +
		`Fix:\n` +
		`  1. Close this remote connection\n` +
		`  2. Open a new local window (File > New Window)\n` +
		`  3. Connect to the remote server from the local window\n\n` +
		`─── Cause 2: Port mismatch ───\n` +
		`The "Remote Port" in the Local ATP panel must equal\n` +
		`the "Proxy Port" in the Remote ATP panel.\n` +
		`Fix:\n` +
		`  1. Open the ATP panel (click the status bar item)\n` +
		`  2. In the Local window: note the "Remote Port" value\n` +
		`  3. In the Remote window: set "Proxy Port" to the same value\n` +
		`  4. Save and reconnect\n\n` +
		`─── Cause 3: Local proxy software not running ───\n` +
		`The local proxy (e.g., Clash, V2Ray) may not be started,\n` +
		`or its port does not match the "Local Port" in the ATP panel.\n` +
		`Fix:\n` +
		`  1. Start your local proxy software\n` +
		`  2. Open the ATP panel and confirm "Local Port" matches your proxy's port\n` +
		`  3. Save and reconnect`;

	log('Showing proxy not reachable warning dialog');

	const selection = await vscode.window.showWarningMessage(
		detailMessage,
		{ modal: true },
		'Open ATP Panel',
		'Run Diagnostics',
		'Close Remote Connection',
		'Dismiss'
	);

	if (selection === 'Open ATP Panel') {
		vscode.commands.executeCommand('antigravity-ssh-proxy.showStatusPanel');
	} else if (selection === 'Run Diagnostics') {
		vscode.commands.executeCommand('antigravity-ssh-proxy.diagnose');
	} else if (selection === 'Close Remote Connection') {
		vscode.window.showInformationMessage(
			'After closing: 1) Open a new local window  2) Connect to remote from there',
			'Got it'
		).then(() => {
			vscode.commands.executeCommand('workbench.action.remote.close');
		});
	}
}

/**
 * Show startup status notification with detailed diagnostics in output channel
 */
async function showStartupStatus(proxyHost: string, proxyPort: number): Promise<void> {
	try {
		log('');
		log('========== Startup Status Check ==========');
		log(`Proxy endpoint: ${proxyHost}:${proxyPort}`);
		log('');

		// Test 1: Port connectivity
		log(`[Test 1] Checking port connectivity...`);
		log(`  Command: nc -zv ${proxyHost} ${proxyPort}`);
		const proxyReachable = await checkPortAvailable(proxyHost, proxyPort);
		log(`  Result: ${proxyReachable ? '✓ Port is reachable' : '✗ Port is NOT reachable'}`);
		log('');

		// Test 2: Backend proxy status (AGY env-proxy or legacy mgraftcp)
		log(`[Test 2] Checking backend proxy status...`);
		const mgraftcpRunning = await isMgraftcpRunning();
		const lsProcess = await getLanguageServerProcess();
		const proxyActive = mgraftcpRunning || Boolean(lsProcess?.kind === 'agy' && lsProcess.isUsingProxy);
		if (lsProcess?.kind === 'agy') {
			log(`  Result: ${lsProcess.isUsingProxy ? '✓ AGY Hub is running with env proxy (proxy active)' : '✗ AGY Hub is running WITHOUT proxy'}`);
		} else {
			log(`  Command: pgrep -f mgraftcp`);
			log(`  Result: ${mgraftcpRunning ? '✓ mgraftcp is running (proxy active)' : '✗ mgraftcp is NOT running'}`);
		}
		log('');

		// Test 2.5: Backend process status (always check for diagnostic purposes)
		log(`[Test 2.5] Checking Antigravity backend process status...`);
		if (lsProcess) {
			const backendName = lsProcess.kind === 'agy' ? 'AGY Hub' : 'Language Server';
			const modeLabel = lsProcess.kind === 'agy' ? 'hub mode' : (lsProcess.isPersistent ? 'persistent mode' : 'normal mode');
			const proxyLabel = lsProcess.isUsingProxy ? 'using proxy' : 'NOT using proxy';
			const statusIcon = lsProcess.isUsingProxy ? '✓' : (lsProcess.isPersistent ? '✗' : '⚠');
			log(`  Result: ${statusIcon} ${backendName} (PID ${lsProcess.pid}) is running in ${modeLabel}, ${proxyLabel}`);
			
			if (lsProcess.isPersistent && !lsProcess.isUsingProxy) {
				log(`  ⚠️ WARNING: ${backendName} was started before wrapper was configured!`);
				log(`    Will auto-fix by restarting backend process...`);
			}
		} else {
			log(`  Result: ○ Antigravity backend is not running (will start on demand)`);
		}
		log('');

		// Test 3: External connectivity (only if port is reachable)
		if (proxyReachable) {
			const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const currentProxyType = config.get<string>('proxyType', 'http');

			// Test HTTP proxy
			log(`[Test 3] Testing HTTP proxy connectivity...`);
			const httpCmd = `curl -I -x http://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 14`;
			log(`  Command: ${httpCmd}`);
			let httpOk = false;
			try {
				const { stdout } = await execAsync(httpCmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				httpOk = httpCode === '200' || httpCode === '204' || httpCode === '301' || httpCode === '302';
				const marker = currentProxyType === 'http' ? ' ← Current' : '';
				log(`  Result: HTTP ${httpCode} ${httpOk ? '✓ OK' : '✗ Failed'}${marker}`);
			} catch (error) {
				const marker = currentProxyType === 'http' ? ' ← Current (⚠️ NOT WORKING)' : '';
				log(`  Result: ✗ Failed${marker}`);
			}
			log('');

			// Test SOCKS5 proxy
			log(`[Test 4] Testing SOCKS5 proxy connectivity...`);
			const socks5Cmd = `curl -I -x socks5://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 14`;
			log(`  Command: ${socks5Cmd}`);
			let socks5Ok = false;
			try {
				const { stdout } = await execAsync(socks5Cmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				socks5Ok = httpCode === '200' || httpCode === '204' || httpCode === '301' || httpCode === '302';
				const marker = currentProxyType === 'socks5' ? ' ← Current' : '';
				log(`  Result: HTTP ${httpCode} ${socks5Ok ? '✓ OK' : '✗ Failed'}${marker}`);
			} catch (error) {
				const marker = currentProxyType === 'socks5' ? ' ← Current (⚠️ NOT WORKING)' : '';
				log(`  Result: ✗ Failed${marker}`);
			}
			log('');

			// Test SOCKS5H proxy (SOCKS5 with remote DNS resolution)
			log(`[Test 5] Testing SOCKS5H proxy connectivity (remote DNS)...`);
			const socks5hCmd = `curl -I -x socks5h://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 14`;
			log(`  Command: ${socks5hCmd}`);
			try {
				const { stdout } = await execAsync(socks5hCmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				const socks5hOk = httpCode === '200' || httpCode === '204' || httpCode === '301' || httpCode === '302';
				log(`  Result: HTTP ${httpCode} ${socks5hOk ? '✓ OK' : '✗ Failed'}`);
			} catch (error) {
				log(`  Result: ✗ Failed`);
			}
			log('');
		}

		log('==========================================');
		log('');

		let message: string;
		let actions: string[] = [];

		// Check LS process status - this is the authoritative check for whether proxy is actually working
		// Note: proxyActive (isMgraftcpRunning) might be true due to stale processes,
		// but lsProcess.isUsingProxy tells us if the CURRENT LS is actually using proxy
		const lsProcessForDecision = await getLanguageServerProcess();
		const lsActuallyUsingProxy = lsProcessForDecision?.isUsingProxy ?? false;
		const lsIsPersistent = lsProcessForDecision?.isPersistent ?? false;
		const lsNeedsRestart = lsProcessForDecision && lsIsPersistent && !lsActuallyUsingProxy;

		if (proxyReachable && lsActuallyUsingProxy) {
			// Everything is actually working - LS is using proxy
			message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
		} else if (proxyReachable && lsNeedsRestart) {
			// LS is in persistent mode but not using proxy - this is the bug scenario
			// Auto-fix by killing LS
			log('Startup: Detected persistent_mode LS not using proxy, auto-fixing...');
			
			const killed = await killLanguageServer();
			if (killed) {
				message = `🔄 Language Server restarted to enable proxy. Reloading...`;
				actions = ['Reload Now'];
				
				// Auto-reload after a short delay
				setTimeout(() => {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				}, 2000);
			} else {
				message = `⚠️ Proxy configured but Language Server needs manual restart.`;
				actions = ['Kill & Reload', 'Dismiss'];
			}
		} else if (proxyReachable && !proxyActive) {
			// Proxy is reachable, mgraftcp not running, LS might not be started yet or needs reload
			if (lsProcessForDecision && !lsActuallyUsingProxy) {
				// LS is running but not using proxy (non-persistent mode)
				message = `⚠️ Proxy configured but not active. Reload to enable.`;
				actions = ['Reload Now', 'Dismiss'];
			} else {
				// LS not running yet, or other state
				message = `⚠️ Proxy configured but not active. Reload to enable.`;
				actions = ['Reload Now', 'Dismiss'];
			}
		} else if (!proxyReachable) {
			// Proxy not reachable - likely SSH tunnel not established
			// This can happen when user directly connects to remote via Antigravity's memory feature
			log('Proxy not reachable - SSH tunnel may not be established');
			log('This can happen when connecting directly to remote without opening a local window first');

			// Show a detailed warning with explanation
			await showSSHTunnelNotEstablishedWarning(proxyHost, proxyPort);
			return;
		} else {
			message = `⚠️ Proxy status unknown`;
			actions = ['Run Diagnostics', 'Dismiss'];
		}

		log(`Startup status: ${message}`);

		if (actions.length > 0) {
			const selection = await vscode.window.showInformationMessage(message, ...actions);
			if (selection === 'Reload Now') {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			} else if (selection === 'Kill & Reload') {
				// Kill LS and reload
				await killLanguageServer();
				setTimeout(() => {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				}, 1000);
			} else if (selection === 'Run Diagnostics') {
				vscode.commands.executeCommand('antigravity-ssh-proxy.diagnose');
			} else if (selection === 'Close Remote') {
				// Close remote connection and return to local window
				vscode.commands.executeCommand('workbench.action.remote.close');
			}
		} else {
			// Just show a brief notification for success
			vscode.window.showInformationMessage(message);
		}
	} catch (error) {
		log(`Startup status check failed: ${error}`);
	}
}

/**
 * Run setup script silently in background (idempotent)
 * @returns true if setup was successful or already configured
 */
async function runSetupScriptSilently(proxyHost: string, proxyPort: number, proxyType: string, extensionPath: string): Promise<boolean> {
	const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');

	try {
		// Ensure script is executable
		await execAsync(`chmod +x "${scriptPath}"`);

		// Read extension version from package.json
		const packageJsonPath = path.join(extensionPath, 'package.json');
		let extensionVersion = 'unknown';
		try {
			const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
			const packageJson = JSON.parse(packageJsonContent);
			extensionVersion = packageJson.version || 'unknown';
		} catch (e) {
			log(`Failed to read package.json: ${e}`);
		}

		// Execute script directly with environment variables for proxy config
		const env = {
			...process.env,
			PROXY_HOST: proxyHost,
			PROXY_PORT: String(proxyPort),
			PROXY_TYPE: proxyType,
			EXTENSION_PATH: extensionPath,  // Current extension's exact path
			EXTENSION_VERSION: extensionVersion  // Extension version for update detection
		};

		const { stdout, stderr } = await execAsync(`bash "${scriptPath}" 2>&1`, { env });
		const output = stdout || stderr || '';

		log(`Setup output: ${output}`);

		// Check if this is a new configuration
		const isNewConfig = output.includes('Setup complete') ||
			(output.includes('configured') && !output.includes('Already configured'));

		if (isNewConfig) {
			// New configuration or version update - need to restart LS
			log('Setup: New configuration applied');
			
			// Check if LS is in persistent mode - if so, need to kill it first
			// Otherwise the new wrapper won't take effect even after reload
			const lsProcess = await getLanguageServerProcess();
			if (lsProcess && lsProcess.isPersistent) {
				log('Setup: LS is in persistent_mode, killing to apply new configuration');
				const killed = await killLanguageServer();
				if (killed) {
					promptReloadWindow(
						'Antigravity proxy updated. Language Server restarted. Please reload the window to reconnect.'
					);
				} else {
					vscode.window.showWarningMessage(
						'Proxy updated but Language Server needs restart. ' +
						'Run in terminal: kill $(pgrep -f language_server_linux) && then reload window.',
						'Reload Now'
					).then(selection => {
						if (selection === 'Reload Now') {
							vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
				}
			} else {
				// Non-persistent mode or LS not running - regular reload is fine
				promptReloadWindow(
					'Antigravity proxy configured. Reload window to apply changes to the language server.'
				);
			}
			return true;
		} else if (output.includes('Already configured')) {
			log('Setup: Already configured');

			// Check if Language Server is actually using the proxy
			// Use getLanguageServerProcess() as the authoritative check, not just isMgraftcpRunning()
			// because there might be stale mgraftcp processes
			const lsProcess = await getLanguageServerProcess();
			const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
			const lsIsPersistent = lsProcess?.isPersistent ?? false;
			
			if (lsProcess && !lsActuallyUsingProxy) {
				// Wrapper is configured but LS isn't using proxy (started before wrapper was set up)
				log('Setup: Proxy configured but LS not using it');
				
				if (lsIsPersistent) {
					// Persistent mode: LS won't restart on reload, need to kill it first
					log('Setup: Language Server is in persistent_mode, killing process to force restart through wrapper');
					
					const killed = await killLanguageServer();
					if (killed) {
						promptReloadWindow(
							'Language Server was restarted to enable proxy. Please reload the window to reconnect.'
						);
					} else {
						// Fallback to manual instructions
						vscode.window.showWarningMessage(
							'Proxy configured but Language Server needs restart. ' +
							'Run in terminal: kill $(pgrep -f language_server_linux) && then reload window.',
							'Reload Now'
						).then(selection => {
							if (selection === 'Reload Now') {
								vscode.commands.executeCommand('workbench.action.reloadWindow');
							}
						});
					}
				} else {
					// Non-persistent mode: regular reload should work
					log('Setup: Prompting reload');
					promptReloadWindow(
						'Proxy is configured but not active. Reload window to enable proxy for the language server.'
					);
				}
			} else if (lsActuallyUsingProxy) {
				log('Setup: Proxy is active, no reload needed');
			} else {
				// LS not running yet - this is fine, it will start with proxy when needed
				log('Setup: LS not running, will use proxy when started');
			}
			return true;
		}
		return false;
	} catch (error: unknown) {
		const err = error as { message?: string; stdout?: string; stderr?: string };
		log(`Setup error: ${err.message || error}`);
		if (err.stdout) { log(`stdout: ${err.stdout}`); }
		if (err.stderr) { log(`stderr: ${err.stderr}`); }
		return false;
	}
}

export async function deactivate() {
	if (statusManager) {
		statusManager.stopAutoRefresh();
	}
	if (isRunningLocally()) {
		try {
			await updateSSHConfigFile(0, 0, false);
		} catch (e) {
			log(`Cleanup during deactivation failed: ${e}`);
		}
	}
}
