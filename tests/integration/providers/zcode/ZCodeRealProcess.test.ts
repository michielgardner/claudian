import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProviderExecutionEvent, ProviderInteractionPort } from '@/core/execution';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { ZCodeExecutionSession } from '@/providers/zcode/execution/ZCodeExecutionSession';
import { ZCodeConversationHistoryService } from '@/providers/zcode/history/ZCodeConversationHistoryService';
import { isRecord } from '@/providers/zcode/runtime/ZCodeAppServer';
import { decodeZCodeModelCatalog } from '@/providers/zcode/runtime/ZCodeModels';
import { ZCodeRuntime, zcodeWorkspace } from '@/providers/zcode/runtime/ZCodeRuntime';

/**
 * Real `zcode app-server` round trip. It spends model quota, so it runs only with
 * ZCODE_E2E=1 and an installed, signed-in `zcode` (ZCODE_CLI overrides the path).
 */
const run = process.env.ZCODE_E2E === '1' ? describe : describe.skip;

run('ZCode against a real app-server', () => {
  jest.setTimeout(240_000);
  const workspace = mkdtempSync(path.join(tmpdir(), 'claudian-zcode-'));
  mkdirSync(workspace, { recursive: true });
  const host = {
    config: {}, selection: { referencedModelIds: [] }, providerSelection: {}, savedSelection: {},
    environmentText: '', locale: 'en', workingDirectory: workspace,
    resolveCliPath: () => Promise.resolve(process.env.ZCODE_CLI ?? `${process.env.HOME}/.local/bin/zcode`),
    notifyChatOptionsChanged: () => undefined,
    updateConfig: () => Promise.resolve(false),
  } as unknown as ProviderRuntimeHost;
  const runtime = new ZCodeRuntime(host);
  const approvals: string[] = [];
  const interactionPort: ProviderInteractionPort = {
    requestApproval: request => { approvals.push(request.toolName); return Promise.resolve({ interactionId: request.interactionId, decision: 'allow' }); },
    askUserQuestion: request => Promise.resolve({ interactionId: request.interactionId, answers: null }),
    dismissInteraction: () => undefined,
  };

  afterAll(async () => { await runtime.dispose(); });

  it('discovers models without storing a session', async () => {
    const client = await runtime.client();
    const created = await client.call('session/create', { workspace: zcodeWorkspace(workspace) });
    const models = decodeZCodeModelCatalog(isRecord(created) ? created.settings : undefined);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].encodedId).toMatch(/^zcode:/);
    expect(models[0].reasoning?.length).toBeGreaterThan(0);
  });

  it('runs a turn with an approved edit, then replays it from native history', async () => {
    const session = new ZCodeExecutionSession({ lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: workspace, interactionPort }, runtime);
    const run = session.execute({
      input: [{ type: 'text', text: 'Create a file e2e.txt containing exactly: ok. Then run `cat e2e.txt`. Answer in one short sentence.' }],
      configuration: { systemInstructions: { kind: 'explicit', instructions: 'You are tested by an automated check. Be brief.' } },
      toolPolicy: { kind: 'provider-default' },
      signal: new AbortController().signal,
    });
    const events: ProviderExecutionEvent[] = [];
    for await (const event of run.events) events.push(event);

    const terminal = events.at(-1);
    expect(terminal?.type).toBe('turn_completed');
    const tools = events.filter(event => event.type === 'tool_started').map(event => event.type === 'tool_started' ? event.name : '');
    // The model chooses its own tools; any side effect must have been approved through Claudian.
    expect(tools.length).toBeGreaterThan(0);
    expect(approvals.length).toBeGreaterThan(0);
    expect(events.filter(event => event.type === 'tool_completed')).toHaveLength(tools.length);
    expect(events.some(event => event.type === 'text_delta')).toBe(true);
    expect(events.some(event => event.type === 'usage_updated')).toBe(true);
    expect(readFileSync(path.join(workspace, 'e2e.txt'), 'utf8').trim()).toBe('ok');

    const sessionId = session.getSnapshot().providerSessionId;
    expect(sessionId).toMatch(/^sess_/);
    await session.dispose();

    const history = new ZCodeConversationHistoryService(() => Promise.resolve(runtime));
    const { messages } = await history.hydrateConversationHistory({ sessionId: sessionId!, providerState: {}, messages: [] }, workspace);
    expect(messages?.[0]).toMatchObject({ role: 'user', content: expect.stringMatching(/^Create a file e2e\.txt/) });
    const reply = messages?.find(message => message.role === 'assistant');
    expect(reply?.toolCalls?.map(tool => tool.name)).toEqual(tools);
    expect(reply?.content).toBeTruthy();
  });
  it('stops a running command when the run is cancelled', async () => {
    const session = new ZCodeExecutionSession({ lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: workspace, interactionPort }, runtime);
    const run = session.execute({
      input: [{ type: 'text', text: 'Run the shell command `sleep 60 && echo done` and report its output.' }],
      configuration: {
        systemInstructions: { kind: 'explicit', instructions: '' },
        model: 'zcode:account%3Azai-individual-coding-plan/GLM-5.3-Flash', reasoning: 'low', permissionMode: 'yolo',
      },
      toolPolicy: { kind: 'provider-default' },
      signal: new AbortController().signal,
    });
    const events: ProviderExecutionEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'tool_started') run.cancel();
    }
    expect(events.at(-1)?.type).toBe('cancelled');
    expect(events.some(event => event.type === 'tool_completed' && event.isError === true)).toBe(true);
    expect(session.getStatus()).toBe('idle');
    await session.dispose();
  });
  it('sends an attached image to the model', async () => {
    // A 32x32 solid red PNG.
    const red = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';
    const session = new ZCodeExecutionSession({ lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: workspace, interactionPort }, runtime);
    const run = session.execute({
      input: [
        { type: 'text', text: 'What single colour fills the attached image? Answer with one word and use no tools.' },
        { type: 'image', image: { id: 'red', name: 'red.png', mediaType: 'image/png', data: red, size: 120, source: 'paste' } },
      ],
      configuration: { systemInstructions: { kind: 'explicit', instructions: '' }, model: 'zcode:account%3Azai-individual-coding-plan/GLM-5.3-Flash', reasoning: 'low' },
      toolPolicy: { kind: 'provider-default' },
      signal: new AbortController().signal,
    });
    let text = '';
    const events: ProviderExecutionEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text_delta') text += event.text;
    }
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(text.toLowerCase()).toContain('red');
    await session.dispose();
  });
  it('stops asking after switching to full access mid-session', async () => {
    const seen: string[] = [];
    const port: ProviderInteractionPort = { ...interactionPort, requestApproval: request => { seen.push(request.toolName); return Promise.resolve({ interactionId: request.interactionId, decision: 'allow' }); } };
    const session = new ZCodeExecutionSession({ lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: workspace, interactionPort: port }, runtime);
    const turn = async (text: string, permissionMode: string): Promise<void> => {
      const run = session.execute({
        input: [{ type: 'text', text }],
        configuration: { systemInstructions: { kind: 'explicit', instructions: '' }, model: 'zcode:account%3Azai-individual-coding-plan/GLM-5.3-Flash', reasoning: 'low', permissionMode },
        toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
      });
      for await (const event of run.events) void event;
    };
    await turn('Create a file ask.txt containing a. No other tools.', 'build');
    expect(seen.length).toBeGreaterThan(0);
    seen.length = 0;
    await turn('Create a file full.txt containing f. No other tools.', 'yolo');
    expect(readFileSync(path.join(workspace, 'full.txt'), 'utf8').trim()).toBe('f');
    expect(seen).toEqual([]);
    await session.dispose();
  });
  it('follows a switch to full access while a turn is running', async () => {
    const selection = host.providerSelection as { permissionMode?: string };
    const seen: string[] = [];
    const port: ProviderInteractionPort = { ...interactionPort, requestApproval: request => {
      seen.push(request.toolName);
      selection.permissionMode = 'yolo';
      return Promise.resolve({ interactionId: request.interactionId, decision: 'allow' });
    } };
    const session = new ZCodeExecutionSession({ lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: workspace, interactionPort: port }, runtime);
    const run = session.execute({
      input: [{ type: 'text', text: 'Using the Write tool three separate times, create one.txt, two.txt and three.txt, each containing its own name. No other tools.' }],
      configuration: { systemInstructions: { kind: 'explicit', instructions: '' }, model: 'zcode:account%3Azai-individual-coding-plan/GLM-5.3-Flash', reasoning: 'low', permissionMode: 'build' },
      toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
    });
    for await (const event of run.events) void event;
    delete selection.permissionMode;
    for (const name of ['one', 'two', 'three']) expect(readFileSync(path.join(workspace, `${name}.txt`), 'utf8')).toContain(name);
    expect(seen).toHaveLength(1);
    await session.dispose();
  });
});
