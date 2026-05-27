import { describe, expect, it } from 'vitest';
import { normalize } from '../src/compaction/normalize.js';
import { filterNoise } from '../src/compaction/filter-noise.js';
import { buildCompactionSummary, formatForSupervisor } from '../src/compaction/index.js';
import type { NormalizedBlock } from '../src/compaction/types.js';

describe('Compaction Pipeline', () => {
  describe('normalize', () => {
    it('normalizes user messages', () => {
      const messages = [{ role: 'user' as const, content: 'Hello world' }];
      const blocks = normalize(messages);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe('user');
      expect(blocks[0]).toHaveProperty('text', 'Hello world');
    });

    it('normalizes assistant text content', () => {
      const messages = [
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Working on it' }],
        },
      ];
      const blocks = normalize(messages);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe('assistant');
    });

    it('normalizes tool calls from assistant content', () => {
      const messages = [
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'toolCall' as const,
              name: 'bash',
              id: 'call_1',
              arguments: { command: 'ls' },
            },
          ],
        },
      ];
      const blocks = normalize(messages);
      const toolCall = blocks.find((b) => b.kind === 'tool_call');
      expect(toolCall).toBeDefined();
      if (toolCall && toolCall.kind === 'tool_call') {
        expect(toolCall.name).toBe('bash');
        expect(toolCall.args).toEqual({ command: 'ls' });
      }
    });

    it('normalizes tool results', () => {
      const messages = [
        {
          role: 'toolResult' as const,
          toolName: 'bash',
          isError: false,
          content: 'file1.txt\nfile2.txt',
        },
      ];
      const blocks = normalize(messages);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe('tool_result');
      if (blocks[0].kind === 'tool_result') {
        expect(blocks[0].name).toBe('bash');
        expect(blocks[0].isError).toBe(false);
      }
    });

    it('normalizes bashExecution messages', () => {
      const messages = [
        {
          role: 'bashExecution' as any,
          command: 'npm test',
          output: '1 test passed',
          exitCode: 0,
        },
      ];
      const blocks = normalize(messages);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe('bash');
      if (blocks[0].kind === 'bash') {
        expect(blocks[0].command).toBe('npm test');
        expect(blocks[0].exitCode).toBe(0);
      }
    });

    it('strips thinking blocks from assistant content', () => {
      const messages = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'thinking' as const, thinking: 'Let me think...', redacted: false },
            { type: 'text' as const, text: 'Here is my answer' },
          ],
        },
      ];
      const blocks = normalize(messages);
      const thinking = blocks.find((b) => b.kind === 'thinking');
      const text = blocks.find((b) => b.kind === 'assistant');
      expect(thinking).toBeDefined();
      expect(text).toBeDefined();
    });
  });

  describe('filterNoise', () => {
    it('removes thinking blocks', () => {
      const blocks: NormalizedBlock[] = [
        { kind: 'thinking', text: 'Internal reasoning', redacted: false },
        { kind: 'user', text: 'Hello' },
      ];
      const filtered = filterNoise(blocks);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].kind).toBe('user');
    });

    it('removes noise tool calls (TodoWrite, etc.)', () => {
      const blocks: NormalizedBlock[] = [
        { kind: 'tool_call', name: 'TodoWrite', args: {} },
        { kind: 'tool_call', name: 'bash', args: { command: 'ls' } },
      ];
      const filtered = filterNoise(blocks);
      expect(filtered).toHaveLength(1);
      if (filtered[0].kind === 'tool_call') {
        expect(filtered[0].name).toBe('bash');
      }
    });

    it('removes XML wrapper noise from user messages', () => {
      const blocks: NormalizedBlock[] = [
        { kind: 'user', text: '<system-reminder>Some directive</system-reminder>' },
        { kind: 'user', text: 'Real user message' },
      ];
      const filtered = filterNoise(blocks);
      expect(filtered).toHaveLength(1);
      if (filtered[0].kind === 'user') {
        expect(filtered[0].text).toBe('Real user message');
      }
    });
  });

  describe('buildCompactionSummary', () => {
    it('produces structured sections from messages', () => {
      const messages = [
        { role: 'user' as const, content: 'Implement JWT auth' },
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'I will implement JWT auth now' }],
        },
      ];
      const summary = buildCompactionSummary(messages);

      expect(summary.sessionGoal).toBeDefined();
      expect(summary.briefTranscript).toBeDefined();
      expect(summary.outstandingContext).toBeDefined();
      expect(summary.currentStatus).toBeDefined();
      expect(summary.filesAndChanges).toBeDefined();
    });

    it('extracts goals from user messages', () => {
      const messages = [
        {
          role: 'user' as const,
          content: 'Please implement JWT authentication with refresh tokens',
        },
      ];
      const summary = buildCompactionSummary(messages);

      expect(summary.sessionGoal.length).toBeGreaterThan(0);
    });

    it('captures tool errors in outstanding context', () => {
      const messages = [
        { role: 'user' as const, content: 'Fix the build' },
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'toolCall' as const,
              name: 'bash',
              id: '1',
              arguments: { command: 'npm run build' },
            },
          ],
        },
        {
          role: 'toolResult' as const,
          toolName: 'bash',
          isError: true,
          content: 'error TS2304: Cannot find name "auth"',
        },
      ];
      const summary = buildCompactionSummary(messages);

      // Should pick up the error in outstanding context
      expect(summary.outstandingContext.length).toBeGreaterThan(0);
    });

    it('produces a brief transcript', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello' },
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Hi there' }],
        },
      ];
      const summary = buildCompactionSummary(messages);

      expect(summary.briefTranscript).toContain('[user]');
      expect(summary.briefTranscript).toContain('[assistant]');
    });

    it('handles empty messages gracefully', () => {
      const summary = buildCompactionSummary([]);
      expect(summary.sessionGoal).toEqual([]);
      expect(summary.briefTranscript).toBe('');
    });
  });

  describe('formatForSupervisor', () => {
    it('formats sections as text', () => {
      const messages = [{ role: 'user' as const, content: 'Implement auth' }];
      const summary = buildCompactionSummary(messages);
      const text = formatForSupervisor(summary);

      expect(text.length).toBeGreaterThan(0);
    });

    it('includes relevant sections for steering decisions', () => {
      const messages = [
        { role: 'user' as const, content: 'Implement JWT auth with tests' },
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Working on it' }],
        },
      ];
      const summary = buildCompactionSummary(messages);
      const text = formatForSupervisor(summary);

      // Should contain at least some structured sections
      expect(text).toMatch(/\[.+\]/);
    });

    it('returns empty string when no data', () => {
      const summary = buildCompactionSummary([]);
      const text = formatForSupervisor(summary);
      expect(text).toBe('');
    });
  });
});
