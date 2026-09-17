# e2e

真实网络 + 真实 pi 进程 + 真实伪终端。跑法：

```bash
npm run test:e2e      # 约 70 秒（其中 70 秒都是那一个 pty 测试）
```

| 文件 | 验什么 | 需要 |
|---|---|---|
| `live-catalog.test.ts` | 真拉 pi.dev、真解析、`type=extension` 过滤、中文 0 命中的前提还成立 | 网络 |
| `tui-dry.test.ts` | 把 pi 真的跑起来 → 输入 `/zhiqi` → 选择器画出来 → 回车选中 → 出安装命令 | 网络 + `pi` + `expect` |
| `drive-tui.exp` | 上面那个测试用的 pty 驱动脚本 | `expect` |

前置条件缺失时**硬失败**（见 `requireBinary()`），不静默跳过 —— 跳过会让整套测试看起来是绿的。

`tui-dry.test.ts` 用 `--dry`，所以对磁盘是只读的（连 `.pi/` 都不该出现，测试里断言了这一点）。
**「真的执行 `pi install` 并落盘」没有自动化测试**，要验就手动跑一次不带 `--dry` 的。

---

## 真模型路径（只能手工验，且必须验）

「模型会不会给出可解析的中文」是** mock 永远测不出来**的那一类 —— 它取决于模型实际传什么。
所以下面三条要手跑一次（会花少量 token）：

```bash
# ① 关键词翻译：标题应该显示**原始中文** → 英文关键词
pi -p "/zhiqi 流程图 --limit=2"
#   期望：pi.dev 目录 · "流程图" → flowchart · 2 命中 / 共 5643 个包

# ② 描述翻译：应看到中文说明 + EN: 英文原文
pi -p "/zhiqi mermaid --limit=3"

# ③ 译文缓存：第二次应明显更快（不再调模型）
time pi -p "/zhiqi mermaid --limit=3"
```

实测记录（2026-09-17，deepseek 默认模型）：①② 一次通过；① 约 3.5s；② 约 4.1s；
③ 降到 2.6s（剩下的全是 pi 启动 + 页面下载，翻译部分归零）。

⚠️ **踩过一次的坑**：早期版本在中文关键词重搜时把 `translatedFrom = query` 写在循环里，
而循环里 `query` 已被上一轮的关键词覆盖 → 标题会显示成 `"flowchart" → diagram` 而不是 `"流程图" → diagram`。
单测（当初只测了纯函数）完全看不到 —— 只有真跑一次才暴露。修法：循环外先 `const originalQuery = query`。

---

## 踩过的坑（改这些脚本前必读）

### 1. expect 的 `log_file` 只在它自己读 pty 时才落盘

脚本里如果全是 `sleep`，日志里**只会有一行 `spawn`**，pi 画的界面一个字节都收不到。
第一版就是这么白等了两轮，还误以为是 pi 不渲染。

正确做法：用 `expect -re <标记>` 等真实输出（既同步又把缓冲抽进日志），结尾补 `expect eof` 抽干。

### 2. 就当绪标记别用 emoji

macOS 自带 expect 是 **Tcl 8.5，`TCL_UTF_MAX=3`**，无法表示增补平面字符：
4 字节 UTF-8 会被拆成 4 个 latin-1 字符，在日志里显示成 `ð§` 这种"乱码"。

```
同一段 print 模式输出：
  经 expect 的 log_file 通道 → c3b0 c29f c2a7 c29c
  经纯 bash 重定向           → f09f a79c   ← 正确
```

已用「不含本插件任何代码的纯本地探针扩展」复现，确认是**采集工具**的问题，不是 pi、也不是本插件。
所以日志里 emoji 花掉请忽略；但 3 字节以内的中文（`↑↓ 选择`、`pi.dev ·`）是无损的，可以放心当断言。

### 3. 别 `send "\r"` 到不确定的状态

如果选择器还没画出来，回车会打到别的地方（比如把启动时的报错弹窗按掉，然后 pi 直接退出，
表现为 expect 报 `spawn_id: spawn id exp6 not open`）。
所以要先 `expect -re <就绪标记>` 再按键，并且 `close` 要包 `catch`。

### 4. 一定要隔离 + `--no-session`

`PI_CODING_AGENT_DIR` 和 `--session-dir` 都指到临时目录，加 `--no-session`，
否则会真的往 `~/.pi/agent/sessions/` 写会话文件。
