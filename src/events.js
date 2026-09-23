/**
 * dsh-session-tg-notify — 事件分类 + turn 跟踪。
 *
 * 把原始 DSH 事件归一化成「一次通知」，不在这里做任何输出或路由决策。
 *
 * 事件来源（均为 host 侧 Cordis 事件，不修改 DSH 核心）：
 *   - `session/event` 的 `turn/end`(reason.completed) + 最终 assistant 文本 → complete
 *   - `session/event` 的 `approval/asked`                                   → approval
 *   - `session/event` 的 `tool/call` + `ask_user_question`                   → question
 *   - `goal/changed` 的 block 操作                                          → block
 *   - `agent/error`                                                         → error
 *
 * 子代理过滤：DSH 中**活的**主会话 header 通常没有 delegationDepth 字段
 * （只有经 JSONL 恢复的会话才有 0），子代理的 delegationDepth >= 1。
 * 因此 `undefined` 或合法的 0 视为主会话，同时用 `header.origin === 'subagent'`
 * 兜底排除子代理；异常值保守拒绝（宁可不通知，也不要被子代理刷屏）。
 */

/** 是否主会话（子代理会话一律不通知）。 */
export function isMainSession(session) {
	const header = session?.header;
	if (!header || header.origin === 'subagent') return false;
	const depth = header.delegationDepth;
	if (depth === undefined) return true;
	return Number.isSafeInteger(depth) && depth === 0;
}

const isValidTurn = (turn) => Number.isSafeInteger(turn) && turn > 0;

/**
 * 工作区名称：取会话 cwd 的末段（DSH 的工作区就是以目录为单位），
 * 拿不到时退回 session id 前 8 位，保证通知里总有东西可显示。
 */
export function workspaceName(session) {
	const cwd = session?.header?.cwd;
	if (typeof cwd === 'string' && cwd.length > 0) {
		const parts = cwd.replace(/\/+$/, '').split('/');
		const last = parts[parts.length - 1];
		if (last) return last;
	}
	const id = session?.id;
	return typeof id === 'string' && id.length > 0 ? id.slice(0, 8) : '';
}

/** 截断为单行，避免通知正文过长。 */
export function oneLine(text, max = 120) {
	if (typeof text !== 'string') return '';
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * turn 跟踪：只为判定 `complete`（“存在最终 assistant 文本回答”）。
 *
 * 事件链：turn/start → [step 循环: assistant/message → tool/call → approval/asked …] → turn/end
 * `turn/end` 的 `reason.kind === 'completed'` 只表示物理 turn 平衡关闭，
 * 空 no-op claim 与工具 concludesTurn 路径也会产生 completed，二者没有
 * 最终文本回答，不应通知。
 */
export function createTurnTracker() {
	/** `${sessionId}:${turn}` → { startTime, firstUserMessage, lastAssistant, lastToolCall } */
	const turns = new Map();
	/** sessionId → 已消费的最大 turn 号（防止完整重放重复通知）。 */
	const endedTurns = new Map();
	/** sessionId → 最近一次 turn/start 的 turn 号（user/message 不自带 turn）。 */
	const currentTurns = new Map();
	let order = 0;

	const stamp = (event) => {
		order += 1;
		return { order, time: Number.isFinite(event?.time) ? event.time : null };
	};

	const entryOf = (session, turn) => {
		const sessionId = session?.id ?? 'unknown';
		const key = `${sessionId}:${turn}`;
		let entry = turns.get(key);
		if (!entry) {
			entry = { sessionId, startTime: null, firstUserMessage: null, lastAssistant: null, lastToolCall: null };
			turns.set(key, entry);
		}
		return entry;
	};

	/** 只认 source.kind === 'user' 的真实用户输入，排除系统注入快照。 */
	const userText = (event) => {
		const data = event?.data ?? {};
		if (data.source?.kind !== 'user') return null;
		const text = (Array.isArray(data.content) ? data.content : [])
			.filter((block) => block?.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
		return text.length > 0 ? text : null;
	};

	const assistantShape = (event) => {
		const content = event?.data?.message?.content;
		const blocks = Array.isArray(content) ? content : [];
		let hasText = false;
		let hasToolCall = false;
		for (const block of blocks) {
			if (!block || typeof block !== 'object') continue;
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) hasText = true;
			if (block.type === 'tool-call') hasToolCall = true;
		}
		return { hasText, hasToolCall };
	};

	const onTurnStart = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = event?.data?.turn;
		if (!isValidTurn(turn)) return;
		currentTurns.set(session.id ?? 'unknown', turn);
		entryOf(session, turn).startTime = stamp(event).time;
	};

	const onUserMessage = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = currentTurns.get(session?.id ?? 'unknown');
		if (!isValidTurn(turn)) return;
		const entry = turns.get(`${session?.id ?? 'unknown'}:${turn}`);
		if (!entry || entry.firstUserMessage !== null) return;
		const text = userText(event);
		if (text !== null) entry.firstUserMessage = text;
	};

	const onAssistantMessage = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = event?.data?.turn;
		if (!isValidTurn(turn)) return;
		const entry = entryOf(session, turn);
		entry.lastAssistant = { ...stamp(event), ...assistantShape(event) };
	};

	const onToolCall = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = event?.data?.turn;
		if (!isValidTurn(turn)) return;
		entryOf(session, turn).lastToolCall = stamp(event);
	};

	/**
	 * 严格 complete 判定：turn/end(completed) + 最后一个 assistant/message
	 * 是非空纯文本（不是 tool-call-only/混合）+ 其后没有新的 tool/call。
	 * @returns { turn, durationMs, summary } 或 null。
	 */
	const onTurnEnd = (session, event) => {
		if (event?.type !== 'turn/end' || !isMainSession(session)) return null;
		const turn = event?.data?.turn;
		if (!isValidTurn(turn)) return null;
		const sessionId = session?.id ?? 'unknown';
		const lastEnded = endedTurns.get(sessionId);
		const alreadyEnded = typeof lastEnded === 'number' && turn <= lastEnded;
		if (!alreadyEnded) endedTurns.set(sessionId, turn);
		if (currentTurns.get(sessionId) === turn) currentTurns.delete(sessionId);
		const entry = turns.get(`${sessionId}:${turn}`);
		turns.delete(`${sessionId}:${turn}`);
		if (alreadyEnded || event?.data?.reason?.kind !== 'completed' || !entry) return null;
		const lastAssistant = entry.lastAssistant;
		const isFinalText = lastAssistant?.hasText === true && lastAssistant?.hasToolCall !== true;
		const noToolAfter = lastAssistant !== null &&
			(entry.lastToolCall === null || lastAssistant.order > entry.lastToolCall.order);
		if (!isFinalText || !noToolAfter) return null;
		const durationMs = entry.startTime !== null && Number.isFinite(event.time)
			? Math.max(0, event.time - entry.startTime)
			: null;
		return { turn, durationMs, summary: entry.firstUserMessage ?? null };
	};

	const onSessionDisposed = (session) => {
		const sessionId = session?.id;
		if (typeof sessionId !== 'string' || sessionId.length === 0) return;
		currentTurns.delete(sessionId);
		endedTurns.delete(sessionId);
		for (const [key, entry] of turns) if (entry.sessionId === sessionId) turns.delete(key);
	};

	return { onTurnStart, onUserMessage, onAssistantMessage, onToolCall, onTurnEnd, onSessionDisposed };
}

/** 分类 `session/event` 的 approval/asked（等待人工批准工具操作）。 */
export function classifyApproval(session, event) {
	if (!isMainSession(session) || event?.type !== 'approval/asked') return null;
	const data = event.data ?? {};
	const id = typeof data.id === 'string' && data.id.length > 0 ? data.id : 'unknown';
	const sessionId = session?.id ?? 'unknown';
	const toolName = typeof data.toolName === 'string' && data.toolName.length > 0 ? data.toolName : '(unknown tool)';
	const reason = typeof data.reason === 'string' && data.reason.length > 0 ? data.reason : null;
	return {
		kind: 'approval',
		sessionId,
		body: oneLine(reason === null ? toolName : `${toolName} — ${reason}`),
		detail: { toolName, reason },
		dedupeKey: `approval:${sessionId}:${id}`
	};
}

/**
 * 分类 Agent 主动提问。
 *
 * 可靠监听点是 session 的 durable `tool/call` 事件且 name === 'ask_user_question'
 * （`question/requested` 下行帧属 API 层，host 侧不保证可见）。
 */
export function classifyQuestion(session, event) {
	if (!isMainSession(session) || event?.type !== 'tool/call') return null;
	const data = event.data ?? {};
	if (data.name !== 'ask_user_question') return null;
	let args = {};
	try {
		args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : {};
	} catch {
		// 参数解析失败仍通知，正文退化为占位文本。
	}
	const questions = Array.isArray(args.questions) ? args.questions : [];
	const first = questions[0] ?? {};
	const text = typeof first.question === 'string' && first.question.length > 0 ? first.question : null;
	const optionsCount = Array.isArray(first.options) ? first.options.length : 0;
	const sessionId = session?.id ?? 'unknown';
	const suffix = optionsCount > 0 ? `（${optionsCount} 个选项）` : '';
	return {
		kind: 'question',
		sessionId,
		body: oneLine(text === null ? '(Agent 提问)' : text) + suffix,
		detail: { questionText: text, optionsCount, questionCount: questions.length },
		dedupeKey: `question:${sessionId}:${data.callId ?? 'unknown'}`
	};
}

/** 分类 `goal/changed`：只有 block 操作需要打扰用户。 */
export function classifyGoalChange(change) {
	if (!change || change.operation !== 'block') return null;
	const goal = change.goal ?? null;
	const ref = change.ref ?? null;
	const objective = typeof goal?.objective === 'string' && goal.objective.length > 0 ? goal.objective : null;
	return {
		kind: 'block',
		sessionId: null,
		body: oneLine(objective ?? '(未提供目标描述)'),
		detail: { objective },
		dedupeKey: ref ? `goal:${ref.id}@${ref.revision}` : `goal:block:${goal?.id ?? 'unknown'}`
	};
}

/** 分类 `agent/error`（step/turn 级错误）。 */
export function classifyAgentError(payload) {
	if (!payload) return null;
	const { agent, turn, step, error } = payload;
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
	return {
		kind: 'error',
		sessionId: typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : null,
		body: oneLine(message),
		detail: { message, turn: Number.isFinite(turn) ? turn : null, step: Number.isFinite(step) ? step : null },
		dedupeKey: `error:${agent?.id ?? 'unknown'}@${turn ?? '-'}@${step ?? '-'}`
	};
}

/** 分类 `session/event` 的 turn/end → complete（需配合 createTurnTracker）。 */
export function classifyTurnEnd(session, complete) {
	if (!complete) return null;
	const sessionId = session?.id ?? 'unknown';
	const durationText = complete.durationMs === null ? '' : `（${Math.round(complete.durationMs / 1000)}s）`;
	return {
		kind: 'complete',
		sessionId,
		body: oneLine(complete.summary ?? `第 ${complete.turn} 轮`) + durationText,
		detail: { turn: complete.turn, durationMs: complete.durationMs, summary: complete.summary },
		dedupeKey: `complete:${sessionId}:${complete.turn}`
	};
}

/** 去重容器：有界 FIFO，避免长会话把内存撑大。 */
export function createDedupe(maxKeys = 2000) {
	const perSession = new Map();
	const sessionless = new Set();

	const remember = (store, key) => {
		if (store.has(key)) return false;
		if (store.size >= maxKeys) {
			const oldest = store.values().next().value;
			if (oldest !== undefined) store.delete(oldest);
		}
		store.add(key);
		return true;
	};

	return {
		/** @returns true = 首次出现（允许通知）；false = 重复。 */
		admit(sessionId, key) {
			if (typeof sessionId === 'string' && sessionId.length > 0) {
				let keys = perSession.get(sessionId);
				if (!keys) {
					keys = new Set();
					perSession.set(sessionId, keys);
				}
				return remember(keys, key);
			}
			return remember(sessionless, key);
		},
		forget(sessionId) {
			if (typeof sessionId === 'string' && sessionId.length > 0) perSession.delete(sessionId);
		}
	};
}
