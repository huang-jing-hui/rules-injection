// OpenCode 插件集成测试：模拟 messages.transform 钩子的真实消息结构，
// 验证注入/去重/幂等/边界行为。运行：node test.mjs（前置条件：~/.config/opencode/rules
// 已放入 17 个规则文件——与 ZCode 版相同的规则集）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RulesInjectionPlugin } from './opencode-rules-injection.mjs';

const results = [];
function check(desc, ok, detail = '') {
  results.push(ok);
  console.log(ok ? 'PASS' : 'FAIL', '-', desc, detail ? `(${detail})` : '');
}

async function make_transform() {
  const hooks = await RulesInjectionPlugin({});
  return hooks['experimental.chat.messages.transform'];
}

// 模拟 OpenCode 消息结构：user 消息 / 含 tool part 的 assistant 消息
const make_user = (text) => ({
  id: 'u1',
  info: { role: 'user' },
  parts: [{ id: 'p1', type: 'text', text }],
});
const make_tool_msg = (tool, filePath) => ({
  id: 'a1',
  info: { role: 'assistant' },
  parts: [{ id: 'tp1', type: 'tool', tool, state: { status: 'completed', input: { filePath } } }],
});

const injected_text = (messages) => messages.find((m) => m.info?.role === 'user')?.parts[0]?.text || '';
const source_count = (text) => (text.match(/\[Source: /g) || []).length;

// 1. 全局规则注入
let messages = [make_user('hello')];
await (await make_transform())({}, { messages });
let text = injected_text(messages);
check('全局规则注入到首条用户消息（8 条）', text.includes('<rules-injection>') && source_count(text) === 8, `sources=${source_count(text)}`);
check('前言含规则目录路径', text.includes('Global rules directory:'));
check('无按需规则时不含 on-demand 段', !text.includes('<on-demand-rules>'));
check('原用户文本保留在后续 part', messages[0].parts[1]?.text === 'hello');

// 2. 按需注入：read Foo.java
messages = [make_user('hello'), make_tool_msg('read', 'G:/x/src/Foo.java')];
await (await make_transform())({}, { messages });
text = injected_text(messages);
check('read .java 注入 8 全局 + 3 java = 11 条', source_count(text) === 11, `sources=${source_count(text)}`);
check('含 on-demand 段与 java 规则', text.includes('<on-demand-rules>') && text.includes('name="toolchain"'));

// 3. 规则级去重：再编辑另一个 .java 不增加规则
messages = [make_user('hello'), make_tool_msg('read', 'G:/x/src/Foo.java'), make_tool_msg('edit', 'G:\\x\\src\\Bar.java')];
await (await make_transform())({}, { messages });
text = injected_text(messages);
check('多个同语言文件触发仍只 11 条', source_count(text) === 11, `sources=${source_count(text)}`);

// 4. 幂等：同一数组二次经过钩子不重复注入
const parts_before = messages[0].parts.length;
await (await make_transform())({}, { messages });
check('同数组二次 transform 不重复注入', messages[0].parts.length === parts_before);

// 5. DB 重建模拟：全新数组（无注入痕迹）→ 重新注入（幂等重建）
messages = [make_user('hello'), make_tool_msg('read', 'G:/x/src/Foo.java')];
await (await make_transform())({}, { messages });
check('新数组（DB 重建后）重新注入', injected_text(messages).includes('<rules-injection>'));

// 6. compact 模拟：工具消息被压缩掉 → java 规则不再注入，全局保留
messages = [make_user('hello')];
await (await make_transform())({}, { messages });
text = injected_text(messages);
check('compact 后只剩全局 8 条', source_count(text) === 8 && !text.includes('toolchain'));

// 7. write/edit 工具与大写工具名
messages = [make_user('hello'), make_tool_msg('Write', 'G:/x/app.py')];
await (await make_transform())({}, { messages });
text = injected_text(messages);
check('write 工具（大写）触发 python 规则', text.includes('name="patterns"') && source_count(text) === 10, `sources=${source_count(text)}`);

// 8. 规则目录内文件跳过
const rules_dir = path.join(os.homedir(), '.config', 'opencode', 'rules');
messages = [make_user('hello'), make_tool_msg('read', path.join(rules_dir, 'java', 'toolchain.md'))];
await (await make_transform())({}, { messages });
text = injected_text(messages);
check('读规则目录内文件不触发按需注入', source_count(text) === 8);

// 9. 边界：空消息 / 无用户消息不崩
let empty = [];
await (await make_transform())({}, { messages: empty });
check('空消息数组安全', Array.isArray(empty) && empty.length === 0);
await (await make_transform())({}, { messages: [make_tool_msg('read', 'G:/x/Foo.java')] });
check('无用户消息安全', true);

// 10. 规则目录不存在 → 不注入
const prev_config_dir = process.env.OPENCODE_CONFIG_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rules-empty-'));
process.env.OPENCODE_CONFIG_DIR = tmp;
const empty_hooks = await RulesInjectionPlugin({});
messages = [make_user('hello')];
await empty_hooks['experimental.chat.messages.transform']({}, { messages });
check('规则目录不存在时不注入', !injected_text(messages).includes('<rules-injection>'));
fs.rmSync(tmp, { recursive: true, force: true });
if (prev_config_dir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
else process.env.OPENCODE_CONFIG_DIR = prev_config_dir;

const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\n${failed} FAILED / ${results.length}`);
process.exit(failed === 0 ? 0 : 1);
