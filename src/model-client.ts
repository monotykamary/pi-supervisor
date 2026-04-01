/**
 * model-client — calls the supervisor LLM using pi's internal agent session API.
 *
 * callModel        — low-level: returns raw response text
 * callSupervisorModel — high-level: parses response as SteeringDecision
 * SupervisorSession — reusable session for a single supervision goal
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@mariozechner/pi-coding-agent';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SteeringDecision, InterventionASI } from './types.js';

/**
 * Reusable supervisor session for a single goal.
 * Maintains context window across multiple analyses for token efficiency.
 */
export class SupervisorSession {
  private session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  private model: any = null;
  private systemPrompt: string = '';

  async ensureStarted(
    ctx: ExtensionContext,
    provider: string,
    modelId: string,
    systemPrompt: string
  ): Promise<boolean> {
    // If model or system prompt changed, need new session
    const newModel = ctx.modelRegistry.find(provider, modelId);
    if (!newModel) return false;

    if (this.session && this.model === newModel && this.systemPrompt === systemPrompt) {
      // Session reusable
      return true;
    }

    // Dispose old session if exists
    this.dispose();

    const loader = new DefaultResourceLoader({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();

    try {
      const result = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        modelRegistry: ctx.modelRegistry,
        model: newModel,
        tools: [],
        resourceLoader: loader,
      });
      this.session = result.session;
      this.model = newModel;
      this.systemPrompt = systemPrompt;
      return true;
    } catch {
      return false;
    }
  }

  async prompt(
    userPrompt: string,
    signal?: AbortSignal,
    onDelta?: (accumulated: string) => void
  ): Promise<string | null> {
    if (!this.session) return null;

    const onAbort = () => this.session?.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let responseText = '';
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        responseText += event.assistantMessageEvent.delta;
        onDelta?.(responseText);
      }
    });

    try {
      await this.session.prompt(userPrompt);
    } catch {
      return null;
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }

    return responseText;
  }

  dispose(): void {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.model = null;
  }
}

// Global session manager (one per supervision goal)
let activeSession: SupervisorSession | null = null;

export function getOrCreateSession(): SupervisorSession {
  if (!activeSession) {
    activeSession = new SupervisorSession();
  }
  return activeSession;
}

export function disposeSession(): void {
  activeSession?.dispose();
  activeSession = null;
}

/**
 * Run a one-shot LLM call using pi's internal agent session.
 * Returns the raw response text, or null on failure.
 * @deprecated Use SupervisorSession for token efficiency
 */
export async function callModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<string | null> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) return null;

  const loader = new DefaultResourceLoader({
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  let session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  try {
    const result = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelRegistry: ctx.modelRegistry,
      model,
      tools: [],
      resourceLoader: loader,
    });
    session = result.session;
  } catch {
    return null;
  }

  const onAbort = () => session.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let responseText = '';
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      responseText += event.assistantMessageEvent.delta;
      onDelta?.(responseText);
    }
  });

  try {
    await session.prompt(userPrompt);
  } catch {
    return null;
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
    session.dispose();
  }

  return responseText;
}

/**
 * Run a one-shot supervisor analysis using reusable session.
 * Returns { action: "continue" } on any failure so the chat is never interrupted.
 */
export async function callSupervisorModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<SteeringDecision> {
  const session = getOrCreateSession();
  const started = await session.ensureStarted(ctx, provider, modelId, systemPrompt);
  if (!started) return safeContinue('Failed to start supervisor session');

  const text = await session.prompt(userPrompt, signal, onDelta);
  if (text === null) return safeContinue('Model call failed');
  return parseDecision(text);
}

// ---- Response parsing ----

export function parseDecision(text: string): SteeringDecision {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch?.[1] ?? text.trim();

  try {
    const parsed = JSON.parse(jsonStr) as Partial<SteeringDecision>;
    const action = parsed.action;
    if (action !== 'continue' && action !== 'steer' && action !== 'done') {
      return safeContinue('Invalid action in supervisor response');
    }
    return {
      action,
      message: typeof parsed.message === 'string' ? parsed.message.trim() : undefined,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      asi: parsed.asi && typeof parsed.asi === 'object' ? parsed.asi : undefined,
    };
  } catch {
    return safeContinue('Failed to parse supervisor JSON decision');
  }
}

function safeContinue(reason: string): SteeringDecision {
  return { action: 'continue', reasoning: reason, confidence: 0 };
}
