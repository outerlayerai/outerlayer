/* eslint-disable import/no-unused-modules -- ambient module declaration, not a real export */
// Minimal ambient declaration for `jsdom`: it ships no types and @types/jsdom is
// not a dependency (and this lane may only add the five @milkdown packages). Only
// the tiny surface the headless test shim uses is declared.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis & Record<string, unknown>;
  }
}
