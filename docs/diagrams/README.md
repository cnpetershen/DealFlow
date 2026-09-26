# 架构配图

## DealFlow 产品架构概念图

| 文件 | 用途 |
| --- | --- |
| `dealflow-product-architecture.mmd` | Mermaid 源文件，**唯一手工维护的产物**，改图只改这里 |
| `dealflow-product-architecture.svg` | 矢量图，适合嵌入文档与 README（可无损缩放） |
| `dealflow-product-architecture.png` | 位图，适合直接分享（2600px 宽，白底） |

图的读法：从左侧「外部事实来源」进入，经接入层到 `WorkflowEngine` 的闭环
（事件登记 → Resume → 状态机迁移 → Decision → Policy → Executor），
副作用出口由 Provider Adapter 承担，真实成功由结果事件回执确认。
下方是接口化端口与运行时底座，右侧是这张架构交付的产品能力。

## 重新渲染

渲染依赖 headless Chrome，Windows 上可直接复用系统已安装的 Chrome。
下面的命令只把工具装进被 gitignore 的 `.diagram-tools/`，不影响项目依赖。

```powershell
# 1. 安装渲染工具（跳过 Chromium 下载，改用系统 Chrome）
$env:PUPPETEER_SKIP_DOWNLOAD='1'
npm install --prefix .diagram-tools --cache .diagram-tools/.npm-cache `
  --ignore-scripts --no-audit --no-fund @mermaid-js/mermaid-cli

# 2. 在 .diagram-tools/puppeteer-config.json 指定系统 Chrome
#    {"executablePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"}

# 3. 渲染 PNG 与 SVG
node .diagram-tools/node_modules/@mermaid-js/mermaid-cli/src/cli.js `
  -i docs/diagrams/dealflow-product-architecture.mmd `
  -o docs/diagrams/dealflow-product-architecture.png `
  -e png --size 2600 -b white -p .diagram-tools/puppeteer-config.json

node .diagram-tools/node_modules/@mermaid-js/mermaid-cli/src/cli.js `
  -i docs/diagrams/dealflow-product-architecture.mmd `
  -o docs/diagrams/dealflow-product-architecture.svg `
  -e svg -b white --no-font-embed -p .diagram-tools/puppeteer-config.json
```

不想装工具时，把 `.mmd` 内容粘到 [mermaid.live](https://mermaid.live) 即可在线编辑与导出。

### 改动提示

Mermaid 的自动布局会忽略「被子图内外连线打断的 `direction`」，
因此改图时注意两点，否则容易出现大块空白与跨图长线：

1. 连边尽量只发生在相邻层级之间，跨层回边（人工审批、结果事件回执）控制在必要的最少条数；
2. 与主流程没有连边的子图（运行时底座、产品能力）用 `~~~` 隐形连线锚定到主流程之后，
   否则它们会被排到画布左上角。
