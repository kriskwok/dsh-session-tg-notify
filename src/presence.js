/**
 * dsh-session-tg-notify — 在线状态 + SSE 推送 hub。
 *
 * 关键设计：**SSE 长连接本身就是存活信号**。浏览器端与后端之间只有一条
 * 通道（`GET /session-notify/events`），它同时承担：
 *   1. 存活判定 —— 连接存在即页面开着；连接关闭（含页面关闭、标签被回收）
 *      即视为离线，后端据此把通知改走 Telegram。
 *   2. 前后台判定 —— 客户端通过 `POST /session-notify/presence` 上报
 *      `{ visibility, focused }`，二者可随窗口焦点变化即时更新。
 *   3. 通知下发 —— 后端按判定结果推 `toast` / `webnotify` 帧。
 *
 * 三态（在线只看连接，心跳只管焦点）：
 *   - foreground：存在连接，且**新鲜**的焦点上报是 visible + focused
 *   - background：存在连接但没有新鲜的前台信息
 *   - offline   ：**没有任何连接**（页面确实关了）
 *
 * 曾经把「心跳过期」也算成 offline，结果被 Chrome 的后台标签页定时器节流误伤：
 * 页面开着、只是被切走久了，就被判成离线并错误地改走 Telegram。
 *
 * 多标签页：只要**任一**标签页处于前台就算 foreground（用户在看着 DSH）；
 * 通知只发给“最合适的那一个”标签页（前台优先，否则最近上报的），避免多标签
 * 重复弹窗。
 */
export function createPresenceHub(options = {}) {
	const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs >= 5000 ? options.ttlMs : 30000;
	const maxConnections = Number.isSafeInteger(options.maxConnections) && options.maxConnections > 0
		? options.maxConnections
		: 16;

	/** clientId → { res, lastSeen, visibility, focused } */
	const clients = new Map();
	let timer = null;

	const now = () => Date.now();

	/** 正常关闭时立即移除；用于推导 offline。 */
	const detach = (clientId) => {
		clients.delete(clientId);
		stopHeartbeatIfIdle();
	};

	const stopHeartbeatIfIdle = () => {
		if (clients.size > 0 || timer === null) return;
		clearInterval(timer);
		timer = null;
	};

	const writeFrame = (res, event, data) => {
		try {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			return true;
		} catch {
			return false;
		}
	};

	/** 心跳注释帧，防止中间的代理掐断 idle 连接。 */
	const startHeartbeat = () => {
		if (timer !== null) return;
		timer = setInterval(() => {
			for (const res of [...clients.values()].map((c) => c.res)) {
				try {
					res.write(`: hb ${now()}\n\n`);
				} catch {
					// 断开的连接由 close 事件清理
				}
			}
		}, 15000);
		if (typeof timer.unref === 'function') timer.unref();
	};

	/**
	 * 接管一个 SSE 连接。
	 * @param clientId - 浏览器端为每个标签页生成的稳定标识。
	 * @param res - node HTTP 响应对象。
	 * @param ready - ready 帧载荷（服务端状态快照）。
	 * @returns 是否成功接管（false = 超出连接上限）。
	 */
	const attach = (clientId, res, ready = {}) => {
		if (clients.size >= maxConnections) return false;
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		});
		clients.set(clientId, { res, lastSeen: now(), visibility: 'visible', focused: false });
		writeFrame(res, 'ready', { ...ready, clientId });
		res.on('close', () => {
			// 先 detach 再记录剩余数：反过来的话 clients.size 还没减，
			// 只能靠 -1 硬凑，日志会打出「剩余 -1 个」这种误导性的值。
			detach(clientId);
			console.log(`[session-notify] 页面连接断开（剩余 ${clients.size} 个）`);
		});
		console.log(`[session-notify] 页面连接建立（clientId=${clientId}，共 ${clients.size} 个）`);
		startHeartbeat();
		return true;
	};

	/** 更新某个客户端的可见性/焦点；返回是否命中已知连接。 */
	const update = (clientId, patch = {}) => {
		const client = clients.get(clientId);
		if (!client) return false;
		client.lastSeen = now();
		if (patch.visibility === 'visible' || patch.visibility === 'hidden') client.visibility = patch.visibility;
		if (typeof patch.focused === 'boolean') client.focused = patch.focused;
		return true;
	};

	/**
	 * 最近若干次下发记录（诊断用）。
	 *
	 * 为什么需要：`/test` 端点返回 `delivered:true` 只代表「写进了 SSE 连接」，
	 * 不代表客户端真的执行了。一旦「面板测试能弹、实际事件不弹」，光看宿主日志
	 * 无法区分是**路由选错了帧**（该发 webnotify 却发了 toast）还是**客户端收到
	 * 后没执行**。把最近下发的帧记下来就能一眼定位。
	 *
	 * 两条下发路径都要记：`sendTo`（真实事件与面板测试都走它）与 `broadcast`
	 * （`/test` 未指定 clientId 时的回退）。早先只记了 sendTo，导致手测
	 * `/test` 明明 delivered 却查不到任何记录，一度误判成「插件没加载新代码」。
	 */
	let recentFrames = [];
	const rememberFrame = (channel, event, clientId, data) => {
		recentFrames.unshift({
			channel,
			event,
			clientId,
			kind: data?.kind ?? null,
			title: data?.title ?? null,
			// body 与 sessionId 也要记：真实事件和面板测试的差别可能藏在正文里
			// （例如正文为空时某些平台会不弹横幅），只记 title 会漏掉这类线索。
			body: data?.body ?? null,
			sessionId: data?.sessionId ?? null,
			tone: data?.tone ?? null,
			at: new Date().toISOString()
		});
		if (recentFrames.length > 20) recentFrames = recentFrames.slice(0, 20);
	};

	/** 广播一帧给所有在线客户端。 */
	const broadcast = (event, data) => {
		for (const client of clients.values()) writeFrame(client.res, event, data);
		rememberFrame('broadcast', event, null, data);
	};

	/** 推给单个客户端（通知类帧用，避免多标签重复弹窗）。 */
	const sendTo = (clientId, event, data) => {
		const client = clients.get(clientId);
		const ok = client ? writeFrame(client.res, event, data) : false;
		rememberFrame(ok ? 'desktop' : 'dropped', event, clientId, data);
		return ok;
	};

	/**
	 * 三态快照；同时返回通知应该落到哪个标签页。
	 *
	 * 关键区分（曾经在这里踩过坑）：
	 *   - **在线** = SSE 连接还开着。连接存在就是页面存在的证据。
	 *   - **心跳新鲜度**只用来判断「焦点信息还算不算数」，不用来判断生死。
	 *
	 * 不能拿心跳当存活依据：Chrome 对隐藏超过约 5 分钟的标签页会把 setInterval
	 * 节流到每分钟一次，10 秒的心跳会变成 60 秒，远超任何合理的 TTL ——
	 * 页面明明开着却会被判成离线，通知被错误地改走 Telegram。
	 *
	 * 焦点信息过期时退化为 background（而不是 offline）：这是保守的一侧 ——
	 * 后台只会发系统通知（点击仍能直达会话），而离线会跳过桌面通道。
	 */
	const snapshot = () => {
		if (clients.size === 0) {
			return { state: 'offline', targetClientId: null, count: 0, foregroundCount: 0 };
		}
		const all = [...clients.entries()];
		const fresh = all.filter(([, c]) => now() - c.lastSeen <= ttlMs);
		const foreground = fresh.filter(([, c]) => c.visibility === 'visible' && c.focused === true);
		if (foreground.length > 0) {
			// 多个前台标签页时取最近上报的那个
			const [clientId] = foreground.reduce((a, b) => (b[1].lastSeen > a[1].lastSeen ? b : a));
			return { state: 'foreground', targetClientId: clientId, count: all.length, foregroundCount: foreground.length };
		}
		// 没有新鲜的前台信息：有连接就算后台，优先挑心跳较新的那个
		const pool = fresh.length > 0 ? fresh : all;
		const [clientId] = pool.reduce((a, b) => (b[1].lastSeen > a[1].lastSeen ? b : a));
		return { state: 'background', targetClientId: clientId, count: all.length, foregroundCount: 0 };
	};

	const dispose = () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		for (const { res } of clients.values()) {
			try {
				res.end();
			} catch {
				// 已关闭的连接忽略
			}
		}
		clients.clear();
	};

	return {
		attach,
		update,
		broadcast,
		sendTo,
		snapshot,
		dispose,
		/** 最近下发记录（诊断用，见 rememberFrame 的说明）。 */
		get recentFrames() {
			return recentFrames;
		},
		get size() {
			return clients.size;
		}
	};
}
