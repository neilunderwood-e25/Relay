import type { FoundryApi } from '../shared/contracts';

declare global {
  interface Window {
    foundry: FoundryApi;
  }
}

export {};
