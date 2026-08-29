#!/usr/bin/env node
// PreToolUse hook（matcher: Read|Write|Edit）：按被操作文件的路径匹配规则 frontmatter
// 中的 paths glob，注入匹配到的规则。规则文件级去重：每条规则每会话只注入一次，
// 避免同语言多个文件重复注入同一批规则导致上下文膨胀。
import {
  RULES_DIR,
  project_rules_dir,
  session_project_dir,
  norm_file_key,
  read_stdin_json,
  collect_rules,
  path_matches,
  injected_rules,
  mark_rules_injected,
  emit_additional_context,
  rule_xml,
} from './lib.mjs';

try {
  const input = await read_stdin_json();
  const file_path = input?.tool_input?.file_path;
  if (!file_path || !input.session_id) process.exit(0);
  // 规则目录自身的文件跳过（用户级与项目级）：读规则文件不触发规则注入，避免元数据噪音
  const rules_dir_keys = [RULES_DIR, project_rules_dir(input)]
    .filter(Boolean)
    .map((d) => `${norm_file_key(d)}/`);
  const file_key = norm_file_key(file_path);
  if (rules_dir_keys.some((k) => file_key.startsWith(k))) process.exit(0);

  // 相对 glob（如 src/test/**/*.java）以会话项目目录为基准解析
  const project = session_project_dir(input);
  const matched = collect_rules(input)
    .filter((r) => r.paths?.some((p) => path_matches(p, file_path, project)));
  // 最常见路径：文件不匹配任何规则，快速退出
  if (matched.length === 0) process.exit(0);

  // 已注入过的规则剔除；全部已注入则静默退出（如第二个 .java 文件）
  const already = new Set(injected_rules(input.session_id));
  const fresh = matched.filter((r) => !already.has(norm_file_key(r.source)));
  if (fresh.length === 0) process.exit(0);
  mark_rules_injected(
    input.session_id,
    fresh.map((r) => norm_file_key(r.source))
  );

  const body = fresh.map(rule_xml).join('\n\n');
  const context = `<rules-injection>
The following rules apply to this file (matched via paths globs). Follow them when working on it.

${body}
</rules-injection>`;
  emit_additional_context('PreToolUse', context);
} catch (e) {
  console.error(`inject-rules hook failed: ${e.message}`);
}
process.exit(0);
