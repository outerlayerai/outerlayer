// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The supported-stack matrix. Qualification
 * classifies a detected stack into supported / partial / not-yet, and the
 * verdict banner is honest about it rather than attempting a repo we can't
 * grade well.
 */

export type StackSupport = "supported" | "partial" | "not_yet";

export interface StackDetection {
  language: string;
  runner?: string;
  /** e.g. "monorepo", "bazel", "needs-gpu" — drives partial/not-yet. */
  traits: string[];
}

export interface StackVerdict {
  support: StackSupport;
  reason: string;
}

const NOT_YET_TRAITS: Record<string, string> = {
  bazel: "hermetic build systems (bazel) aren't supported yet",
  gpu: "GPU-dependent test suites aren't supported yet",
  "needs-gpu": "GPU-dependent test suites aren't supported yet",
  "external-services": "suites needing live external services aren't supported yet",
  mobile: "mobile projects aren't supported yet",
};

const SUPPORTED = new Map<string, string[]>([
  ["python", ["pytest"]],
  ["typescript", ["jest", "vitest"]],
  ["javascript", ["jest", "vitest"]],
]);

const NOT_YET_LANGS: Record<string, string> = {
  java: "JVM stacks are a fast-follow candidate, not supported yet",
  kotlin: "JVM stacks are a fast-follow candidate, not supported yet",
  go: "Go is a fast-follow candidate, not supported yet",
  ruby: "Ruby isn't supported yet",
};

export function classifyStack(detection: StackDetection): StackVerdict {
  const language = detection.language.toLowerCase();

  for (const trait of detection.traits) {
    const blocker = NOT_YET_TRAITS[trait.toLowerCase()];
    if (blocker) return { support: "not_yet", reason: blocker };
  }

  const notYetLang = NOT_YET_LANGS[language];
  if (notYetLang) return { support: "not_yet", reason: notYetLang };

  const runners = SUPPORTED.get(language);
  if (!runners) {
    return { support: "not_yet", reason: `${detection.language} is not a supported stack yet` };
  }
  if (detection.runner && !runners.includes(detection.runner.toLowerCase())) {
    return {
      support: "not_yet",
      reason: `${detection.language} with ${detection.runner} isn't supported (supported: ${runners.join(", ")})`,
    };
  }
  if (detection.traits.includes("monorepo")) {
    return { support: "partial", reason: "monorepo — supported per-workspace; scope the report to one package" };
  }
  return { support: "supported", reason: `${language}/${(detection.runner ?? runners[0]!).toLowerCase()}` };
}
