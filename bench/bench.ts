/**
 * 性能基准：把「扩展自己花的时间」从「pi 进程启动时间」里剥出来。
 *
 *   node bench/bench.ts
 *
 * 三个口径：
 *   A. 加载成本 —— 用 pi 同款的 jiti 转译并 import 扩展（启动时唯一新增的工作）
 *   B. 解析成本 —— catalog.ts 解析一份真实 200KB 目录页
 *   C. 缓存命中 —— readFile + JSON.parse + 排序 + 格式化（一次 /zhiqi 的全部非网络成本）
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

import { describeItem, parseCatalog, rankItems, type CatalogItem } from "../extensions/catalog.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function timeIt(label: string, iterations: number, fn: () => void): void {
	for (let i = 0; i < Math.min(iterations, 3); i += 1) fn(); // 预热
	const samples: number[] = [];
	for (let i = 0; i < iterations; i += 1) {
		const start = performance.now();
		fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)] ?? 0;
	console.log(`${label.padEnd(34)} median=${median.toFixed(2)}ms  min=${(samples[0] ?? 0).toFixed(2)}ms  n=${iterations}`);
}

const html = readFileSync(join(ROOT, "test/fixtures/pi-ex-page2.html"), "utf8");
console.log(`fixture: pi-ex-page2.html  ${(html.length / 1024).toFixed(0)}KB\n`);

timeIt("B. parseCatalog(整页 50 条)", 50, () => {
	parseCatalog(html, 50);
});

const items = parseCatalog(html, 50).items;
timeIt("B2. rankItems(50 条)", 200, () => {
	rankItems(items, "mermaid");
});

timeIt("C. 格式化 25 行展示", 200, () => {
	items.slice(0, 25).forEach((item: CatalogItem) => describeItem(item));
});

const jiti = createJiti(join(ROOT, "bench/bench.ts"), { interopDefault: true, moduleCache: false });
const loadSamples: number[] = [];
for (let i = 0; i < 10; i += 1) {
	const start = performance.now();
	await jiti.import("../extensions/zhiqi.ts");
	loadSamples.push(performance.now() - start);
}
loadSamples.sort((a, b) => a - b);
console.log("");
console.log(
	`A. jiti 冷转译 + 加载扩展            median=${(loadSamples[Math.floor(loadSamples.length / 2)] ?? 0).toFixed(2)}ms  min=${(loadSamples[0] ?? 0).toFixed(2)}ms  n=${loadSamples.length}`,
);
console.log(`   其中可执行代码仅 2 个文件：extensions/catalog.ts + extensions/zhiqi.ts`);
