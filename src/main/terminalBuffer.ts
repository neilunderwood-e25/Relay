/** Bounded replay buffer for reconnecting renderers and switched terminal tabs. */
export class TerminalBuffer {
  private value = '';

  constructor(private readonly maxCharacters = 1024 * 1024) {
    if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
      throw new Error('Terminal buffer size must be a positive integer');
    }
  }

  append(chunk: string): void {
    if (!chunk) return;
    this.value += chunk;
    if (this.value.length > this.maxCharacters) {
      this.value = this.value.slice(this.value.length - this.maxCharacters);
    }
  }

  read(): string {
    return this.value;
  }

  get length(): number {
    return this.value.length;
  }
}
