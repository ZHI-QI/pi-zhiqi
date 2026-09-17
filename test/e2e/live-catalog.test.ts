/**
 * 真实网络端到端：pi.dev 目录现在还认不认我们的解析器。
 *
 * 需要网络。失败一律**硬失败**，不许静默跳过 —— 「跳过」会让整套测试看起来是绿的。
 * 这里断言的第一条不是"解析出东西"，而是"页面里还有卡片标记"：
 * 将来 pi.dev 改版时，这条会立刻炸掉，而不是安静地返回 0 条结果。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCatalogUrl, describeItem, parseCatalog } from "../../extensions/catalog.ts";

const TIMEOUT_MS = 20_000;

async function fetchCatalog(query: string, extra = ""): Promise<{ html: string; status: number; url: string }> {
	const url = `${buildCatalogUrl({ query })}${extra}`;
	const response = await fetch(url, {
		headers: { accept: "text/html", "user-agent": "pi-zhiqi/0.1 (e2e test)" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const html = await response.text();
	return { html, status: response.status, url: response.url };
}

test("pi.dev 目录页仍含卡片标记（改版哨兵）", async () => {
	const { html, status } = await fetchCatalog("mermaid");
	assert.equal(status, 200);
	assert.ok(
		html.includes('data-package-card="true"'),
		"pi.dev 页面里找不到 data-package-card 标记 —— 目录改版了，解析器需要跟着改",
	);
	assert.ok(html.includes("packages-count"), "找不到 packages-count 计数节点 —— 目录改版了");
});

test("真实搜索 mermaid：能解析出条目且首条字段完整", async () => {
	const { html } = await fetchCatalog("mermaid");
	const snapshot = parseCatalog(html, 50);

	assert.ok(snapshot.items.length > 0, "真实搜索应当有结果");
	assert.ok(snapshot.matched >= snapshot.items.length);
	assert.ok(snapshot.total > 1000, `目录总数异常: ${snapshot.total}`);

	const names = snapshot.items.map((item) => item.name);
	assert.ok(names.includes("pi-mermaid"), `结果里没有 pi-mermaid，实际前 5 条: ${names.slice(0, 5).join(", ")}`);

	const mermaid = snapshot.items.find((item) => item.name === "pi-mermaid");
	assert.ok(mermaid);
	assert.ok(mermaid.downloads > 0, `pi-mermaid 下载量应当 > 0，实际 ${mermaid.downloads}`);
	assert.ok(mermaid.desc.length > 0);
	assert.match(mermaid.desc, /[Mm]ermaid/);
	assert.equal(mermaid.desc.includes("<"), false, "描述里混进了 HTML 标签");
	assert.match(describeItem(mermaid), /^[\d.]+K?M?|^-/);
});

test("真实 type=extension 过滤生效", async () => {
	const { html } = await fetchCatalog("mermaid", "&type=extension");
	const snapshot = parseCatalog(html, 50);
	assert.ok(snapshot.items.length > 0);
	for (const item of snapshot.items) {
		assert.match(item.type, /extension/, `${item.name} 的类型是 "${item.type}"，不该出现在 type=extension 的结果里`);
	}
});

test("真实中文关键词仍然是 0 条 —— 翻译回退的前提还成立", async () => {
	const { html, status } = await fetchCatalog("流程图");
	assert.equal(status, 200);
	const snapshot = parseCatalog(html, 50);
	assert.equal(snapshot.items.length, 0, "如果这里有了结果，说明 pi.dev 开始索引中文，翻译回退可以退役了");
});
