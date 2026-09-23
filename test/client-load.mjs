/**
 * dsh-session-tg-notify — 客户端 bundle 装载测试。
 *
 * 浏览器 bundle 不走 ESM，而是注册到 `window.__ModuleLoader__`。这里复现
 * 装载协议：给出最小的 window/require 桩，跑一遍工厂函数，确认
 *   - 注册的 id 与包名一致（否则 DSH 的模块加载器认不出它）
 *   - 工厂返回带 apply / inject 的模块对象
 *   - 面板工厂在「空快照」下不抛异常（回归防护：这正是面板打开空白的原因）
 */
let captured = null;
globalThis.window = {
	__ModuleLoader__: {
		load(entry) {
			captured = entry;
		}
	}
};

await import('../src/client.js');

let failures = 0;
const check = (label, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) {
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
	}
};

console.log('\n[客户端 bundle 装载]');
check('注册到 __ModuleLoader__', captured !== null, true);
check('注册 id 与包名一致', captured?.id, 'dsh-session-tg-notify');

// 最小的 react 桩：只需要 createElement 存在
const react = { createElement: (...args) => ({ args }), useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}] };
const moduleExports = captured.factory((specifier) => {
	if (specifier === 'react') return react;
	throw new Error(`unexpected require: ${specifier}`);
});

check('导出 apply', typeof moduleExports.apply, 'function');
check('导出 inject（含 uiWorkspace，用于通知点击直达会话）', JSON.stringify(moduleExports.inject), JSON.stringify(['slots', 'locale', 'uiWorkspace']));
check('导出 createTonePlayer', typeof moduleExports.createTonePlayer, 'function');

// 提示音播放器在没有 AudioContext 的环境里必须安全降级（返回 false，而不是抛错）
const player = moduleExports.createTonePlayer();
check('无 AudioContext 时 play() 返回 false', player.play('ding'), false);
check('tone=none 视为已处理', player.play('none'), true);
check('dispose 不抛异常', typeof player.dispose, 'function') === 'function' && (player.dispose(), true);

// getClientId 在无 sessionStorage 时必须回退而不是抛错
check('getClientId 无 storage 时回退生成', typeof moduleExports.getClientId(), 'string');

console.log('');
if (failures === 0) {
	console.log('客户端 bundle 装载通过 ✅');
} else {
	console.log(`${failures} 项失败 ❌`);
	process.exitCode = 1;
}
