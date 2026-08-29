// inject-rules / session-start 的集成测试：用 child_process 直接喂 JSON，绕开 shell 转义。
// 运行：node test.mjs  （全部通过输出 ALL PASS 并退出码 0）
// 期望值从当前规则集动态推导（规则文件增减不破坏测试，测试对象是注入管线行为）。
// 注意：多个场景依赖执行顺序（规则文件级去重——先注入的规则影响后续断言）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RULES_DIR, scan_rules, path_matches } from './lib.mjs';

const hooks_dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const state_dir = path.join(os.homedir(), '.zcode', 'cli', 'plugins', 'data', 'rules-injection', 'sessions');

function run_hook(script, input, env_extra) {
  const r = spawnSync('node', [path.join(hooks_dir, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env_extra },
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

// 期望基线：当前用户级规则集（测试环境无 ZCODE_PROJECT_DIR/cwd）
const all_rules = scan_rules();
const global_rules = all_rules.filter((r) => !r.paths);
const match_for = (fp) => all_rules.filter((r) => r.paths?.some((p) => path_matches(p, fp)));

const sid = `testrun-${Date.now()}`;
const sid2 = `${sid}-b`;
const sid3 = `${sid}-c`;
const sid4 = `${sid}-d`;
const sid5 = `${sid}-e`;
const sid6 = `${sid}-f`;
for (const s of [sid, sid2, sid3, sid4, sid5, sid6]) fs.rmSync(path.join(state_dir, `${s}.json`), { force: true });

// --- session-start（无项目上下文：仅用户级全局规则）---
let r = run_hook('session-start.mjs', { session_id: sid, source: 'startup' });
let c = parse_context(r.stdout);
check('session-start 注入全部用户级全局规则', c?.event === 'SessionStart' && c.rules.length === global_rules.length, `rules=${c?.rules.length}/期望${global_rules.length}`);
check('session-start 不含任何按需规则', global_rules.every((g) => c?.text.includes(`[Source: ${g.source}`)) && !c.text.includes('trigger='));
check('session-start 含重要性声明', c?.text.includes('MUST follow them throughout this session'));
check('session-start 前言含规则目录绝对路径', c?.text.includes(RULES_DIR));
check('session-start 每条规则含可见 [Source: 地址行', c?.text.split('[Source: ').length - 1 === global_rules.length);
check('session-start 规则无 source 属性（路径仅在正文首行）', !c?.text.includes('source="'));
check('session-start 无项目目录时不含 Project 行', !c?.text.includes('Project rules directory'));
check('session-start XML 外层标签', c?.text.startsWith('<rules-injection>'));
check('session-start stderr 为空', r.stderr === '', r.stderr);

// --- inject-rules（顺序敏感：pom.xml 必须先测，否则 toolchain 已注入）---
const pom_match = match_for('G:/x/pom.xml');
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/pom.xml' } });
c = parse_context(r.stdout);
check('读 pom.xml 注入 basename 匹配的规则', c?.rules.length === pom_match.length, `rules=${c?.rules?.join(',')}/期望${pom_match.map((x) => x.name).join(',')}`);

const foo_match = match_for('G:/x/src/Foo.java');
const foo_fresh = foo_match.filter((x) => !pom_match.some((y) => y.source === x.source));
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
c = parse_context(r.stdout);
check('读 .java 注入剩余 java 规则（pom 已注入的剔除）', c?.rules.length === foo_fresh.length, `rules=${c?.rules?.length}/期望${foo_fresh.length}`);
check('PreToolUse 事件名与外层标签', c?.event === 'PreToolUse' && c.text.startsWith('<rules-injection>'));

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
check('同文件重复读不重注', r.stdout === '');

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: 'G:\\x\\src\\Bar.java' } });
check('另一 .java：规则全部已注入，无输出', r.stdout === '');

const py_match = match_for('G:/x/app.py');
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Write', tool_input: { file_path: 'G:/x/app.py' } });
c = parse_context(r.stdout);
check('写 .py 注入 python 规则', c?.rules.length === py_match.length, `rules=${c?.rules?.length}/期望${py_match.length}`);

const kt_match = match_for('G:/x/A.kt');
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/A.kt' } });
c = parse_context(r.stdout);
check('读 .kt 注入 kotlin 规则', c?.rules.length === kt_match.length, `rules=${c?.rules?.length}/期望${kt_match.length}`);

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/README.md' } });
check('读 .md 无匹配无输出', r.stdout === '');

r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: path.join(RULES_DIR, 'java', 'toolchain.md') } });
check('读用户级规则目录内文件跳过', r.stdout === '');

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
check('大写扩展名 .JAVA 仍全量匹配', c?.rules.length === foo_match.length, `rules=${c?.rules?.length}/期望${foo_match.length}`);

// --- 项目级规则：临时项目目录夹具 ---
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-proj-'));
const proj_rules = path.join(proj, '.zcode', 'rules');
fs.mkdirSync(proj_rules, { recursive: true });
fs.writeFileSync(path.join(proj_rules, 'proj-global.md'), '# Proj Global\n\n项目级全局规则（测试夹具）');
fs.writeFileSync(path.join(proj_rules, 'proj-java.md'), '---\npaths:\n  - "**/*.java"\n---\n\n# Proj Java\n\n项目级 Java 规则（测试夹具）');

r = run_hook('session-start.mjs', { session_id: sid3, source: 'startup', cwd: proj });
c = parse_context(r.stdout);
check('项目会话 session-start 注入用户级+项目级全局规则', c?.rules.length === global_rules.length + 1, `rules=${c?.rules?.length}/期望${global_rules.length + 1}`);
check('前言含 Project rules directory 行', c?.text.includes(`Project rules directory: ${proj_rules}`));

r = run_hook('inject-rules.mjs', { session_id: sid3, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' }, cwd: proj });
c = parse_context(r.stdout);
check('项目会话读 .java 注入用户级+项目级 java 规则', c?.rules.length === foo_match.length + 1 && c.rules.includes('proj-java'), `rules=${c?.rules?.length}/期望${foo_match.length + 1}`);

r = run_hook('inject-rules.mjs', { session_id: sid3, tool_name: 'Read', tool_input: { file_path: path.join(proj_rules, 'proj-java.md') }, cwd: proj });
check('读项目级规则目录内文件跳过', r.stdout === '');

// 无 .zcode/rules 的目录：行为与无项目一致
const plain_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-plain-'));
r = run_hook('session-start.mjs', { session_id: sid3, source: 'startup', cwd: plain_dir });
c = parse_context(r.stdout);
check('目录无 .zcode/rules 时不加载项目规则', c?.rules.length === global_rules.length && !c?.text.includes('Project rules directory'), `rules=${c?.rules?.length}`);

// 环境变量指定项目目录（无 cwd 时回退生效）
r = run_hook('session-start.mjs', { session_id: sid3, source: 'startup' }, { ZCODE_PROJECT_DIR: proj });
c = parse_context(r.stdout);
check('ZCODE_PROJECT_DIR 环境变量指定项目目录生效', c?.rules.length === global_rules.length + 1, `rules=${c?.rules?.length}`);

// 回退：项目只有 .claude/rules（无 .zcode）
const proj_claude = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-proj-claude-'));
const claude_rules = path.join(proj_claude, '.claude', 'rules');
fs.mkdirSync(claude_rules, { recursive: true });
fs.writeFileSync(path.join(claude_rules, 'legacy-rule.md'), '# Legacy\n\n仅 .claude/rules 的项目规则（测试夹具）');
r = run_hook('session-start.mjs', { session_id: sid3, source: 'startup', cwd: proj_claude });
c = parse_context(r.stdout);
check('.zcode 缺失时回退 .claude/rules', c?.rules.length === global_rules.length + 1 && c?.text.includes(`Project rules directory: ${claude_rules}`), `rules=${c?.rules?.length}`);
fs.rmSync(proj_claude, { recursive: true, force: true });

// 两者并存时 .zcode 优先（.claude 不生效）
const proj_both = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-proj-both-'));
fs.mkdirSync(path.join(proj_both, '.zcode', 'rules'), { recursive: true });
fs.mkdirSync(path.join(proj_both, '.claude', 'rules'), { recursive: true });
fs.writeFileSync(path.join(proj_both, '.zcode', 'rules', 'zcode-rule.md'), '# Z\n\nzcode 优先（测试夹具）');
fs.writeFileSync(path.join(proj_both, '.claude', 'rules', 'claude-rule.md'), '# C\n\nclaude 回退（测试夹具）');
r = run_hook('session-start.mjs', { session_id: sid3, source: 'startup', cwd: proj_both });
c = parse_context(r.stdout);
check('两者并存时 .zcode 优先', c?.rules.length === global_rules.length + 1 && c?.text.includes('zcode-rule') && !c?.text.includes('claude-rule'), `rules=${c?.rules?.length}`);
fs.rmSync(proj_both, { recursive: true, force: true });

// 相对 glob（以会话项目目录为基准解析）
fs.writeFileSync(path.join(proj_rules, 'proj-relative.md'), '---\npaths:\n  - "src/test/**/*.java"\n---\n\n# Proj Relative\n\n相对路径 glob 规则（测试夹具）');

r = run_hook('inject-rules.mjs', { session_id: sid4, tool_name: 'Read', tool_input: { file_path: path.join(proj, 'src', 'test', 'FooTest.java') }, cwd: proj });
c = parse_context(r.stdout);
check('项目相对 glob 匹配项目内 src/test 文件', c?.rules.length === foo_match.length + 2 && c.rules.includes('proj-relative'), `rules=${c?.rules?.length}/期望${foo_match.length + 2}`);

r = run_hook('inject-rules.mjs', { session_id: sid5, tool_name: 'Read', tool_input: { file_path: path.join(proj, 'src', 'main', 'Bar.java') }, cwd: proj });
c = parse_context(r.stdout);
check('项目相对 glob 不匹配 src/main 文件', c?.rules.length === foo_match.length + 1 && !c.rules.includes('proj-relative'), `rules=${c?.rules?.length}`);

r = run_hook('inject-rules.mjs', { session_id: sid6, tool_name: 'Read', tool_input: { file_path: 'G:/x/Out.java' }, cwd: proj });
c = parse_context(r.stdout);
check('项目相对 glob 不匹配项目外文件', c?.rules.length === foo_match.length + 1 && !c.rules.includes('proj-relative'), `rules=${c?.rules?.length}`);

fs.rmSync(proj, { recursive: true, force: true });
fs.rmSync(plain_dir, { recursive: true, force: true });

// --- 会话重置语义：clear 后重新注入 ---
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
check('重置前 Foo.java 不重注', r.stdout === '');
run_hook('session-start.mjs', { session_id: sid, source: 'clear' });
r = run_hook('inject-rules.mjs', { session_id: sid, tool_name: 'Read', tool_input: { file_path: 'G:/x/src/Foo.java' } });
c = parse_context(r.stdout);
check('clear 重置后 java 规则全部重新注入', c?.rules.length === foo_match.length, `rules=${c?.rules?.length}/期望${foo_match.length}`);

for (const s of [sid, sid2, sid3, sid4, sid5, sid6]) fs.rmSync(path.join(state_dir, `${s}.json`), { force: true });

const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\n${failed} FAILED / ${results.length}`);
process.exit(failed === 0 ? 0 : 1);
