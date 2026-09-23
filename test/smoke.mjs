/**
 * dsh-session-tg-notify — 宿主侧冒烟测试（零依赖，直接 `node test/smoke.mjs`）。
 *
 * 用一个假 ctx 驱动插件，验证核心行为：
 *   1. 三态路由：前台 → toast 帧、后台 → webnotify 帧、离线 → Telegram
 *   2. 子代理会话被过滤（不通知）
 *   3. 三类事件分类（approval / question / complete）能命中
 *   4. 去重：同一 approval 只通知一次；minDuration 过滤短 turn
 *   5. 事件级开关：两个通道都不勾 → 完全不打扰
 *   6. HTTP API：状态读取、配置保存即生效、逐事件测试推送
 */
import { apply } from '../src/index.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (label, actual, expected) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`);
	}
};

/** 假的 SSE 响应对象：记录写出的帧。 */
function fakeRes() {
	return {
		status: null,
		headers: null,
		frames: [],
		writeHead(status, headers) { this.status = status; this.headers = headers; },
		write(chunk) { this.frames.push(String(chunk)); return true; },
		end() {},
		on() {}
	};
}

/** 假的 HTTP 请求对象（async iterable body）。 */
function fakeReq(method, url, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	return { method, url, async *[Symbol.asyncIterator]() { yield* chunks; } };
}

function fakeResponse() {
	const res = { status: null, text: '', writeHead(s) { this.status = s; }, end(t) { this.text = t; } };
	res.json = () => { try { return JSON.parse(res.text); } catch { return null; } };
	return res;
}

/** 解析某个连接收到的帧 → 事件名列表。 */
const frameEvents = (res) => res.frames.map((frame) => (frame.match(/^event: (.*)$/m) ?? [, null])[1]).filter(Boolean);
/** 取某类帧的 payload。 */
const framePayload = (res, event) => {
	const frame = res.frames.find((f) => f.includes(`event: ${event}\n`));
	if (!frame) return null;
	try { return JSON.parse(frame.split('\ndata: ')[1].split('\n')[0]); } catch { return null; }
};

const freshConfigPath = () => join(mkdtempSync(join(tmpdir(), 'dsn-')), 'config.json');

/** 构建假 ctx 并 apply 插件。 */
async function boot(cordisConfig = {}, options = {}) {
	const handlers = new Map();
	const configPath = options.configPath ?? freshConfigPath();
	if (options.initialConfig) writeFileSync(configPath, JSON.stringify(options.initialConfig));
	let httpHandler = null;

	const ctx = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		effect(fn) { return fn?.(); },
		inject(_services, cb) { cb({ webServer: { register: (route) => { httpHandler = route.handler; } } }); },
		// 标题服务：options.sessionTitle 为字符串时模拟「已有标题」，
		// 为 undefined 时模拟「服务存在但会话还没标题」。
		get(name) {
			if (name !== 'sessionTitle') return undefined;
			return {
				get(session) {
					if (typeof options.sessionTitle !== 'string' || options.sessionTitle.length === 0) return undefined;
					return { title: options.sessionTitle, messageSeqs: [], source: { kind: 'auto' }, eventSeq: 1, updatedAt: 0 };
				}
			};
		}
	};

	const sentTelegram = [];
	apply(ctx, cordisConfig, {
		configPath,
		sendTelegram: async (_config, payload) => {
			sentTelegram.push(payload);
			return { ok: true, messageId: 1 };
		},
		// 锁屏状态注入：默认未锁屏；后台要推 Telegram 的用例需显式 locked: true
		readScreenLocked: async () => ({ supported: true, locked: options.locked === true, signal: 'test' })
	});

	return {
		emit: async (event, ...args) => {
			for (const handler of handlers.get(event) ?? []) await handler(...args);
		},
		/** 返回 { body, res }；res 只在 SSE 场景有意义。 */
		request: async (method, url, body) => {
			const res = fakeResponse();
			await httpHandler(fakeReq(method, url, body), res);
			return { body: res.json(), res };
		},
		/** 建立一条 SSE 连接，返回记录帧的假响应对象。 */
		openSse: async (clientId) => {
			const res = fakeRes();
			await httpHandler(fakeReq('GET', `/session-notify/events?clientId=${encodeURIComponent(clientId)}`), res);
			return res;
		},
		/** 带自定义请求头发出请求（用于跨站防护测试）。 */
		requestWithHeaders: async (method, url, headers, body) => {
			const res = fakeResponse();
			const req = fakeReq(method, url, body);
			req.headers = headers;
			await httpHandler(req, res);
			return { body: res.json(), res };
		},
		sentTelegram,
		configPath
	};
}

const mainSession = (id = 'sess-1') => ({ id, header: { cwd: '/Users/me/project-alpha' } });
const subSession = (id = 'sess-sub') => ({ id, header: { cwd: '/Users/me/project-alpha', delegationDepth: 1, origin: 'subagent' } });
const approvalEvent = (id = 'ap-1') => ({ type: 'approval/asked', data: { id, toolName: 'bash', reason: 'rm -rf build' } });
const questionEvent = (callId = 'call-1') => ({
	type: 'tool/call',
	data: {
		name: 'ask_user_question',
		callId,
		arguments: JSON.stringify({ questions: [{ question: '要用哪种方案？', options: [{ label: 'A' }, { label: 'B' }] }] })
	}
});
/** 一个"有最终文本回答"的完整 turn 事件序列。 */
const completeTurn = (session, turn = 1) => [
	['session/event', session, { type: 'turn/start', time: 1000, data: { turn } }],
	['session/event', session, { type: 'user/message', time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我重构一下' }] } }],
	['session/event', session, { type: 'assistant/message', time: 2000, data: { turn, message: { content: [{ type: 'text', text: '已完成重构' }] } } }],
	['session/event', session, { type: 'turn/end', time: 2100, data: { turn, reason: { kind: 'completed' } } }]
];

console.log('\n[1] 三态路由：前台 → toast，后台 → webnotify，离线 → Telegram');
{
	// 本段验证「后台 + 锁屏」才推 Telegram，所以让宿主报告已锁屏
	const { emit, request, openSse, sentTelegram } = await boot({}, { locked: true });
	// 建立 SSE 连接（模拟页面打开）
	const open = { res: await openSse('tab-1') };
	check('SSE 建连时立即发 ready 帧', frameEvents(open.res).includes('ready'), true);
	check('ready 帧带回 clientId', framePayload(open.res, 'ready').clientId, 'tab-1');

	// 默认（未上报焦点）应判为后台
	await request('POST', '/session-notify/presence', { clientId: 'tab-1', visibility: 'visible', focused: false });
	await emit('session/event', mainSession(), approvalEvent('ap-bg'));
	check('后台：发出 webnotify 帧', framePayload(open.res, 'webnotify') !== null, true);
	check('后台：默认不叠加 Telegram', sentTelegram.length, 0);
	check('标题格式为「{emoji} {事件类型}」', framePayload(open.res, 'webnotify').title, '🔐 需要审批');
	check('无会话标题时不出现多余的「：」', framePayload(open.res, 'webnotify').title.includes('：'), false);
	check('正文末尾带「工作区名称」', framePayload(open.res, 'webnotify').body.endsWith('「project-alpha」'), true);
	check('webnotify 载荷带音色', framePayload(open.res, 'webnotify').tone, 'ding');

	// 切到前台
	await request('POST', '/session-notify/presence', { clientId: 'tab-1', visibility: 'visible', focused: true });
	await emit('session/event', mainSession(), approvalEvent('ap-fg'));
	check('前台：发出 toast 帧', framePayload(open.res, 'toast') !== null, true);
	check('前台：不发 webnotify', frameEvents(open.res).filter((e) => e === 'webnotify').length, 1);

	// 打开全局开关、启用 Telegram：此后「后台 + 锁屏」才推手机
	await request('POST', '/session-notify/config', { telegram: { enabled: true, botToken: 'tk', chatId: '42', notifyWhenLocked: true } });
	// 前台即使订阅了 TG 也绝不推手机（你正看着屏幕）
	await request('POST', '/session-notify/presence', { clientId: 'tab-1', visibility: 'visible', focused: true });
	await emit('session/event', mainSession(), approvalEvent('ap-fg-2'));
	check('前台 + 已订阅 TG + 通道就绪：仍不发 Telegram', sentTelegram.length, 0);
	await request('POST', '/session-notify/presence', { clientId: 'tab-1', visibility: 'hidden', focused: false });
	await emit('session/event', mainSession(), approvalEvent('ap-both'));
	check('后台 + 锁屏 + 开关打开：桌面与 Telegram 同时', sentTelegram.length, 1);
}

console.log('\n[1b] 后台但**未锁屏**（只是切到别的应用）→ 不推手机');
{
	const { emit, request, openSse, sentTelegram } = await boot({
		events: { approval: { desktop: true, telegram: true } },
		telegram: { enabled: true, botToken: 'tk', chatId: '42', notifyWhenLocked: true }
	}, { locked: false });
	// 必须先建立 SSE 连接，否则没有在线客户端 → 状态是 offline 而不是 background
	await openSse('tab-x');
	await request('POST', '/session-notify/presence', { clientId: 'tab-x', visibility: 'hidden', focused: false });
	await emit('session/event', mainSession(), approvalEvent('ap-nolock'));
	check('后台但未锁屏：不推 Telegram（这是这次改动的核心）', sentTelegram.length, 0);
}

console.log('\n[1c] 通知标题只显示事件类型（不含会话标题）');
{
	// 即便宿主能拿到会话标题，标题里也不应出现它 —— 锁住这个行为，
	// 避免以后又把标题拼回「事件类型：会话标题」。
	const { emit, request, openSse } = await boot({ telegram: { enabled: true, botToken: 'tk', chatId: '42' } }, {
		sessionTitle: '个人开发APP消息推送方案调研'
	});
	const sse = await openSse('tab-title');
	await request('POST', '/session-notify/presence', { clientId: 'tab-title', visibility: 'hidden', focused: false });
	await emit('session/event', mainSession(), approvalEvent('ap-title'));
	const payload = (function () {
		for (const frame of sse.frames) {
			if (!/^event: (toast|webnotify)$/m.test(frame)) continue;
			const at = frame.indexOf('\ndata: ');
			if (at >= 0) { try { return JSON.parse(frame.slice(at + 7).trim()); } catch { /* 继续 */ } }
		}
		return null;
	})();
	check('标题只有事件类型', payload?.title, '🔐 需要审批');
	check('标题不含会话标题', payload?.title?.includes('个人开发APP消息推送方案调研'), false);
	check('标题不含冒号', payload?.title?.includes('：'), false);
	check('正文仍以「工作区」结尾', payload?.body?.endsWith('「project-alpha」'), true);
}

console.log('\n[2] 页面关闭（无 SSE 连接）→ 改走 Telegram');
{
	const { emit, request, sentTelegram } = await boot({ telegram: { enabled: true, botToken: 'tk', chatId: '42' } });
	const state = await request('GET', '/session-notify/state');
	check('无连接时状态 offline', state.body.value.presence.state, 'offline');
	await emit('session/event', mainSession(), approvalEvent('ap-1'));
	check('离线：approval 走 Telegram', sentTelegram.length, 1);
	check('Telegram 正文含工具名', sentTelegram[0].body.includes('bash'), true);
	await emit('session/event', mainSession(), approvalEvent('ap-1'));
	check('同一 approval 去重', sentTelegram.length, 1);
	await emit('session/event', mainSession(), questionEvent());
	check('question 走 Telegram', sentTelegram.length, 2);
	check('question 正文含问题文本', sentTelegram[1].body.includes('要用哪种方案'), true);
}

console.log('\n[3] 子代理过滤与 complete 判定');
{
	const { emit, sentTelegram } = await boot({
		minDuration: 0,
		// 按新语义：离线时只有**显式订阅了 TG** 的事件才会走 Telegram
		events: { complete: { telegram: true } },
		telegram: { enabled: true, botToken: 'tk', chatId: '42' }
	});
	await emit('session/event', subSession(), approvalEvent('ap-sub'));
	check('子代理 approval 不通知', sentTelegram.length, 0);
	for (const [event, ...args] of completeTurn(subSession(), 1)) await emit(event, ...args);
	check('子代理 turn 完成不通知', sentTelegram.length, 0);

	for (const [event, ...args] of completeTurn(mainSession(), 1)) await emit(event, ...args);
	check('主会话 complete 通知', sentTelegram.length, 1);
	check('complete 正文含用户首条消息', sentTelegram[0].body.includes('帮我重构一下'), true);

	// 只有 tool-call、没有最终文本回答的 turn 不算完成
	const toolOnly = [
		['session/event', mainSession('s2'), { type: 'turn/start', time: 1000, data: { turn: 1 } }],
		['session/event', mainSession('s2'), { type: 'assistant/message', time: 2000, data: { turn: 1, message: { content: [{ type: 'tool-call' }] } } }],
		['session/event', mainSession('s2'), { type: 'turn/end', time: 2100, data: { turn: 1, reason: { kind: 'completed' } } }]
	];
	for (const [event, ...args] of toolOnly) await emit(event, ...args);
	check('tool-call-only 的 turn 不算完成', sentTelegram.length, 1);
}

console.log('\n[4] minDuration 过滤与事件级开关');
{
	const { emit, sentTelegram } = await boot({ telegram: { enabled: true, botToken: 'tk', chatId: '42' } });
	for (const [event, ...args] of completeTurn(mainSession())) await emit(event, ...args);
	check('默认 minDuration=10s：1.1s 的 turn 被过滤', sentTelegram.length, 0);

	// block 默认只订阅了桌面，离线时不会走 Telegram —— 这里显式订阅 TG 以验证
	// 「未关闭的事件仍会投递」，同时 error 保持两个通道都不订阅。
	const off = await boot({
		events: { error: { desktop: false, telegram: false }, block: { telegram: true } },
		telegram: { enabled: true, botToken: 'tk', chatId: '42' }
	});
	await off.emit('agent/error', { agent: { id: 'a1' }, turn: 1, step: 1, error: new Error('boom') });
	check('两个通道都不勾的 error 不打扰', off.sentTelegram.length, 0);
	await off.emit('goal/changed', { change: { operation: 'block', goal: { id: 'g1', objective: '无法继续' }, ref: { id: 'g1', revision: 1 } } });
	check('未关闭的 block 事件仍通知', off.sentTelegram.length, 1);
}

console.log('\n[5] HTTP API：状态、配置保存即生效、逐事件测试推送');
{
	const { request, sentTelegram } = await boot({ telegram: { enabled: true, botToken: 'tk', chatId: '42' } });
	const state = await request('GET', '/session-notify/state');
	check('GET /state 成功', state.body.ok, true);
	check('Bot Token 被隐去', state.body.value.config.telegram.botToken, '');
	check('hasBotToken 为真', state.body.value.config.telegram.hasBotToken, true);
	check('事件元数据有 5 项', state.body.value.events.length, 5);

	const saved = await request('POST', '/session-notify/config', { events: { complete: { telegram: true } } });
	check('局部配置保存成功', saved.body.ok, true);
	check('保存后立即生效', saved.body.value.config.events.complete.telegram, true);
	check('其余字段未被覆盖', saved.body.value.config.events.approval.telegram, true);

	const test = await request('POST', '/session-notify/test', { kind: 'approval', channel: 'telegram' });
	check('逐事件 Telegram 测试推送', test.body.ok, true);
	check('测试推送实际发出', sentTelegram.length, 1);
	check('未知事件类型被拒绝', (await request('POST', '/session-notify/test', { kind: 'nope', channel: 'telegram' })).body.ok, false);
	check('未知端点返回 404', (await request('GET', '/session-notify/nope')).body.ok, false);
}

console.log('\n[6] 跨站防护');
{
	const { requestWithHeaders } = await boot();
	const same = await requestWithHeaders('POST', '/session-notify/config', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, { enabled: true });
	check('同源请求放行', same.body.ok, true);
	const cross = await requestWithHeaders('POST', '/session-notify/config', { origin: 'https://evil.example', host: '127.0.0.1:3080' }, { enabled: false });
	check('跨站请求被拒绝', cross.body.ok, false);
	check('跨站返回 403', cross.res.status, 403);
	const noOrigin = await requestWithHeaders('GET', '/session-notify/state', {}, undefined);
	check('无 Origin 头（curl）仍可读状态', noOrigin.body.ok, true);
}

console.log('\n[7] Telegram：Chat ID 必填，且可从 bot 更新里自动发现');
{
	// 直接测真实实现（boot 会把 sendTelegram 换成桩，测不到真实拒绝路径）
	const { sendTelegram, getTelegramChats } = await import('../src/telegram.js');
	const noChat = await sendTelegram({ botToken: 'tk', chatId: '' }, { title: 't', body: 'b' });
	check('无 Chat ID 时拒绝发送', noChat.ok, false);
	check('拒绝原因明确指出 Chat ID', noChat.error, '未配置 Telegram Chat ID');
	check('无 Token 时拒绝发送', (await sendTelegram({ botToken: '', chatId: '1' }, { title: 't', body: 'b' })).error, '未配置 Telegram Bot Token');

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		if (u.includes('/getUpdates')) {
			return { ok: true, status: 200, json: async () => ({ ok: true, result: [
				{ update_id: 1, message: { chat: { id: 12345, type: 'private', first_name: 'Shu' } } },
				{ update_id: 2, message: { chat: { id: 12345, type: 'private', first_name: 'Shu' } } },
				{ update_id: 3, message: { chat: { id: -999, type: 'group', title: 'DSH 通知' } } }
			] }) };
		}
		if (u.includes('/getChat')) {
			return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 12345, type: 'private', first_name: 'Shu' } }) };
		}
		if (u.includes('/getMe')) {
			return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'dsh_notify_bot', first_name: 'DSH' } }) };
		}
		return { ok: false, status: 404, json: async () => ({ ok: false, description: 'not stubbed' }) };
	};
	try {
		const discovered = await getTelegramChats({ botToken: 'tk' });
		check('自动发现会话（同一 chat 去重）', discovered.chats?.length, 2);
		check('私聊用名字作标签', discovered.chats?.[0]?.label, 'Shu');
		check('群聊用标题作标签', discovered.chats?.[1]?.label, 'DSH 通知');

		const { request } = await boot({ telegram: { enabled: true, botToken: 'tk', chatId: '' } });
		const ep = await request('POST', '/session-notify/telegram-chats', {});
		check('端点 /telegram-chats 可用', ep.body.chats?.length, 2);

		// 关键回归点：只校验 token 是不够的，必须同时报告 Chat ID 不可用
		const checkNoChat = await request('POST', '/session-notify/telegram-check', {});
		check('测试连接：token 有效但 Chat ID 缺失', checkNoChat.body.chatOk, false);
		check('并给出可操作的原因', String(checkNoChat.body.chatError).includes('bot 无法主动发起会话'), true);

		const checkWithChat = await request('POST', '/session-notify/telegram-check', { chatId: '12345' });
		check('配了 Chat ID 后链路可达', checkWithChat.body.chatOk, true);
		check('返回 chat 标签', checkWithChat.body.chat?.label, 'Shu');
	} finally {
		globalThis.fetch = originalFetch;
	}
}

console.log('\n[8] 回归：心跳过期不能把「页面开着」误判成离线');
{
	// TTL 压到 5 秒：建连后只上报一次焦点，然后等焦点信息过期。
	// 修复前这里会变成 offline（页面被误判为关闭），通知被错误改走 Telegram。
	const { request, openSse } = await boot({ presenceTtlMs: 5000 });
	await openSse('tab-stale');
	await request('POST', '/session-notify/presence', { clientId: 'tab-stale', visibility: 'visible', focused: true });
	const before = await request('GET', '/session-notify/state');
	check('焦点信息新鲜时是前台', before.body.value.presence.state, 'foreground');

	await new Promise((resolve) => setTimeout(resolve, 5600));

	const after = await request('GET', '/session-notify/state');
	check('焦点信息过期 → 退化为 background，而不是 offline', after.body.value.presence.state, 'background');
	check('连接仍在，count 不为 0', after.body.value.presence.count, 1);
}

console.log('');
if (failures === 0) {
	console.log('全部通过 ✅');
} else {
	console.log(`${failures} 项失败 ❌`);
	process.exitCode = 1;
}
