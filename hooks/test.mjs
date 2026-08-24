// inject-rules / session-start 的集成测试：用 child_process 直接喂 JSON，绕开 shell 转义。
// 运行：node test.mjs  （全部通过输出 ALL PASS 并退出码 0）
// 注意：多个场景依赖执行顺序（规则文件级去重——先注入的规则影响后续断言）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RULES_DIR } from './lib.mjs';

const hooks_dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const state_dir = path.join(os.homedir(), '.zcode', 'cli', 'plugins', 'data', 'rules-injection', 'sessions');

function run_hook(script, input) {
  const r = spawnSync('node', [path.join(hooks_dir, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function parse_context(out) {
  if (!out) return null;
  const o = JSON.parse(out);
  return {
    event: o.hookSpecificOutput.hookEventName,
    rules: [...o.hookSpecificOutput.additionalContext.matchAll(/<rule name="([^"]+)"/g)].map((m) => m[1]),
    text: o.hookSpecificOutput.additionalContext,
  };
}

const results = [];
function check(desc, ok, detail = '') {
  results.push(ok);
  console.log(ok ? 'PASS' : 'FAIL', '-', desc, detail ? `(${detail})` : '');
}

const sid = `testrun-${Date.now()}`;
const sid2 = `${sid}-b`;
fs.rmSync(path.join(state_dir, `${sid}.json`), { force: true });
fs.rmSync(path.join(state_dir, `${sid2}.json`), { force: true });

// --- session-start ---
let r = run_hook('session-start.mjs', { session_id: sid, source: 'startup' });
let c = parse_context(r.stdout);
check('session-start 注入 8 条全局规则', c?.event === 'SessionStart' && c.rules.length === 8, `rules=${c?.rules.length}`);
check('session-start 含重要性声明', c?.text.includes('MUST follow them throughout this session'));
check('session-start 前言含规则目录绝对路径', c?.text.includes(RULES_DIR));
check('session-start 每条规则含可见 [Source: 地址行', c?.text.split('[Source: ').length - 1 === 8);
check('session-start 规则无 source 属性（路径仅在正文首行）', !c?.text.includes('source="'));
check('session-start XML 外层标签', c?.text.startsWith('<rules-injection>'));
check('session-start stderr 为空', r.stderr === '', r.stderr);

// --- inject-rules（顺序敏感：pom.xml 必须先测，否则 toolchain 已注入只剩 0 条）---
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/pom.xml' } });
c = parse_context(r.stdout);
check('读 pom.xml 注入 toolchain 1 条（basename 匹配）', c?.rules.length === 1 && c.rules[0] === 'toolchain', `rules=${c?.rules?.join(',')}`);

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
c = parse_context(r.stdout);
check('读 .java 注入剩余 2 条（toolchain 已注入被剔除）', c?.rules.length === 2 && !c.rules.includes('toolchain'), `rules=${c?.rules?.join(',')}`);
check('PreToolUse 事件名与外层标签', c?.event === 'PreToolUse' && c.text.startsWith('<rules-injection>'));

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
check('同文件重复读不重注', r.stdout === '');

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: 'G:\\x\\src\\Bar.java' } });
check('另一 .java：规则全部已注入，无输出', r.stdout === '');

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Write', tool_input: { file_path: 'G:/x/app.py' } });
c = parse_context(r.stdout);
check('写 .py 注入 2 条', c?.rules.length === 2, `rules=${c?.rules?.join(',')}`);

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/A.kt' } });
c = parse_context(r.stdout);
check('读 .kt 注入 kotlin 规则 2 条', c?.rules.length === 2);

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/README.md' } });
check('读 .md 无匹配无输出', r.stdout === '');

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: path.join(RULES_DIR, 'java', 'toolchain.md') } });
check('读规则目录内文件跳过', r.stdout === '');

// 边界：空输入 / 非法 JSON / 缺 file_path
let raw = spawnSync('node', [path.join(hooks_dir, 'inject-rules.mjs')], { input: '', encoding: 'utf8' });
check('空 stdin 无输出且不崩', raw.stdout.trim() === '' && raw.status === 0);
raw = spawnSync('node', [path.join(hooks_dir, 'inject-rules.mjs')], { input: '{invalid', encoding: 'utf8' });
check('非法 JSON 无输出且不崩', raw.stdout.trim() === '' && raw.status === 0);
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: {} });
check('缺 file_path 无输出', r.stdout === '');

// 大小写不敏感（Windows）——独立会话，避免规则已注入干扰断言
r = run_hook('inject-rules.mjs', { session_id: sid2, tool_name: 'Read', tool_input: { file_path: 'G:/x/BIG.JAVA' } });
c = parse_context(r.stdout);
check('大写扩展名 .JAVA 仍匹配（3 条全注入）', c?.rules.length === 3, `rules=${c?.rules?.length}`);

// --- 会话重置语义：clear 后重新注入 ---
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
check('重置前 Foo.java 不重注', r.stdout === '');
run_hook('session-start.mjs', { session_id: sid, source: 'clear' });
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
c = parse_context(r.stdout);
check('clear 重置后 java 规则 3 条全部重新注入', c?.rules.length === 3);

fs.rmSync(path.join(state_dir, `${sid}.json`), { force: true });
fs.rmSync(path.join(state_dir, `${sid2}.json`), { force: true });

const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\n${failed} FAILED / ${results.length}`);
process.exit(failed === 0 ? 0 : 1);
