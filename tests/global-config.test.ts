import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlobalModel, saveGlobalModel } from '../src/global-config.js';

describe('global-config', () => {
  let tmp: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pi-supervisor-cfg-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loadGlobalModel returns null when no config exists', () => {
    expect(loadGlobalModel()).toBeNull();
  });

  it('saveGlobalModel returns the written config path', () => {
    const path = saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4o' });
    expect(path).toBe(join(tmp, '.pi', 'supervisor-config.json'));
    expect(existsSync(path)).toBe(true);
  });

  it('loadGlobalModel reads back what saveGlobalModel wrote', () => {
    saveGlobalModel(tmp, { provider: 'anthropic', modelId: 'claude-sonnet-4' });
    expect(loadGlobalModel()).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4' });
  });

  it('saveGlobalModel creates the .pi directory when missing', () => {
    expect(existsSync(join(tmp, '.pi'))).toBe(false);
    saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4.1' });
    expect(existsSync(join(tmp, '.pi'))).toBe(true);
  });

  it('saveGlobalModel preserves other keys already present in the config', () => {
    const configPath = join(tmp, '.pi', 'supervisor-config.json');
    mkdirSync(join(tmp, '.pi'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ otherKey: 'keep' }, null, 2));

    saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4o' });

    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.otherKey).toBe('keep');
    expect(parsed.model).toEqual({ provider: 'openai', modelId: 'gpt-4o' });
  });

  it('saveGlobalModel overwrites a previously saved model', () => {
    saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4o' });
    saveGlobalModel(tmp, { provider: 'anthropic', modelId: 'claude-haiku' });
    expect(loadGlobalModel()).toEqual({ provider: 'anthropic', modelId: 'claude-haiku' });
  });

  it('loadGlobalModel returns null for an invalid JSON config', () => {
    mkdirSync(join(tmp, '.pi'), { recursive: true });
    writeFileSync(join(tmp, '.pi', 'supervisor-config.json'), '{ not json');
    expect(loadGlobalModel()).toBeNull();
  });

  it('loadGlobalModel returns null when the model field is incomplete', () => {
    mkdirSync(join(tmp, '.pi'), { recursive: true });
    writeFileSync(
      join(tmp, '.pi', 'supervisor-config.json'),
      JSON.stringify({ model: { provider: 'openai' } })
    );
    expect(loadGlobalModel()).toBeNull();
  });
});
