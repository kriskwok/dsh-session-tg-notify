/**
 * dsh-session-tg-notify — 通道路由规格（可执行）。
 *
 * 这是「订阅 × 通道 × 网页状态 × 锁屏」的唯一权威定义，用**真实投递**跑出来，
 * 而不是靠读代码推断。改路由逻辑必须先让这张表继续成立。
 *
 * 语义（用户确认过的模型）：
 *   - 行内勾选 = **订阅**（这个事件我愿意通过该通道收到）
 *   - 全局开关 + 凭据 = **通道**是否启动
 *   - 前台 → 桌面 toast；**永不发 Telegram**（你正看着屏幕）
 *   - 后台 → 桌面系统通知；Telegram 需**同时**满足：订阅了 TG、
 *            开了「网页后台且锁屏时推送」、**且当前确实锁屏**
 *   - 离线 → 桌面无处可发；Telegram 只要订阅了 TG 就发
 *
 * 后台这一档刻意要求「锁屏」而不是「失焦」：切到别的应用也会让页面失焦，
 * 那时人还在电脑前，推手机是纯打扰。
 *
 * 运行：node test/truth-table.mjs
 */
import { apply } from '../src/index.js';
import { parseScreenLocked } from '../src/screenlock.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;

// 全局拦截 console.warn：宿主在**异步投递**里打 warning，若只在 apply() 期间
// 替换 console.warn，等真正投递时已经还原，什么都抓不到。
let capturedWarnings = [];
console.warn = (...args) => { capturedWarnings.push(args.join(' ')); };
/** 让 deliver() 的微任务跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function fakeRes() {
	return {
		frames: [],
		writeHead() {},
		write(chunk) { this.frames.push(String(chunk)); return true; },
		end() {},
		on() {}
	};
}
function fakeReq(method, url, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	return { method, url, async *[Symbol.asyncIterator]() { yield* chunks; } };
}
function fakeResponse() {
	const res = { text: '', writeHead() {}, end(t) { this.text = t; } };
	res.json = () => { try { return JSON.parse(res.text); } catch { return null; } };
	return res;
}

/** 注入一个固定的锁屏状态，避免测试依赖真实屏幕。 */
async function boot(cordisConfig, locked) {
	const handlers = new Map();
	let httpHandler = null;
	const sent = [];
	const ctx = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		effect(fn) { return fn?.(); },
		inject(_s, cb) { cb({ webServer: { register: (route) => { httpHandler = route.handler; } } }); }
	};
	apply(ctx, cordisConfig, {
		configPath: join(mkdtempSync(join(tmpdir(), 'dsn-tt-')), 'config.json'),
		sendTelegram: async (_c, payload) => { sent.push(payload); return { ok: true }; },
		readScreenLocked: async () => ({ supported: true, locked, signal: 'test' })
	});
	return {
		emit: async (event, ...args) => { for (const h of handlers.get(event) ?? []) await h(...args); },
		request: async (method, url, body) => {
			const res = fakeResponse();
			await httpHandler(fakeReq(method, url, body), res);
			return res.json();
		},
		openSse: async (clientId) => {
			const res = fakeRes();
			await httpHandler(fakeReq('GET', `/session-notify/events?clientId=${clientId}`), res);
			return res;
		},
		sent
	};
}

async function setState(harness, state) {
	if (state === 'offline') return null;
	const res = await harness.openSse('tab-1');
	await harness.request('POST', '/session-notify/presence', {
		clientId: 'tab-1',
		visibility: state === 'foreground' ? 'visible' : 'hidden',
		focused: state === 'foreground'
	});
	return res;
}

/**
 * 从 SSE 帧里取出**通知**载荷。必须跳过连接建立时的 `ready` 帧，否则会拿到
 * { version, clientId } 而不是通知内容。
 */
function notificationPayload(res) {
	if (!res) return null;
	for (const frame of res.frames) {
		const event = (frame.match(/^event: (.*)$/m) ?? [, null])[1];
		if (event !== 'toast' && event !== 'webnotify') continue;
		const at = frame.indexOf('\ndata: ');
		if (at < 0) continue;
		try { return JSON.parse(frame.slice(at + 7).trim()); } catch { /* 继续找 */ }
	}
	return null;
}

let seq = 0;
async function run({ state, desktop, telegram, notifyWhenLocked, locked = false, channelReady = true }) {
	capturedWarnings = [];
	const harness = await boot({
		telegram: {
			enabled: true,
			botToken: 'tk',
			chatId: channelReady ? '42' : '',
			notifyWhenLocked
		},
		events: { approval: { desktop, telegram } }
	}, locked);
	const sse = await setState(harness, state);
	seq += 1;
	await harness.emit('session/event', { id: `sess-${seq}`, header: { cwd: '/tmp/x' } }, {
		type: 'approval/asked',
		data: { id: `ap-${seq}`, toolName: 'bash', reason: 'r' }
	});
	await flush();
	const frames = sse ? sse.frames.map((f) => (f.match(/^event: (.*)$/m) ?? [, null])[1]).filter(Boolean) : [];
	return {
		desktop: frames.includes('toast') ? 'toast' : frames.includes('webnotify') ? '通知' : '—',
		telegram: harness.sent.length > 0 ? 'TG' : '—',
		payload: notificationPayload(sse),
		warnings: [...capturedWarnings]
	};
}

const SPEC = [
	// 前台：永不推手机，无论订阅与锁屏
	{ state: 'foreground', desktop: true, telegram: true, notifyWhenLocked: true, locked: true, want: { desktop: 'toast', telegram: '—' } },
	{ state: 'foreground', desktop: true, telegram: true, notifyWhenLocked: false, locked: false, want: { desktop: 'toast', telegram: '—' } },
	{ state: 'foreground', desktop: false, telegram: true, notifyWhenLocked: true, locked: true, want: { desktop: '—', telegram: '—' } },

	// 后台 + 未锁屏（只是切到别的应用）：桌面通知有，手机不响
	{ state: 'background', desktop: true, telegram: true, notifyWhenLocked: true, locked: false, want: { desktop: '通知', telegram: '—' } },
	{ state: 'background', desktop: true, telegram: true, notifyWhenLocked: false, locked: false, want: { desktop: '通知', telegram: '—' } },

	// 后台 + 锁屏：必须「订阅 TG 且开了开关」才推手机
	{ state: 'background', desktop: true, telegram: true, notifyWhenLocked: true, locked: true, want: { desktop: '通知', telegram: 'TG' } },
	{ state: 'background', desktop: false, telegram: true, notifyWhenLocked: true, locked: true, want: { desktop: '—', telegram: 'TG' } },
	{ state: 'background', desktop: true, telegram: true, notifyWhenLocked: false, locked: true, want: { desktop: '通知', telegram: '—' } },
	{ state: 'background', desktop: true, telegram: false, notifyWhenLocked: true, locked: true, want: { desktop: '通知', telegram: '—' } },

	// 离线：页面都关了，锁屏与否无关，订阅了 TG 就发
	{ state: 'offline', desktop: true, telegram: true, notifyWhenLocked: false, locked: false, want: { desktop: '—', telegram: 'TG' } },
	{ state: 'offline', desktop: false, telegram: true, notifyWhenLocked: true, locked: true, want: { desktop: '—', telegram: 'TG' } },
	{ state: 'offline', desktop: true, telegram: false, notifyWhenLocked: true, locked: true, want: { desktop: '—', telegram: '—' } },
	{ state: 'offline', desktop: false, telegram: false, notifyWhenLocked: false, locked: false, want: { desktop: '—', telegram: '—' } }
];

const STATE_LABEL = { foreground: '前台', background: '后台', offline: '离线' };
const pad = (s, n) => String(s).padEnd(n, ' ');

console.log('\n通道规格：状态 × 订阅(桌面,TG) × 「后台且锁屏时推送」 × 实际锁屏 → 实际投递\n');
console.log(`  ${pad('状态', 6)}${pad('订阅桌面', 9)}${pad('订阅TG', 7)}${pad('锁屏开关', 9)}${pad('实际锁屏', 9)}${pad('桌面', 7)}${pad('TG', 5)}结果`);
for (const item of SPEC) {
	const actual = await run(item);
	const ok = actual.desktop === item.want.desktop && actual.telegram === item.want.telegram;
	if (!ok) failures += 1;
	console.log(
		`  ${pad(STATE_LABEL[item.state], 6)}${pad(item.desktop ? '✓' : '—', 9)}${pad(item.telegram ? '✓' : '—', 7)}` +
		`${pad(item.notifyWhenLocked ? '✓' : '—', 9)}${pad(item.locked ? '✓' : '—', 9)}` +
		`${pad(actual.desktop, 7)}${pad(actual.telegram, 5)}${ok ? '✓' : '✗ 期望 ' + JSON.stringify(item.want)}`
	);
}

console.log('\n附带断言\n');
{
	const offline = await run({ state: 'offline', desktop: true, telegram: true, notifyWhenLocked: false, channelReady: false });
	if (offline.telegram === '—' && offline.warnings.some((w) => w.includes('缺少 Chat ID'))) {
		console.log('  ✓ 订阅了但通道未就绪 → 未发出，且 warning 指出「缺少 Chat ID」');
	} else {
		failures += 1;
		console.log(`  ✗ 期望未发出且 warning 提到「缺少 Chat ID」，实际 ${JSON.stringify(offline.warnings)}`);
	}

	// 「点击直达会话」的前提：通知帧里必须带 sessionId
	const withSession = await run({ state: 'background', desktop: true, telegram: false, notifyWhenLocked: false });
	if (typeof withSession.payload?.sessionId === 'string' && withSession.payload.sessionId.length > 0) {
		console.log(`  ✓ 桌面通知帧带 sessionId（供点击直达会话）：${withSession.payload.sessionId}`);
	} else {
		failures += 1;
		console.log(`  ✗ 桌面通知帧缺少 sessionId，实际 payload=${JSON.stringify(withSession.payload)}`);
	}
}

console.log('\n锁屏解析单元断言（ioreg plist 片段）\n');
{
	const cases = [
		['键缺失 = 未锁定', '<key>IOConsoleUsers</key><array><dict/></array>', false],
		['显式 true = 已锁定', '<key>IOConsoleUsers</key><key>CGSSessionScreenIsLocked</key><true/>', true],
		['显式 false = 未锁定', '<key>IOConsoleUsers</key><key>CGSSessionScreenIsLocked</key><false/>', false],
		['多个 console user 取最保守', '<key>IOConsoleUsers</key><key>CGSSessionScreenIsLocked</key><false/><key>CGSSessionScreenIsLocked</key><true/>', true],
		['解析不出结构 = null（转兜底信号）', '<plist></plist>', null]
	];
	for (const [label, xml, expect] of cases) {
		const actual = parseScreenLocked(xml);
		if (JSON.stringify(actual) === JSON.stringify(expect)) {
			console.log(`  ✓ ${label} → ${JSON.stringify(actual)}`);
		} else {
			failures += 1;
			console.log(`  ✗ ${label}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`);
		}
	}
}

console.log('');
if (failures === 0) {
	console.log('通道规格全部成立 ✅');
} else {
	console.log(`${failures} 项不符合规格 ❌`);
	process.exitCode = 1;
}
