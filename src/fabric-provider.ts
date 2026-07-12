import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SupervisorState } from './types.js';

const FABRIC_PROVIDER_REGISTER_EVENT = 'pi-fabric:provider:register:v1';
const FABRIC_PROVIDER_DISCOVER_EVENT = 'pi-fabric:provider:discover:v1';

interface FabricActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: 'read' | 'agent';
}

interface FabricInvocationContext {
  extensionContext: ExtensionContext;
}

interface FabricProviderDiscovery {
  version: 1;
  register(provider: FabricProvider, options?: { overwrite?: boolean }): void;
}

interface FabricProvider {
  name: string;
  description: string;
  list(request: { query?: string }): Promise<FabricActionDescriptor[]>;
  describe(actionName: string): Promise<FabricActionDescriptor | undefined>;
  invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext
  ): Promise<unknown>;
}

interface SupervisorFabricController {
  start(outcome: string, context: ExtensionContext): Promise<string>;
  getState(): SupervisorState | null;
}

const descriptors: FabricActionDescriptor[] = [
  {
    name: 'start',
    description:
      'Start persistent supervision toward an explicit outcome. Active supervision remains locked and cannot be replaced by the model.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          description: 'Specific measurable end-state for the supervisor to enforce',
        },
      },
      required: ['outcome'],
      additionalProperties: false,
    },
    risk: 'agent',
  },
  {
    name: 'status',
    description: 'Read the current supervision state',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    risk: 'read',
  },
];

export const registerFabricProvider = (
  pi: ExtensionAPI,
  controller: SupervisorFabricController
): void => {
  const provider: FabricProvider = {
    name: 'supervisor',
    description: 'Persistent goal supervision from pi-supervisor',
    async list(request) {
      const query = request.query?.toLowerCase();
      return query
        ? descriptors.filter((descriptor) =>
            `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query)
          )
        : descriptors;
    },
    async describe(actionName) {
      return descriptors.find((descriptor) => descriptor.name === actionName);
    },
    async invoke(actionName, args, context) {
      if (actionName === 'status') return controller.getState();
      if (actionName === 'start') {
        return {
          message: await controller.start(String(args.outcome), context.extensionContext),
          state: controller.getState(),
        };
      }
      throw new Error(`Unknown supervisor Fabric action: ${actionName}`);
    },
  };

  const register = (): void => {
    pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, {
      version: 1,
      provider,
      overwrite: true,
    });
  };

  register();
  pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const event = value as Partial<FabricProviderDiscovery>;
    if (event.version !== 1 || typeof event.register !== 'function') return;
    event.register(provider, { overwrite: true });
  });
};
