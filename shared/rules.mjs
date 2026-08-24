// 规则注入公共逻辑（agent 无关的纯函数）：frontmatter 解析、规则目录扫描、
// glob 匹配、路径归一化、规则 XML 格式化。
// 供 ZCode hooks（hooks/lib.mjs 包装）与 OpenCode 插件（opencode/）共用。
import fs from 'node:fs';
import path from 'node:path';

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

// 递归扫描给定规则目录下所有 .md 规则文件，按路径排序保证注入顺序稳定。
export function scan_rules(rules_dir) {
  if (!fs.existsSync(rules_dir)) return [];
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
  walk(rules_dir);
  rules.sort((a, b) => a.source.localeCompare(b.source));
  return rules;
}

// glob 模式是否匹配给定文件路径。
// 支持 **（跨目录）、*（单层）、?（单字符）；无斜杠的模式只匹配文件名（如 pom.xml）。
// Windows 文件系统大小写不敏感，故匹配一律忽略大小写。
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

// 文件路径归一化为比较键：绝对路径 + 反斜杠统一 + 小写（Windows 大小写不敏感）。
export function norm_file_key(file_path) {
  return path.resolve(file_path).replace(/\\/g, '/').toLowerCase();
}

function xml_escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 单条规则的 XML 包裹格式（全文注入）。
// 地址同时放在 source 属性和正文首行的 [Source: …]——部分客户端渲染上下文时会
// 隐藏 XML 标签/属性，正文里的可见行保证规则出处始终可见。
export function rule_xml(rule) {
  const src = xml_escape(rule.source);
  return `<rule name="${xml_escape(rule.name)}" source="${src}">\n[Source: ${src}]\n\n${rule.content}\n</rule>`;
}
