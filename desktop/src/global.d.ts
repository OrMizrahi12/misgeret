import type { MisgeretDesktopApi } from './contracts.js';

declare global {
  interface Window {
    misgeret?: MisgeretDesktopApi;
  }
}

export {};
