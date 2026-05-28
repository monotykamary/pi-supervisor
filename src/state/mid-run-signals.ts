/**
 * Mid-run signal detection — replaces the blind turn counter with
 * reactive signals computed from the conversation tail.
 */

import type { Message } from '@earendil-works/pi-ai';
import type { NormalizedBlock } from '../compaction/types.js';
import { normalize } from '../compaction/normalize.js';
import { filterNoise } from '../compaction/filter-noise.js';
import { extractPath } from '../compaction/tool-args.js';

export interface MidRunSignal {
  type: 'tool_error' | 'file_read_loop';
  detail?: string;
}

/** How many recent messages to scan for signals. */
const SIGNAL_WINDOW = 30;

/** Reads of the same file without an edit to that file triggers a loop signal. */
const FILE_READ_LOOP_THRESHOLD = 5;

const FILE_MUTATION_TOOLS = new Set(['Edit', 'Write', 'edit', 'write', 'MultiEdit']);

const FILE_READ_TOOLS = new Set(['Read', 'read', 'read_file', 'View']);

/**
 * Detect mid-run signals from the recent conversation tail.
 * Returns the first signal found (ordered by severity), or null if none.
 */
export function detectMidRunSignals(messages: Message[]): MidRunSignal | null {
  const tail = messages.slice(-SIGNAL_WINDOW);
  if (tail.length === 0) return null;

  const blocks = filterNoise(normalize(tail));
  if (blocks.length === 0) return null;

  return checkToolErrors(blocks) ?? checkFileReadLoop(blocks);
}

/** How many consecutive tool errors (separated by their tool_call) trigger a signal. */
const CONSECUTIVE_ERROR_THRESHOLD = 5;

function checkToolErrors(blocks: NormalizedBlock[]): MidRunSignal | null {
  let consecutive = 0;
  for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - 10); i--) {
    const b = blocks[i];
    if (b.kind === 'tool_result' && b.isError) {
      consecutive++;
      if (consecutive >= CONSECUTIVE_ERROR_THRESHOLD) {
        return { type: 'tool_error', detail: `${b.name}: ${b.text.slice(0, 80)}` };
      }
    } else if (b.kind === 'tool_call') {
      // tool_call between error results is expected — skip it
      continue;
    } else if (b.kind === 'tool_result') {
      // A successful result breaks the streak
      break;
    } else {
      // Any other block (user, assistant, bash) breaks the streak
      break;
    }
  }
  return null;
}

function checkFileReadLoop(blocks: NormalizedBlock[]): MidRunSignal | null {
  const readCounts = new Map<string, number>();

  for (const b of blocks) {
    if (b.kind !== 'tool_call') continue;

    if (FILE_MUTATION_TOOLS.has(b.name)) {
      const path = extractPath(b.args);
      if (path) readCounts.delete(path);
    } else if (FILE_READ_TOOLS.has(b.name)) {
      const path = extractPath(b.args);
      if (path) {
        const count = (readCounts.get(path) ?? 0) + 1;
        readCounts.set(path, count);
        if (count >= FILE_READ_LOOP_THRESHOLD) {
          return { type: 'file_read_loop', detail: path };
        }
      }
    }
  }

  return null;
}
