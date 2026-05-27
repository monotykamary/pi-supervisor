import type { NormalizedBlock } from './types';
import { clip, firstLine } from './content';
import { extractPath } from './tool-args';
import { collapseSkillText } from './skill-collapse';

const TRUNCATE_USER = 256;
const TRUNCATE_ASSISTANT = 200;

const SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

const isNoiseUser = (text: string): boolean => {
  return !text.trim();
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'must',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'over',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  'who',
  'which',
  'what',
  'if',
  'then',
  'than',
  'when',
  'where',
  'how',
  'just',
  'also',
]);

const CONTENT_WORD_RE = /\p{L}[\p{L}\p{N}]*|\p{N}+/gu;

const truncateTokens = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  let count = 0;
  let cutIdx = flat.length;
  CONTENT_WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTENT_WORD_RE.exec(flat)) !== null) {
    if (!STOP_WORDS.has(match[0].toLowerCase())) {
      count++;
      if (count > limit) {
        cutIdx = match.index;
        break;
      }
    }
    cutIdx = match.index + match[0].length;
  }
  if (count <= limit) return flat;
  return flat.slice(0, cutIdx).trimEnd() + '...(truncated)';
};

const BASH_CAP = 120;
const PIPE_TAIL_RE =
  /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/;

const compressBash = (raw: string): string => {
  let cmd =
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? raw;
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, '');
  for (let i = 0; i < 3; i++) {
    const stripped = cmd.replace(PIPE_TAIL_RE, '');
    if (stripped === cmd) break;
    cmd = stripped;
  }
  if (cmd.length > BASH_CAP) {
    return cmd.slice(0, BASH_CAP - 3) + '...';
  }
  return cmd;
};

const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  read: 'file_path',
  edit: 'file_path',
  write: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === 'string') {
    return `* ${name} "${args[field] as string}"`;
  }
  const path = extractPath(args);
  if (path) return `* ${name} "${path}"`;
  if (name === 'bash' || name === 'Bash') {
    const raw = (args.command ?? args.description ?? '') as string;
    const cmd = compressBash(raw);
    return `* ${name} "${cmd}"`;
  }
  if (typeof args.query === 'string') {
    return `* ${name} "${clip(args.query as string, 60)}"`;
  }
  return `* ${name}`;
};

interface BriefLine {
  header: string;
  lines: string[];
}

export const buildBriefSections = (blocks: NormalizedBlock[]): BriefLine[] => {
  const sections: BriefLine[] = [];
  let lastHeader = '';

  const push = (header: string, line: string) => {
    if (header === lastHeader && sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
      return;
    }
    sections.push({ header, lines: [line] });
    lastHeader = header;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'user': {
        if (isNoiseUser(b.text)) break;
        const text = truncateTokens(collapseSkillText(b.text), TRUNCATE_USER);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : '';
          push('[user]', text + ref);
        }
        lastHeader = '[user]';
        break;
      }
      case 'bash': {
        const cmd = compressBash(b.command);
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : '';
        if (cmd) {
          push('[user]', `$ ${cmd}${ref}`);
        }
        lastHeader = '[user]';
        break;
      }
      case 'assistant': {
        let raw = b.text;
        for (let i = 0; i < 2; i++) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, '');
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = truncateTokens(raw, TRUNCATE_ASSISTANT);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : '';
          push('[assistant]', text + ref);
        }
        break;
      }
      case 'tool_call': {
        if (!b.name || b.name.trim() === '') break;
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : '';
        const summary = toolOneLiner(b.name, b.args) + ref;
        push('[assistant]', summary);
        break;
      }
      case 'tool_result': {
        if (b.isError) {
          const body = firstLine(b.text, 150);
          if (!body || body === '(no output)') break;
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : '';
          const header = `[tool_error] ${b.name}${ref}`;
          push(header, body);
          lastHeader = header;
        }
        break;
      }
      case 'thinking':
        break;
    }
  }

  // Collapse consecutive identical tool lines
  for (const sec of sections) {
    if (sec.header !== '[assistant]') continue;
    const out: string[] = [];
    for (const line of sec.lines) {
      if (!line.startsWith('* ')) {
        out.push(line);
        continue;
      }
      const ref = line.match(/\(#(\d+)\)$/)?.[1] ?? '';
      const base = ref ? line.slice(0, -(ref.length + 3)).trimEnd() : line;
      const last = out.length > 0 ? out[out.length - 1] : '';
      const m = last.match(/^(.*) \((#[\d, #]+)\) x(\d+)$/);
      if (m && m[1] === base) {
        out[out.length - 1] = `${base} (${m[2]}, #${ref}) x${parseInt(m[3]) + 1}`;
      } else if (last.match(/\(#\d+\)$/) && last.replace(/\s*\(#\d+\)$/, '') === base) {
        const prevRef = last.match(/\(#(\d+)\)$/)?.[1];
        out[out.length - 1] = `${base} (#${prevRef}, #${ref}) x2`;
      } else {
        out.push(line);
      }
    }
    sec.lines = out;
  }

  // Cap tool calls per [assistant] turn
  const TOOL_CALLS_PER_TURN = 8;
  for (const sec of sections) {
    if (sec.header !== '[assistant]') continue;
    const toolIdxs = sec.lines.map((l, i) => (l.startsWith('* ') ? i : -1)).filter((i) => i >= 0);
    if (toolIdxs.length <= TOOL_CALLS_PER_TURN) continue;
    const dropCount = toolIdxs.length - TOOL_CALLS_PER_TURN;
    const dropSet = new Set(toolIdxs.slice(0, dropCount));
    const firstKeptToolIdx = toolIdxs[dropCount];
    const next: string[] = [];
    let inserted = false;
    for (let i = 0; i < sec.lines.length; i++) {
      if (dropSet.has(i)) continue;
      if (!inserted && i === firstKeptToolIdx) {
        next.push(`* (${dropCount} earlier tool-call entries omitted)`);
        inserted = true;
      }
      next.push(sec.lines[i]);
    }
    sec.lines = next;
  }

  // Collapse consecutive identical [tool_error] sections
  const collapsedErrors: BriefLine[] = [];
  for (const sec of sections) {
    const m = sec.header.match(/^\[tool_error\]\s+(\S+?)(?:\s*\(#(\d+)\))?$/);
    if (!m || sec.lines.length !== 1) {
      collapsedErrors.push(sec);
      continue;
    }
    const tool = m[1];
    const ref = m[2];
    const body = sec.lines[0];
    const prev = collapsedErrors[collapsedErrors.length - 1];
    const prevMatch = prev?.header.match(
      /^\[tool_error\]\s+(\S+?)\s*\(((?:#\d+(?:,\s*)?)+)\)(?:\s*x(\d+))?$/
    );
    if (
      prev &&
      prevMatch &&
      prevMatch[1] === tool &&
      prev.lines.length === 1 &&
      prev.lines[0] === body
    ) {
      const refs = prevMatch[2] + (ref ? `, #${ref}` : '');
      const count = prevMatch[3] ? parseInt(prevMatch[3]) + 1 : 2;
      prev.header = `[tool_error] ${tool} (${refs}) x${count}`;
    } else {
      collapsedErrors.push(sec);
    }
  }
  sections.length = 0;
  sections.push(...collapsedErrors);

  return sections;
};

export const stringifyBrief = (sections: BriefLine[]): string => {
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (i > 0) {
      const prev = sections[i - 1];
      const prevIsTools =
        prev.header === '[assistant]' && prev.lines.every((l) => l.startsWith('* '));
      const curIsTools = sec.header === '[assistant]' && sec.lines.every((l) => l.startsWith('* '));
      if (!(prevIsTools && curIsTools)) {
        out.push('');
      }
    }
    out.push(sec.header);
    for (const line of sec.lines) {
      out.push(line);
    }
  }
  return out.join('\n');
};

const WRITE_TOOLS = new Set(['Edit', 'Write', 'edit', 'write', 'MultiEdit']);

const shortenPath = (p: string): string => {
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
};

const synthesizeTurnSummary = (userText: string | null, toolActions: string[]): string => {
  const parts: string[] = [];
  if (userText && userText.length > 3) {
    parts.push(clip(userText, 50));
  }
  const uniqueActions = [...new Set(toolActions)].slice(0, 5);
  if (uniqueActions.length > 0) {
    const edits = uniqueActions.filter((a) => a.startsWith('edited'));
    const others = uniqueActions.filter((a) => !a.startsWith('edited'));
    if (edits.length > 0 && others.length <= 2) {
      parts.push(uniqueActions.join(', '));
    } else if (edits.length > 0) {
      parts.push(edits.join(', '));
      if (others.length > 0) parts.push(`+${others.length} more`);
    } else {
      parts.push(uniqueActions.join(', '));
    }
  }
  return parts.join(' \u2192 ') || '(no actions)';
};

export const identifyTurns = (blocks: NormalizedBlock[]): { summary: string }[] => {
  const turns: { summary: string }[] = [];
  let currentUserText: string | null = null;
  const toolActions: string[] = [];

  const flush = () => {
    if (currentUserText === null && toolActions.length === 0) return;
    turns.push({
      summary: synthesizeTurnSummary(currentUserText, toolActions),
    });
    currentUserText = null;
    toolActions.length = 0;
  };

  for (const b of blocks) {
    if (b.kind === 'user' || b.kind === 'bash') {
      flush();
      currentUserText =
        b.kind === 'user'
          ? truncateTokens(collapseSkillText(b.text), 12)
          : `$ ${compressBash(b.command)}`;
      continue;
    }
    if (b.kind === 'tool_call') {
      if (!b.name || b.name.trim() === '') continue;
      const path = extractPath(b.args);
      const isWrite = WRITE_TOOLS.has(b.name);
      if (isWrite && path) {
        toolActions.push(`edited ${shortenPath(path)}`);
      } else if (path) {
        toolActions.push(`${b.name.toLowerCase()} ${shortenPath(path)}`);
      } else if (b.name === 'bash' || b.name === 'Bash') {
        const raw = (b.args.command ?? '') as string;
        const cmd = compressBash(raw);
        if (cmd) toolActions.push(`ran ${cmd}`);
      } else {
        toolActions.push(b.name.toLowerCase());
      }
    }
  }
  flush();

  return turns;
};
