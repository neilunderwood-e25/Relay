import { create } from 'zustand';
import type { TerminalDataEvent, TerminalExitEvent, TerminalSnapshot } from '../../../shared/contracts';

interface TerminalState {
  terminals: TerminalSnapshot[];
  selectedId: string | null;
  error: string | null;
  hydrate(terminals: TerminalSnapshot[]): void;
  upsert(terminal: TerminalSnapshot): void;
  select(id: string): void;
  markOutput(event: TerminalDataEvent): void;
  markStopping(id: string): void;
  markExited(event: TerminalExitEvent): void;
  remove(id: string): void;
  setError(error: string | null): void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  terminals: [],
  selectedId: null,
  error: null,
  hydrate: (terminals) => set((state) => ({
    terminals,
    selectedId: terminals.some((terminal) => terminal.id === state.selectedId)
      ? state.selectedId
      : (terminals[0]?.id ?? null)
  })),
  upsert: (terminal) => set((state) => {
    const exists = state.terminals.some((candidate) => candidate.id === terminal.id);
    return {
      terminals: exists
        ? state.terminals.map((candidate) => candidate.id === terminal.id ? terminal : candidate)
        : [...state.terminals, terminal],
      selectedId: terminal.id,
      error: null
    };
  }),
  select: (id) => set({ selectedId: id }),
  markOutput: (event) => set((state) => {
    const terminal = state.terminals.find((candidate) => candidate.id === event.id);
    if (!terminal || terminal.status !== 'starting') return state;
    return {
      terminals: state.terminals.map((candidate) => candidate.id === event.id
        ? {
            ...candidate,
            status: 'running',
            hasOutput: true,
            lastOutputAt: Date.now(),
            lastSequence: Math.max(candidate.lastSequence, event.sequence)
          }
        : candidate)
    };
  }),
  markStopping: (id) => set((state) => ({
    terminals: state.terminals.map((terminal) => terminal.id === id && terminal.status !== 'exited'
      ? { ...terminal, status: 'stopping' }
      : terminal)
  })),
  markExited: (event) => set((state) => ({
    terminals: state.terminals.map((terminal) => terminal.id === event.id
      ? {
          ...terminal,
          status: 'exited',
          exitCode: event.exitCode,
          exitSignal: event.signal,
          exitedAt: event.exitedAt
        }
      : terminal)
  })),
  remove: (id) => set((state) => {
    const terminals = state.terminals.filter((terminal) => terminal.id !== id);
    return {
      terminals,
      selectedId: state.selectedId === id ? (terminals[0]?.id ?? null) : state.selectedId
    };
  }),
  setError: (error) => set({ error })
}));
