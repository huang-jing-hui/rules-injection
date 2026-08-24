// rules-injection 共享逻辑：规则扫描、frontmatter 解析、glob 匹配、会话去重状态。
// 约定：所有导出函数绝不抛出阻断性错误——hook 失败必须静默（stderr 记录），
// 否则会阻塞用户的正常工具调用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 唯一规则来源目录（按设计决定：只读 ~/.zcode/rules，不读 ~/.claude/rules）
export const RULES_DIR = path.join(os.homedir(), '.zcode', 'rules');
// 会话去重状态目录：记录每个会话已注入过的规则（规则文件级去重）
export const STATE_DIR = path.join(
  os.homedir(), '.zcode', 'cli', 'plugins', 'data', 'rules-injection', 'sessions'
);
// 状态文件保留时长：超过 7 天的会话状态视为陈旧并清理
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

// 解析单个规则文件的原始内容。
// 元数据语义（与用户约定）：无 paths 字段 = 全局规则；有 paths = 按需规则。
// 与规则文件所在子目录无关，只看 frontmatter。
// 仅支持 YAML 的简单列表子集：
//   paths:
//     - "**/*.java"
//     - pom.xml
export function parse_rule(raw, source) {
  const frontmatter_match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let paths = null;
  let content = raw;
  if (frontmatter_match) {
    content = raw.slice(frontmatter_match[0].length);
    const items = [];
    let in_paths = false;
    for (const line of frontmatter_match[1].split(/\r?\n/)) {
      if (/^paths:\s*$/.test(line)) {
        in_paths = true;
        continue;
      }
      if (!in_paths) continue;
      const item = line.match(/^\s+-\s*(.+?)\s*$/);
      if (item) {
        // 去掉条目两侧可选引号
        items.push(item[1].replace(/^["']|["']$/g, ''));
        continue;
      }
      // paths: 段遇到非列表行（其他键或空行后的新键）即结束
      if (/^\S/.test(line)) in_paths = false;
    }
    // 空列表视为无 paths（全局），避免 "paths:" 空段导致规则被静默丢弃
    if (items.length > 0) paths = items;
  }
  return {
    name: path.basename(source, '.md'),
    source,
    paths,
    content: content.trim(),
  };
}

/**
 * 递归扫描 RULES_DIR 下所有 .md 规则文件，按路径排序保证注入顺序稳定。
 */
export function scan_rules() {
  if (!fs.existsSync(RULES_DIR)) return [];
  const rules = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.error(`scan_rules: 无法读取目录 ${dir}: ${e.message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try {
          rules.push(parse_rule(fs.readFileSync(full, 'utf8'), full));
        } catch (e) {
          // 单个规则文件损坏不影响其余规则
          console.error(`scan_rules: 跳过无法解析的规则文件 ${full}: ${e.message}`);
        }
      }
    }
  };
  walk(RULES_DIR);
  rules.sort((a, b) => a.source.localeCompare(b.source));
  return rules;
}

/**
 * glob 模式是否匹配给定文件路径。
 * 支持 **（跨目录）、*（单层）、?（单字符）；无斜杠的模式只匹配文件名（如 pom.xml）。
 * Windows 文件系统大小写不敏感，故匹配一律忽略大小写。
 */
export function path_matches(pattern, file_path) {
  const normalized = file_path.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const regex = new RegExp(`^${re}$`, 'i');
  // 无斜杠模式（pom.xml、build.gradle）只对 basename 匹配
  return p.includes('/')
    ? regex.test(normalized)
    : regex.test(normalized.split('/').pop());
}

/**
 * 文件路径归一化为去重键：绝对路径 + 反斜杠统一 + 小写（Windows 大小写不敏感）。
 */
export function norm_file_key(file_path) {
  return path.resolve(file_path).replace(/\\/g, '/').toLowerCase();
}

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

function xml_escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 单条规则的 XML 包裹格式（全文注入）。
 * 地址同时放在 source 属性和正文首行的 [Source: …]——部分客户端渲染上下文时会
 * 隐藏 XML 标签/属性，正文里的可见行保证规则出处始终可见。
 */
export function rule_xml(rule) {
  const src = xml_escape(rule.source);
  return `<rule name="${xml_escape(rule.name)}" source="${src}">\n[Source: ${src}]\n\n${rule.content}\n</rule>`;
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
