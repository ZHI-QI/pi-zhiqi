/**
 * catalog.ts — pi.dev 包目录的纯逻辑层。
 *
 * 设计约束（性能优先）：
 *   1. 本文件 **零 import**，不碰 fs / net / process，可被 node:test 直接加载；
 *   2. 解析用「一次 indexOf 切卡 + 预编译正则逐卡提取」，不用 DOM / cheerio / jsdom：
 *      既没有解析树的内存峰值，也没有第三方依赖的加载成本。
 *   3. 所有正则都在模块顶层编译一次，热路径里不再 new RegExp。
 *
 * 数据源：https://pi.dev/packages?name=<q> 是 **服务端渲染的 HTML**（无 JSON API）。
 * 每张卡片自带机器可读属性：
 *   data-package-name / -search / -types / -downloads / -date / -sort-name
 * 描述在 <p class="packages-desc"> 里。
 */

/** 卡片起始标记。用 indexOf 切分，不做全局 match（避免为整页建数组）。 */
const CARD_MARK = 'data-package-card="true"';

/** 切最后一张卡时给尾巴设上限，避免把分页/页脚整段复制一遍。 */
const TAIL_WINDOW = 8000;

const RE_NAME = /data-package-name="([^"]*)"/;
const RE_SEARCH = /data-package-search="([^"]*)"/;
const RE_TYPES = /data-package-types="([^"]*)"/;
const RE_DOWNLOADS = /data-package-downloads="(\d*)"/;
const RE_DATE = /data-package-date="(\d*)"/;
const RE_DESC = /class="packages-desc">([\s\S]*?)<\/p>/;
const RE_BADGE = /packages-badge"[^>]*data-type="([^"]*)"/;
const RE_META = /class="packages-meta">([\s\S]*?)<\/div>/;
const RE_SPAN = /<span[^>]*>([\s\S]*?)<\/span>/g;
const RE_COUNT = /class="packages-count">([^<]*)</;
const RE_OF_TOTAL = /\(of (\d+)\)/;
const RE_RANGE = /^(\d+)-(\d+)\s*\/\s*(\d+)/;
const RE_ONLY = /^(\d+)\s*\/\s*(\d+)/;

export const CATALOG_ORIGIN = "https://pi.dev/packages";

/** pi.dev 的 type 过滤值。*/
export type PackageType = "extension" | "skill" | "theme" | "prompt";
export const PACKAGE_TYPES: readonly PackageType[] = ["extension", "skill", "theme", "prompt"];

export type SortMode = "downloads" | "recent" | "name";
export const SORT_MODES: readonly SortMode[] = ["downloads", "recent", "name"];

/** 归一化后的单条目录结果（只留展示/安装需要的字段，不保留原始 HTML）。*/
export interface CatalogItem {
	/** npm 包名，例如 `pi-mermaid`、`@scope/pkg` */
	name: string;
	/** 简介（已反转义、已折叠空白） */
	desc: string;
	/** 作者（npm 用户名或 scope） */
	author: string;
	/** 下载量的人类可读形式，例如 `428.8K/mo`（缺失时为空串） */
	usage: string;
	/** 相对时间，例如 `1d ago`（缺失时为空串） */
	ago: string;
	/** 目录标注的类型：extension / skill / theme / prompt / package(空) */
	type: string;
	/** 月下载量原始数值，用于排序/展示 */
	downloads: number;
	/** 发布/更新时间戳（ms epoch），0 表示未知 */
	date: number;
	/** 服务端给的检索串（名称+描述+作者+关键词，已小写） */
	search: string;
}

export interface CatalogSnapshot {
	/** 原始计数文案，例如 `1-50 / 1290 (of 5639)` */
	range: string;
	/** 命中数（客户端过滤后） */
	matched: number;
	/** 目录总包数 */
	total: number;
	/** 本次解析出的条目 */
	items: CatalogItem[];
}

export interface SearchOptions {
	query: string;
	type?: PackageType;
	sort?: SortMode;
	page?: number;
}

/** 构造目录查询 URL。pi.dev 对默认值做 302 归一化，所以只带非默认参数。 */
export function buildCatalogUrl(options: SearchOptions): string {
	const params = new URLSearchParams();
	if (options.query) params.set("name", options.query);
	if (options.type) params.set("type", options.type);
	if (options.sort && options.sort !== "downloads") params.set("sort", options.sort);
	if (options.page && options.page > 1) params.set("page", String(options.page));
	const qs = params.toString();
	return qs ? `${CATALOG_ORIGIN}?${qs}` : CATALOG_ORIGIN;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
};

/** 只反解会出现在目录文案里的实体，不做完整 HTML 解析。 */
export function decodeEntities(input: string): string {
	if (input.indexOf("&") === -1) return input;
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.charCodeAt(0) === 35 /* # */) {
			const hex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
			try {
				return String.fromCodePoint(code);
			} catch {
				return whole;
			}
		}
		const named = NAMED_ENTITIES[body.toLowerCase()];
		return named === undefined ? whole : named;
	});
}

function cleanText(input: string | undefined): string {
	if (!input) return "";
	return decodeEntities(input).replace(/\s+/g, " ").trim();
}

function attrNumber(source: string, re: RegExp): number {
	const raw = re.exec(source)?.[1];
	if (!raw) return 0;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : 0;
}

function parseCard(chunk: string): CatalogItem {
	const meta = RE_META.exec(chunk)?.[1] ?? "";
	const spans: string[] = [];
	RE_SPAN.lastIndex = 0;
	let spanMatch = RE_SPAN.exec(meta);
	while (spanMatch !== null) {
		spans.push(cleanText(spanMatch[1]));
		spanMatch = RE_SPAN.exec(meta);
	}
	return {
		name: cleanText(RE_NAME.exec(chunk)?.[1]),
		desc: cleanText(RE_DESC.exec(chunk)?.[1]),
		search: cleanText(RE_SEARCH.exec(chunk)?.[1]).toLowerCase(),
		author: spans[0] ?? "",
		usage: spans[1] ?? "",
		ago: spans[2] ?? "",
		// data-package-types 对「多资源包」是空串，兜底读卡片上的徽章。
		type: cleanText(RE_TYPES.exec(chunk)?.[1]) || cleanText(RE_BADGE.exec(chunk)?.[1]),
		downloads: attrNumber(chunk, RE_DOWNLOADS),
		date: attrNumber(chunk, RE_DATE),
	};
}

/** 解析 `1-50 / 1290 (of 5639)` 或 `0 / 5639` 两种计数文案。 */
export function parseCountText(raw: string): { matched: number; total: number } {
	const text = raw.trim();
	const total = Number.parseInt(RE_OF_TOTAL.exec(text)?.[1] ?? "", 10);
	const range = RE_RANGE.exec(text);
	if (range) {
		return {
			matched: Number.parseInt(range[3] ?? "0", 10) || 0,
			total: Number.isFinite(total) ? total : Number.parseInt(range[2] ?? "0", 10) || 0,
		};
	}
	const only = RE_ONLY.exec(text);
	if (only) {
		return {
			matched: Number.parseInt(only[1] ?? "0", 10) || 0,
			total: Number.isFinite(total) ? total : Number.parseInt(only[2] ?? "0", 10) || 0,
		};
	}
	return { matched: 0, total: Number.isFinite(total) ? total : 0 };
}

/**
 * 从目录 HTML 里抽出结果。limit 只解析前 N 张卡（剩下的连正则都不跑）。
 */
export function parseCatalog(html: string, limit = Number.POSITIVE_INFINITY): CatalogSnapshot {
	const count = parseCountText(RE_COUNT.exec(html)?.[1] ?? "");
	const items: CatalogItem[] = [];

	let start = html.indexOf(CARD_MARK);
	while (start !== -1 && items.length < limit) {
		const next = html.indexOf(CARD_MARK, start + CARD_MARK.length);
		const end = next === -1 ? Math.min(html.length, start + TAIL_WINDOW) : next;
		const item = parseCard(html.slice(start, end));
		// 只收有名字的卡：把「标记在但字段没了」的畸形片段挡在外面，不污染结果。
		if (item.name) items.push(item);
		start = next;
	}

	return { range: cleanText(RE_COUNT.exec(html)?.[1]), matched: count.matched, total: count.total, items };
}

/** 结果里是否有中文/日文假名 —— 用来决定要不要走「翻译后重搜」。 */
export function hasCJK(text: string): boolean {
	return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/** 把下载量数值压成 `12.3K` / `1.2M` 这种短形式。 */
export function formatDownloads(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

/** `1d ago` / `9m ago` 这类相对时间；无数据时回退到时间戳。 */
export function formatAge(item: CatalogItem, now = Date.now()): string {
	if (item.ago) return item.ago;
	if (!item.date) return "-";
	const minutes = Math.max(0, Math.round((now - item.date) / 60000));
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
	if (minutes < 60 * 24 * 30) return `${Math.round(minutes / 1440)}d`;
	return `${Math.round(minutes / 43200)}mo`;
}

/* ────────────────── 结果描述 → 简体中文 ────────────────── */

/** FNV-1a 32 位哈希，纯 JS 实现（catalog.ts 要保持零 import，所以不用 node:crypto）。 */
export function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * 翻译缓存 key：包名 + 描述内容的哈希。
 * 描述变了（包更新了简介）就自动换 key，不会串用旧译文。
 */
export function translationKey(item: Pick<CatalogItem, "name" | "desc">): string {
	return `${item.name}@${fnv1a(item.desc || item.name)}`;
}

/** prompt 里每条描述的长度上限 —— 防止超长描述把 token 吃光。 */
const TRANSLATE_DESC_LIMIT = 300;

/**
 * 一次性把所有待展示条目交给模型翻译。
 * 刻意用「编号 + 要求 JSON 数组」的形式：编号让输出对齐可验证，JSON 让解析稳定。
 */
export function buildTranslationPrompt(items: Array<Pick<CatalogItem, "name" | "desc">>): string {
	const list = items
		.map((item, index) => {
			const desc = item.desc.length > TRANSLATE_DESC_LIMIT ? `${item.desc.slice(0, TRANSLATE_DESC_LIMIT)}…` : item.desc;
			return `${index + 1}. ${item.name} — ${desc}`;
		})
		.join("\n");

	return [
		"你在帮中文用户挑选 pi coding agent 的插件。下面每个插件有编号、英文名和英文描述。",
		"请给每一条写一句**简体中文**说明，要求：",
		'- 不超过 30 个汉字，说清「这个插件到底能干什么」，不要写"这是一个 pi 插件"这类废话',
		"- 专有名词保留原文（Mermaid / TUI / MCP / SQLite / Playwright / JSON …），不要生造译名",
		'- 只输出 JSON 数组，形如 [{"i":1,"zh":"中文说明"}]，不要代码围栏、不要任何解释',
		"",
		list,
	].join("\n");
}

/**
 * 宽容地解析模型回复。按强→弱三轮降级，任何一轮拿到结果就返回：
 *   1. 整段 JSON（理想情况）
 *   2. 逐对正则（模型把 JSON 写坏了，但键值还在）
 *   3. 编号行（模型干脆给你编号列表）
 * 返回定长数组，缺失位置是 undefined —— 缺失的条目在 UI 上回退显示英文，绝不因为解析失败就不给结果。
 */
export function parseTranslationResponse(text: string, expected: number): Array<string | undefined> {
	const out: Array<string | undefined> = new Array<string | undefined>(Math.max(0, expected)).fill(undefined);
	if (!text || expected <= 0) return out;

	const assign = (index: number, value: string): void => {
		if (!Number.isFinite(index) || index < 1 || index > expected) return;
		const clean = value.replace(/\s+/g, " ").trim();
		if (clean) out[index - 1] = clean;
	};

	// 1) 整段 JSON
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start !== -1 && end > start) {
		try {
			const parsed: unknown = JSON.parse(text.slice(start, end + 1));
			if (Array.isArray(parsed)) {
				parsed.forEach((entry, position) => {
					if (typeof entry !== "object" || entry === null) return;
					const record = entry as Record<string, unknown>;
					const rawIndex = record.i ?? record.index ?? record.id ?? position + 1;
					const index = typeof rawIndex === "number" ? rawIndex : Number.parseInt(String(rawIndex), 10);
					const rawText = record.zh ?? record.zh_cn ?? record.zhCN ?? record.text ?? record.desc;
					if (typeof rawText === "string") assign(index, rawText);
				});
				if (out.some((value) => value !== undefined)) return out;
			}
		} catch {
			/* 落到下一轮 */
		}
	}

	// 2) 逐对正则
	const pair = /"i"\s*:\s*"?(\d+)"?\s*,\s*"zh(?:_cn|CN)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
	let match = pair.exec(text);
	while (match !== null) {
		assign(Number(match[1]), (match[2] ?? "").replace(/\\"/g, '"').replace(/\\n/g, " "));
		match = pair.exec(text);
	}
	if (out.some((value) => value !== undefined)) return out;

	// 3) 编号行
	for (const line of text.split(/\r?\n/)) {
		const lineMatch = /^\s*(\d+)\s*[.、):：]\s*(.+?)\s*$/.exec(line);
		if (lineMatch) assign(Number(lineMatch[1]), (lineMatch[2] ?? "").replace(/^["“”']|["“”']$/g, ""));
	}
	return out;
}

/** 中文描述的展示上限（超出就截断，避免选择器里被硬裁到半个词）。 */
const ZH_DISPLAY_LIMIT = 30;

/**
 * 合并多页结果，按包名去重（保持先出现的顺序）。
 * 服务端分页边界上偶尔会重复或漂移，去重按包名最稳。
 */
export function mergeCatalogItems(pages: Array<readonly CatalogItem[]>): CatalogItem[] {
	const seen = new Set<string>();
	const merged: CatalogItem[] = [];
	for (const page of pages) {
		for (const item of page) {
			if (!item.name || seen.has(item.name)) continue;
			seen.add(item.name);
			merged.push(item);
		}
	}
	return merged;
}

/**
 * 为了凑足 limit 条结果，一共需要读几页。
 * 三个上限取最小：想要的数量、实际命中数、允许的最大页数。
 */
export function pagesNeeded(limit: number, matched: number, pageSize: number, maxPages: number): number {
	if (limit <= 0 || matched <= 0 || pageSize <= 0) return 1;
	const wanted = Math.min(limit, matched);
	return Math.max(1, Math.min(Math.ceil(wanted / pageSize), maxPages));
}

/** 单行摘要，给 SelectList 的 description 用。保证返回长度 ≤ maxLength。zh 为空时回退英文原文。 */
export function describeItem(
	item: CatalogItem,
	options: { zh?: string; maxLength?: number } = {},
): string {
	const maxLength = options.maxLength ?? 96;
	const head = [formatDownloads(item.downloads), item.type || "package", item.ago || "-"].join(" · ");
	const zh = options.zh?.trim();
	let body = zh && zh.length > 0 ? zh : item.desc;
	if (zh && body.length > ZH_DISPLAY_LIMIT) body = `${body.slice(0, ZH_DISPLAY_LIMIT - 1)}…`;
	const tail = item.author ? ` @${item.author}` : "";
	const full = body ? `${head} · ${body}${tail}` : `${head}${tail}`;
	if (full.length <= maxLength) return full;
	return `${full.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * 本地二次排序：名称命中优先，其次下载量。
 * 服务端的 `name` 过滤是模糊的（搜 `diagram` 会混进只命中描述/关键词的包），
 * 这里让「名字里真的含关键词」的包浮上来 —— 纯内存操作，无额外请求。
 */
export function rankItems(items: CatalogItem[], query: string): CatalogItem[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return items;
	const tokens = needle.split(/\s+/).filter(Boolean);
	const score = (item: CatalogItem): number => {
		const name = item.name.toLowerCase();
		if (name === needle) return 0;
		if (name.includes(needle)) return 1;
		if (tokens.length > 1 && tokens.every((token) => name.includes(token))) return 2;
		if (name.includes(needle.replace(/\s+/g, "-"))) return 3;
		return 4;
	};
	return items
		.map((item, index) => ({ item, index, score: score(item) }))
		.sort((a, b) => a.score - b.score || b.item.downloads - a.item.downloads || a.index - b.index)
		.map((entry) => entry.item);
}

/**
 * 安装命令的可读形式（也用于 --dry）。
 * 用官方 CLI：写进项目 .pi/settings.json，pi 负责装到 .pi/npm 并注册资源。
 */
export function installCommandFor(name: string): string {
	return `pi install npm:${name} -l`;
}

/** 从模型回复里尽量多取候选关键词（去重、保序、只留纯 ASCII 词）。 */
export function keywordCandidatesFrom(text: string, max = 3): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const raw of text.split(/[^a-zA-Z0-9+._-]+/)) {
		const token = raw.trim();
		if (token.length < 2 || token.length > 24) continue;
		// 必须以字母开头：滤掉 "1." "2." 这种列表编号
		if (!/^[a-zA-Z][a-zA-Z0-9+._-]*$/.test(token)) continue;
		const lower = token.toLowerCase();
		if (seen.has(lower)) continue;
		// 丢掉模型爱写的英文虚词
		if (STOP_WORDS.has(lower)) continue;
		seen.add(lower);
		found.push(lower);
		if (found.length >= max) break;
	}
	return found;
}

/**
 * 决定最终展示顺序。
 *
 * 只在服务端按**下载量**排序（默认）时做本地重排 —— 把「名字里真含关键词」的包提上来，
 * 修掉服务端模糊匹配把「只命中描述」的包排到真·名字命中的包前面的问题。
 *
 * 用户显式要了 `--sort=recent` / `--sort=name` 时**必须完整尊重服务端顺序**：
 * 否则本地重排会把最新的包压到后面，「最近发布」这个开关就形同虚设
 * （真踩过：三种 sort 跑出来一模一样，因为展示顺序全被本地重排盖掉了）。
 */
export function orderResults(items: CatalogItem[], query: string, sort: SortMode): CatalogItem[] {
	return sort === "downloads" ? rankItems(items, query) : items;
}

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "you", "your", "and", "are", "was", "were", "will", "can", "could",
	"would", "should", "keyword", "keywords", "search", "terms", "term", "english", "pi", "packages", "package",
	"translate", "translation", "output", "only", "please", "use", "using", "some", "any", "one", "two", "three",
]);
