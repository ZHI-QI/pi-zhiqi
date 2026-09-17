# fixtures

真实抓取的 pi.dev 目录页，供离线单测使用。**不要手写假 HTML** —— 手写的只能证明「我的正则符合我的想象」。

重新抓取（pi.dev 改版后需要更新）：

```bash
cd test/fixtures
curl -sS "https://pi.dev/packages?name=diagram"                     -o diagram.html
curl -sS "https://pi.dev/packages?name=flowchart"                   -o flowchart.html
curl -sS "https://pi.dev/packages?name=%E6%B5%81%E7%A8%8B%E5%9B%BE"  -o empty-cjk.html          # 「流程图」，0 结果
curl -sS "https://pi.dev/packages?name=pi-ex&page=2"                -o pi-ex-page2.html         # 第 2 页，50 条
curl -sS "https://pi.dev/packages?name=mermaid&type=extension"      -o mermaid-extension.html
```

| 文件 | 抓住的特征 |
|---|---|
| `diagram.html` | 22 条；多类型混排；页面还带「Recently published」区块（用来验解析器不会把非结果卡混进来） |
| `flowchart.html` | 2 条；描述里带 `.` 与长英文 |
| `empty-cjk.html` | `0 / 5639` 这种无 `(of …)` 的计数文案 |
| `pi-ex-page2.html` | `51-100 / 1290`；满页 50 条；202KB（性能基准也用它） |
| `mermaid-extension.html` | `type=extension` 过滤后的页面 |

注意 `total` 会随目录增长变化（抓取时是 5639），所以测试里对 `total` 只断言「> 1000」这类下界，不断言具体值；
但 `matched` / `items.length` / 计数文案是强断言 —— 它们必须和页面严格一致。
