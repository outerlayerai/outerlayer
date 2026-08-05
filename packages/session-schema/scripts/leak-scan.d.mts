// SPDX-License-Identifier: Apache-2.0
export interface LeakFinding {
  file?: string;
  path: string;
  sample: string;
}
export function scanFixtureFile(file: string): LeakFinding[];
export function scanDir(dir: string): LeakFinding[];
