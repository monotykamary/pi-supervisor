import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

  it.each(['{ partial', 'null', '[]', '{"model":{"provider":"openai"}}'])(
    'does not overwrite malformed model config: %s',
    (content) => {
      const configPath = join(tmp, '.pi', 'supervisor-config.json');
      mkdirSync(join(tmp, '.pi'));
      writeFileSync(configPath, content);
      expect(() => saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4o' })).toThrow();
      expect(readFileSync(configPath, 'utf8')).toBe(content);
      expect(readdirSync(join(tmp, '.pi'))).toEqual(['supervisor-config.json']);
    }
  );

  it('atomically replaces the symlink target while preserving its mode', () => {
    mkdirSync(join(tmp, '.pi'));
    const target = join(tmp, 'shared.json');
    const before = '{"otherKey":"keep"}';
    writeFileSync(target, before, { mode: 0o640 });
    const path = join(tmp, '.pi', 'supervisor-config.json');
    symlinkSync('../shared.json', path);
    const old = openSync(target, 'r');
    try {
      saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4o' });
      expect(readFileSync(old, 'utf8')).toBe(before);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o640);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
        model: { provider: 'openai', modelId: 'gpt-4o' },
        otherKey: 'keep',
      });
    } finally {
      closeSync(old);
    }
  });

  it('does not steal the canonical lock from another process', async () => {
    mkdirSync(join(tmp, '.pi'));
    const target = join(tmp, 'shared.json');
    const configPath = join(tmp, '.pi', 'supervisor-config.json');
    const lock = `${target}.lock`;
    writeFileSync(target, '{}');
    symlinkSync('../shared.json', configPath);
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const lock = process.argv[1];
      fs.mkdirSync(lock);
      fs.utimesSync(lock, 1, 1);
      process.stdout.write('locked\\n');
      fs.readSync(0, Buffer.alloc(1));
      fs.rmdirSync(lock);
    `,
        lock,
      ],
      { timeout: 4000, stdio: ['pipe', 'pipe', 'inherit'] }
    );
    const closed = once(child, 'close');
    try {
      expect(
        await Promise.race([
          once(child.stdout, 'data').then(([data]) => data.toString()),
          closed.then(() => 'closed before acquiring lock'),
        ])
      ).toBe('locked\n');
      expect(() => saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4o' })).toThrow(
        'Config is locked'
      );
      expect(readFileSync(target, 'utf8')).toBe('{}');
      expect(existsSync(lock)).toBe(true);
    } finally {
      child.stdin.end();
      expect(await closed).toEqual([0, null]);
    }
    expect(saveGlobalModel(tmp, { provider: 'openai', modelId: 'gpt-4o' })).toBe(configPath);
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
