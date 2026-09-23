/**
 * dsh-session-tg-notify — 屏幕锁定探测（macOS）。
 *
 * 「人在不在」在 macOS 上没有标准 API 给 Node 用，可靠且零权限的做法是读
 * IOKit 的 console user 信息：
 *
 *   主信号：ioreg -n Root -d1 -a  →  IOConsoleUsers[].CGSSessionScreenIsLocked
 *           该键**只在锁屏时出现**（未锁屏时整个键不存在），所以「键缺失 = 未锁定」。
 *   兜底：pgrep -x ScreenSaverEngine —— 屏保/锁屏界面进程在跑也算「离开了」。
 *         仅在主信号不可用时使用，避免把纯屏保误报成锁屏而覆盖真实判断。
 *
 * 只跑在 darwin 上；其他平台返回 supported:false，调用方据此退化为「未锁定」，
 * 不会把通知永久吞掉。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 4000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * 从 `ioreg -a` 的 plist XML 里解析锁屏状态。
 *
 * 不引入 plist 依赖：只需要一个布尔键，正则足够且不会因 XML 结构变化而整体失败。
 * ioreg 的 plist 是扁平的 `<key>K</key><true/>` 序列，没有同名嵌套。
 *
 * @returns true / false，解析不出结构时返回 null（调用方转兜底信号）。
 */
export function parseScreenLocked(xml) {
	if (typeof xml !== 'string' || xml.length === 0) return null;
	if (!xml.includes('IOConsoleUsers')) return null;
	// 多个 console user 时只要有一个锁定即视为锁定（取最保守的判断）
	const matches = [...xml.matchAll(/<key>CGSSessionScreenIsLocked<\/key>\s*<(true|false)\s*\/>/g)];
	if (matches.length === 0) return false; // 键缺失 = 未锁定
	return matches.some((m) => m[1] === 'true');
}

/**
 * 读取当前是否锁屏。
 * @returns { supported: boolean, locked: boolean, signal: string, error?: string }
 */
export async function readScreenLocked(options = {}) {
	const platform = options.platform ?? process.platform;
	const exec = options.execFile ?? execFileAsync;
	if (platform !== 'darwin') return { supported: false, locked: false, signal: 'unsupported' };

	try {
		const { stdout } = await exec('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1', '-a'], {
			timeout: TIMEOUT_MS,
			maxBuffer: MAX_BUFFER
		});
		const locked = parseScreenLocked(String(stdout));
		if (locked !== null) return { supported: true, locked, signal: 'ioreg' };
	} catch (error) {
		// 落到兜底信号；把原因带出去便于排查
		return readScreensaverFallback(exec, error?.message);
	}
	return readScreensaverFallback(exec, 'ioreg 输出里没有 IOConsoleUsers');
}

/** 兜底：屏保/锁屏界面进程是否在跑。pgrep 无匹配时退出码为 1，属正常「未锁定」。 */
async function readScreensaverFallback(exec, reason) {
	try {
		const { stdout } = await exec('/usr/bin/pgrep', ['-x', 'ScreenSaverEngine'], { timeout: TIMEOUT_MS });
		return { supported: true, locked: String(stdout).trim().length > 0, signal: 'screensaver', note: reason };
	} catch (error) {
		if (error?.code === 1) return { supported: true, locked: false, signal: 'screensaver', note: reason };
		return { supported: false, locked: false, signal: 'error', error: error?.message ?? String(error), note: reason };
	}
}
