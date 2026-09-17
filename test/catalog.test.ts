/**
 * catalog.ts 的单元测试。
 *
 * 全部断言都打在**真实抓取的 pi.dev 页面**（test/fixtures/*.html）上 ——
 * 手写的假 HTML 只能证明「我的正则符合我的想象」，证明不了它符合 pi.dev 的真实标记。
 * fixture 的抓取命令写在 test/fixtures/README.md 里，过期了重抓即可。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildCatalogUrl,
	buildTranslationPrompt,
	decodeEntities,
	describeItem,
	fnv1a,
	formatAge,
	formatDownloads,
	hasCJK,
	installCommandFor,
	keywordCandidatesFrom,
	mergeCatalogItems,
	pagesNeeded,
	parseCatalog,
	parseCountText,
	parseTranslationResponse,
	rankItems,
	translationKey,
	type CatalogItem,
} from "../extensions/catalog.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, `${name}.html`), "utf8");
}

function makeItem(partial: Partial<CatalogItem> & { name: string }): CatalogItem {
	return {
		desc: "",
		author: "",
		usage: "",
		ago: "",
		type: "",
		downloads: 0,
		date: 0,
		search: "",
		...partial,
	};
}

/* ────────────────── 真实页面 ────────────────── */

test("diagram 页：计数、条数、首条都与页面一致", () => {
	const html = fixture("diagram");
	const snapshot = parseCatalog(html);

	assert.equal(snapshot.range, "1-22 / 22 (of 5639)");
	assert.equal(snapshot.matched, 22);
	assert.equal(snapshot.total, 5639);
	assert.equal(snapshot.items.length, 22);

	// 解析出的条数必须等于页面里真实的卡片数（不是多也不是少）
	const cardMarkers = html.split('data-package-card="true"').length - 1;
	assert.equal(snapshot.items.length, cardMarkers, "解析条数应等于页面卡片数");

	const first = snapshot.items[0];
	assert.ok(first, "应有首条结果");
	assert.equal(first.name, "pi-mermaid");
	assert.equal(first.downloads, 2204);
	assert.equal(first.author, "gurpartap");
	assert.equal(first.type, "extension");
	assert.match(first.usage, /\/mo$/);
	assert.match(first.desc, /renders Mermaid diagrams as ASCII/);
});

test("diagram 页：不会把「Recently published」区块混进结果", () => {
	const html = fixture("diagram");
	const names = new Set(parseCatalog(html).items.map((item) => item.name));
	// 这两个包只出现在页面的 recent 列表里，不在搜索结果卡里
	assert.equal(names.has("@pi-unipi/ask-user"), false);
	assert.equal(names.has("pi-memsearch"), false);
});

test("解析结果里没有 HTML 残留", () => {
	for (const name of ["diagram", "flowchart", "mermaid-extension", "pi-ex-page2"]) {
		for (const item of parseCatalog(fixture(name)).items) {
			for (const field of [item.name, item.desc, item.author, item.usage, item.ago]) {
				assert.equal(field.includes("<"), false, `${name}: 字段里混进了标签: ${field}`);
				assert.equal(field.includes("&#"), false, `${name}: 字段里还有未解码实体: ${field}`);
				assert.equal(field.includes("data-package"), false, `${name}: 字段里混进了属性: ${field}`);
			}
			assert.ok(item.name.length > 0, `${name}: 出现了无名条目`);
		}
	}
});

test("flowchart 页：两条 draw.io / graphviz 结果", () => {
	const snapshot = parseCatalog(fixture("flowchart"));
	assert.equal(snapshot.matched, 2);
	assert.deepEqual(
		snapshot.items.map((item) => item.name),
		["@senad-d/drawme", "@walterra/pi-graphviz"],
	);
	assert.equal(snapshot.items[0]?.type, "extension");
});

test("中文关键词（流程图）在 pi.dev 就是 0 结果 —— 这是翻译回退存在的理由", () => {
	const snapshot = parseCatalog(fixture("empty-cjk"));
	assert.equal(snapshot.matched, 0);
	assert.equal(snapshot.total, 5639);
	assert.equal(snapshot.items.length, 0);
	assert.equal(snapshot.range, "0 / 5639");
});

test("第 2 页：range 与命中数正确，条数 = 一页 50 条", () => {
	const snapshot = parseCatalog(fixture("pi-ex-page2"));
	assert.equal(snapshot.range, "51-100 / 1290 (of 5639)");
	assert.equal(snapshot.matched, 1290);
	assert.equal(snapshot.items.length, 50);
	assert.equal(snapshot.items[0]?.name, "@sreetej510/pi-prompt-manager");
});

test("type=extension 过滤页：每条都标着 extension", () => {
	const snapshot = parseCatalog(fixture("mermaid-extension"));
	assert.equal(snapshot.matched, 11);
	assert.ok(snapshot.items.length > 0);
	for (const item of snapshot.items) {
		assert.match(item.type, /extension/, `${item.name} 的类型不该是 "${item.type}"`);
	}
});

test("limit 只解析前 N 张卡，且与全量解析的前缀一致", () => {
	const html = fixture("diagram");
	const full = parseCatalog(html);
	const limited = parseCatalog(html, 3);
	assert.equal(limited.items.length, 3);
	assert.deepEqual(
		limited.items.map((item) => item.name),
		full.items.slice(0, 3).map((item) => item.name),
	);
	// 计数信息来自页头，不受 limit 影响
	assert.equal(limited.matched, full.matched);
});

/* ────────────────── 计数文案 ────────────────── */

test("parseCountText 覆盖两种真实格式", () => {
	assert.deepEqual(parseCountText("1-22 / 22 (of 5639)"), { matched: 22, total: 5639 });
	assert.deepEqual(parseCountText("51-100 / 1290 (of 5639)"), { matched: 1290, total: 5639 });
	assert.deepEqual(parseCountText("0 / 5639"), { matched: 0, total: 5639 });
	assert.deepEqual(parseCountText("1-2 / 2 (of 5639)"), { matched: 2, total: 5639 });
	assert.deepEqual(parseCountText(""), { matched: 0, total: 0 });
	assert.deepEqual(parseCountText("乱码"), { matched: 0, total: 0 });
});

/* ────────────────── URL ────────────────── */

test("buildCatalogUrl 只带非默认参数（避免服务端 302 归一化）", () => {
	assert.equal(buildCatalogUrl({ query: "flowchart" }), "https://pi.dev/packages?name=flowchart");
	assert.equal(buildCatalogUrl({ query: "a b" }), "https://pi.dev/packages?name=a+b");
	assert.equal(
		buildCatalogUrl({ query: "mermaid", type: "extension" }),
		"https://pi.dev/packages?name=mermaid&type=extension",
	);
	// 默认排序不带 sort，第 1 页不带 page
	assert.equal(buildCatalogUrl({ query: "x", sort: "downloads", page: 1 }), "https://pi.dev/packages?name=x");
	assert.equal(buildCatalogUrl({ query: "x", sort: "recent", page: 3 }), "https://pi.dev/packages?name=x&sort=recent&page=3");
	// 中文必须被百分号编码
	assert.equal(buildCatalogUrl({ query: "流程图" }), "https://pi.dev/packages?name=%E6%B5%81%E7%A8%8B%E5%9B%BE");
});

/* ────────────────── 本地重排 ────────────────── */

test("rankItems 把名字里真的含关键词的包排前面", () => {
	const items = [
		makeItem({ name: "pi-diagram", downloads: 10 }),
		makeItem({ name: "unrelated-helper", downloads: 999_999, search: "unrelated helper diagram" }),
		makeItem({ name: "awesome-diagram-tools", downloads: 5 }),
	];
	const ranked = rankItems(items, "diagram");
	// 名称命中优先级最高（哪怕下载量差 5 个数量级）；同桶内再按下载量降序。
	assert.deepEqual(
		ranked.map((item) => item.name),
		["pi-diagram", "awesome-diagram-tools", "unrelated-helper"],
	);
});

test("rankItems 在无关键词时保持原序", () => {
	const items = [makeItem({ name: "b" }), makeItem({ name: "a" })];
	assert.deepEqual(
		rankItems(items, "  ").map((item) => item.name),
		["b", "a"],
	);
});

test("rankItems 不改动原数组", () => {
	const items = [makeItem({ name: "b", downloads: 1 }), makeItem({ name: "a", downloads: 9 })];
	const before = items.map((item) => item.name);
	rankItems(items, "a");
	assert.deepEqual(
		items.map((item) => item.name),
		before,
	);
});

/* ────────────────── 文本处理 ────────────────── */

test("decodeEntities 处理命名与数字实体", () => {
	assert.equal(decodeEntities("a &amp; b"), "a & b");
	assert.equal(decodeEntities("&lt;tag&gt;"), "<tag>");
	assert.equal(decodeEntities("it&#39;s"), "it's");
	assert.equal(decodeEntities("x &quot;y&quot;"), 'x "y"');
	assert.equal(decodeEntities("&#x1F600;"), "😀");
	assert.equal(decodeEntities("&nbsp;"), " ");
	assert.equal(decodeEntities("100% &copy;"), "100% &copy;", "不认识的实体原样保留");
	assert.equal(decodeEntities("纯文本"), "纯文本");
});

test("hasCJK 只认中日文字符", () => {
	assert.equal(hasCJK("流程图"), true);
	assert.equal(hasCJK("flowchart"), false);
	assert.equal(hasCJK("mermaid 图"), true);
	assert.equal(hasCJK("d2 diagram"), false);
	assert.equal(hasCJK("パッケージ"), true);
});

test("formatDownloads", () => {
	assert.equal(formatDownloads(0), "-");
	assert.equal(formatDownloads(999), "999");
	assert.equal(formatDownloads(2204), "2.2K");
	assert.equal(formatDownloads(428_818), "428.8K");
	assert.equal(formatDownloads(1_234_567), "1.2M");
	assert.equal(formatDownloads(Number.NaN), "-");
});

test("formatAge 优先用页面给的相对时间，缺失时用时间戳兜底", () => {
	const now = Date.UTC(2026, 0, 1);
	assert.equal(formatAge(makeItem({ name: "a", ago: "3d ago" }), now), "3d ago");
	assert.equal(formatAge(makeItem({ name: "a", date: now - 30 * 60_000 }), now), "30m");
	assert.equal(formatAge(makeItem({ name: "a", date: now - 5 * 3_600_000 }), now), "5h");
	assert.equal(formatAge(makeItem({ name: "a", date: now - 3 * 86_400_000 }), now), "3d");
	assert.equal(formatAge(makeItem({ name: "a" }), now), "-");
});

test("describeItem 单行且受长度约束", () => {
	const item = makeItem({ name: "pi-x", author: "me", type: "extension", ago: "1d ago", downloads: 428_818, desc: "x".repeat(400) });
	const line = describeItem(item, { maxLength: 60 });
	assert.equal(line.includes("\n"), false);
	assert.ok(line.length <= 60, `应当被截断到 60，实际长度 ${line.length}`);
	assert.match(line, /^428\.8K · extension · 1d ago/);
	assert.match(line, /…$/);
	// 短内容不应被截
	const short = describeItem(makeItem({ name: "pi-x", desc: "短描述" }), { maxLength: 60 });
	assert.equal(short.endsWith("…"), false);
});

test("describeItem 有中文译文时优先显示中文，并保留作者", () => {
	const item = makeItem({
		name: "pi-mermaid",
		author: "gurpartap",
		type: "extension",
		ago: "6mo ago",
		downloads: 2204,
		desc: "Pi extension that renders Mermaid diagrams as ASCII in the TUI",
	});
	const line = describeItem(item, { zh: "在 TUI 里把 Mermaid 图渲染成 ASCII" });
	assert.match(line, /^2\.2K · extension · 6mo ago · 在 TUI 里把 Mermaid 图渲染成 ASCII/);
	assert.match(line, /@gurpartap$/);
	assert.equal(line.includes("renders Mermaid diagrams"), false, "有译文时不该再出现英文原文");
});

test("describeItem 的中文译文过长会被截断，且 zh 为空时回退英文", () => {
	const item = makeItem({ name: "pi-x", type: "extension", desc: "English fallback text" });
	const long = describeItem(item, { zh: "中".repeat(200) });
	assert.ok(long.length < 90, `中文不该无限长，实际 ${long.length}`);
	assert.match(long, /…$/);
	// 空/全空格译文 → 回退英文
	assert.match(describeItem(item, { zh: "   " }), /English fallback text/);
	assert.match(describeItem(item), /English fallback text/);
});

test("installCommandFor 用官方项目级安装命令", () => {
	assert.equal(installCommandFor("pi-mermaid"), "pi install npm:pi-mermaid -l");
	assert.equal(installCommandFor("@mcuste/pi-diagram"), "pi install npm:@mcuste/pi-diagram -l");
});

/* ────────────────── 模型关键词提取 ────────────────── */

test("keywordCandidatesFrom 从各种模型回复里捞出 ASCII 关键词", () => {
	assert.deepEqual(keywordCandidatesFrom("flowchart diagram mermaid"), ["flowchart", "diagram", "mermaid"]);
	assert.deepEqual(keywordCandidatesFrom("1. flowchart\n2. diagram"), ["flowchart", "diagram"]);
	assert.deepEqual(keywordCandidatesFrom("流程图 → flowchart（diagram）"), ["flowchart", "diagram"]);
	assert.deepEqual(keywordCandidatesFrom("The keywords are: flowchart"), ["flowchart"], "虚词要滤掉");
	assert.deepEqual(keywordCandidatesFrom("只有中文没有英文"), []);
	assert.deepEqual(keywordCandidatesFrom(""), []);
	assert.equal(keywordCandidatesFrom("flowchart diagram mermaid sequence", 2).length, 2, "max 要生效");
});

/* ────────────────── 描述 → 中文（prompt 构造与宽容解析） ────────────────── */

test("translationKey 随描述变化，不会串用旧译文", () => {
	const a = makeItem({ name: "pi-x", desc: "old description" });
	const b = makeItem({ name: "pi-x", desc: "new description" });
	const c = makeItem({ name: "pi-y", desc: "old description" });
	assert.equal(translationKey(a), translationKey({ name: "pi-x", desc: "old description" }), "同包同描述必须稳定");
	assert.notEqual(translationKey(a), translationKey(b), "描述变了必须换 key");
	assert.notEqual(translationKey(a), translationKey(c), "不同包必须不同 key");
	// 描述为空时用包名兜底，不能产生 undefined/空 key
	assert.equal(translationKey(makeItem({ name: "pi-x", desc: "" })), `pi-x@${fnv1a("pi-x")}`);
});

test("fnv1a 是确定性且对输入敏感的", () => {
	assert.equal(fnv1a("abc"), fnv1a("abc"));
	assert.notEqual(fnv1a("abc"), fnv1a("abd"));
	assert.match(fnv1a("任意中文"), /^[0-9a-f]{8}$/);
});

test("buildTranslationPrompt 带上全部条目、编号对齐、要求简体中文与 JSON", () => {
	const items = [
		makeItem({ name: "pi-mermaid", desc: "renders mermaid diagrams as ascii" }),
		makeItem({ name: "pi-mem", desc: "long-term memory for pi" }),
	];
	const prompt = buildTranslationPrompt(items);
	assert.match(prompt, /1\. pi-mermaid — renders mermaid diagrams as ascii/);
	assert.match(prompt, /2\. pi-mem — long-term memory for pi/);
	assert.match(prompt, /简体中文/);
	assert.match(prompt, /\[\{"i":1,"zh":"中文说明"\}\]/);
});

test("buildTranslationPrompt 给超长描述封顶，不让它吃光 token", () => {
	const prompt = buildTranslationPrompt([makeItem({ name: "pi-x", desc: "x".repeat(4000) })]);
	assert.ok(prompt.length < 1000, `prompt 不该被单条描述撞爆，实际 ${prompt.length}`);
});

test("parseTranslationResponse 处理理想的 JSON 数组", () => {
	const text = '[{"i":1,"zh":"把 Mermaid 图渲染成 ASCII"},{"i":2,"zh":"长期记忆"}]';
	assert.deepEqual(parseTranslationResponse(text, 2), ["把 Mermaid 图渲染成 ASCII", "长期记忆"]);
});

test("parseTranslationResponse 处理带代码围栏与前后废话的回复", () => {
	const text = '好的，下面是翻译：\n```json\n[{"i":1,"zh":"渲染 Mermaid 图"}]\n```\n希望有帮助。';
	assert.deepEqual(parseTranslationResponse(text, 1), ["渲染 Mermaid 图"]);
});

test("parseTranslationResponse 在 JSON 写坏时回退到逐对正则", () => {
	// 尾部破掉，JSON.parse 会失败，但键值对还在（真实模型偶发）
	const text = '{"i":1,"zh":"第一个"}, {"i":2,"zh":"第二个"}, }]';
	const parsed = parseTranslationResponse(text, 2);
	assert.equal(parsed[0], "第一个");
	assert.equal(parsed[1], "第二个");
});

test("parseTranslationResponse 在模型只给编号列表时也能用", () => {
	const text = "1. 把 Mermaid 图渲染成 ASCII\n2. 长期记忆\n3. 第三个";
	assert.deepEqual(parseTranslationResponse(text, 3), ["把 Mermaid 图渲染成 ASCII", "长期记忆", "第三个"]);
});

test("parseTranslationResponse 容忍缺失与越界：缺失位置是 undefined", () => {
	const text = '[{"i":2,"zh":"只有第二条"}]';
	const parsed = parseTranslationResponse(text, 3);
	assert.equal(parsed[0], undefined);
	assert.equal(parsed[1], "只有第二条");
	assert.equal(parsed[2], undefined);
	assert.equal(parsed.length, 3, "返回长度必须等于 expected，才能按下标对齐");
});

test("parseTranslationResponse 的数字编号越界时直接丢弃", () => {
	const text = '[{"i":99,"zh":"不该要"},{"i":0,"zh":"也不该要"},{"i":1,"zh":"这个要"}]';
	assert.deepEqual(parseTranslationResponse(text, 1), ["这个要"]);
});

test("parseTranslationResponse 认常见字段别名", () => {
	assert.deepEqual(parseTranslationResponse('[{"index":1,"zh_cn":"别名一"}]', 1), ["别名一"]);
	assert.deepEqual(parseTranslationResponse('[{"id":1,"text":"别名二"}]', 1), ["别名二"]);
});

test("负向对照：完全不相干的输出必须一条都解析不出来", () => {
	for (const garbage of ["", "抱歉，我无法完成这个请求。", "{ broken json", "null", "[]", "<html></html>"]) {
		const parsed = parseTranslationResponse(garbage, 3);
		assert.equal(parsed.length, 3);
		assert.ok(
			parsed.every((value) => value === undefined),
			`不该从「${garbage}」里解析出译文，实际: ${JSON.stringify(parsed)}`,
		);
	}
});

test("parseTranslationResponse 的 expected=0 不抛异常", () => {
	assert.deepEqual(parseTranslationResponse('[{"i":1,"zh":"x"}]', 0), []);
});

/* ────────────────── 多页合并与翻页计算 ────────────────── */

test("pagesNeeded：按「想要的数量 / 命中数 / 最大页数」三者取最小", () => {
	assert.equal(pagesNeeded(50, 109, 50, 4), 1, "只要 50 条 → 不翻页");
	assert.equal(pagesNeeded(100, 109, 50, 4), 2);
	assert.equal(pagesNeeded(200, 109, 50, 4), 3, "109 条只需 3 页，不该去读第 4 页空页");
	assert.equal(pagesNeeded(200, 5643, 50, 4), 4, "最大页数封顶");
	assert.equal(pagesNeeded(10, 3, 50, 4), 1, "命中比想要的还少 → 一页就够");
	assert.equal(pagesNeeded(0, 109, 50, 4), 1);
	assert.equal(pagesNeeded(50, 0, 50, 4), 1, "0 命中也要读一页才知道");
});

test("mergeCatalogItems：按包名去重且保序", () => {
	const pageA = [makeItem({ name: "a" }), makeItem({ name: "b" })];
	const pageB = [makeItem({ name: "b" }), makeItem({ name: "c" })];
	assert.deepEqual(
		mergeCatalogItems([pageA, pageB]).map((item) => item.name),
		["a", "b", "c"],
	);
	// 先出现的胜出（不是后覆盖前）
	const firstWins = mergeCatalogItems([[makeItem({ name: "x", downloads: 1 })], [makeItem({ name: "x", downloads: 999 })]]);
	assert.equal(firstWins.length, 1);
	assert.equal(firstWins[0]?.downloads, 1);
});

test("mergeCatalogItems：跳过无名条目，接受空输入", () => {
	assert.deepEqual(mergeCatalogItems([]), []);
	assert.deepEqual(mergeCatalogItems([[], []]), []);
	assert.deepEqual(
		mergeCatalogItems([[makeItem({ name: "" }), makeItem({ name: "ok" })]]).map((item) => item.name),
		["ok"],
	);
});

test("负向对照：不合并的话重复项会真的多出来（证明去重确实在干活）", () => {
	const pageA = [makeItem({ name: "dup" }), makeItem({ name: "uniq" })];
	const pageB = [makeItem({ name: "dup" })];
	const naive = [...pageA, ...pageB];
	assert.equal(naive.length, 3, "朴素拼接会有 3 条");
	assert.equal(mergeCatalogItems([pageA, pageB]).length, 2, "去重后必须是 2 条");
});

/* ────────────────── 鲁棒性 / 负向对照 ────────────────── */

test("负向对照 1：把卡片标记改掉，解析必须归零（证明解析真的依赖该标记）", () => {
	const html = fixture("diagram");
	assert.ok(parseCatalog(html).items.length > 0, "原始页面必须有结果");
	const mutated = html.replaceAll('data-package-card="true"', 'data-package-card="false"');
	assert.equal(parseCatalog(mutated).items.length, 0);
});

test("负向对照 2：改掉 downloads 属性名，下载量必须归零（证明数值不是碰巧来的）", () => {
	const html = fixture("diagram");
	const mutated = html.replaceAll("data-package-downloads=", "data-package-downloads-x=");
	const items = parseCatalog(mutated).items;
	assert.equal(items.length, 22, "标记还在，条目数不该变");
	assert.equal(items[0]?.downloads, 0, "字段名变了，下载量必须读不到");
	assert.equal(parseCatalog(html).items[0]?.downloads, 2204);
});

test("负向对照 3：改掉描述节点 class，描述必须变空", () => {
	const html = fixture("diagram");
	assert.ok(parseCatalog(html).items[0]?.desc.length);
	const mutated = html.replaceAll('class="packages-desc"', 'class="packages-desc-x"');
	assert.equal(parseCatalog(mutated).items[0]?.desc, "");
});

test("畸形输入不抛异常", () => {
	for (const bad of ["", "<html></html>", 'data-package-card="true"', 'data-package-card="true"<p>没有字段</p>', "x".repeat(9000)]) {
		const snapshot = parseCatalog(bad);
		assert.equal(snapshot.matched, 0);
		assert.equal(snapshot.total, 0);
	}
});

test("标记在但字段缺失的畸形卡片被丢掉，不会产生无名条目", () => {
	const broken = 'data-package-card="true" data-package-downloads="5" <p class="packages-desc">无名字</p>';
	assert.equal(parseCatalog(broken).items.length, 0);
});
