# rules-injection

为多个 coding agent 注入个人规则：会话开始注入全局规则 + 按文件路径匹配的按需规则。

| Agent | 插件目录 | 规则目录 | 注入机制 |
|---|---|---|---|
| ZCode | `hooks/` | `~/.zcode/rules` | `SessionStart` + `PreToolUse(Read\|Write\|Edit)` hooks |
| OpenCode | `opencode/` | `~/.config/opencode/rules` | `experimental.chat.messages.transform` |

两个插件共用 `shared/rules.mjs` 的核心逻辑（frontmatter 解析、规则扫描、glob 匹配、XML 格式化）。

## 规则格式（两个插件一致）

递归扫描规则目录下所有 `.md` 文件，子目录结构不影响行为。

**元数据语义**：只看 frontmatter，与文件所在目录无关。

```markdown
---
paths:
  - "**/*.java"
  - "pom.xml"
---

# Java 规则正文……
```

- **无 `paths` 字段** → 全局规则，每个会话注入
- **有 `paths` 字段** → 按需规则，Read/Write/Edit 匹配任一 glob 的文件时注入

glob 支持 `**`（跨目录）、`*`（单层）、`?`（单字符）；不含 `/` 的模式只匹配文件名（如 `pom.xml`）；匹配忽略大小写（Windows）。

## ZCode 插件

**安装**：ZCode 客户端 → Settings → Plugin Management → Discover → `+` → 添加本仓库（GitHub 仓库或本地目录），安装 rules-injection。

**去重**：按**规则文件**去重，每条规则每会话只注入一次（状态文件 `~/.zcode/cli/plugins/data/rules-injection/sessions/`，7 天自动清理）；`clear`/`compact` 后重置。hook 失败静默退出，不阻塞工具调用。

## OpenCode 插件

零 npm 依赖（`@opencode-ai/plugin` 只提供 TS 类型与 `tool()` 辅助函数，纯 JS 钩子插件不需要）。

**安装**：在 `~/.config/opencode/opencode.json`（全局）或项目 `opencode.json` 中原地引用：

```json
{
  "plugin": ["<本仓库绝对路径>/opencode/opencode-rules-injection.mjs"]
}
```

原地引用使 `../shared/rules.mjs` 相对导入成立——不要把文件单独复制到 `plugins/` 目录（会丢失 shared 依赖）。

**行为**：

- 每次 LLM 调用前把注入块写入**第一条用户消息**头部（带 `<rules-injection>` 标记防同数组重复注入；不用 system message——会每轮膨胀且部分模型不兼容）
- 注入块 = 前言（含规则目录绝对路径）+ 全局规则 + read/write/edit 工具触及文件匹配的按需规则
- 消息数组每次从 DB 重建，注入块随之幂等重建：**规则级去重天然成立，无需会话状态文件**；compact 后工具消息被压缩则对应规则自动不再注入

## 注入格式（两个插件一致）

每条规则以 XML 标签包裹全文；规则文件地址同时出现在 `source` 属性和正文首行的
`[Source: …]`（部分客户端渲染上下文时会隐藏 XML 标签，可见行保证地址不丢）：

```xml
<rules-injection>
Rules below are the user's personal coding rules. You MUST follow them throughout this session.
Global rules directory: <规则目录绝对路径>
...

<global-rules>
<rule name="coding-style" source="…\common\coding-style.md">
[Source: …\common\coding-style.md]

规则正文全文
</rule>
</global-rules>
</rules-injection>
```

## 手动测试

```bash
node hooks/test.mjs      # ZCode 插件（前置：~/.zcode/rules 已有规则）
node opencode/test.mjs   # OpenCode 插件（前置：~/.config/opencode/rules 已有规则）
```

均输出 `ALL PASS` 与退出码 0。

## 设计说明

- ZCode hook 脚本为 Node，`hooks/hooks.json` 以 `node "${CLAUDE_PLUGIN_ROOT}/hooks/xxx.mjs"` 调用，cmd.exe 与 Git Bash 均可执行
- OpenCode 注入第一条用户消息是 superpowers 生产实证的做法（system message 重复膨胀 + 多 system 消息破坏 Qwen 等模型）
- SessionStart matcher 排除 `resume`：恢复的会话历史中已含注入内容
