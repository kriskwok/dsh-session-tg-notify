/**
 * dsh-session-tg-notify — 配置模块。
 *
 * 配置来源优先级：Cordis 配置（cordis.yml 的 config）> 持久化文件 > 内置默认值。
 * 持久化文件默认位于 `~/.config/dsh/session-notify.json`，可用环境变量
 * `DSH_SESSION_NOTIFY_CONFIG` 覆盖路径。Web 设置页写入的就是这份文件，
 * 因此运行时可改、无需重启 DSH。
 *
 * 本模块不依赖 @deepseek-ai/schemastery：插件以 `link:` 方式安装时
 * pnpm 不会安装被链接包自身的依赖，零依赖可以让安装更稳。代价是配置
 * 校验由本模块自己完成（sanitizeConfig），非法字段逐项回退默认值。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 支持通知的会话事件种类。 */
export const EVENT_KINDS = Object.freeze(['complete', 'approval', 'question', 'block', 'error']);

/** 事件种类 → 中文显示名（设置页与会话通知共用）。 */
export const EVENT_LABELS = Object.freeze({
	complete: '会话完成',
	approval: '需要审批',
	question: '需要回答',
	block: '目标受阻',
	error: '运行出错'
});

/** 事件种类 → 通知 emoji 前缀。 */
export const EVENT_EMOJI = Object.freeze({
	complete: '✅',
	approval: '🔐',
	question: '❓',
	block: '⚠️',
	error: '✗'
});

/** 可选提示音（浏览器端 Web Audio 合成，不需要素材文件）。 */
export const TONES = Object.freeze(['ding', 'alert', 'chime', 'none']);

/** 默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	/** complete 事件的最短 turn 时长（秒），低于此值不通知，避免短任务刷屏。 */
	minDuration: 10,
	events: Object.freeze({
		complete: Object.freeze({ desktop: true, telegram: false }),
		approval: Object.freeze({ desktop: true, telegram: true }),
		question: Object.freeze({ desktop: true, telegram: true }),
		block: Object.freeze({ desktop: true, telegram: false }),
		error: Object.freeze({ desktop: true, telegram: false })
	}),
	desktop: Object.freeze({
		enabled: true,
		sound: true,
		tone: 'ding'
	}),
	telegram: Object.freeze({
		enabled: false,
		botToken: '',
		chatId: '',
		apiBase: 'https://api.telegram.org',
		/**
		 * 页面在后台**且屏幕已锁定**时，是否在桌面通知之外再补一条 Telegram。
		 * 注意不是「一切后台」：切到别的应用也会让页面失焦，那种情况不推手机，
		 * 否则人还在电脑前就被手机反复打扰。
		 */
		notifyWhenLocked: false
	}),
	/**
	 * 焦点信息（可见性/是否聚焦）的有效期。超过就当作「焦点未知」，退化为后台；
	 * 但**不影响**在线判定 —— 在线只看 SSE 连接是否存在。
	 * 取 90s 是为了容忍浏览器对后台标签页的定时器节流（隐藏超 5 分钟后约 1 次/分钟）。
	 */
	presenceTtlMs: 90000
});

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/** 深拷贝默认配置。 */
export function cloneDefaults() {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/** 从任意输入中挑出当前支持的字段并做类型收敛，缺失/非法一律回退默认值。 */
export function sanitizeConfig(raw, defaults = DEFAULT_CONFIG) {
	const input = isPlainObject(raw) ? raw : {};
	const out = cloneDefaults();

	if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
	if (Number.isFinite(input.minDuration) && input.minDuration >= 0) out.minDuration = input.minDuration;
	if (Number.isFinite(input.presenceTtlMs) && input.presenceTtlMs >= 5000) out.presenceTtlMs = input.presenceTtlMs;

	const events = isPlainObject(input.events) ? input.events : {};
	for (const kind of EVENT_KINDS) {
		const base = defaults.events[kind];
		const value = isPlainObject(events[kind]) ? events[kind] : {};
		out.events[kind] = {
			desktop: typeof value.desktop === 'boolean' ? value.desktop : base.desktop,
			telegram: typeof value.telegram === 'boolean' ? value.telegram : base.telegram
		};
	}

	const desktop = isPlainObject(input.desktop) ? input.desktop : {};
	if (typeof desktop.enabled === 'boolean') out.desktop.enabled = desktop.enabled;
	if (typeof desktop.sound === 'boolean') out.desktop.sound = desktop.sound;
	if (TONES.includes(desktop.tone)) out.desktop.tone = desktop.tone;

	const telegram = isPlainObject(input.telegram) ? input.telegram : {};
	if (typeof telegram.enabled === 'boolean') out.telegram.enabled = telegram.enabled;
	if (typeof telegram.botToken === 'string') out.telegram.botToken = telegram.botToken.trim();
	if (typeof telegram.chatId === 'string') out.telegram.chatId = telegram.chatId.trim();
	if (nonEmptyString(telegram.apiBase)) out.telegram.apiBase = telegram.apiBase.trim().replace(/\/+$/, '');
	// 新键优先；旧键 notifyWhenBackground 作为迁移来源（语义已收紧为「且锁屏」）。
	if (typeof telegram.notifyWhenLocked === 'boolean') {
		out.telegram.notifyWhenLocked = telegram.notifyWhenLocked;
	} else if (typeof telegram.notifyWhenBackground === 'boolean') {
		out.telegram.notifyWhenLocked = telegram.notifyWhenBackground;
	}

	return out;
}

/** 递归深合并（over 覆盖 base，undefined 跳过）。 */
function deepMerge(base, over) {
	const out = { ...base };
	for (const key of Object.keys(over)) {
		const value = over[key];
		if (value === undefined) continue;
		out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
	}
	return out;
}

/**
 * 把绝对路径收敛成 `~/...` 形式，用于任何会展示给用户的地方（设置面板、日志）。
 * 面板里直接打印绝对路径会把用户名写进界面，截图/分享时就泄漏了。
 */
export function displayPath(path, home = homedir()) {
	if (typeof path !== 'string' || path.length === 0) return '';
	if (typeof home === 'string' && home.length > 1 && path.startsWith(`${home}/`)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** 配置文件路径：环境变量优先，否则 `~/.config/dsh/session-notify.json`。 */
export function defaultConfigPath(env = process.env, home = homedir()) {
	const override = env?.DSH_SESSION_NOTIFY_CONFIG;
	return nonEmptyString(override) ? override : join(home, '.config', 'dsh', 'session-notify.json');
}

/** 读取持久化配置；文件缺失/损坏时回退默认值并返回 warning。 */
export function loadFileConfig(path) {
	try {
		const text = readFileSync(path, 'utf8');
		return { value: sanitizeConfig(JSON.parse(text)), warning: null };
	} catch (error) {
		if (error?.code === 'ENOENT') return { value: cloneDefaults(), warning: null };
		return { value: cloneDefaults(), warning: `[session-notify] 配置读取失败（回退默认值）: ${path}: ${error?.message ?? error}` };
	}
}

/**
 * 原子写入配置（临时文件 + rename），文件权限 0600 —— 内含 Telegram Bot Token。
 * @returns 写入的内容。
 */
export function saveConfig(path, config) {
	const text = `${JSON.stringify(config, null, 2)}\n`;
	const tmp = `${path}.${process.pid}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
	return config;
}

/**
 * 合并配置层：文件配置为 base，Cordis 显式配置覆盖它，最后 sanitize 兜底。
 * @param cordisConfig - Cordis 传入的配置（可能为空对象）。
 */
export function resolveConfig(cordisConfig, path) {
	const file = loadFileConfig(path);
	const explicit = isPlainObject(cordisConfig) ? cordisConfig : {};
	const merged = sanitizeConfig(deepMerge(file.value, explicit));
	return { config: merged, warning: file.warning, path };
}

/**
 * 把设置页提交的局部补丁应用到当前配置上（深合并 + sanitize），返回新配置。
 * 只接受已知字段；未知键被 sanitizeConfig 丢弃。
 */
export function applyPatch(current, patch) {
	return sanitizeConfig(deepMerge(current, isPlainObject(patch) ? patch : {}));
}

/** 对外暴露配置时隐去 Bot Token（只报告是否已配置）。 */
export function redactConfig(config) {
	return {
		...config,
		telegram: {
			...config.telegram,
			botToken: '',
			hasBotToken: nonEmptyString(config.telegram.botToken)
		}
	};
}
