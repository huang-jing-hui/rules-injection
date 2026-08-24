// ZCode 插件专属逻辑：hook stdin/stdout 协议与会话去重状态文件。
// 规则解析/扫描/匹配等纯逻辑位于 shared/rules.mjs（与 OpenCode 插件共用）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scan_rules as shared_scan_rules } from '../shared/rules.mjs';

// 唯一规则来源目录（按设计决定：只读 ~/.zcode/rules，不读 ~/.claude/rules）
export const RULES_DIR = path.join(os.homedir(), '.zcode', 'rules');
// 会话去重状态目录：记录每个会话已注入过的规则（规则文件级去重）
export const STATE_DIR = path.join(
  os.homedir(), '.zcode', 'cli', 'plugins', 'data', 'rules-injection', 'sessions'
);
// 状态文件保留时长：超过 7 天的会话状态视为陈旧并清理
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

// 纯逻辑转发：hook 脚本统一从本模块导入，无需感知 shared 的存在
export { path_matches, norm_file_key, rule_xml } from '../shared/rules.mjs';
// 规则目录固定为 RULES_DIR，包装为零参形式
export const scan_rules = () => shared_scan_rules(RULES_DIR);

function state_file(session_id) {
  // session id 兜底消毒，防止其包含路径非法字符
  const safe_id = String(session_id).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(STATE_DIR, `${safe_id}.json`);
}

/**
 * 重置会话去重状态。startup/clear/compact 后上下文已清空，
 * 允许（且应当）重新注入，同时顺带清理陈旧状态文件。
 */
export function reset_session(session_id) {
  try {
    fs.rmSync(state_file(session_id), { force: true });
  } catch (e) {
    console.error(`reset_session: ${e.message}`);
  }
  try {
    if (!fs.existsSync(STATE_DIR)) return;
    for (const name of fs.readdirSync(STATE_DIR)) {
      const full = path.join(STATE_DIR, name);
      if (Date.now() - fs.statSync(full).mtimeMs > STALE_MS) {
        fs.rmSync(full, { force: true });
      }
    }
  } catch (e) {
    console.error(`reset_session: 清理陈旧状态失败: ${e.message}`);
  }
}

/**
 * 读取会话已注入的规则键列表（规则文件的归一化路径）。
 */
export function injected_rules(session_id) {
  try {
    const state = JSON.parse(fs.readFileSync(state_file(session_id), 'utf8'));
    return state.rules || [];
  } catch {
    return [];
  }
}

/**
 * 记录本会话新注入的规则键。不可变合并去重后一次性写回。
 */
export function mark_rules_injected(session_id, rule_keys) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const merged = [...new Set([...injected_rules(session_id), ...rule_keys])];
    fs.writeFileSync(state_file(session_id), JSON.stringify({ rules: merged }));
  } catch (e) {
    console.error(`mark_rules_injected: ${e.message}`);
  }
}

/**
 * 读取 hook 的 stdin JSON 输入。空 stdin 或非法 JSON 返回 {}（hook 侧按无输入退出）。
 */
export async function read_stdin_json() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * 以 ZCode/Claude Code 兼容协议向 stdout 输出上下文注入。
 * 注意：ZCode 对 hook 输出做严格 JSON schema 校验，多余字段会导致校验失败，
 * 因此只输出 hookSpecificOutput 这一个字段。
 */
export function emit_additional_context(event_name, context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event_name,
        additionalContext: context,
      },
    })
  );
}
