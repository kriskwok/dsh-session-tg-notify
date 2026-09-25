// dsh-session-tg-notify — 浏览器端（client bundle）
//
// 三件事：
//   1. 状态上报 —— 每 10 秒 + 每次 visibility/focus/blur 变化，把
//      { visibility, focused } POST 给后端；后端据此判定前台/后台/离线。
//      存活信号是 SSE 长连接本身（页面关闭 → 连接断 → 后端改走 Telegram）。
//   2. 通知呈现 —— 收到 toast 帧就画页面内提示；收到 webnotify 帧就发
//      macOS 系统通知（Chrome 的通知中心条目，点击天然切回本标签页），
//      并按配置播放提示音。
//   3. 设置面板 —— 对话页顶栏铃铛打开：逐事件勾选桌面/Telegram、逐事件
//      测试推送、桌面声音与音色、Telegram Bot Token 与 Chat ID。
//
// 本文件是打包产物格式的浏览器 bundle：注册到 window.__ModuleLoader__，
// 工厂函数内通过 require() 解析平台种子模块（react），与官方 dsh-client-*
// 包发布的 client.js 结构一致。

window.__ModuleLoader__.load({
	id: "dsh-session-tg-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");

		var API = "/session-notify";
		var CLIENT_ID_KEY = "dsh-session-tg-notify:client-id";
		var HEARTBEAT_MS = 10000;
		var TOAST_MS = 9000;

		//#region 样式
		var CSS = [
			// 顶栏按钮（与 Session log 按钮同风格）
			".dsn-entry{position:relative;flex:none;display:inline-flex}",
			".dsn-bell{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:32px;height:32px;color:var(--dsw-alias-label-primary);background:0 0;border-radius:16px;justify-content:center;align-items:center;padding:0;display:inline-flex;flex:none;cursor:pointer}",
			".dsn-bell:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsn-bell:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".dsn-bell[data-active=\"false\"]{color:var(--dsw-alias-label-dimmed)}",
			// 模态面板
			".dsn-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;padding:24px;font-family:var(--dsw-font-family,system-ui);}",
			".dsn-panel{box-sizing:border-box;width:560px;max-width:100%;max-height:min(760px,88vh);overflow:auto;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.1));border-radius:14px;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.28));padding:18px 18px 14px}",
			".dsn-hd{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}",
			".dsn-hd h3{margin:0;font-size:16px;font-weight:650;flex:1}",
			".dsn-ver{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}",
			".dsn-x{box-sizing:border-box;border:0;background:0 0;color:var(--dsw-alias-label-secondary,#666);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}",
			".dsn-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
			".dsn-sec{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}",
			".dsn-sec:first-of-type{border-top:0;padding-top:0;margin-top:6px}",
			".dsn-sec h4{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#555)}",
			".dsn-row{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px}",
			".dsn-row .dsn-grow{flex:1}",
			".dsn-grid{display:grid;grid-template-columns:1fr 62px 62px 116px;gap:6px 8px;align-items:center;font-size:13px}",
			".dsn-grid .dsn-gh{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);text-align:center;font-weight:500}",
			".dsn-grid .dsn-gl{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-weight:500}",
			".dsn-cell{display:flex;justify-content:center}",
			".dsn-acts{display:flex;gap:4px;justify-content:center}",
			".dsn-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:0 0;color:var(--dsw-alias-label-primary,#111);font-family:inherit;font-size:12px;border-radius:8px;padding:3px 9px;cursor:pointer;white-space:nowrap}",
			".dsn-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
			".dsn-btn:disabled{color:var(--dsw-alias-label-dimmed,#aaa);cursor:default}",
			".dsn-btn[data-tone=\"primary\"]{background:var(--dsw-alias-brand-primary,#3b6cf6);border-color:transparent;color:#fff}",
			".dsn-input{box-sizing:border-box;width:100%;font-family:inherit;font-size:13px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:0 0;color:inherit}",
			".dsn-note{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888);margin:6px 0 0}",
			".dsn-state{display:inline-flex;align-items:center;gap:5px;font-size:12px}",
			".dsn-dot{width:7px;height:7px;border-radius:50%;flex:none}",
			".dsn-msg{font-size:12px;margin:6px 0 0;min-height:16px}",
			".dsn-msg[data-kind=\"ok\"]{color:#22a06b}",
			".dsn-msg[data-kind=\"err\"]{color:var(--dsw-alias-state-error-primary,#e5484d)}",
			// 页面内 toast
			".dsn-toasts{position:fixed;top:16px;right:16px;z-index:2147483001;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:var(--dsw-font-family,system-ui)}",
			".dsn-toast{box-sizing:border-box;pointer-events:auto;width:320px;padding:10px 12px;border-radius:12px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.1));box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.22));cursor:pointer;animation:dsn-in .18s ease-out}",
			"@keyframes dsn-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}",
			".dsn-toast-t{font-size:13px;font-weight:650;margin-bottom:3px;display:flex;gap:6px;align-items:center}",
			".dsn-toast-b{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#555);word-break:break-word}",
			".dsn-toast-f{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:4px}",
			".dsn-toast[data-activatable=\"true\"]:hover{border-color:var(--dsw-alias-brand-primary,#3b6cf6)}"
		].join("\n");
		//#endregion

		//#region 小工具
		/** 每个标签页一个稳定 id（sessionStorage 随标签页存活，刷新不变）。 */
		function getClientId() {
			try {
				var existing = sessionStorage.getItem(CLIENT_ID_KEY);
				if (existing) return existing;
				var id = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
				sessionStorage.setItem(CLIENT_ID_KEY, id);
				return id;
			} catch (error) {
				// 隐私模式等禁用 storage：退化为进程内随机 id（新开标签页视为新客户端）
				return "c" + Math.random().toString(36).slice(2, 12);
			}
		}

		/** 调用后端 API；网络异常收敛成 { ok:false, error }，不抛给调用方。 */
		function api(endpoint, options) {
			var opts = options || {};
			var init = { method: opts.method || (opts.body ? "POST" : "GET") };
			if (opts.body) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(opts.body);
			}
			return fetch(API + "/" + endpoint, init)
				.then(function (res) { return res.json(); })
				.catch(function (error) { return { ok: false, error: String(error && error.message ? error.message : error) }; });
		}
		//#endregion

		//#region 提示音（Web Audio 合成，无需素材文件）
		/** 三种音色 → [频率, 起始偏移] 序列。 */
		var TONE_NOTES = {
			ding: [[880, 0]],
			alert: [[880, 0], [660, 0.18]],
			chime: [[660, 0], [880, 0.14], [1175, 0.28]]
		};

		/**
		 * 提示音播放器。浏览器 autoplay 策略要求先有用户手势解锁，
		 * 因此首次 pointerdown/keydown 时 resume()；未解锁时返回 false，
		 * 调用方据此回退到系统默认通知音。
		 */
		function createTonePlayer() {
			var player = { ctx: null, unlocked: false, unlockDisposer: null };

			player.ensure = function () {
				if (player.ctx !== null) return player.ctx;
				var Ctor = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
				if (!Ctor) return null;
				try {
					player.ctx = new Ctor();
				} catch (error) {
					player.ctx = null;
				}
				return player.ctx;
			};

			player.unlock = function () {
				var ctx = player.ensure();
				if (!ctx) return;
				if (typeof ctx.resume === "function") ctx.resume();
				if (ctx.state === "running") player.unlocked = true;
			};

			player.attachUnlock = function () {
				if (player.unlockDisposer !== null) return;
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
				var handler = function () {
					player.unlock();
					if (player.unlocked) player.detachUnlock();
				};
				window.addEventListener("pointerdown", handler, true);
				window.addEventListener("keydown", handler, true);
				player.unlockDisposer = function () {
					window.removeEventListener("pointerdown", handler, true);
					window.removeEventListener("keydown", handler, true);
				};
			};

			player.detachUnlock = function () {
				if (player.unlockDisposer === null) return;
				var dispose = player.unlockDisposer;
				player.unlockDisposer = null;
				dispose();
			};

			/** @returns true = 已用合成音播放；false = 未解锁/不支持，调用方回退系统音。 */
			player.play = function (tone) {
				if (!tone || tone === "none") return true; // 用户选择无声，视作已处理
				var ctx = player.ensure();
				if (!ctx) return false;
				if (ctx.state === "suspended" && typeof ctx.resume === "function") ctx.resume();
				if (ctx.state !== "running") return false;
				var notes = TONE_NOTES[tone] || TONE_NOTES.ding;
				var base = ctx.currentTime;
				for (var i = 0; i < notes.length; i++) {
					var freq = notes[i][0];
					var at = base + notes[i][1];
					var osc = ctx.createOscillator();
					var gain = ctx.createGain();
					osc.type = "sine";
					osc.frequency.value = freq;
					gain.gain.setValueAtTime(0.0001, at);
					gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
					gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
					osc.connect(gain);
					gain.connect(ctx.destination);
					osc.start(at);
					osc.stop(at + 0.4);
				}
				return true;
			};

			player.dispose = function () {
				player.detachUnlock();
				if (player.ctx !== null) {
					try { player.ctx.close(); } catch (error) { /* 忽略 */ }
					player.ctx = null;
				}
			};

			return player;
		}
		//#endregion

		//#region 页面内 toast
		/**
		 * 页面内 toast 容器。
		 * @param options.onActivate - 点击通知时调用，参数是该通知的 payload；
		 *   用于「点击直达对应会话」。缺省时只把窗口拉到前台。
		 */
		function createToastHost(options) {
			var activate = options && typeof options.onActivate === "function" ? options.onActivate : null;
			var host = null;
			var dispose = function () {
				if (host && host.parentNode) host.parentNode.removeChild(host);
				host = null;
			};
			return {
				show: function (payload) {
					if (typeof document === "undefined") return;
					if (host === null) {
						host = document.createElement("div");
						host.className = "dsn-toasts";
						host.setAttribute("data-plugin", "dsh-session-tg-notify");
						document.body.append(host);
					}
					var el = document.createElement("div");
					el.className = "dsn-toast";
					var head = document.createElement("div");
					head.className = "dsn-toast-t";
					// 宿主已把标题组装成「{emoji} {事件类型}：{会话标题}」，这里原样渲染
					head.textContent = payload.title || "通知";
					head.style.whiteSpace = "normal";
					var body = document.createElement("div");
					body.className = "dsn-toast-b";
					body.textContent = payload.body || "";
					el.append(head, body);
					// 工作区已经作为「工作区名称」附在正文末尾，不再单起页脚
					var timer = setTimeout(function () {
						if (el.parentNode) el.parentNode.removeChild(el);
					}, TOAST_MS);
					// 可点击时才做成手型，避免给用户「点了没反应」的假承诺
					if (activate !== null && payload.sessionId) el.setAttribute("data-activatable", "true");
					el.addEventListener("click", function () {
						clearTimeout(timer);
						if (el.parentNode) el.parentNode.removeChild(el);
						try { window.focus(); } catch (error) { /* 忽略 */ }
						if (activate !== null) activate(payload);
					});
					host.append(el);
				},
				dispose: dispose
			};
		}
		//#endregion

		//#region 插件入口
		// uiWorkspace 提供 openSession(sessionId)，是客户端唯一「切到指定会话」的
		// 正规入口（dsh-client-ui-workspace 的 UiWorkspaceService，ctx 键 "uiWorkspace"）。
		var inject = ["slots", "locale", "uiWorkspace"];

		function apply(ctx) {
			var clientId = getClientId();
			var tone = createTonePlayer();

			/**
			 * 切到指定会话。这是「点击通知直达会话」的落点。
			 * 服务缺失或会话已归档时静默失败——通知点击不该因为导航失败而报错。
			 * @returns 是否成功发起导航
			 */
			function openSessionById(sessionId) {
				if (typeof sessionId !== "string" || sessionId.length === 0) return false;
				var nav = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : ctx.uiWorkspace;
				if (!nav || typeof nav.openSession !== "function") return false;
				try {
					nav.openSession(sessionId);
					return true;
				} catch (error) {
					console.warn("[session-notify] 打开会话失败:", sessionId, error);
					return false;
				}
			}

			var toasts = createToastHost({
				onActivate: function (payload) { openSessionById(payload && payload.sessionId); }
			});
			/** 最近一次从后端拿到的状态（设置面板打开时用于渲染）。 */
			var lastState = { config: null, presence: null, events: [], configPath: "" };
			var panel = null;

			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-session-tg-notify");
				style.textContent = CSS;
				document.head.append(style);
				return function () { style.remove(); };
			}, "dsh-session-tg-notify: styles");

			// 通知序号：宿主给的是毫秒时间戳，同一毫秒内连续到达的两条事件会撞 tag，
			// 又会退回「静默替换」。这里用一个单调递增的本地序号兜底。
			var notifySeq = 0;

			// ---- 通知呈现
			ctx.effect(function () {
				tone.attachUnlock();
				return function () { tone.dispose(); };
			}, "dsh-session-tg-notify: audio");

			function showSystemNotification(payload) {
				if (typeof Notification === "undefined") {
					toasts.show(payload);
					return;
				}
				if (Notification.permission !== "granted") {
					// 没授权就退化为页面内提示，避免静默丢失
					toasts.show(payload);
					return;
				}
				var played = tone.play(payload.tone);
				try {
					var note = new Notification(payload.title || "DSH 通知", {
						body: payload.body || "", 
						// body 末尾已带「工作区名称」，无需再拼页脚
						//
						// tag 必须每条唯一。早先只用事件类型做 tag，于是同一类型的
						// 第二条通知会**静默替换**通知中心里还挂着的那条：macOS 不再弹
						// 横幅、也不再响铃。表现就是「偶尔收不到」，且很难复现——间隔久了
						// 旧通知已被清走就又能弹。所以这里拼上会话、事件类型和宿主给的
						// 唯一 at（毫秒时间戳），保证每条都是独立条目。
						tag: "dsn:" + (payload.sessionId || "na") + ":" + (payload.kind || "event") + ":" + (payload.at || 0) + ":" + (++notifySeq),
						// 合成音已播放时抑制系统音；未解锁则让系统出默认声，保证一定有声音
						silent: played
					});
					note.onclick = function () {
						try { window.focus(); } catch (error) { /* 忽略 */ }
						// 点击系统通知同样直达对应会话
						openSessionById(payload.sessionId);
						note.close();
					};
				} catch (error) {
					toasts.show(payload);
				}
			}

			// ---- 状态上报（心跳 + 焦点/可见性变化）
			var reportPresence = function () {
				if (typeof document === "undefined") return;
				api("presence", {
					body: {
						clientId: clientId,
						visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
						focused: typeof document.hasFocus === "function" ? document.hasFocus() : false
					}
				});
			};

			// ---- SSE：存活信号 + 通知下发
			ctx.effect(function () {
				if (typeof EventSource === "undefined") return;
				var es = new EventSource(API + "/events?clientId=" + encodeURIComponent(clientId));
				var handler = function (event) {
					var payload = null;
					try { payload = JSON.parse(event.data); } catch (error) { return; }
					if (payload && payload.kind) showSystemNotification(payload);
				};
				es.addEventListener("toast", function (event) {
					var payload = null;
					try { payload = JSON.parse(event.data); } catch (error) { return; }
					tone.play(payload.tone);
					toasts.show(payload);
				});
				es.addEventListener("webnotify", handler);
				es.addEventListener("ready", function (event) {
					reportPresence();
					console.debug("[session-notify] ready", event.data);
				});
				return function () { es.close(); };
			}, "dsh-session-tg-notify: sse");

			// ---- 心跳：定期 + 焦点/可见性变化时立即上报
			ctx.effect(function () {
				reportPresence();
				var interval = setInterval(reportPresence, HEARTBEAT_MS);
				document.addEventListener("visibilitychange", reportPresence);
				window.addEventListener("focus", reportPresence);
				window.addEventListener("blur", reportPresence);
				return function () {
					clearInterval(interval);
					document.removeEventListener("visibilitychange", reportPresence);
					window.removeEventListener("focus", reportPresence);
					window.removeEventListener("blur", reportPresence);
				};
			}, "dsh-session-tg-notify: presence");

			// ---- 设置面板
			panel = createSettingsPanel({
				clientId: clientId,
				open: function () { return lastState; },
				refresh: function () { return api("state").then(function (res) { if (res.ok) lastState = res.value; return res; }); }
			});
			ctx.effect(function () {
				return function () { panel.dispose(); toasts.dispose(); };
			}, "dsh-session-tg-notify: panel");

			ctx.effect(function () {
				if (!ctx.locale || typeof ctx.locale.register !== "function") return;
				return ctx.locale.register("session-notify", { en: { notifications: "Session notifications" }, zh: { notifications: "会话通知" } });
			}, "dsh-session-tg-notify: locale");

			ctx.effect(function () {
				return ctx.slots.inject("conversation.session.header.utilities", function () {
					var dispose = ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "session-notify-entry",
						order: 91,
						locale: "session-notify",
						inject: function () { return {}; }
					}, function NotifyEntry() {
						return react.createElement(
							"span",
							{ className: "dsn-entry" },
							react.createElement(
								"button",
								{
									type: "button",
									className: "dsn-bell",
									title: "会话通知设置",
									"aria-label": "会话通知设置",
									onClick: function () { panel.toggle(); }
								},
								react.createElement(
									"svg",
									{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true, focusable: "false" },
									react.createElement("path", {
										d: "M12 2a2 2 0 0 1 2 2v.6A6.5 6.5 0 0 1 18.5 11v3.2l1.32 2.1A1 1 0 0 1 18.99 17.8H5.01a1 1 0 0 1-.83-1.5L5.5 14.2V11A6.5 6.5 0 0 1 10 4.6V4a2 2 0 0 1 2-2Zm0 19a2.5 2.5 0 0 1-2.45-2h4.9A2.5 2.5 0 0 1 12 21Z",
										fill: "currentColor"
									})
								)
							)
						);
					});
					return function () { dispose(); };
				});
			}, "dsh-session-tg-notify: entry");
		}
		//#endregion

		//#region 设置面板（纯 DOM，便于承载较多控件）
		/**
		 * 构建设置面板。所有控件直接改后端配置（保存即生效，无需重启 DSH）。
		 * @param deps - { clientId, open(), refresh() }
		 */
		function createSettingsPanel(deps) {
			var mask = null;
			var msgTimer = null;

			function el(tag, className, text) {
				var node = document.createElement(tag);
				if (className) node.className = className;
				if (text !== undefined) node.textContent = text;
				return node;
			}

			function button(label, onClick, tone) {
				var node = el("button", "dsn-btn", label);
				node.type = "button";
				if (tone) node.setAttribute("data-tone", tone);
				node.addEventListener("click", onClick);
				return node;
			}

			function setMessage(text, kind) {
				if (!mask) return;
				var target = mask.querySelector(".dsn-msg");
				if (!target) return;
				target.textContent = text || "";
				target.setAttribute("data-kind", kind || "");
				if (msgTimer !== null) clearTimeout(msgTimer);
				if (text) msgTimer = setTimeout(function () { target.textContent = ""; }, 6000);
			}

			/** 保存局部配置补丁并重绘。 */
			function save(patch, okText) {
				return api("config", { body: patch }).then(function (res) {
					if (res.ok) {
						setMessage(okText || "已保存", "ok");
						render(res.value);
					} else {
						setMessage("保存失败：" + (res.error || "未知错误"), "err");
					}
					return res;
				});
			}

			function render(state) {
				if (!mask) return;
				var body = mask.querySelector(".dsn-body");
				body.textContent = "";
				// 首次打开时只有空快照（还没从后端读到配置）——必须在这里提前返回：
				// 否则下面访问 config.desktop 会抛异常，连带把 openPanel 里后续的
				// refresh() 调用一起中断，面板就永远停在空白。
				if (!state || !state.config) {
					var loading = el("div", "dsn-sec");
					loading.append(el("p", "dsn-note", "正在读取配置…若此处长时间没有内容，说明后端 /session-notify 接口不可达。"));
					body.append(loading);
					return;
				}
				var config = state.config;
				var presence = state.presence || { state: "offline", count: 0 };
				var desktop = config.desktop || {};
				var telegram = config.telegram || {};
				var events = state.events || [];

				// ---- 总开关 + 当前状态
				var head = el("div", "dsn-sec");
				var top = el("div", "dsn-row");
				var master = el("input");
				master.type = "checkbox";
				master.checked = config.enabled !== false;
				master.addEventListener("change", function () {
					save({ enabled: master.checked }, master.checked ? "通知已开启" : "通知已关闭");
				});
				var masterLabel = el("span", "dsn-grow", "启用会话通知");
				var stateWrap = el("span", "dsn-state");
				var dot = el("span", "dsn-dot");
				// 后台这一档要区分「只是切走了」和「人真的锁屏走了」——两者的通道
				// 完全不同（前者只发系统通知，后者才可能推 Telegram）。
				var screen = state.screen || {};
				var lockSuffix = screen.supported === false
					? "（无法探测锁屏）"
					: screen.locked ? "（已锁屏）" : "（未锁屏）";
				var stateMap = {
					foreground: ["#22a06b", "网页前台 · toast"],
					background: ["#e0a400", "网页后台 · 系统通知" + lockSuffix],
					offline: ["#9aa0a6", "网页未打开 · Telegram"]
				};
				var info = stateMap[presence.state] || stateMap.offline;
				dot.style.background = info[0];
				stateWrap.append(dot, el("span", null, info[1] + (presence.count > 1 ? "（" + presence.count + " 个标签页）" : "")));
				top.append(master, masterLabel, stateWrap);
				head.append(top);
				body.append(head);

				// ---- 「会话完成」的最短时长阈值
				// 以前这个阈值只能改配置文件、面板里完全没有入口，于是「发个『你好』
				// 这种几秒结束的 turn 收不到通知」看起来像插件坏了。
				var minRow = el("div", "dsn-row");
				minRow.append(el("span", "dsn-grow", "最短完成时长（秒，0 = 不过滤）"));
				var minInput = el("input", "dsn-input");
				minInput.type = "number";
				minInput.min = "0";
				minInput.step = "1";
				minInput.style.width = "80px";
				minInput.value = String(config.minDuration === undefined ? 0 : config.minDuration);
				minInput.addEventListener("change", function () {
					var n = parseInt(minInput.value, 10);
					if (!isFinite(n) || n < 0) { minInput.value = String(config.minDuration || 0); return; }
					save({ minDuration: n }, n === 0 ? "已关闭时长过滤" : "已设为 " + n + " 秒");
				});
				minRow.append(minInput);
				body.append(minRow);

				// ---- 逐事件：桌面 / Telegram / 测试
				var evSec = el("div", "dsn-sec");
				evSec.append(el("h4", null, "事件与通道"));
				var grid = el("div", "dsn-grid");
				grid.append(el("div", "dsn-gl", "事件"), el("div", "dsn-gh", "桌面"), el("div", "dsn-gh", "TG"), el("div", "dsn-gh", "测试推送"));
				for (var i = 0; i < events.length; i++) {
					(function (meta) {
						var cfg = (config.events && config.events[meta.kind]) || { desktop: false, telegram: false };
						grid.append(el("div", "dsn-gl", meta.emoji + " " + meta.label));

						var dCell = el("div", "dsn-cell");
						var dBox = el("input");
						dBox.type = "checkbox";
						dBox.checked = cfg.desktop === true;
						dBox.addEventListener("change", function () {
							var patch = { events: {} };
							patch.events[meta.kind] = { desktop: dBox.checked };
							save(patch);
						});
						dCell.append(dBox);
						grid.append(dCell);

						var tCell = el("div", "dsn-cell");
						var tBox = el("input");
						tBox.type = "checkbox";
						tBox.checked = cfg.telegram === true;
						tBox.addEventListener("change", function () {
							var patch = { events: {} };
							patch.events[meta.kind] = { telegram: tBox.checked };
							save(patch);
						});
						tCell.append(tBox);
						grid.append(tCell);

						var acts = el("div", "dsn-acts");
						acts.append(button("桌面", function () {
							api("test", { body: { kind: meta.kind, channel: "desktop", clientId: deps.clientId } }).then(function (res) {
								setMessage(res.ok ? "已发出桌面测试（系统通知）" : "测试失败：" + res.error, res.ok ? "ok" : "err");
							});
						}));
						acts.append(button("TG", function () {
							api("test", { body: { kind: meta.kind, channel: "telegram" } }).then(function (res) {
								setMessage(res.ok ? "已发出 Telegram 测试" : "测试失败：" + res.error, res.ok ? "ok" : "err");
							});
						}));
						grid.append(acts);
					})(events[i]);
				}
				evSec.append(grid);
				evSec.append(el("p", "dsn-note", "勾选 = 订阅该通道（不是立即发送）。桌面：前台页面内提示、后台 macOS 系统通知，点击通知直达对应会话；TG：前台永不发，后台需同时打开下面的「网页后台且锁屏时推送」，网页关闭时直接发 TG。两个都不勾 = 该事件完全不打扰。「测试」中的桌面按钮固定发系统通知，便于验证通知中心与声音。"));
				body.append(evSec);

				// ---- 桌面通知
				var deskSec = el("div", "dsn-sec");
				deskSec.append(el("h4", null, "桌面通知"));
				var deskRow = el("div", "dsn-row");
				var soundBox = el("input");
				soundBox.type = "checkbox";
				soundBox.checked = desktop.sound !== false;
				soundBox.addEventListener("change", function () { save({ desktop: { sound: soundBox.checked } }); });
				var toneSelect = el("select", "dsn-input");
				toneSelect.style.width = "120px";
				var toneOptions = [["ding", "叮"], ["alert", "双响"], ["chime", "三连音"], ["none", "静音"]];
				for (var t = 0; t < toneOptions.length; t++) {
					var opt = el("option", null, toneOptions[t][1]);
					opt.value = toneOptions[t][0];
					if (desktop.tone === toneOptions[t][0]) opt.selected = true;
					toneSelect.append(opt);
				}
				toneSelect.addEventListener("change", function () { save({ desktop: { tone: toneSelect.value } }); });
				deskRow.append(soundBox, el("span", "dsn-grow", "提示音"), toneSelect);
				deskSec.append(deskRow);

				var permRow = el("div", "dsn-row");
				var permText = typeof Notification === "undefined"
					? "当前浏览器不支持通知 API"
					: Notification.permission === "granted" ? "系统通知权限：已授权"
						: Notification.permission === "denied" ? "系统通知权限：已被拒绝（需在浏览器站点设置里恢复）"
							: "系统通知权限：未授权";
				permRow.append(el("span", "dsn-grow", permText));
				var permBtn = button("请求权限", function () {
					if (typeof Notification === "undefined") return;
					Notification.requestPermission().then(function (result) {
						setMessage("权限：" + result, result === "granted" ? "ok" : "err");
						render(deps.open());
					});
				});
				permBtn.disabled = typeof Notification === "undefined" || Notification.permission === "granted";
				permRow.append(permBtn);
				deskSec.append(permRow);
				deskSec.append(el("p", "dsn-note", "系统通知由本页面发出（Chrome 的通知中心条目）。点击通知会切回本标签页，并直接打开对应的那个会话。首次使用需要授权；若权限未授权，后台通知会退化为页面内提示。"));
				body.append(deskSec);

				// ---- Telegram
				var tgSec = el("div", "dsn-sec");
				tgSec.append(el("h4", null, "Telegram"));
				var tgEnableRow = el("div", "dsn-row");
				var tgEnable = el("input");
				tgEnable.type = "checkbox";
				tgEnable.checked = telegram.enabled === true;
				tgEnable.addEventListener("change", function () { save({ telegram: { enabled: tgEnable.checked } }); });
				var bgBox = el("input");
				bgBox.type = "checkbox";
				bgBox.checked = telegram.notifyWhenLocked === true;
				bgBox.addEventListener("change", function () { save({ telegram: { notifyWhenLocked: bgBox.checked } }); });
				tgEnableRow.append(tgEnable, el("span", "dsn-grow", "启用 Telegram 通道"), bgBox, el("span", null, "网页后台且锁屏时推送"));
				tgSec.append(tgEnableRow);

				var tokenInput = el("input", "dsn-input");
				tokenInput.type = "password";
				tokenInput.autocomplete = "off";
				tokenInput.placeholder = telegram.hasBotToken ? "Bot Token 已配置（留空则保持不变）" : "123456:ABC-DEF...（@BotFather 获取）";
				var chatInput = el("input", "dsn-input");
				chatInput.type = "text";
				chatInput.autocomplete = "off";
				chatInput.value = telegram.chatId || "";
				chatInput.placeholder = "Chat ID，例如 123456789";
				var f1 = el("div", "dsn-row");
				f1.append(el("span", null, "Bot Token"), tokenInput);
				var f2 = el("div", "dsn-row");
				f2.append(el("span", null, "Chat ID"), chatInput);
				tgSec.append(f1, f2);

				var tgActs = el("div", "dsn-row");
				tgActs.append(button("保存凭据", function () {
					var patch = { telegram: { chatId: chatInput.value.trim() } };
					// 留空表示不改动已存的 Token
					if (tokenInput.value.trim().length > 0) patch.telegram.botToken = tokenInput.value.trim();
					if (patch.telegram.chatId.length === 0) {
						// 允许只存 token，但必须说清 Chat ID 为空会导致发送失败，
						// 而不是显示一句「已保存」让人以为配好了。
						save(patch, "Bot Token 已保存，但 Chat ID 为空 —— Telegram 不会发出任何消息（bot 无法主动发起会话，请先给 bot 发一条消息再点「获取 Chat ID」）").then(function () { tokenInput.value = ""; });
						return;
					}
					save(patch, "凭据已保存").then(function () { tokenInput.value = ""; });
				}, "primary"));
				tgActs.append(button("获取 Chat ID", function () {
					var probe = { chatId: chatInput.value.trim() };
					if (tokenInput.value.trim().length > 0) probe.botToken = tokenInput.value.trim();
					if (tokenInput.value.trim().length === 0 && !telegram.hasBotToken) {
						setMessage("请先填写 Bot Token", "err");
						return;
					}
					api("telegram-chats", { body: probe }).then(function (res) {
						if (!res.ok) { setMessage("获取失败：" + res.error, "err"); return; }
						var chats = res.chats || [];
						if (chats.length === 0) {
							setMessage("没找到任何会话 —— 请先在 Telegram 里给这个 bot 发一条消息（如 /start），再回来点一次", "err");
							return;
						}
						chatInput.value = chats[0].id;
						if (chats.length === 1) {
							setMessage("已填入 Chat ID " + chats[0].id + "（" + chats[0].label + "），点「保存凭据」生效", "ok");
							return;
						}
						setMessage("发现 " + chats.length + " 个会话，已填入第一个；其他：" + chats.slice(1).map(function (c) { return c.id + " " + c.label; }).join(" / "), "ok");
					});
				}));
				tgActs.append(button("测试连接", function () {
					var probe = { chatId: chatInput.value.trim() };
					if (tokenInput.value.trim().length > 0) probe.botToken = tokenInput.value.trim();
					if (tokenInput.value.trim().length === 0 && !telegram.hasBotToken) {
						setMessage("请先填写 Bot Token", "err");
						return;
					}
					api("telegram-check", { body: probe }).then(function (res) {
						if (!res.ok) { setMessage("连接失败：" + res.error, "err"); return; }
						var bot = "@" + (res.username || res.name || "bot");
						if (res.chatOk) {
							setMessage("连接成功：" + bot + " → " + (res.chat && res.chat.label ? res.chat.label : probe.chatId), "ok");
						} else {
							setMessage("Bot Token 有效（" + bot + "），但 Chat ID 不可用：" + (res.chatError || "未配置"), "err");
						}
					});
				}));
				tgSec.append(tgActs);
				// 只展示 ~/... 形式：绝对路径会把用户名渲染进界面，截图即泄漏。
				var where = state.configPathDisplay || "本机 DSH 的配置文件";
				tgSec.append(el("p", "dsn-note", "凭据只写进 " + where + "（权限 0600），界面不回显。Telegram 的 bot 不能主动给人发消息，所以必须先在 Telegram 里给 bot 发一条消息，再用「获取 Chat ID」把它读出来。网页未打开时，订阅了 TG 的事件会改走 Telegram 投递。"));
				body.append(tgSec);
			}

			function openPanel() {
				if (mask) return;
				mask = el("div", "dsn-mask");
				var panel = el("div", "dsn-panel");
				var head = el("div", "dsn-hd");
				head.append(el("h3", null, "会话通知设置"));
				head.append(el("span", "dsn-ver", "v" + ((deps.open() || {}).version || "")));
				var close = el("button", "dsn-x", "×");
				close.type = "button";
				close.setAttribute("aria-label", "关闭");
				close.addEventListener("click", closePanel);
				head.append(close);
				panel.append(head);
				panel.append(el("div", "dsn-body"));
				var footer = el("p", "dsn-msg", "");
				panel.append(footer);
				mask.append(panel);
				mask.addEventListener("click", function (event) { if (event.target === mask) closePanel(); });
				document.addEventListener("keydown", onKeydown);
				document.body.append(mask);
				// 先用已有快照渲染（首次打开时是空快照 → 显示“正在读取配置…”），
				// 再向后端要一次最新状态。render 对空快照已做防御，不会中断下面的刷新。
				render(deps.open());
				deps.refresh().then(function (res) {
					if (res && res.ok) {
						render(res.value);
					} else {
						render(null);
						setMessage("读取配置失败：" + ((res && res.error) || "接口不可达"), "err");
					}
				});
			}

			function onKeydown(event) {
				if (event.key === "Escape") closePanel();
			}

			function closePanel() {
				if (!mask) return;
				document.removeEventListener("keydown", onKeydown);
				if (msgTimer !== null) clearTimeout(msgTimer);
				msgTimer = null;
				mask.remove();
				mask = null;
			}

			return {
				toggle: function () { if (mask) closePanel(); else openPanel(); },
				dispose: function () { closePanel(); }
			};
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.createTonePlayer = createTonePlayer;
		exports.createToastHost = createToastHost;
		exports.getClientId = getClientId;
		return module.exports;
	}
});
