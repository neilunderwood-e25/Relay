import type { ProviderId } from './contracts';

const ANSI_PATTERN = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g;
const DIM = '\x1b[90m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** Turns provider JSONL into a compact terminal transcript while chunks arrive. */
export class ProviderEventFormatter {
  private pending = '';
  private readonly tools = new Map<string, string>();
  private readonly emittedText = new Set<string>();

  constructor(private readonly provider: ProviderId) {}

  write(chunk: string): string {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    return lines.map((line) => this.formatLine(line)).join('');
  }

  flush(): string {
    if (!this.pending) return '';
    const line = this.pending;
    this.pending = '';
    return this.formatLine(line);
  }

  private formatLine(line: string): string {
    const clean = line.replace(ANSI_PATTERN, '').trim();
    if (!clean) return '';
    const event = parseRecord(clean);
    if (!event) return `${line}\r\n`;
    return this.provider === 'claude' ? this.formatClaude(event) : this.formatCodex(event);
  }

  private formatClaude(event: Record<string, unknown>): string {
    if (event.type === 'system' && event.subtype === 'init') {
      const model = stringValue(event.model);
      return statusLine('●', `Claude connected${model ? ` · ${model}` : ''}`, DIM);
    }
    if (event.type === 'assistant') {
      const message = recordValue(event.message);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      return blocks.map((block) => this.formatClaudeBlock(recordValue(block))).join('');
    }
    if (event.type === 'user') {
      const message = recordValue(event.message);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      return blocks.map((block) => {
        const value = recordValue(block);
        if (value?.type !== 'tool_result') return '';
        const id = stringValue(value.tool_use_id);
        const tool = this.tools.get(id) ?? 'Tool';
        if (id) this.tools.delete(id);
        return statusLine(value.is_error ? '×' : '✓', `${tool} ${value.is_error ? 'failed' : 'finished'}`, value.is_error ? RED : GREEN);
      }).join('');
    }
    if (event.type === 'result') {
      const result = stringValue(event.result);
      if (result && !this.emittedText.has(result.trim())) return this.text(result);
      if (event.is_error) return statusLine('×', stringValue(event.error) || 'Claude failed', RED);
      return statusLine('✓', 'Completed', GREEN);
    }
    if (event.type === 'error') {
      return statusLine('×', eventError(event) || 'Claude failed', RED);
    }
    return '';
  }

  private formatClaudeBlock(block: Record<string, unknown> | null): string {
    if (!block) return '';
    if (block.type === 'text') return this.text(stringValue(block.text));
    if (block.type !== 'tool_use') return '';
    const name = stringValue(block.name) || 'Tool';
    const id = stringValue(block.id);
    if (id) this.tools.set(id, name);
    return statusLine('→', describeClaudeTool(name, recordValue(block.input)), YELLOW);
  }

  private formatCodex(event: Record<string, unknown>): string {
    if (event.type === 'thread.started') return statusLine('●', 'Codex connected', DIM);
    if (event.type === 'turn.started') return statusLine('…', 'Working', DIM);
    if (event.type === 'turn.completed') return statusLine('✓', 'Completed', GREEN);
    if (event.type === 'turn.failed' || event.type === 'error') {
      return statusLine('×', eventError(event) || 'Codex failed', RED);
    }
    if (event.type !== 'item.started' && event.type !== 'item.completed' && event.type !== 'item.updated') return '';
    const item = recordValue(event.item);
    if (!item) return '';
    const completed = event.type === 'item.completed';
    switch (item.type) {
      case 'agent_message':
        return completed ? this.text(stringValue(item.text)) : '';
      case 'command_execution': {
        const command = truncate(stringValue(item.command), 140);
        if (!completed) return statusLine('→', `Run ${command || 'command'}`, YELLOW);
        const exitCode = numberValue(item.exit_code);
        return statusLine(exitCode === 0 ? '✓' : '×', `Command ${exitCode === 0 ? 'finished' : `failed${exitCode === null ? '' : ` (${exitCode})`}`}`, exitCode === 0 ? GREEN : RED);
      }
      case 'file_change':
        return completed ? statusLine('✓', 'Files updated', GREEN) : statusLine('→', 'Update files', YELLOW);
      case 'mcp_tool_call': {
        const server = stringValue(item.server);
        const tool = stringValue(item.tool);
        return statusLine(completed ? '✓' : '→', `${server && tool ? `${server}.${tool}` : tool || 'Tool'} ${completed ? 'finished' : ''}`.trim(), completed ? GREEN : YELLOW);
      }
      case 'reasoning':
        return completed ? this.text(stringValue(item.text), true) : '';
      default:
        return '';
    }
  }

  private text(value: string, dim = false): string {
    const clean = value.trim();
    if (!clean || this.emittedText.has(clean)) return '';
    this.emittedText.add(clean);
    return `${dim ? DIM : ''}${normalizeNewlines(clean)}${dim ? RESET : ''}\r\n`;
  }
}

/** Extracts the provider's final answer from JSONL for planning and run summaries. */
export function extractProviderResult(provider: ProviderId, output: string): string {
  const records = output
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => parseRecord(line.trim()))
    .filter((record): record is Record<string, unknown> => record !== null);
  if (records.length === 0) return output;

  if (provider === 'claude') {
    const results = records
      .filter((event) => event.type === 'result')
      .map((event) => stringValue(event.result))
      .filter(Boolean);
    if (results.length > 0) return results.at(-1)!;
    const messages = records.flatMap((event) => {
      if (event.type !== 'assistant') return [];
      const message = recordValue(event.message);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      return blocks.flatMap((block) => {
        const value = recordValue(block);
        return value?.type === 'text' ? [stringValue(value.text)] : [];
      }).filter(Boolean);
    });
    if (messages.length > 0) return messages.at(-1)!;
  } else {
    const messages = records.flatMap((event) => {
      if (event.type !== 'item.completed') return [];
      const item = recordValue(event.item);
      return item?.type === 'agent_message' ? [stringValue(item.text)] : [];
    }).filter(Boolean);
    if (messages.length > 0) return messages.at(-1)!;
  }

  const errors = records.map(eventError).filter(Boolean);
  return errors.length > 0 ? errors.join('\n') : output;
}

function describeClaudeTool(name: string, input: Record<string, unknown> | null): string {
  const target = stringValue(input?.file_path)
    || stringValue(input?.path)
    || stringValue(input?.pattern)
    || stringValue(input?.query)
    || stringValue(input?.command);
  const labels: Record<string, string> = {
    Bash: 'Run', Read: 'Read', Write: 'Write', Edit: 'Edit', Glob: 'Find', Grep: 'Search',
    WebFetch: 'Fetch', WebSearch: 'Search web', TodoWrite: 'Update plan'
  };
  return `${labels[name] ?? name}${target ? ` ${truncate(target, 140)}` : ''}`;
}

function statusLine(symbol: string, message: string, color: string): string {
  return `${color}${symbol} ${normalizeNewlines(message)}${RESET}\r\n`;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r?\n/g, '\r\n');
}

function truncate(value: string, max: number): string {
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function parseRecord(value: string): Record<string, unknown> | null {
  if (!value.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return recordValue(parsed);
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function eventError(event: Record<string, unknown>): string {
  const nested = recordValue(event.error);
  return stringValue(event.message) || stringValue(event.error) || stringValue(nested?.message);
}
