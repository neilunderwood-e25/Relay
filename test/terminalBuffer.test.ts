import { describe, expect, it } from 'vitest';
import { TerminalBuffer } from '../src/main/terminalBuffer';

describe('TerminalBuffer', () => {
  it('preserves output in arrival order', () => {
    const buffer = new TerminalBuffer(100);
    buffer.append('hello');
    buffer.append(' world');

    expect(buffer.read()).toBe('hello world');
    expect(buffer.length).toBe(11);
  });

  it('retains only the newest output when its bound is exceeded', () => {
    const buffer = new TerminalBuffer(8);
    buffer.append('12345');
    buffer.append('67890');

    expect(buffer.read()).toBe('34567890');
  });

  it('handles a single chunk larger than the whole buffer', () => {
    const buffer = new TerminalBuffer(4);
    buffer.append('abcdefgh');

    expect(buffer.read()).toBe('efgh');
  });

  it('rejects invalid bounds', () => {
    expect(() => new TerminalBuffer(0)).toThrow('positive integer');
    expect(() => new TerminalBuffer(1.5)).toThrow('positive integer');
  });
});
