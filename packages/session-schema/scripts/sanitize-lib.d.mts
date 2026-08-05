// SPDX-License-Identifier: Apache-2.0
export function token(value: unknown, len?: number): string;
export const KEEP_KEYS: Record<string, RegExp>;
export const HARNESS_CONSTANTS: string[];
export const PLACEHOLDER_PATTERNS: RegExp[];
export const FORBIDDEN_NEEDLES: RegExp;
export function classify(key: string, value: string, ctx?: Record<string, unknown>): string;
export function isSafeKey(key: string): boolean;
export function sanitizeKey(key: string): string;
export function rewrite(rule: string, value: string): string;
export function sanitizeValue(node: unknown, key?: string, ctx?: Record<string, unknown>): unknown;
export function isSanitizedString(key: string, value: string, ctx?: Record<string, unknown>): boolean;
export function scanValue(
  node: unknown,
  key?: string,
  ctx?: Record<string, unknown>,
  path?: string,
  out?: { path: string; sample: string }[],
): { path: string; sample: string }[];
