/**
 * dsh-session-tg-notify — 宿主（node）半。
 *
 * 职责：
 *   1. 订阅会话事件，归一化成「一次通知」（events.js）；
 *   2. 依据浏览器前后台状态（presence.js）把通知投到两个通道：
 *        - 桌面：前台 → 页面内 toast；后台 → macOS 系统通知（点击天然切回该标签页）；
 *                离线 → 无处可发
 *        - Telegram：前台 → 永不；后台 → 需「订阅 TG 且开了后台同时推送」；离线 → 订阅了即发
 *   3. 暴露设置页所需的 HTTP API 与 SSE 通道（不改 DSH 核心）。
 *
 * 两个概念必须分清（这是本插件唯一需要理解的设计）：
 *   - **订阅**：设置页每行的「桌面」「TG」勾选框，表示"这个事件我愿意通过该通道收到"。
 *   - **通道**：全局开关与凭据（桌面通知权限 / Telegram 启用+Token+Chat ID）。
 *   只有「已订阅」且「通道就绪」且「当前网页状态该通道适用」三者同时成立才会发出。
 *   订阅了但通道没起来时，宿主会打印一条明确的 warning，而不是静默丢弃。
 *
 * 子代理会话不通知（events.js 的 isMainSession）。
 */
import { resolveConfig, defaultConfigPath, applyPatch, redactConfig, saveConfig, displayPath, EVENT_EMOJI, EVENT_LABELS } from './config.js';
import {
	createTurnTracker,
	createDedupe,
	classifyApproval,
	classifyQuestion,
	classifyTurnEnd,
	classifyGoalChange,
	classifyAgentError,
	workspaceName,
	oneLine
} from './events.js';
import { createPresenceHub } from './presence.js';
import { readScreenLocked } from './screenlock.js';
import { sendTelegram, getTelegramMe, getTelegramChats, getTelegramChat } from './telegram.js';

export const name = 'session-notify';
export const VERSION = '0.1.4';
/** 只消费事件与 webServer，不依赖其他服务。 */
export const inject = [];

/** 设置页需要知道的事件元数据。 */
const EVENT_META = Object.entries(EVENT_LABELS).map(([kind, label]) => ({ kind, label, emoji: EVENT_EMOJI[kind] }));

export function apply(ctx, cordisConfig = {}, options = {}) {
	const configPath = options.configPath ?? defaultConfigPath();
	let { config, warning } = resolveConfig(cordisConfig, configPath);
	if (warning) console.warn(warning);

	const hub = createPresenceHub({ ttlMs: config.presenceTtlMs });
	const turns = createTurnTracker();
	const dedupe = createDedupe();
	if (typeof ctx.effect === 'function') ctx.effect(() => () => hub.dispose(), 'session-notify presence hub');

	const send = options.sendTelegram ?? sendTelegram;

	// ------------------------------------------------------------ 锁屏探测
	/**
	 * 最近一次锁屏探测结果。锁屏只在「后台 + 订阅了 TG + 开了锁屏推送」这一种
	 * 组合下影响路由，所以平时不轮询、按需探测；设置页读取时也会强制探一次，
	 * 让面板上的状态行始终是实时的。
	 */
	const lockProbe = options.readScreenLocked ?? readScreenLocked;
	let lastScreen = { supported: null, locked: false, signal: 'unknown', at: 0 };

	const probeScreenLocked = async () => {
		const result = await lockProbe();
		lastScreen = { ...result, at: Date.now() };
		return lastScreen;
	};

	/**
	 * 诊断轮询：只在有页面连接时运行，且**只在锁屏状态发生变化时**打日志。
	 *
	 * 存在的理由很具体：我这个 agent 无法自己去锁你的屏幕，所以「锁屏分支到
	 * 底能不能识别」只能靠你锁一次、再回来查日志验证。日志里同时带上信号来源，
	 * 便于区分是 ioreg 命中还是屏保兜底。
	 */
	const lockPollMs = Number.isSafeInteger(options.lockPollMs) ? options.lockPollMs : 20000;
	if (lockPollMs > 0 && typeof ctx.effect === 'function') {
		ctx.effect(() => {
			let previous = null;
			const timer = setInterval(() => {
				if (hub.size === 0) return; // 页面没开时锁屏与否不影响路由
				void probeScreenLocked().then((next) => {
					if (previous !== null && next.locked !== previous) {
						console.log(`[session-notify] 锁屏状态变化: ${next.locked ? '已锁定' : '已解锁'}（信号：${next.signal}）`);
					}
					previous = next.locked;
				});
			}, lockPollMs);
			if (typeof timer.unref === 'function') timer.unref();
			return () => clearInterval(timer);
		}, 'session-notify lock poll');
	}

	/** 持久化修正后的配置（含运行时开关），失败只记日志、不影响通知。 */
	const persist = (next) => {
		config = next;
		try {
			saveConfig(configPath, config);
			return { ok: true };
		} catch (error) {
			const message = error?.message ?? String(error);
			console.warn(`[session-notify] 配置写入失败: ${message}`);
			return { ok: false, error: message };
		}
	};

	/**
	 * 组装最终通知文案（两个通道共用，保证 toast / 系统通知 / Telegram 完全一致）：
	 *   标题 = `{emoji} {事件类型}：{会话标题}`，标题缺失时省去「：…」
	 *   正文 = `{事件正文} 「{工作区名称}」`
	 */
	const compose = (kind, body, session) => {
		const emoji = EVENT_EMOJI[kind] ?? '';
		const label = EVENT_LABELS[kind] ?? kind;
		const workspace = session ? workspaceName(session) : '';
		const text = typeof body === 'string' ? body : '';
		return {
			// 标题只显示事件类型（「✅ 会话完成」）。会话标题不进通知 —— 它在
			// 通知里容易被截断且信息量低，点进去就能看到。
			title: `${emoji} ${label}`.trim(),
			body: workspace.length > 0 ? `${text} 「${workspace}」`.trim() : text
		};
	};

	/**
	 * Telegram 通道未就绪的原因（就绪返回 null）。
	 * 「行内勾选 TG」表达的是**订阅**，通道是否真的能用由启用开关 + 凭据决定。
	 */
	const telegramChannelIssue = () => {
		if (config.telegram.enabled !== true) return '未启用 Telegram 通道';
		if (config.telegram.botToken.trim().length === 0) return '缺少 Bot Token';
		if (config.telegram.chatId.trim().length === 0) return '缺少 Chat ID';
		return null;
	};

	/**
	 * 订阅（行内 TG 勾选）× 网页状态 → 是否发送 Telegram。
	 *
	 *   前台 → 永不（页面可见即视为已送达，不再打扰手机）
	 *   后台 → 仅当开了「网页后台且锁屏时推送」**且当前确实锁屏**
	 *   离线 → 直接发（页面都关了，这正是 Telegram 存在的意义）
	 *
	 * 后台这一档刻意要求「锁屏」而非「失焦」：切到别的应用也会让页面失焦，
	 * 那时人还在电脑前，推手机是纯打扰。锁屏才是「人走了」的可靠信号。
	 *
	 * 未订阅的行在三种状态下都不会发。通道本身是否启动由 telegramChannelIssue 判定。
	 */
	const shouldTelegram = (eventConfig, state, screenLocked) => {
		if (eventConfig.telegram !== true) return false;
		if (state === 'foreground') return false;
		if (state === 'background') return config.telegram.notifyWhenLocked === true && screenLocked === true;
		return true;
	};

	/**
	 * 路由并投递一次通知。
	 * @param notification - 分类器输出（kind / body / sessionId / dedupeKey / detail）。
	 * @param session - 对应会话；goal/error 这类没有会话上下文的事件传 null。
	 */
	const deliver = async (notification, session = null) => {
		if (!notification) return;
		const eventConfig = config.events[notification.kind];
		if (!config.enabled || !eventConfig) return;
		if (!dedupe.admit(notification.sessionId, notification.dedupeKey)) return;
		// 两个通道都没勾 → 用户明确不想被这个事件打扰。
		if (!eventConfig.desktop && !eventConfig.telegram) return;
		const composed = compose(notification.kind, notification.body, session);

		const presence = hub.snapshot();
		// 只有「后台 + 开了锁屏推送」这一种组合需要真的去问系统锁没锁，
		// 其余情况不付这次子进程开销。
		const needsLockProbe = presence.state === 'background' && eventConfig.telegram === true && config.telegram.notifyWhenLocked === true;
		const screen = needsLockProbe ? await probeScreenLocked() : null;

		// title 已含 emoji 与事件类型，body 末尾已带「工作区」——两端渲染时原样使用。
		const payload = {
			kind: notification.kind,
			title: composed.title,
			body: composed.body,
			// 供页面内 toast / 系统通知点击后直达对应会话
			sessionId: notification.sessionId ?? null,
			at: Date.now()
		};

		if (eventConfig.desktop && config.desktop.enabled && presence.state !== 'offline') {
			const frame = presence.state === 'foreground' ? 'toast' : 'webnotify';
			hub.sendTo(presence.targetClientId, frame, {
				...payload,
				tone: config.desktop.sound ? config.desktop.tone : 'none'
			});
		}

		if (shouldTelegram(eventConfig, presence.state, screen?.locked === true)) {
			const issue = telegramChannelIssue();
			if (issue !== null) {
				// 订阅了但通道没起来 —— 这是最容易让人困惑的情况，必须显式提示。
				console.warn(`[session-notify] 「${EVENT_LABELS[notification.kind] ?? notification.kind}」已订阅 Telegram，但通道未就绪（${issue}），本条已跳过`);
			} else {
				const result = await send(config.telegram, payload);
				if (!result.ok) console.warn(`[session-notify] Telegram 推送失败: ${result.error}`);
			}
		}

		const lockText = screen === null ? '' : ` 锁屏=${screen.locked ? '是' : '否'}(${screen.signal})`;
		console.log(`[session-notify] ${EVENT_EMOJI[notification.kind] ?? ''} ${notification.kind} (${presence.state}${lockText}) ${oneLine(notification.body, 80)}`);
	};

	// ---------------------------------------------------------------- 事件订阅
	const turns2 = turns;

	ctx.on('session/event', (session, event) => {
		const type = event?.type;
		// tool/call 必须先喂给 turn tracker，否则「最终文本之后没有新 tool/call」判定不完整。
		if (type === 'tool/call') turns2.onToolCall(session, event);

		const approval = classifyApproval(session, event);
		if (approval) {
			void deliver(approval, session);
			return;
		}
		const question = classifyQuestion(session, event);
		if (question) {
			void deliver(question, session);
			return;
		}

		if (type === 'turn/start') {
			turns2.onTurnStart(session, event);
			return;
		}
		if (type === 'user/message') {
			turns2.onUserMessage(session, event);
			return;
		}
		if (type === 'assistant/message') {
			turns2.onAssistantMessage(session, event);
			return;
		}
		if (type === 'turn/end') {
			const complete = classifyTurnEnd(session, turns2.onTurnEnd(session, event));
			if (!complete) return;
			const durationMs = complete.detail?.durationMs;
			// 时长过滤：短于 minDuration 的 turn 不打扰（未知时长按通过处理）。
			if (typeof durationMs === 'number' && durationMs < config.minDuration * 1000) return;
			void deliver(complete, session);
		}
	});

	ctx.on('goal/changed', ({ change }) => {
		const block = classifyGoalChange(change);
		if (block) void deliver(block);
	});

	ctx.on('agent/error', (payload) => {
		const error = classifyAgentError(payload);
		if (error) void deliver(error);
	});

	ctx.on('session/disposed', (session) => {
		turns2.onSessionDisposed(session);
		dedupe.forget(session?.id);
	});

	// ------------------------------------------------------------ HTTP + SSE
	ctx.inject(['webServer'], (webCtx) => {
		const readBody = async (req) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			return Buffer.concat(chunks).toString('utf8');
		};
		const json = (res, status, body) => {
			res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify(body));
		};
		const statePayload = () => ({
			config: redactConfig(config),
			presence: hub.snapshot(),
			// 面板的状态行要显示「锁屏推送」是否真的生效，所以这里带上实时锁屏状态
			screen: lastScreen,
			events: EVENT_META,
			// configPath 给 curl/运维用；configPathDisplay 是收敛成 ~/... 的版本，
			// 界面只允许用后者，避免把用户名渲染进 UI。
			configPath,
			configPathDisplay: displayPath(configPath),
			version: VERSION
		});

		webCtx.webServer.register({
			kind: 'prefix',
			path: '/session-notify',
			handler: async (req, res) => {
				const url = new URL(req.url ?? '/', 'http://session-notify');
				const endpoint = url.pathname.replace(/^\/session-notify\/?/, '') || 'state';
				try {
					// 跨站防护：本插件的路由不经 DSH 的 token 校验，因此显式拒绝
					// Origin 与 Host 不匹配的请求，避免任意网页在浏览器里替你改配置
					// 或发测试推送。注意这挡不住同网段的直接 curl —— 见 README 的安全说明。
					const origin = req.headers?.origin;
					const host = req.headers?.host;
					if (typeof origin === 'string' && origin.length > 0) {
						let originHost = null;
						try {
							originHost = new URL(origin).host;
						} catch {
							originHost = null;
						}
						if (originHost === null || originHost !== host) {
							return json(res, 403, { ok: false, error: 'cross-origin request rejected' });
						}
					}

					// SSE：同时是存活信号与通知下发通道。
					if (endpoint === 'events') {
						if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'use GET' });
						const clientId = url.searchParams.get('clientId') || `anon-${Date.now()}`;
						if (!hub.attach(clientId, res, { version: VERSION })) {
							return json(res, 503, { ok: false, error: 'too many connections' });
						}
						return;
					}

					if (endpoint === 'state' && req.method === 'GET') {
						// 面板打开时强制探一次锁屏，状态行才不会显示过期值
						await probeScreenLocked();
						return json(res, 200, { ok: true, value: statePayload() });
					}

					if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use POST' });

					let body = {};
					try {
						body = JSON.parse((await readBody(req)) || '{}');
					} catch {
						return json(res, 400, { ok: false, error: 'body must be JSON' });
					}

					// 浏览器上报可见性/焦点（心跳）。
					if (endpoint === 'presence') {
						const clientId = typeof body.clientId === 'string' ? body.clientId : '';
						if (clientId.length === 0) return json(res, 400, { ok: false, error: 'clientId required' });
						hub.update(clientId, body);
						return json(res, 200, { ok: true, value: hub.snapshot() });
					}

					// 设置页保存配置（局部补丁）。
					if (endpoint === 'config') {
						const next = applyPatch(config, body);
						const written = persist(next);
						return json(res, written.ok ? 200 : 500, {
							ok: written.ok,
							error: written.error,
							value: statePayload()
						});
					}

					// 逐事件测试推送。
					if (endpoint === 'test') {
						const kind = typeof body.kind === 'string' ? body.kind : '';
						const channel = body.channel === 'telegram' ? 'telegram' : 'desktop';
						if (!EVENT_LABELS[kind]) return json(res, 400, { ok: false, error: `unknown event kind: ${kind}` });
						// 用与真实通知相同的文案形状，测试才代表实际观感
						const sample = {
							kind,
							title: `${EVENT_EMOJI[kind] ?? ''} ${EVENT_LABELS[kind]}：测试会话`,
							body: `这是一条测试通知 「settings-test」`,
							at: Date.now()
						};
						if (channel === 'telegram') {
							const issue = telegramChannelIssue();
							if (issue !== null) return json(res, 400, { ok: false, error: `Telegram 通道未就绪：${issue}` });
							const result = await send(config.telegram, sample);
							return json(res, result.ok ? 200 : 502, { ok: result.ok, error: result.error });
						}
						// 桌面测试：强制走系统通知，这样能验证 OS 通知 + 声音 + 点击切回标签页。
						const clientId = typeof body.clientId === 'string' ? body.clientId : '';
						const delivered = clientId
							? hub.sendTo(clientId, 'webnotify', { ...sample, tone: config.desktop.sound ? config.desktop.tone : 'none' })
							: (hub.broadcast('webnotify', { ...sample, tone: config.desktop.sound ? config.desktop.tone : 'none' }), true);
						return json(res, 200, { ok: true, value: { delivered } });
					}

					// 校验 Telegram 凭据：token 走 getMe，有 Chat ID 时再走 getChat，
					// 这样「测试连接」验证的是整条链路，而不只是 token 有效。
					if (endpoint === 'telegram-check') {
						const probe = applyPatch(config, { telegram: body }).telegram;
						const me = await getTelegramMe(probe);
						if (!me.ok) return json(res, 502, me);
						const chatId = probe.chatId;
						if (typeof chatId !== 'string' || chatId.trim().length === 0) {
							return json(res, 200, { ...me, chatOk: false, chatError: '未配置 Chat ID —— bot 无法主动发起会话，请先给 bot 发一条消息再点「获取 Chat ID」' });
						}
						const chat = await getTelegramChat(probe, chatId);
						return json(res, chat.ok ? 200 : 502, { ...me, chatOk: chat.ok, chatError: chat.ok ? null : chat.error, chat: chat.chat ?? null });
					}

					// 从 bot 的最近更新里发现可用 chat（获取 Chat ID 的正规途径）。
					if (endpoint === 'telegram-chats') {
						const probe = applyPatch(config, { telegram: body }).telegram;
						const result = await getTelegramChats(probe);
						return json(res, result.ok ? 200 : 502, result);
					}

					return json(res, 404, { ok: false, error: `unknown endpoint: ${endpoint}` });
				} catch (error) {
					return json(res, 500, { ok: false, error: error?.message ?? String(error) });
				}
			}
		});
		console.log(`[session-notify] v${VERSION} 已加载（配置：${configPath}）`);
	});
}
