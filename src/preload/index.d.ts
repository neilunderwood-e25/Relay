import type { RelayApi } from '../shared/contracts';

declare global {
  interface Window {
    relay: RelayApi;
  }
}

export {};
