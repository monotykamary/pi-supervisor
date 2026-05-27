import type { Message } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SectionData } from './types';
import { normalize } from './normalize';
import { filterNoise } from './filter-noise';
import { buildSections } from './build-sections';

const section = (title: string, items?: string[]): string => {
  if (!items || items.length === 0) return '';
  const body = items.map((i) => `- ${i}`).join('\n');
  return `[${title}]\n${body}`;
};

const BRIEF_MAX_LINES = 120;
const TUI_SAFE_LINE_CHARS = 120;

const wrapLine = (line: string, maxChars: number): string[] => {
  if (line.length <= maxChars) return [line];

  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? '';
  const continuationIndent = indent ? ' '.repeat(Math.min(indent.length, 8)) : '';
  const wrapped: string[] = [];
  let remaining = line;
  let prefix = '';

  while (prefix.length + remaining.length > maxChars) {
    const available = Math.max(20, maxChars - prefix.length);
    let splitAt = remaining.lastIndexOf(' ', available);
    if (splitAt < Math.floor(available * 0.5)) splitAt = available;

    wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    prefix = continuationIndent;
  }

  if (remaining) wrapped.push(prefix + remaining);
  return wrapped;
};

const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text
    .split('\n')
    .flatMap((line) => wrapLine(line, maxChars))
    .join('\n');

const capBrief = (text: string): string => {
  const lines = text.split('\n');
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const omitted = lines.length - BRIEF_MAX_LINES;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join('\n')}`;
};

/**
 * Extract Message[] from the active branch entries.
 */
export function extractMessages(ctx: ExtensionContext): Message[] {
  const entries = ctx.sessionManager.getBranch();
  const messages: Message[] = [];
  for (const entry of entries) {
    if (entry.type === 'message' && (entry as any).message) {
      messages.push((entry as any).message);
    }
  }
  return messages;
}

/**
 * Build a structured compaction summary from branch messages.
 * One-shot, no merge, no state — fresh each time.
 */
export function buildCompactionSummary(messages: Message[]): SectionData {
  const blocks = filterNoise(normalize(messages));
  return buildSections({ blocks });
}

/**
 * Format SectionData as text for the supervisor prompt.
 * Only includes sections relevant to steering decisions.
 */
export function formatForSupervisor(data: SectionData): string {
  const sections = [
    section('Session Goal', data.sessionGoal),
    section('User Preferences', data.userPreferences),
    section('Files And Changes', data.filesAndChanges),
    section('Commits', data.commits),
    section('Outstanding Context', data.outstandingContext),
    section('Current Status', data.currentStatus),
    section('Earlier Turns', data.turnSummaries),
  ].filter(Boolean);

  const parts: string[] = [];
  if (sections.length > 0) {
    parts.push(sections.join('\n\n'));
  }
  if (data.briefTranscript) {
    parts.push(capBrief(data.briefTranscript));
  }

  if (parts.length === 0) return '';
  return wrapLongLines(parts.join('\n\n---\n\n'));
}
