import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerFabricProvider } from '../src/fabric-provider.js';

const createApi = () => {
  const listeners = new Map<string, (value: unknown) => void>();
  const emit = vi.fn();
  const api = {
    events: {
      emit,
      on: vi.fn((name: string, handler: (value: unknown) => void) => {
        listeners.set(name, handler);
      }),
    },
  } as any as ExtensionAPI;
  return { api, emit, listeners };
};

describe('pi-fabric supervisor provider', () => {
  it('registers eagerly and through discovery', async () => {
    const { api, emit, listeners } = createApi();
    const state = {
      active: true,
      outcome: 'Ship the feature',
      provider: 'test',
      modelId: 'model',
      interventions: [],
      startedAt: 1,
    };
    const start = vi.fn(async () => 'started');
    registerFabricProvider(api, { start, getState: () => state });

    expect(emit).toHaveBeenCalledWith(
      'pi-fabric:provider:register:v1',
      expect.objectContaining({ version: 1, overwrite: true })
    );
    const registration = emit.mock.calls[0][1];
    const provider = registration.provider;
    expect((await provider.describe('start')).risk).toBe('agent');
    expect(await provider.invoke('status', {}, {})).toBe(state);

    const context = {} as ExtensionContext;
    await expect(
      provider.invoke('start', { outcome: 'Goal' }, { extensionContext: context })
    ).resolves.toEqual({
      message: 'started',
      state,
    });
    expect(start).toHaveBeenCalledWith('Goal', context);

    const register = vi.fn();
    listeners.get('pi-fabric:provider:discover:v1')?.({ version: 1, register });
    expect(register).toHaveBeenCalledWith(provider, { overwrite: true });
  });
});
