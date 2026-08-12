/**
 * Maps an `authorizedAction` `ActionResult` (see `lib/action-kit/result.ts`)
 * onto the dashboard API's canonical error envelope. Routes that delegate to
 * an existing `authorizedAction` reuse its validate → authorize → handle
 * outcome directly instead of re-deriving an HTTP status from scratch — the
 * permission gate a route enforces is then provably the same one the action
 * (and whatever UI already calls it) enforces.
 */

import 'server-only';
import { NextResponse } from 'next/server';
import type { ActionResult } from '@/lib/action-kit/result';
import { structuredError } from './error-envelope';

/**
 * `result.error.code` is one of `ActionErrorCodes` — a closed set the action
 * wrapper itself emits (see `lib/action-kit/result.ts`), not user input, so a
 * plain switch is safe here without importing that module's runtime values.
 */
export function actionResultToResponse<T>(
  result: ActionResult<T>,
  successStatus = 200,
): NextResponse {
  if (result.ok) {
    return NextResponse.json(result.data, { status: successStatus });
  }

  const { code, message, fieldErrors } = result.error;
  switch (code) {
    case 'forbidden':
      return NextResponse.json(structuredError('forbidden', message), { status: 403 });
    case 'unauthenticated':
      return NextResponse.json(structuredError('unauthorized', message), { status: 401 });
    case 'validation_error':
      return NextResponse.json(
        structuredError(
          'invalid_request_body',
          message,
          fieldErrors ? { details: fieldErrors } : {},
        ),
        { status: 400 },
      );
    default:
      return NextResponse.json(structuredError('internal_error', message), { status: 500 });
  }
}
