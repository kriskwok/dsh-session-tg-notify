/**
 * dsh-session-tg-notify — Telegram 通道（Bot API `sendMessage`）。
 *
 * 只依赖全局 fetch（Node >= 18），无第三方依赖。所有失败都被收敛成
 * `{ ok: false, error }`，由调用方决定记日志还是回报给设置页 ——
 * 通知失败绝不能影响 DSH 会话本身。
 */

/**
 * 把通知内容渲染成 Telegram 消息文本（HTML 模式，需转义）。
 *
 * title 已由宿主组装成「{emoji} {事件类型}：{会话标题}」，body 末尾已带
 * 「工作区名称」，所以这里只做转义与换行，不再自己拼接片段 —— 保证
 * Telegram 与页面内 toast / 系统通知三处文案完全一致。
 */
export function renderTelegramText(notification) {
	const title = notification.title ?? 'DSH 通知';
	const body = notification.body ?? '';
	const lines = [`<b>${escapeHtml(title)}</b>`];
	if (body) lines.push(escapeHtml(body));
	return lines.join('\n');
}

function escapeHtml(text) {
	return String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

/**
 * 发送一条 Telegram 消息。
 * @param config - { botToken, chatId, apiBase }
 * @param notification - { title, body, emoji?, sessionLabel? }
 * @param fetchImpl - 可注入的 fetch（测试用）
 * @returns { ok: true, messageId } 或 { ok: false, error }
 */
export async function sendTelegram(config, notification, fetchImpl = globalThis.fetch) {
	const token = typeof config?.botToken === 'string' ? config.botToken.trim() : '';
	const chatId = typeof config?.chatId === 'string' ? config.chatId.trim() : '';
	if (token.length === 0) return { ok: false, error: '未配置 Telegram Bot Token' };
	if (chatId.length === 0) return { ok: false, error: '未配置 Telegram Chat ID' };
	if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行时没有 fetch' };

	const base = (typeof config?.apiBase === 'string' && config.apiBase.trim().length > 0
		? config.apiBase.trim()
		: 'https://api.telegram.org').replace(/\/+$/, '');
	const url = `${base}/bot${token}/sendMessage`;

	try {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: renderTelegramText(notification),
				parse_mode: 'HTML',
				disable_web_page_preview: true
			}),
			signal: AbortSignal.timeout(15000)
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok || payload?.ok !== true) {
			const description = payload?.description ?? `HTTP ${response.status}`;
			return { ok: false, error: description };
		}
		return { ok: true, messageId: payload?.result?.message_id ?? null };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error) };
	}
}

/** 取 bot 身份，用于设置页的「测试连接」（同时校验 Token 是否有效）。 */
export async function getTelegramMe(config, fetchImpl = globalThis.fetch) {
	const token = typeof config?.botToken === 'string' ? config.botToken.trim() : '';
	if (token.length === 0) return { ok: false, error: '未配置 Telegram Bot Token' };
	const base = (typeof config?.apiBase === 'string' && config.apiBase.trim().length > 0
		? config.apiBase.trim()
		: 'https://api.telegram.org').replace(/\/+$/, '');
	try {
		const response = await fetchImpl(`${base}/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) });
		const payload = await response.json().catch(() => null);
		if (!response.ok || payload?.ok !== true) {
			return { ok: false, error: payload?.description ?? `HTTP ${response.status}` };
		}
		return { ok: true, username: payload.result?.username ?? null, name: payload.result?.first_name ?? null };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error) };
	}
}

/** 解析 Telegram 端点所需的 token 与 base（失败时给出可读错误）。 */
function resolveEndpoint(config) {
	const token = typeof config?.botToken === 'string' ? config.botToken.trim() : '';
	if (token.length === 0) return { error: '未配置 Telegram Bot Token' };
	const base = (typeof config?.apiBase === 'string' && config.apiBase.trim().length > 0
		? config.apiBase.trim()
		: 'https://api.telegram.org').replace(/\/+$/, '');
	return { token, base, url: `${base}/bot${token}` };
}

/** 把 Telegram 的 chat 对象压成设置页需要的形状。 */
function describeChat(chat) {
	const name = chat.title
		?? [chat.first_name, chat.last_name].filter(Boolean).join(' ')
		?? (chat.username ? `@${chat.username}` : '');
	return {
		id: String(chat.id),
		type: chat.type,
		label: name.length > 0 ? name : String(chat.id),
		username: chat.username ?? null
	};
}

/**
 * 从 bot 的最近更新里发现可用的 chat —— 这就是获取 Chat ID 的正规途径。
 *
 * Telegram 的 bot **不能**主动发起会话：必须先由你给 bot 发过至少一条消息，
 * `getUpdates` 才能看到那个 chat。本插件从不带 offset 调用，因此不会确认
 * （消费）更新，历史消息始终可见。
 *
 * @returns { ok: true, chats: [{ id, type, label, username }] } 或 { ok: false, error }
 */
export async function getTelegramChats(config, fetchImpl = globalThis.fetch) {
	const endpoint = resolveEndpoint(config);
	if (endpoint.error) return { ok: false, error: endpoint.error };
	if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行时没有 fetch' };
	try {
		const response = await fetchImpl(`${endpoint.url}/getUpdates?limit=100&timeout=0`, {
			signal: AbortSignal.timeout(15000)
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok || payload?.ok !== true) {
			return { ok: false, error: payload?.description ?? `HTTP ${response.status}` };
		}
		const seen = new Map();
		for (const update of payload.result ?? []) {
			const chat = update?.message?.chat ?? update?.edited_message?.chat ?? update?.channel_post?.chat;
			if (!chat || chat.id === undefined) continue;
			seen.set(String(chat.id), describeChat(chat));
		}
		return { ok: true, chats: [...seen.values()] };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error) };
	}
}

/**
 * 校验 Chat ID 是否可达（`getChat`）。用于「测试连接」真正验证整条链路，
 * 而不只是证明 token 有效。
 */
export async function getTelegramChat(config, chatId, fetchImpl = globalThis.fetch) {
	const endpoint = resolveEndpoint(config);
	if (endpoint.error) return { ok: false, error: endpoint.error };
	const id = typeof chatId === 'string' ? chatId.trim() : String(chatId ?? '');
	if (id.length === 0) return { ok: false, error: '未配置 Telegram Chat ID' };
	try {
		const response = await fetchImpl(`${endpoint.url}/getChat?chat_id=${encodeURIComponent(id)}`, {
			signal: AbortSignal.timeout(15000)
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok || payload?.ok !== true) {
			return { ok: false, error: payload?.description ?? `HTTP ${response.status}` };
		}
		return { ok: true, chat: describeChat(payload.result ?? {}) };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error) };
	}
}
