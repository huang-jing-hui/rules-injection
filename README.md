# rules-injection

ZCode 插件：通过 hooks 自动注入个人规则（用户级 + 项目级）。

- **SessionStart**（`startup|clear|compact`）：注入全局规则 + 遵循规则的重要性声明
- **PreToolUse**（`Read|Write|Edit`）：按被操作文件路径匹配规则的 `paths` glob，注入匹配到的规则全文

## 规则目录与格式

两级规则来源（格式完全相同，递归扫描所有 `.md` 文件，子目录结构不影响行为）：

| 级别 | 目录 | 说明 |
|---|---|---|
| 用户级 | `~/.zcode/rules/` | 对所有项目生效 |
| 项目级 | `<项目>/.zcode/rules/`，不存在时回退 `<项目>/.claude/rules/` | 仅在该项目会话中生效（兼容已有 Claude Code 项目规则的仓库）；项目目录取自 `ZCODE_PROJECT_DIR` 环境变量或 hook 输入的 `cwd` |

项目级规则在注入块中排在用户级之后（更具体的规则更靠后）；两级按各自绝对路径天然不冲突，同名规则不互相覆盖（都会注入）。

**元数据语义**：只看 frontmatter，与文件所在目录无关。

```markdown
---
paths:
  - "**/*.java"
  - "pom.xml"
---

# Java 规则正文……
```

- **无 `paths` 字段** → 全局规则，每个会话开始时全部注入
- **有 `paths` 字段** → 按需规则，Read/Write/Edit 匹配任一 glob 的文件时注入

glob 支持 `**`（跨目录）、`*`（单层）、`?`（单字符）；不含 `/` 的模式只匹配文件名（如 `pom.xml`）；匹配忽略大小写（Windows）。

## 注入格式

每条规则以 XML 标签包裹全文，正文首行带可见的 `[Source: …]` 地址行（部分客户端渲染
上下文时会隐藏 XML 标签，可见行保证规则出处不丢）：

```xml
<rules-injection>
Rules below are the user's personal coding rules. You MUST follow them throughout this session.
Global rules directory: C:\Users\xxx\.zcode\rules
Project rules directory: G:\myproject\.zcode\rules
...

<global-rules>
<rule name="coding-style">
[Source: C:\Users\xxx\.zcode\rules\common\coding-style.md]

规则正文全文
</rule>
</global-rules>
</rules-injection>
```

按需注入（PreToolUse）形如：

```xml
<rules-injection>
The following rules apply to this file (matched via paths globs). Follow them when working on it.

<rule name="coding-style">
[Source: …]

…规则全文…
</rule>
</rules-injection>
```

## 去重

按**规则文件**去重：每条规则每个会话只注入一次。同一语言后续文件触发时，若匹配到的
规则均已注入则静默跳过（如会话里读第二个 .java 文件不再重复注入 java 规则）；若只注入过
部分规则（如先读过 pom.xml），后续文件只补注入剩余规则。`clear`/`compact` 后会重置
（上下文已清空）。状态文件位于
`~/.zcode/cli/plugins/data/rules-injection/sessions/<session_id>.json`，记录已注入的规则列表，
7 天后自动清理。

## 安装

**方式一：GitHub marketplace（推荐）**

ZCode 客户端 → Settings → Plugin Management → Discover 标签 → `+` 按钮 → 输入本仓库地址（GitHub repository），安装 rules-injection。

**方式二：本地目录**

`+` 按钮 → 选择本地目录 → 指向本仓库克隆目录（含 `.zcode-plugin/plugin.json` 的目录），安装 rules-injection。

## 手动测试

```bash
cd <本仓库>/hooks
node test.mjs   # 全部通过输出 ALL PASS

# 或单独喂样例输入：
echo '{"session_id":"test","source":"startup"}' | node session-start.mjs
echo '{"session_id":"test","tool_name":"Read","tool_input":{"file_path":"G:/x/Foo.java"}}' | node inject-rules.mjs
```

预期输出为单行 JSON：`{"hookSpecificOutput":{"hookEventName":"…","additionalContext":"…"}}`。

## 设计说明

- hook 脚本为 Node（`hooks/*.mjs`），由 `hooks/hooks.json` 以
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/xxx.mjs"` 方式调用；该写法在 cmd.exe 与 Git Bash 下均可执行
- 所有失败均静默退出（stderr 记录），绝不阻塞工具调用
- SessionStart matcher 排除 `resume`：恢复的会话历史中已含注入内容
