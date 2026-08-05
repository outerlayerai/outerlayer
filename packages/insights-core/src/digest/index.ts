// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export type { DeltaStat, DigestFinding, DigestModel, WeeklyRollup } from "./types.js";
export { composeDigest } from "./compose.js";
export { renderDigestEmail } from "./render-email.js";
export { renderDigestSlack } from "./render-slack.js";
