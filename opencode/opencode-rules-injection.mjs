// rules-injection 的 OpenCode 插件：从 ~/.config/opencode/rules 注入个人规则。
// - 全局规则（无 paths 元数据）+ 按需规则（paths glob 匹配 read/write/edit 涉及的文件）
// - 通过 experimental.chat.messages.transform 注入第一条用户消息——system message
//   会每轮重复膨胀且部分模型（如 Qwen）不兼容多条 system，superpowers 生产实现同款做法
// - 消息数组每次 LLM 调用从 DB 重建，注入块随之整体重建（幂等、无状态），
//   规则级去重天然成立，无需会话状态文件；compact 后工具消息消失则对应规则自动不再注入
// - 零 npm 依赖：@opencode-ai/plugin 仅提供 TS 类型与 tool() 辅助函数，纯 JS 钩子插件不需要
import path from 'node:path';
import os from 'node:os';
import { scan_rules, path_matches, norm_file_key, rule_xml } from '../shared/rules.mjs';

const MARKER = '<rules-injection>';
const FILE_TOOLS = ['read', 'write', 'edit'];

// 规则目录：尊重 OPENCODE_CONFIG_DIR（OpenCode 使用自定义配置目录时同步生效）
function resolve_rules_dir() {
  const config_dir = (process.env.OPENCODE_CONFIG_DIR || '').trim();
  const base = config_dir || path.join(os.homedir(), '.config', 'opencode');
  return path.join(base, 'rules');
}

// 提取消息数组中 read/write/edit 工具调用涉及的所有文件路径。
// 工具调用位于 assistant 消息的 tool parts，参数为驼峰 filePath（防御性兼容其他命名）。
function collect_touched_files(messages) {
  const files = [];
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue;
    for (const part of m.parts || []) {
      if (part.type !== 'tool') continue;
      const tool = String(part.tool || '').toLowerCase();
      if (!FILE_TOOLS.includes(tool)) continue;
      const args = part.state?.input || part.input || {};
      const file_path = args.filePath || args.file_path || args.path;
      if (file_path) files.push(String(file_path));
    }
  }
  return files;
}

export const RulesInjectionPlugin = async () => {
  const rules_dir = resolve_rules_dir();
  // 文件路径 → 命中规则 的内存缓存（transform 每步都触发，避免重复 glob）；
  // 规则文件内容变动需重启会话生效
  const match_cache = new Map();

  const match_rules_for = (rules, file_path) => {
    const cached = match_cache.get(file_path);
    if (cached) return cached;
    const matched = rules.filter((r) => r.paths?.some((p) => path_matches(p, file_path)));
    match_cache.set(file_path, matched);
    return matched;
  };

  // 构建注入块：全局规则 + 按需规则（按 rule.source 去重）。无可注入内容时返回 null。
  const build_block = (messages) => {
    const rules = scan_rules(rules_dir);
    if (rules.length === 0) return null;

    const global_rules = rules.filter((r) => !r.paths);
    const rules_dir_key = `${norm_file_key(rules_dir)}/`;
    const seen = new Set();
    const on_demand = [];
    for (const file_path of collect_touched_files(messages)) {
      // 规则目录自身的文件跳过：读规则文件不触发规则注入
      if (norm_file_key(file_path).startsWith(rules_dir_key)) continue;
      for (const rule of match_rules_for(rules, file_path)) {
        if (seen.has(rule.source)) continue;
        seen.add(rule.source);
        on_demand.push(rule);
      }
    }
    if (global_rules.length === 0 && on_demand.length === 0) return null;

    const sections = [];
    if (global_rules.length > 0) {
      sections.push(`<global-rules>\n${global_rules.map(rule_xml).join('\n\n')}\n</global-rules>`);
    }
    if (on_demand.length > 0) {
      sections.push(`<on-demand-rules>\n${on_demand.map(rule_xml).join('\n\n')}\n</on-demand-rules>`);
    }
    return `${MARKER}
Rules below are the user's personal coding rules. You MUST follow them throughout this session.
Global rules directory: ${rules_dir}
Additional rules may appear below, matched automatically for files you have read, written, or edited — follow those too.

${sections.join('\n\n')}
</rules-injection>`;
  };

  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        const messages = output.messages || [];
        if (messages.length === 0) return;
        const first_user = messages.find((m) => m.info?.role === 'user');
        if (!first_user || !(first_user.parts || []).length) return;
        // 已含标记说明该数组注入过（内存数组二次经过钩子），跳过
        if (first_user.parts.some((p) => p.type === 'text' && p.text?.includes(MARKER))) return;

        const block = build_block(messages);
        if (!block) return;

        // 复用首个 part 的结构字段（id 等），仅改 type/text——与 superpowers 同款做法
        const ref = first_user.parts[0];
        first_user.parts.unshift({ ...ref, type: 'text', text: block });
      } catch (e) {
        // 注入失败绝不阻断正常对话
        console.error(`rules-injection: ${e.message}`);
      }
    },
  };
};
