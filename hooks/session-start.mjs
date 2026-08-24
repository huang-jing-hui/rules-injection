#!/usr/bin/env node
// SessionStart hook：重置会话去重状态，并注入全局规则（无 paths 元数据的规则文件）。
// matcher 为 startup|clear|compact，排除 resume——恢复的会话历史中已含注入内容。
import {
  read_stdin_json,
  scan_rules,
  reset_session,
  emit_additional_context,
  rule_xml,
} from './lib.mjs';

try {
  const input = await read_stdin_json();
  if (input.session_id) {
    reset_session(input.session_id);
  }
  const global_rules = scan_rules().filter((r) => !r.paths);
  // 无全局规则时不输出空壳声明，避免噪音
  if (global_rules.length === 0) process.exit(0);
  const body = global_rules.map(rule_xml).join('\n\n');
  const context = `<rules-injection>
Rules below are the user's personal coding rules. You MUST follow them throughout this session.
Additional rules will be injected automatically when you read, write, or edit matching files — follow those too.

<global-rules>
${body}
</global-rules>
</rules-injection>`;
  emit_additional_context('SessionStart', context);
} catch (e) {
  console.error(`session-start hook failed: ${e.message}`);
}
process.exit(0);
