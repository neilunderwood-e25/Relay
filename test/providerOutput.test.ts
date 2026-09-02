import { describe, expect, it } from 'vitest';
import { extractProviderResult, ProviderEventFormatter } from '../src/shared/providerOutput';

describe('provider event output', () => {
  it('formats chunked Claude events as readable live activity', () => {
    const formatter = new ProviderEventFormatter('claude');
    const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'opus' });
    const tool = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/app.ts' } }] }
    });
    const result = JSON.stringify({ type: 'result', subtype: 'success', result: 'Finished the task.' });

    expect(formatter.write(`${init}\n${tool.slice(0, 20)}`)).toContain('Claude connected · opus');
    expect(formatter.write(`${tool.slice(20)}\n${result}\n`)).toContain('Read src/app.ts');
    expect(formatter.write('')).toBe('');
    expect(extractProviderResult('claude', `${init}\n${tool}\n${result}\n`)).toBe('Finished the task.');
  });

  it('formats Codex commands and extracts its final agent message', () => {
    const events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'item-1', type: 'command_execution', command: 'npm test' } },
      { type: 'item.completed', item: { id: 'item-1', type: 'command_execution', command: 'npm test', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'item-2', type: 'agent_message', text: 'All tests pass.' } },
      { type: 'turn.completed' }
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
    const formatter = new ProviderEventFormatter('codex');
    const formatted = formatter.write(events);

    expect(formatted).toContain('Codex connected');
    expect(formatted).toContain('Run npm test');
    expect(formatted).toContain('Command finished');
    expect(formatted).toContain('All tests pass.');
    expect(extractProviderResult('codex', events)).toBe('All tests pass.');
  });

  it('streams Claude text deltas before the final result without duplicating them', () => {
    const formatter = new ProviderEventFormatter('claude');
    const delta = (text: string): string => JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
    });
    const stop = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } });
    const result = JSON.stringify({ type: 'result', result: 'Checking tests now.' });

    expect(formatter.write(`${delta('Checking ')}\n`)).toBe('Checking ');
    expect(formatter.write(`${delta('tests now.')}\n${stop}\n`)).toBe('tests now.\r\n');
    expect(formatter.write(`${result}\n`)).not.toContain('Checking tests now.');
  });

  it('leaves ordinary terminal output intact when no event stream was produced', () => {
    expect(extractProviderResult('claude', 'Authentication failed')).toBe('Authentication failed');
  });

  it('projects Cursor stream-json activity and extracts its durable result', () => {
    const events = [
      { type: 'system', subtype: 'init', model: 'Auto', session_id: 'cursor-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Updating the file.' }] } },
      { type: 'tool_call', subtype: 'started', tool_call: { writeToolCall: { args: { path: 'src/app.ts' } } } },
      { type: 'tool_call', subtype: 'completed', tool_call: { writeToolCall: { args: { path: 'src/app.ts' }, result: { success: {} } } } },
      { type: 'result', subtype: 'success', result: 'Cursor finished.', session_id: 'cursor-session' }
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
    const formatted = new ProviderEventFormatter('cursor').write(events);

    expect(formatted).toContain('Cursor connected · Auto');
    expect(formatted).toContain('Write src/app.ts');
    expect(formatted).toContain('Cursor finished.');
    expect(extractProviderResult('cursor', events)).toBe('Cursor finished.');
  });
});
