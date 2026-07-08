import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock node:fs so readModelSortLastUsed can be tested in isolation.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import {
  buildModelKey,
  hasUsageData,
  readModelSortLastUsed,
  sortByLastUsed,
} from '../src/ui/model-sort.js';

const mockedExists = vi.mocked(existsSync);
const mockedRead = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildModelKey', () => {
  it('builds a key from provider and model id', () => {
    expect(buildModelKey('anthropic', 'claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
  });

  it('preserves slashes in model ids (e.g. openrouter proxy ids)', () => {
    expect(buildModelKey('openrouter', 'anthropic/claude-sonnet-4')).toBe(
      'openrouter/anthropic/claude-sonnet-4'
    );
  });
});

describe('hasUsageData', () => {
  it('returns false for null', () => {
    expect(hasUsageData(null)).toBe(false);
  });

  it('returns false for an empty map', () => {
    expect(hasUsageData({})).toBe(false);
  });

  it('returns true for a non-empty map', () => {
    expect(hasUsageData({ 'openai/gpt-4o': 1 })).toBe(true);
  });
});

describe('readModelSortLastUsed', () => {
  it('returns null when the config file does not exist', () => {
    mockedExists.mockReturnValue(false);
    expect(readModelSortLastUsed()).toBeNull();
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('returns null when the config is not valid JSON', () => {
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue('not json');
    expect(readModelSortLastUsed()).toBeNull();
  });

  it('returns null when lastUsed is missing', () => {
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue(JSON.stringify({}));
    expect(readModelSortLastUsed()).toBeNull();
  });

  it('returns null when lastUsed is not an object', () => {
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue(JSON.stringify({ lastUsed: 'nope' }));
    expect(readModelSortLastUsed()).toBeNull();
  });

  it('returns the lastUsed map when present', () => {
    const lastUsed = { 'openai/gpt-4o': 100, 'anthropic/claude-sonnet-4': 200 };
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue(JSON.stringify({ lastUsed }));
    expect(readModelSortLastUsed()).toEqual(lastUsed);
  });
});

describe('sortByLastUsed', () => {
  const models = [
    { provider: 'anthropic', id: 'claude-opus-4' },
    { provider: 'anthropic', id: 'claude-sonnet-4' },
    { provider: 'openai', id: 'gpt-4o' },
    { provider: 'google', id: 'gemini-2.5-pro' },
    { provider: 'openai', id: 'gpt-4.1' },
  ];

  it('sorts by last-used descending when all have timestamps', () => {
    const lastUsed = {
      'google/gemini-2.5-pro': 300,
      'openai/gpt-4.1': 500,
      'openai/gpt-4o': 100,
      'anthropic/claude-sonnet-4': 400,
      'anthropic/claude-opus-4': 200,
    };
    const sorted = sortByLastUsed(models, lastUsed, null);
    expect(sorted.map((m) => `${m.provider}/${m.id}`)).toEqual([
      'openai/gpt-4.1',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
      'anthropic/claude-opus-4',
      'openai/gpt-4o',
    ]);
  });

  it('puts the current model first, ahead of more-recent models', () => {
    const lastUsed = {
      'openai/gpt-4.1': 500,
      'openai/gpt-4o': 100,
    };
    const sorted = sortByLastUsed(models, lastUsed, 'google/gemini-2.5-pro');
    expect(sorted[0]).toEqual({ provider: 'google', id: 'gemini-2.5-pro' });
  });

  it('falls back to provider/id alphabetical for equal or missing timestamps', () => {
    const lastUsed: Record<string, number> = {};
    const sorted = sortByLastUsed(models, lastUsed, null);
    expect(sorted.map((m) => `${m.provider}/${m.id}`)).toEqual([
      'anthropic/claude-opus-4',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
      'openai/gpt-4.1',
      'openai/gpt-4o',
    ]);
  });

  it('sorts unused models last, alphabetically within the unused group', () => {
    const lastUsed = {
      'openai/gpt-4o': 500,
    };
    const sorted = sortByLastUsed(models, lastUsed, null);
    expect(sorted.map((m) => `${m.provider}/${m.id}`)).toEqual([
      'openai/gpt-4o',
      'anthropic/claude-opus-4',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
      'openai/gpt-4.1',
    ]);
  });

  it('does not mutate the input array', () => {
    const lastUsed = { 'openai/gpt-4o': 100 };
    const input = models.map((m) => ({ ...m }));
    sortByLastUsed(models, lastUsed, null);
    expect(models).toEqual(input);
  });

  it('returns the same length as the input', () => {
    const lastUsed = { 'openai/gpt-4o': 100 };
    const sorted = sortByLastUsed(models, lastUsed, null);
    expect(sorted).toHaveLength(models.length);
  });
});
