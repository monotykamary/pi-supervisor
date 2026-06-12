import type { Message } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SectionData } from './sections';
import { normalize } from './normalize';
import { filterNoise } from './filter-noise';
import { buildSections } from './build-sections';
import { formatSummary } from './format';

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
 * Uses cache-friendly section ordering (stable first, volatile last).
 */
export function formatForSupervisor(data: SectionData): string {
  return formatSummary(data);
}
