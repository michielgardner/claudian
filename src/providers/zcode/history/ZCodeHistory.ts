import type { ChatMessage, ContentBlock, ToolCallInfo } from '@/core/types';

import { encodeZCodeModelId } from '../models';
import { fileDiff } from '../normalization/ZCodeOutput';
import { isRecord } from '../runtime/ZCodeAppServer';

/**
 * Converts native session messages (`info` + `parts`) into Claudian chat messages.
 * Hidden runtime messages (system reminders, synthetic context) are skipped; consecutive
 * assistant messages of one turn merge into one Claudian reply.
 */
export function mapZCodeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const result: ChatMessage[] = [];
  let assistant: ChatMessage | null = null;

  for (const message of messages) {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) continue;
    const info = message.info;
    const semantics = isRecord(info.semantics) ? info.semantics : {};
    if (semantics.uiVisibility === 'hidden' || info.synthetic === true) continue;
    const id = typeof info.messageId === 'string' ? info.messageId : typeof info.id === 'string' ? info.id : '';
    const timestamp = isRecord(info.time) && typeof info.time.created === 'number' ? info.time.created : 0;
    const turnId = isRecord(info.anchor) && typeof info.anchor.turnId === 'string' ? info.anchor.turnId : undefined;

    if (info.role === 'user') {
      const text = message.parts.flatMap(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
      if (!text) continue;
      assistant = null;
      result.push({ id, role: 'user', content: text, timestamp, userMessageId: id, ...(turnId ? { turnId } : {}) });
      continue;
    }
    if (info.role !== 'assistant') continue;
    if (!assistant) {
      assistant = { id, role: 'assistant', content: '', timestamp, assistantMessageId: id, toolCalls: [], contentBlocks: [], ...(turnId ? { turnId } : {}) };
      result.push(assistant);
    } else {
      assistant.assistantMessageId = id;
    }
    appendParts(assistant, message.parts);
    const completed = isRecord(info.time) && typeof info.time.completed === 'number' ? info.time.completed : undefined;
    if (completed) assistant.completedAt = completed;
  }

  for (const message of result) {
    if (message.toolCalls?.length === 0) delete message.toolCalls;
    if (message.contentBlocks?.length === 0) delete message.contentBlocks;
  }
  return result;
}

function appendParts(message: ChatMessage, parts: unknown[]): void {
  const blocks = message.contentBlocks!;
  const tools = message.toolCalls!;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      const last = blocks.at(-1);
      if (last?.type === 'text') last.content += part.text;
      else blocks.push({ type: 'text', content: part.text });
      message.content += message.content ? `\n\n${part.text}` : part.text;
    } else if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
      blocks.push({ type: 'thinking', content: part.text });
    } else if (part.type === 'tool' && typeof part.tool === 'string') {
      // Resumed transcripts spell the call id `callId`, active ones `callID`.
      const id = typeof part.callId === 'string' ? part.callId : typeof part.callID === 'string' ? part.callID : null;
      if (!id) continue;
      const tool = toolCall(id, part.tool, part.state);
      tools.push(tool);
      blocks.push({ type: 'tool_use', toolId: tool.id } satisfies ContentBlock);
    }
  }
}

function toolCall(id: string, name: string, value: unknown): ToolCallInfo {
  const state = isRecord(value) ? value : {};
  // A tool still running in stored history was interrupted.
  const status = state.status === 'completed' ? 'completed' : state.status === 'error' || state.status === 'running' || state.status === 'pending' ? 'error' : 'completed';
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  const diff = fileDiff(metadata.display);
  return {
    id, name, status,
    input: isRecord(state.input) ? { ...state.input } : {},
    result: typeof state.output === 'string' ? state.output : typeof state.error === 'string' ? state.error : '',
    resultFormat: 'plain',
    ...(diff ? { diffData: { filePath: diff.filePath ?? '', diffLines: diff.diffLines, stats: diff.stats } } : {}),
  };
}

/** The model selection recorded on the latest native message, as a Claudian model id. */
export function latestZCodeModel(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index];
    if (!isRecord(message) || !isRecord(message.info)) continue;
    const info = message.info;
    const model = isRecord(info.model) ? info.model : isRecord(info.modelSelection) ? info.modelSelection : info;
    if (typeof model.providerId === 'string' && typeof model.modelId === 'string') {
      return encodeZCodeModelId(model.providerId, model.modelId);
    }
  }
  return null;
}
