/**
 * 真进程 + 真伪终端端到端：在真实 pi TUI 里跑一遍
 *   输入 /zhiqi pi-mermaid --limit=3 --dry → 选择器画出来 → 回车选中 → 屏幕上出现安装命令
 *
 * 为什么必须这么验：选择器、按键、`ctx.ui.custom()` 全都只在真实 TTY 里才有意义。
 * mock 一个 ExtensionUIContext 只能证明"我调用了 custom()"，证明不了
 * "选择器真的画出来了、回车真的能选中"。这正是 mock 永远测不出来的那一类。
 *
 * 用 `--dry`：验到「选中 → 拿到正确的安装命令」为止，不真的动 .pi/settings.json。
 * 因此这个测试对磁盘是**只读**的（连 .pi 目录都不该出现），可以放心跑。
 *
 * 需要：网络（真搜 pi.dev）、`pi` 与 `expect` 在 PATH。
 * 缺任何一个都**硬失败**，不静默跳过。
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXTENSION = join(ROOT, "extensions/zhiqi.ts");
const DRIVER = join(ROOT, "test/e2e/drive-tui.exp");
const QUERY_PACKAGE = "pi-mermaid";
const COMMAND = `/zhiqi ${QUERY_PACKAGE} --limit=3 --dry`;

/** 缺依赖要炸得响亮，并告诉人怎么补 —— 不要 return / skip。 */
function requireBinary(name: string, hint: string): void {
	try {
		execFileSync("/usr/bin/which", [name], { stdio: "pipe" });
	} catch {
		throw new Error(`端到端测试需要 \`${name}\`，但它不在 PATH 上。${hint}`);
	}
}

function stripAnsi(input: string): string {
	return input
		.replace(/\u001b\][^\u0007]*\u0007/g, "")
		.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\r/g, "");
}

test("真实 TUI：/zhiqi 画出选择器，回车选中后给出安装命令", { timeout: 180_000 }, () => {
	requireBinary("pi", "pi 需要在 PATH 上（这个测试要真的把 pi 跑起来）。");
	requireBinary("expect", "macOS 自带 /usr/bin/expect；Linux 上装 expect 即可。");
	assert.ok(existsSync(EXTENSION), `扩展文件不存在: ${EXTENSION}`);

	// 隔离：agent 目录与会话目录都在临时目录，绝不碰 ~/.pi/agent
	const sandbox = mkdtempSync(join(tmpdir(), "pi-zhiqi-e2e-"));
	const agentDir = join(sandbox, "agent");
	const projectDir = join(sandbox, "proj");
	const logPath = join(sandbox, "tui.log");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	try {
		const run = spawnSync(
			"expect",
			[DRIVER, logPath, EXTENSION, agentDir, projectDir, COMMAND, "enter", QUERY_PACKAGE],
			{ encoding: "utf8", timeout: 170_000 },
		);
		const rawLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		const screen = stripAnsi(rawLog);

		assert.ok(screen.length > 0, `expect 没有产出任何屏幕内容。stderr:\n${run.stderr ?? ""}`);

		// 1) 选择器真的画出来了
		assert.match(screen, /pi\.dev · pi-mermaid/, "选择器标题没出现 —— TUI 界面没渲染");
		// 2) 列表里有条目（中文字符都在 BMP 内，pty 能无损承载；emoji 是采集工具的已知缺陷，不去断言）
		assert.match(screen, /↑↓ 选择/, "选择器的操作提示行没出现");
		assert.match(screen, new RegExp(QUERY_PACKAGE), "结果列表里没有搜到的包");
		// 3) 回车选中后真的走到了安装分支
		assert.match(
			screen,
			new RegExp(`\\[dry-run\\] pi install npm:${QUERY_PACKAGE} -l -a`),
			"回车选中后没有出现预期的安装命令",
		);
		// 4) --dry 不该碰磁盘
		assert.equal(existsSync(join(projectDir, ".pi")), false, "--dry 模式不应该创建 .pi 目录");
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});
