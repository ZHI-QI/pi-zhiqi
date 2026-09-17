/**
 * pi-zhiqi — 把 pi.dev 的包目录搬进 TUI。
 *
 *   /zhiqi 流程图        → 搜 pi.dev 目录 → ↑↓ 选 → enter 装到当前项目
 *
 * 性能设计（三条硬约束，都是有意的取舍）：
 *
 *  1) **加载期零工作**：工厂函数里只有 `pi.registerCommand()` 一次同步调用。
 *     没有顶层 IO、没有定时器、没有 network、没有 spawn、不注册 tool/shortcut/event。
 *     不注册 tool 是刻意的 —— tool 会进 system prompt，等于给**每一轮对话**加 token。
 *  2) **零运行时依赖**：只用 `node:*` 内建 + 全局 fetch。解析走 catalog.ts 的
 *     纯正则实现，不引入 cheerio/jsdom/axios（省掉几十 MB 的 node_modules 和启动解析）。
 *  3) **网络只在按键之后**：搜索/翻译/安装全部发生在命令 handler 里。
 *     结果落盘缓存（默认 10 分钟 TTL），缓存命中时一次 `/zhiqi` 成本 = 一次 readFile。
 *
 * 命令：
 *   /zhiqi <关键词> [--type=extension|skill|theme|prompt] [--sort=downloads|recent|name]
 *                   [--page=N] [--limit=N] [--fresh] [--dry] [--json] [--clear] [--help]
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BorderedLoader, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";

import {
	buildCatalogUrl,
	buildTranslationPrompt,
	describeItem,
	formatAge,
	formatDownloads,
	hasCJK,
	installCommandFor,
	keywordCandidatesFrom,
	mergeCatalogItems,
	PACKAGE_TYPES,
	type PackageType,
	orderResults,
	pagesNeeded,
	parseCatalog,
	parseTranslationResponse,
	SORT_MODES,
	type SortMode,
	translationKey,
	type CatalogItem,
	type CatalogSnapshot,
} from "./catalog.ts";

/* ────────────────────────────── 常量 ────────────────────────────── */

const EXT_ID = "zhiqi";
const COMMAND = "zhiqi";
const CACHE_FILE = "zhiqi-cache.json";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_HARD_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 40;

const NET_TIMEOUT_MS = 9000;
const INSTALL_TIMEOUT_MS = 300 * 1000;
const TRANSLATE_TIMEOUT_MS = 25 * 1000;
/** 一次模型调用最多翻多少条：条数越多，模型越想偷懒/漏条目，且输出 token 线性变长。 */
const ZH_CHUNK_SIZE = 25;
/** 并发几个块。实测对照：同 109 条，并发 1 = 52.6s，并发 6 = 30.2s —— 并行有效但被 provider 排队限流，只有 ~1.7x。 */
const ZH_CONCURRENCY = 4;

/** 译文持久缓存：同一个包只花一次 token，之后永远秒出。 */
const ZH_CACHE_FILE = "zhiqi-zh.json";
const ZH_CACHE_VERSION = 1;
const ZH_CACHE_MAX = 4000;

const SERVER_PAGE_SIZE = 50;
/** 默认展示一整页：不多花一次网络请求，也不让人以为“命中 109 结果只给了 25”。 */
const DEFAULT_LIMIT = SERVER_PAGE_SIZE;
/** 上限 = 4 页。--limit 超过一页时会自动顺序翻页（每页约 1.2s）。 */
const MAX_PAGES = 4;
const MAX_LIMIT = SERVER_PAGE_SIZE * MAX_PAGES;
const MAX_TRANSLATION_LOOKUPS = 3;
const MIN_RESULTS_BEFORE_STOPPING = 3;

const TYPES: readonly PackageType[] = PACKAGE_TYPES;
const SORTS: readonly SortMode[] = SORT_MODES;

/* ────────────────────────────── 参数解析 ────────────────────────────── */

interface CliArgs {
	query: string;
	type?: PackageType;
	sort: SortMode;
	page: number;
	limit: number;
	fresh: boolean;
	dry: boolean;
	json: boolean;
	help: boolean;
	clear: boolean;
	/** 关掉中文翻译（不调模型） */
	en: boolean;
}

const HELP_LINES = [
	"用法: /zhiqi <关键词> [选项]",
	"",
	"  /zhiqi 流程图            搜 pi.dev 目录（中文关键词会自动翻成英文再搜）",
	"  /zhiqi mermaid --type=extension",
	"",
	"结果里的英文描述会用当前模型翻成简体中文（译文永久缓存，同一个包只翻一次）。",
	"",
	"选项:",
	"  --type=extension|skill|theme|prompt   只看某一类资源",
	"  --sort=downloads|recent|name          排序（默认 downloads；recent/name 时完全按服务端顺序）",
	"  --page=N                              第 N 页（每页 50 条）",
	"  --limit=N                             展示条数，默认 50（= 1 页），上限 200（超过一页会自动翻页）",
	"  --en                                 不翻译，直接看英文原文（不调模型）",
	"  --fresh                               跳过缓存，强制重新拉取",
	"  --dry                                 只打印安装命令，不真的执行",
	"  --json                                print 模式下输出 JSON",
	"  --clear                               清空本地缓存（含译文）",
	"",
	"选中后执行: pi install npm:<包名> -l   （写入当前项目的 .pi/settings.json）",
];

function parseArgs(raw: string): { args: CliArgs; error?: string } {
	const args: CliArgs = {
		query: "",
		sort: "downloads",
		page: 1,
		limit: DEFAULT_LIMIT,
		fresh: false,
		dry: false,
		json: false,
		help: false,
		clear: false,
		en: false,
	};
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (!token.startsWith("-")) {
			positional.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const key = (eq === -1 ? token : token.slice(0, eq)).replace(/^--?/, "").toLowerCase();
		let value = eq === -1 ? undefined : token.slice(eq + 1);
		// 支持 `--type extension` 与 `--type=extension` 两种写法。
		if (value === undefined && (key === "type" || key === "sort" || key === "page" || key === "limit")) {
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				value = next;
				index += 1;
			}
		}

		switch (key) {
			case "fresh":
			case "no-cache":
				args.fresh = true;
				break;
			case "dry":
			case "dry-run":
				args.dry = true;
				break;
			case "json":
				args.json = true;
				break;
			case "help":
			case "h":
				args.help = true;
				break;
			case "clear":
				args.clear = true;
				break;
			case "en":
			case "english":
				args.en = true;
				break;
			case "type":
				if (!TYPES.includes(value as PackageType)) {
					return { args, error: `--type 只能是 ${TYPES.join(" / ")}` };
				}
				args.type = value as PackageType;
				break;
			case "sort":
				if (!SORTS.includes(value as SortMode)) {
					return { args, error: `--sort 只能是 ${SORTS.join(" / ")}` };
				}
				args.sort = value as SortMode;
				break;
			case "page": {
				const page = Number.parseInt(value ?? "", 10);
				if (!Number.isFinite(page) || page < 1) return { args, error: "--page 需要 ≥1 的整数" };
				args.page = page;
				break;
			}
			case "limit": {
				const limit = Number.parseInt(value ?? "", 10);
				if (!Number.isFinite(limit) || limit < 1) return { args, error: "--limit 需要 ≥1 的整数" };
				args.limit = Math.min(limit, MAX_LIMIT);
				break;
			}
			default:
				return { args, error: `未知选项 --${key}（/zhiqi --help 看用法）` };
		}
	}

	args.query = positional.join(" ").trim();
	return { args };
}

/* ────────────────────────────── 磁盘缓存 ────────────────────────────── */

interface CacheRecord {
	/** 写入时间（ms epoch） */
	t: number;
	range: string;
	matched: number;
	total: number;
	items: CatalogItem[];
}

interface CacheFile {
	v: number;
	entries: Record<string, CacheRecord>;
}

function cachePath(): string {
	return join(getAgentDir(), CACHE_FILE);
}

function emptyCache(): CacheFile {
	return { v: CACHE_VERSION, entries: {} };
}

async function readCache(): Promise<CacheFile> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath(), "utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as CacheFile).v !== CACHE_VERSION ||
			typeof (parsed as CacheFile).entries !== "object" ||
			(parsed as CacheFile).entries === null
		) {
			return emptyCache();
		}
		return parsed as CacheFile;
	} catch {
		return emptyCache();
	}
}

/** 原子写：先写 tmp 再 rename，避免并发下留下半个 JSON。失败静默（缓存不是关键路径）。 */
async function writeCache(file: CacheFile): Promise<void> {
	try {
		const now = Date.now();
		const kept: Record<string, CacheRecord> = {};
		const sorted = Object.entries(file.entries).sort((a, b) => b[1].t - a[1].t);
		for (const [key, record] of sorted) {
			if (now - record.t > CACHE_HARD_TTL_MS) continue;
			kept[key] = record;
			if (Object.keys(kept).length >= CACHE_MAX_ENTRIES) break;
		}
		const path = cachePath();
		const tmp = `${path}.${process.pid}.tmp`;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify({ v: CACHE_VERSION, entries: kept }), "utf8");
		await rename(tmp, path);
	} catch {
		/* 缓存写失败不影响本次结果 */
	}
}

/* ────────────────────────────── 结果描述 → 简体中文（持久缓存） ────────────────────────────── */

interface ZhCacheFile {
	v: number;
	entries: Record<string, string>;
}

function zhCachePath(): string {
	return join(getAgentDir(), ZH_CACHE_FILE);
}

async function readZhCache(): Promise<ZhCacheFile> {
	try {
		const parsed: unknown = JSON.parse(await readFile(zhCachePath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null || (parsed as ZhCacheFile).v !== ZH_CACHE_VERSION) {
			return { v: ZH_CACHE_VERSION, entries: {} };
		}
		const entries = (parsed as ZhCacheFile).entries;
		if (typeof entries !== "object" || entries === null) return { v: ZH_CACHE_VERSION, entries: {} };
		return { v: ZH_CACHE_VERSION, entries };
	} catch {
		return { v: ZH_CACHE_VERSION, entries: {} };
	}
}

/** 原子写 + 数量上限。译文是无价的（花过 token），所以失败也不抛，宁可下次重翻。 */
async function writeZhCache(file: ZhCacheFile): Promise<void> {
	try {
		const entries: Record<string, string> = {};
		for (const key of Object.keys(file.entries).slice(-ZH_CACHE_MAX)) {
			const value = file.entries[key];
			if (typeof value === "string" && value.length > 0) entries[key] = value;
		}
		const path = zhCachePath();
		const tmp = `${path}.${process.pid}.tmp`;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify({ v: ZH_CACHE_VERSION, entries }), "utf8");
		await rename(tmp, path);
	} catch {
		/* 写失败不影响本次展示 */
	}
}

/** 给模型调用加一道超时保险：模型卡住时宁可不翻译，不能让 /zhiqi 挂死。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/** 单块翻译：一次模型调用最多处理 ZH_CHUNK_SIZE 条。返回与输入等长的数组，缺失位置是 undefined。 */
async function translateChunk(
	ctx: ExtensionCommandContext,
	model: NonNullable<ExtensionCommandContext["model"]>,
	chunk: CatalogItem[],
): Promise<Array<string | undefined>> {
	if (chunk.length === 0) return [];
	const response = await withTimeout(
		ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: buildTranslationPrompt(chunk) }],
						timestamp: Date.now(),
					},
				],
			},
			{ reasoningEffort: "minimal", cacheRetention: "none", sessionId: randomUUID() },
		),
		TRANSLATE_TIMEOUT_MS,
		"翻译",
	);

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");

	return parseTranslationResponse(text, chunk.length);
}

interface TranslationOutcome {
	/** 包名 → 中文说明 */
	zh: Map<string, string>;
	/** 本次需要展示的条数 */
	requested: number;
	/** 其中拿到中文的条数（含缓存命中） */
	filled: number;
	note?: string;
}

/**
 * 把待展示条目的英文描述翻成中文。
 *
 * 关键设计：**译文按「包名+描述哈希」永久缓存**，所以只有第一次搜到某个包时才花 token，
 * 之后无论搜多少次、换什么关键词、甚至换项目，都是缓存命中、零模型调用。
 * 整个函数不抛异常：任何失败都只意味着“回退显示英文”。
 */
async function translateItems(ctx: ExtensionCommandContext, items: CatalogItem[], enabled: boolean): Promise<TranslationOutcome> {
	const zh = new Map<string, string>();
	if (!enabled || items.length === 0) return { zh, requested: items.length, filled: 0 };

	const cache = await readZhCache();
	const pending: CatalogItem[] = [];
	const seen = new Set<string>();

	for (const item of items) {
		const key = translationKey(item);
		const cached = cache.entries[key];
		if (cached) {
			zh.set(item.name, cached);
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		pending.push(item);
	}

	if (pending.length === 0) return { zh, requested: items.length, filled: zh.size };

	const model = ctx.scopedModels[0]?.model ?? ctx.model;
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
		return { zh, requested: items.length, filled: zh.size, note: "没有可用的模型，本次直接展示英文原文" };
	}

	try {
		// 分块并发：一条 call 塞 109 条会让模型慢慢往外吐 3000+ token（实测 33 秒）。
		// 拆成 25 条/块、最多 4 块并行 → 墙钟时间降到约“一个块”的时间。
		const chunks: CatalogItem[][] = [];
		for (let index = 0; index < pending.length; index += ZH_CHUNK_SIZE) {
			chunks.push(pending.slice(index, index + ZH_CHUNK_SIZE));
		}

		const results: Array<string | undefined> = [];
		for (let index = 0; index < chunks.length; index += ZH_CONCURRENCY) {
			const wave = chunks.slice(index, index + ZH_CONCURRENCY);
			const settled = await Promise.allSettled(wave.map((chunk) => translateChunk(ctx, model, chunk)));
			settled.forEach((outcome, position) => {
				const size = wave[position]?.length ?? 0;
				for (let offset = 0; offset < size; offset += 1) {
					results.push(outcome.status === "fulfilled" ? outcome.value[offset] : undefined);
				}
			});
		}

		results.forEach((value, index) => {
			const item = pending[index];
			if (!item || !value) return;
			cache.entries[translationKey(item)] = value;
			zh.set(item.name, value);
		});

		if (zh.size > 0) await writeZhCache(cache);

		const filled = zh.size;
		if (filled < items.length) {
			return { zh, requested: items.length, filled, note: `${items.length} 条里翻了 ${filled} 条，其余显示英文原文` };
		}
		return { zh, requested: items.length, filled };
	} catch (error) {
		return {
			zh,
			requested: items.length,
			filled: zh.size,
			note: `翻译失败（${error instanceof Error ? error.message : String(error)}），本次显示英文原文`,
		};
	}
}

/* ────────────────────────────── 取数 ────────────────────────────── */

interface SearchResult {
	snapshot: CatalogSnapshot;
	fromCache: boolean;
	note?: string;
}

function cacheTtlMs(): number {
	const override = Number.parseInt(process.env.ZHIQI_CACHE_TTL_MS ?? "", 10);
	return Number.isFinite(override) && override >= 0 ? override : CACHE_TTL_MS;
}

function toSnapshot(record: CacheRecord): CatalogSnapshot {
	return {
		range: record.range,
		matched: record.matched,
		total: record.total,
		items: record.items,
	};
}

async function fetchCatalogHtml(url: string, signal?: AbortSignal): Promise<{ html: string; finalUrl: string }> {
	const signals = [AbortSignal.timeout(NET_TIMEOUT_MS)];
	if (signal) signals.push(signal);
	const response = await fetch(url, {
		headers: { accept: "text/html", "user-agent": "pi-zhiqi/0.1 (+https://pi.dev/packages)" },
		signal: AbortSignal.any(signals),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	const html = await response.text();
	if (html.length < 512) throw new Error("目录返回内容异常（过短）");
	return { html, finalUrl: response.url };
}

/**
 * 拉取**一页**（50 条），带磁盘缓存。返回该页全部条目（本地重排后），不按 limit 截断 —— 
 * 截断交给调用方，这样多页合并才能凑足数量。
 */
async function fetchPage(args: CliArgs, query: string, page: number, signal?: AbortSignal): Promise<SearchResult> {
	const url = buildCatalogUrl({ query, type: args.type, sort: args.sort, page });
	const cache = await readCache();
	const record = cache.entries[url];
	const freshEnough = record !== undefined && Date.now() - record.t <= cacheTtlMs();

	if (record && freshEnough && !args.fresh) {
		// 不在这里排序：多页合并时必须先拼原始页再统一排序，否则第 2 页的强匹配会永远排在第 1 页弱匹配后面。
		return { snapshot: toSnapshot(record), fromCache: true };
	}

	try {
		const { html, finalUrl } = await fetchCatalogHtml(url, signal);
		// 命中服务端 302 归一化（例如 page 超范围被打回第 1 页）时如实说明。
		const requestedPage = new URL(url).searchParams.get("page");
		const finalPage = new URL(finalUrl).searchParams.get("page");
		const note = requestedPage !== null && requestedPage !== finalPage ? `第 ${requestedPage} 页超范围，已回到第 ${finalPage ?? 1} 页` : undefined;

		const parsed = parseCatalog(html, SERVER_PAGE_SIZE);
		const next: CacheFile = {
			v: CACHE_VERSION,
			entries: { ...cache.entries, [url]: { t: Date.now(), range: parsed.range, matched: parsed.matched, total: parsed.total, items: parsed.items } },
		};
		await writeCache(next);

		return {
			snapshot: parsed,
			fromCache: false,
			...(note ? { note } : {}),
		};
	} catch (error) {
		if (record) {
			return {
				snapshot: toSnapshot(record),
				fromCache: true,
				note: `网络失败（${error instanceof Error ? error.message : String(error)}），已用 ${formatAge({ ...EMPTY_ITEM, date: record.t }, Date.now())} 前的缓存`,
			};
		}
		throw error;
	}
}

/**
 * 按需读多页直到凑足 limit 条，**合并完再统一排序**。
 * 先读第 1 页拿到 matched，才知道到底要翻几页 —— 命中很少时仍然只请求一次。
 */
async function collectMatches(
	args: CliArgs,
	query: string,
	signal?: AbortSignal,
	onPage?: (page: number, donePages: number, totalPages: number) => void,
): Promise<SearchResult> {
	const first = await fetchPage(args, query, args.page, signal);
	const pages: CatalogItem[][] = [first.snapshot.items];
	const notes: string[] = [];
	if (first.note) notes.push(first.note);
	let fromCache = first.fromCache;

	const need = pagesNeeded(args.limit, first.snapshot.matched, SERVER_PAGE_SIZE, MAX_PAGES);
	for (let offset = 1; offset < need && first.snapshot.items.length > 0; offset += 1) {
		onPage?.(args.page + offset, offset + 1, need);
		const next = await fetchPage(args, query, args.page + offset, signal);
		fromCache = fromCache && next.fromCache;
		if (next.note) notes.push(next.note);
		if (next.snapshot.items.length === 0) break;
		pages.push(next.snapshot.items);
	}

	return {
		snapshot: { ...first.snapshot, items: orderResults(mergeCatalogItems(pages), query, args.sort) },
		fromCache,
		...(notes.length > 0 ? { note: notes.join(" · ") } : {}),
	};
}

/* ────────────────────────────── 中文关键词 → 英文 ────────────────────────────── */

const EMPTY_ITEM: CatalogItem = {
	name: "",
	desc: "",
	author: "",
	usage: "",
	ago: "",
	type: "",
	downloads: 0,
	date: 0,
	search: "",
};

const TRANSLATE_PROMPT = [
	"你是 npm 包检索助手。用户会用中文描述他想找的 pi coding agent 插件。",
	"请给出最多 3 个**英文**检索关键词，按优先级排序（pi.dev 包目录只匹配英文 name/description/keywords）。",
	"要求：",
	"- 只输出关键词本身，用空格分隔，一行搞定",
	"- 不要解释，不要编号，不要引号，不要标点",
	"- 优先输出 npm 生态里真会出现在包名/描述里的技术词，例如 flowchart → diagram mermaid",
].join("\n");

/**
 * 用当前会话的模型做一次极短的补全，把中文关键词翻成英文候选。
 * 只在「TUI + 命中 0 条 + 关键词含中文」时触发，所以正常搜索完全不会调模型。
 */
async function translateKeywords(ctx: ExtensionCommandContext, query: string): Promise<string[]> {
	try {
		const model = ctx.scopedModels[0]?.model ?? ctx.model;
		if (!model) return [];
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) return [];

		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: `${TRANSLATE_PROMPT}\n\n用户的检索意图：${query}` }],
						timestamp: Date.now(),
					},
				],
			},
			{ reasoningEffort: "minimal", cacheRetention: "none", sessionId: randomUUID() },
		);

		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		return keywordCandidatesFrom(text, MAX_TRANSLATION_LOOKUPS);
	} catch {
		return [];
	}
}

/* ────────────────────────────── 输出 ────────────────────────────── */

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

/** 标题行：命中数 + 实际展示了多少条（不足时把「丢了多少」明说，不让人猜）。 */
function resultHeader(query: string, snapshot: CatalogSnapshot, translatedFrom?: string): string {
	const scope = translatedFrom ? `"${translatedFrom}" → ${query}` : `"${query}"`;
	const shown = snapshot.items.length;
	const hit = shown < snapshot.matched ? `显示 ${shown} / ${snapshot.matched} 命中` : `${snapshot.matched} 命中`;
	return `pi.dev 目录 · ${scope} · ${hit} / 共 ${snapshot.total} 个包`;
}

function renderPlain(
	query: string,
	snapshot: CatalogSnapshot,
	limit: number,
	translatedFrom?: string,
	zh?: Map<string, string>,
): string {
	const lines: string[] = [];
	lines.push(resultHeader(query, snapshot, translatedFrom), "");
	snapshot.items.slice(0, limit).forEach((item, index) => {
		lines.push(`${String(index + 1).padStart(2)}. ${item.name}  [${item.type || "package"}]  ${formatDownloads(item.downloads)}/mo  ${formatAge(item)}`);
		const itemZh = zh?.get(item.name);
		if (itemZh) lines.push(`    ${itemZh}`);
		if (item.desc) lines.push(`    ${itemZh ? `EN: ${item.desc}` : item.desc}`);
		lines.push(`    ${installCommandFor(item.name)}`);
	});
	return lines.join("\n");
}

/* ────────────────────────────── 安装 ────────────────────────────── */

interface InstallOutcome {
	ok: boolean;
	message: string;
}

async function runInstall(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, signal?: AbortSignal): Promise<InstallOutcome> {
	try {
		const result = await pi.exec("pi", ["install", `npm:${name}`, "-l"], {
			cwd: ctx.cwd,
			timeout: INSTALL_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
		if (result.code === 0) {
			return { ok: true, message: `已装 ${name} → ${join(ctx.cwd, ".pi", "settings.json")}\n运行 /reload 或重启 pi 生效` };
		}
		const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-4).join("\n");
		if (result.code === 127) {
			return { ok: false, message: `找不到 pi 可执行文件，请手动执行:\n  ${installCommandFor(name)}` };
		}
		return { ok: false, message: `安装失败（exit ${result.code}）\n${detail}` };
	} catch (error) {
		return { ok: false, message: `安装失败: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function installWithLoader(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string): Promise<InstallOutcome> {
	return ctx.ui.custom<InstallOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `安装 npm:${name} …`);
		let settled = false;
		const finish = (outcome: InstallOutcome): void => {
			if (settled) return;
			settled = true;
			done(outcome);
		};
		loader.onAbort = () => finish({ ok: false, message: "已取消安装" });
		void runInstall(pi, ctx, name, loader.signal).then(finish, (error: unknown) =>
			finish({ ok: false, message: `安装失败: ${error instanceof Error ? error.message : String(error)}` }),
		);
		return loader;
	});
}

/* ────────────────────────────── TUI 选择器 ────────────────────────────── */

async function pickPackage(
	ctx: ExtensionCommandContext,
	args: CliArgs,
	snapshot: CatalogSnapshot,
	query: string,
	zh: Map<string, string>,
	translatedFrom?: string,
): Promise<string | null> {
	const items: SelectItem[] = snapshot.items.slice(0, args.limit).map((item) => ({
		value: item.name,
		label: item.name,
		description: describeItem(item, { zh: zh.get(item.name) }),
	}));

	const title = translatedFrom ? `pi.dev · ${translatedFrom} → ${query}` : `pi.dev · ${query}`;
	const subtitle = `${snapshot.items.length} / ${snapshot.matched} 命中 · 共 ${snapshot.total} 个包${snapshot.range ? ` · ${snapshot.range}` : ""}`;

	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(`${theme.fg("accent", theme.bold(title))}`, 1, 0));
		container.addChild(new Text(theme.fg("dim", subtitle), 1, 0));

		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · 直接输入可过滤 · enter 装到当前项目 · esc 取消"), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

async function runZhiqi(pi: ExtensionAPI, raw: string, ctx: ExtensionCommandContext): Promise<void> {
	const { args, error } = parseArgs(raw);
	if (error) {
		notify(ctx, error, "warning");
		return;
	}
	if (args.help) {
		if (ctx.mode === "print") console.log(HELP_LINES.join("\n"));
		else notify(ctx, HELP_LINES.join("\n"));
		return;
	}
	if (args.clear) {
		await writeCache(emptyCache());
		await writeZhCache({ v: ZH_CACHE_VERSION, entries: {} });
		notify(ctx, `已清空搜索结果缓存与译文缓存`);
		return;
	}

	let query = args.query;
	if (!query) {
		if (!ctx.hasUI) {
			notify(ctx, "非交互模式必须带关键词：/zhiqi <关键词>", "warning");
			return;
		}
		const typed = await ctx.ui.input("搜索 pi.dev 插件目录", "flowchart / memory / subagent …");
		if (!typed?.trim()) return;
		query = typed.trim();
	}

	if (ctx.hasUI) ctx.ui.setStatus(EXT_ID, `zhiqi: 搜索 ${query} …`);
	try {
		let translatedFrom: string | undefined;
		const onPage = (page: number, donePages: number, totalPages: number): void => {
			if (ctx.hasUI) ctx.ui.setStatus(EXT_ID, `zhiqi: 读取第 ${page} 页（${donePages}/${totalPages}）…`);
		};
		let result = await collectMatches(args, query, ctx.signal, onPage);
		let lookups = 0;

		// 中文关键词在 pi.dev 上几乎必然 0 命中（服务端只匹配英文），此时才请模型翻译。
		// 不再限定 TUI —— print 模式同样需要看得懂，而且翻译本身已有超时与降级保护。
		if (result.snapshot.items.length === 0 && hasCJK(query) && lookups < MAX_TRANSLATION_LOOKUPS) {
			if (ctx.hasUI) ctx.ui.setStatus(EXT_ID, `zhiqi: "${query}" 无结果，正在翻译关键词 …`);
			const originalQuery = query;
			const candidates = await translateKeywords(ctx, originalQuery);
			for (const keyword of candidates) {
				lookups += 1;
				const attempt = await collectMatches(args, keyword, ctx.signal);
				// 保留命中最多的一次；translatedFrom 必须是**原始中文**，不能被上一轮的关键词覆盖
				if (attempt.snapshot.items.length > result.snapshot.items.length) {
					result = attempt;
					translatedFrom = originalQuery;
					query = keyword;
				}
				if (result.snapshot.items.length >= MIN_RESULTS_BEFORE_STOPPING) break;
			}
		}

		if (result.note) notify(ctx, result.note, "warning");

		if (result.snapshot.items.length === 0) {
			const hint = hasCJK(args.query)
				? `pi.dev 目录只索引英文 name/description/keywords。试试英文关键词，例如 /zhiqi diagram`
				: `换个关键词试试（--fresh 可跳过缓存重查）`;
			notify(ctx, `pi.dev 目录没有匹配 "${args.query}" 的包。${hint}`, "warning");
			return;
		}

		// 把英文描述翻成中文（译文永久缓存）。这是“看得懂”的关键，失败就回退英文，不阻断流程。
		const visible = result.snapshot.items.slice(0, args.limit);
		if (ctx.hasUI && !args.en) ctx.ui.setStatus(EXT_ID, `zhiqi: 翻译 ${visible.length} 条描述 …`);
		const translation = await translateItems(ctx, visible, !args.en);
		if (translation.note) notify(ctx, translation.note, "warning");

		if (ctx.mode !== "tui") {
			if (ctx.mode === "print") {
				if (args.json) {
					console.log(
						JSON.stringify(
							{ query, snapshot: result.snapshot, zh: Object.fromEntries(translation.zh) },
							null,
							2,
						),
					);
				} else {
					console.log(renderPlain(query, result.snapshot, args.limit, translatedFrom, translation.zh));
				}
			} else {
				notify(ctx, `${query}: ${result.snapshot.items.length} 条结果（交互模式才有选择器）`);
			}
			return;
		}

		const picked = await pickPackage(ctx, args, result.snapshot, query, translation.zh, translatedFrom);
		if (!picked) {
			notify(ctx, "已取消");
			return;
		}
		if (args.dry) {
			notify(ctx, `[dry-run] ${installCommandFor(picked)}`);
			return;
		}

		const outcome = await installWithLoader(pi, ctx, picked);
		notify(ctx, outcome.message, outcome.ok ? "info" : "error");
	} catch (caught) {
		notify(ctx, `搜索失败: ${caught instanceof Error ? caught.message : String(caught)}`, "error");
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus(EXT_ID, undefined);
	}
}

/* ────────────────────────────── 注册 ────────────────────────────── */

const COMPLETIONS: readonly AutocompleteItem[] = [
	{ value: "--type=extension", label: "--type=extension", description: "只看扩展" },
	{ value: "--type=skill", label: "--type=skill", description: "只看 skill" },
	{ value: "--type=theme", label: "--type=theme", description: "只看主题" },
	{ value: "--type=prompt", label: "--type=prompt", description: "只看 prompt 模板" },
	{ value: "--sort=recent", label: "--sort=recent", description: "按最近发布排序（不做本地重排）" },
	{ value: "--sort=name", label: "--sort=name", description: "按名字排序（不做本地重排）" },
	{ value: "--page=", label: "--page=", description: "翻页（每页 50 条）" },
	{ value: "--limit=", label: "--limit=", description: "展示条数，默认 50（= 1 页），上限 200" },
	{ value: "--en", label: "--en", description: "不翻译，直接看英文原文（不调模型）" },
	{ value: "--fresh", label: "--fresh", description: "跳过缓存强制重查" },
	{ value: "--dry", label: "--dry", description: "只打印安装命令" },
	{ value: "--clear", label: "--clear", description: "清空本地缓存" },
	{ value: "--help", label: "--help", description: "用法" },
];

/**
 * 工厂函数里**只**注册一条命令 —— 这是「不影响 pi 启动速度」的全部秘密。
 * 任何看起来无害的顶层代码（读缓存、探网络、初始化正则表以外的东西）都会摊到每次启动上。
 */
export default function zhiqi(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND, {
		description: "搜索 pi.dev 插件目录，选中即装到当前项目",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim();
			if (!trimmed.startsWith("-")) return null;
			const matches = COMPLETIONS.filter((item) => item.value.startsWith(trimmed));
			return matches.length > 0 ? [...matches] : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runZhiqi(pi, args, ctx);
		},
	});
}
