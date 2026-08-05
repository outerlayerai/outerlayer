/**
 * Trace/span `filter` query-param grammar (string DSL).
 *
 * The public read endpoint (`GET /v1/spans`) accepts a
 * human-readable filter expression and compile it to the internal
 * `AnalyticsFilter[]` AST that `buildSplitFilterWhereClause` already knows how
 * to turn into parameterized ClickHouse SQL. This module is the *only* new
 * surface: it parses + validates the string and never touches SQL, so a
 * predicate the parser accepts is always one the backend can execute (the
 * parser's allowlist IS the backend's capability set).
 *
 * Grammar (AND of predicates and parenthesized OR-groups — conjunctive
 * normal form, one level deep, mirroring the `AnalyticsFilterNode[]` AST):
 *
 *   filter      = clause ("and" clause)*
 *   clause      = predicate | "(" predicate ("or" predicate)* ")"
 *   predicate   = field operator [value]
 *   operator    = "="  | "!=" | ">" | ">=" | "<" | "<="
 *               | "contains" | "not contains"
 *               | "starts with" | "ends with"
 *               | "exists" | "does not exist"        // take no value
 *   value       = '"..."' | "'...'" | bareword        // quote values with spaces
 *   field       = status | cost | latency_ms | model | user_id | session_id
 *               | trace_id | input | output | props
 *               | semantic_kind | prompt_tokens | completion_tokens
 *               | tags | metadata.<key> | score__<name>
 *
 * `or` is only valid inside parentheses, `and` only outside them — there is
 * exactly one way to write any expression, so no precedence rules to learn
 * (or get wrong silently). Groups cannot nest.
 *
 * Examples:
 *   metadata.debug_screenshot_url exists
 *   metadata.env = "prod" and status = ERROR
 *   cost > 0.01 and latency_ms <= 2000
 *   (model = "gpt-4o" or model = "claude-sonnet-4-6") and status = ERROR
 *
 * This string DSL is the only documented grammar; there is no JSON filter
 * form on this path. Anything malformed throws {@link FilterParseError}, and
 * the route handlers translate that into a 400 carrying the message. A
 * dropped predicate must never be silent: a filter the caller believes is
 * narrowing their results would instead return every row.
 */

import type { AnalyticsFilter, AnalyticsFilterNode } from '@repo/api-types';
import {
  type CanonicalOp,
  type FieldKind,
  VALUELESS_OPS,
  STATIC_FIELDS,
  DSL_OPS_BY_KIND,
  METADATA_KEY_RE,
  SCORE_NAME_RE,
  STATUS_VALUES,
  NUMERIC_VALUE_RE,
  MAX_FILTER_PREDICATES,
} from '@repo/api-schemas';

/** Thrown for any syntactically or semantically invalid filter expression. */
export class FilterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterParseError';
  }
}

// Field/operator allowlists live in @repo/api-schemas (public
// contract), shared with the JSON filter validator (filter-validation.ts)
// and the /v1/filter-schema discovery endpoint so the surfaces cannot
// drift. The parser uses the DSL view of the operator sets —
// `in`/`notIn`/`between` are JSON-only and have no DSL surface syntax
// (membership is an OR-group here).
const OPS_BY_KIND = DSL_OPS_BY_KIND;

// Bounds. Each predicate becomes a ClickHouse WHERE clause, so an unbounded
// expression is a DoS/perf vector — cap both the raw length (cheap guard
// before tokenizing) and the predicate count (mirrors the dashboard's 10-filter
// cap; slightly higher here since API callers compose filters programmatically).
const MAX_FILTER_LENGTH = 2000;
const MAX_PREDICATES = MAX_FILTER_PREDICATES;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { type: 'sym'; value: '=' | '!=' | '>' | '>=' | '<' | '<=' }
  | { type: 'paren'; value: '(' | ')' } // OR-group delimiters
  | { type: 'str'; value: string } // quoted string literal (quotes stripped)
  | { type: 'word'; value: string }; // bareword: field, keyword, or unquoted value

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Quoted string (single or double). Supports backslash escapes.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let str = '';
      let closed = false;
      while (i < n) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < n) {
          str += input[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        str += c;
        i++;
      }
      if (!closed) {
        throw new FilterParseError(`Unterminated quoted string in filter: ${input.slice(0).trim()}`);
      }
      tokens.push({ type: 'str', value: str });
      continue;
    }

    // OR-group parentheses
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    // Operator symbols
    if (ch === '=') {
      tokens.push({ type: 'sym', value: '=' });
      i++;
      continue;
    }
    if (ch === '!') {
      if (input[i + 1] === '=') {
        tokens.push({ type: 'sym', value: '!=' });
        i += 2;
        continue;
      }
      throw new FilterParseError(`Unexpected "!" in filter (did you mean "!="?)`);
    }
    if (ch === '>') {
      if (input[i + 1] === '=') {
        tokens.push({ type: 'sym', value: '>=' });
        i += 2;
      } else {
        tokens.push({ type: 'sym', value: '>' });
        i++;
      }
      continue;
    }
    if (ch === '<') {
      if (input[i + 1] === '=') {
        tokens.push({ type: 'sym', value: '<=' });
        i += 2;
      } else {
        tokens.push({ type: 'sym', value: '<' });
        i++;
      }
      continue;
    }

    // Bareword: run of chars until whitespace, quote, paren, or operator symbol.
    let word = '';
    while (i < n) {
      const c = input[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '"' || c === "'"
        || c === '=' || c === '!' || c === '>' || c === '<' || c === '(' || c === ')') {
        break;
      }
      word += c;
      i++;
    }
    tokens.push({ type: 'word', value: word });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a filter expression into the internal `AnalyticsFilterNode[]` AST:
 * leaf predicates plus one-level `{ or: [...] }` groups, combined with AND.
 *
 * @throws {FilterParseError} on any malformed / unsupported input.
 */
export function parseFilterExpression(input: string): AnalyticsFilterNode[] {
  if (input.length > MAX_FILTER_LENGTH) {
    throw new FilterParseError(
      `Filter expression too long (${input.length} chars; max ${MAX_FILTER_LENGTH}).`,
    );
  }
  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new FilterParseError('Empty filter expression.');
  }

  const nodes: AnalyticsFilterNode[] = [];
  let predicateCount = 0;
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];
  const isWord = (t: Token | undefined, v: string): boolean =>
    !!t && t.type === 'word' && t.value.toLowerCase() === v;
  const isParen = (t: Token | undefined, v: '(' | ')'): boolean =>
    !!t && t.type === 'paren' && t.value === v;

  // One `field operator [value]` leaf. The MAX_PREDICATES cap counts every
  // leaf — grouped or not — since each becomes a ClickHouse WHERE clause.
  const parsePredicate = (): AnalyticsFilter => {
    // ----- field -----
    const fieldTok = next();
    if (!fieldTok || fieldTok.type !== 'word') {
      throw new FilterParseError(
        `Expected a field name${fieldTok ? ` but found "${tokenText(fieldTok)}"` : ' but reached end of filter'}.`,
      );
    }
    const field = fieldTok.value;
    const { kind } = resolveField(field);

    // ----- operator -----
    const op = parseOperator(field, kind, peek, next);

    // ----- value (unless valueless op) -----
    let value = '';
    if (!VALUELESS_OPS.has(op)) {
      const valueTok = next();
      if (!valueTok || valueTok.type === 'sym' || valueTok.type === 'paren') {
        throw new FilterParseError(
          `Expected a value after "${field} ${canonicalToSurface(op)}"${
            valueTok ? ` but found "${tokenText(valueTok)}"` : ''
          }.`,
        );
      }
      value = valueTok.value;
      validateValue(field, kind, op, value);
    }

    predicateCount++;
    if (predicateCount > MAX_PREDICATES) {
      throw new FilterParseError(`Too many filter predicates (max ${MAX_PREDICATES}).`);
    }
    return { field, operator: op, value };
  };

  while (pos < tokens.length) {
    // ----- clause: OR-group or single predicate -----
    if (isParen(peek(), '(')) {
      pos++;
      const members: AnalyticsFilter[] = [parsePredicate()];
      for (;;) {
        const sep = peek();
        if (isParen(sep, ')')) {
          pos++;
          break;
        }
        if (isWord(sep, 'or')) {
          pos++;
          members.push(parsePredicate());
          continue;
        }
        if (isWord(sep, 'and')) {
          throw new FilterParseError(
            '"and" is not allowed inside parentheses — a group combines predicates ' +
              'with "or" only; combine groups with "and" outside the parentheses.',
          );
        }
        throw new FilterParseError(
          sep
            ? `Unexpected "${tokenText(sep)}" inside a group. Separate group predicates with "or" and close the group with ")".`
            : 'Unterminated group: expected ")" before the end of the filter.',
        );
      }
      // A one-member group is just that predicate — no OR node needed.
      nodes.push(members.length === 1 ? members[0]! : { or: members });
    } else {
      nodes.push(parsePredicate());
    }

    // ----- "and" separator or end -----
    const sep = peek();
    if (!sep) break;
    if (isWord(sep, 'and')) {
      pos++;
      if (pos >= tokens.length) {
        throw new FilterParseError('Filter ends with a dangling "and".');
      }
      continue;
    }
    if (isWord(sep, 'or')) {
      throw new FilterParseError(
        '"or" is only allowed inside parentheses: write (a = 1 or b = 2), ' +
          'then combine groups with "and".',
      );
    }
    throw new FilterParseError(
      `Unexpected "${tokenText(sep)}" after a predicate. Combine predicates with "and".`,
    );
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_FIELD_HINT =
  'status, cost, latency_ms, prompt_tokens, completion_tokens, model, user_id, ' +
  'session_id, trace_id, input, output, props, semantic_kind, tags, ' +
  'metadata.<key>, score__<name>';

function resolveField(field: string): { kind: FieldKind } {
  const lower = field.toLowerCase();

  if (lower.startsWith('metadata.')) {
    const key = field.slice('metadata.'.length);
    if (!METADATA_KEY_RE.test(key)) {
      throw new FilterParseError(
        `Invalid metadata key "${key}" — keys must match [a-zA-Z_][a-zA-Z0-9_]{0,63} ` +
          '(letters, digits, underscore; no dots).',
      );
    }
    return { kind: 'metadata' };
  }

  if (lower.startsWith('score__')) {
    const name = field.slice('score__'.length);
    if (!SCORE_NAME_RE.test(name)) {
      throw new FilterParseError(
        `Invalid score name "${name}" — names must match [a-zA-Z_][a-zA-Z0-9_-]{0,63}.`,
      );
    }
    return { kind: 'score' };
  }

  const kind = STATIC_FIELDS.get(lower);
  if (!kind) {
    throw new FilterParseError(
      `Unknown filter field "${field}". Allowed fields: ${ALLOWED_FIELD_HINT}.`,
    );
  }
  return { kind };
}

function parseOperator(
  field: string,
  kind: FieldKind,
  peek: () => Token | undefined,
  next: () => Token | undefined,
): CanonicalOp {
  const tok = next();
  if (!tok) {
    throw new FilterParseError(`Expected an operator after "${field}" but reached end of filter.`);
  }

  let op: CanonicalOp;

  if (tok.type === 'sym') {
    op = SYMBOL_OPS[tok.value];
  } else if (tok.type === 'word') {
    const w = tok.value.toLowerCase();
    switch (w) {
      case 'contains':
        op = 'contains';
        break;
      case 'exists':
        op = 'exists';
        break;
      case 'not': {
        // "not contains"
        const t2 = peek();
        if (t2 && t2.type === 'word' && t2.value.toLowerCase() === 'contains') {
          next();
          op = 'notContains';
        } else {
          throw new FilterParseError(`Unexpected "not" in operator for "${field}" (did you mean "not contains"?).`);
        }
        break;
      }
      case 'starts': {
        // "starts with"
        const t2 = peek();
        if (t2 && t2.type === 'word' && t2.value.toLowerCase() === 'with') {
          next();
          op = 'startsWith';
        } else {
          throw new FilterParseError(`Expected "with" after "starts" for "${field}".`);
        }
        break;
      }
      case 'ends': {
        // "ends with"
        const t2 = peek();
        if (t2 && t2.type === 'word' && t2.value.toLowerCase() === 'with') {
          next();
          op = 'endsWith';
        } else {
          throw new FilterParseError(`Expected "with" after "ends" for "${field}".`);
        }
        break;
      }
      case 'does': {
        // "does not exist"
        const t2 = next();
        const t3 = next();
        if (t2 && t2.type === 'word' && t2.value.toLowerCase() === 'not'
          && t3 && t3.type === 'word' && t3.value.toLowerCase() === 'exist') {
          op = 'doesNotExist';
        } else {
          throw new FilterParseError(`Expected "does not exist" for "${field}".`);
        }
        break;
      }
      default:
        throw new FilterParseError(
          `Unknown operator "${tok.value}" for field "${field}".`,
        );
    }
  } else {
    throw new FilterParseError(`Expected an operator after "${field}" but found a value.`);
  }

  if (!OPS_BY_KIND[kind].has(op)) {
    throw new FilterParseError(
      `Operator "${canonicalToSurface(op)}" is not valid for ${kind} field "${field}". ` +
        `Allowed: ${[...OPS_BY_KIND[kind]].map(canonicalToSurface).join(', ')}.`,
    );
  }
  return op;
}

function validateValue(field: string, kind: FieldKind, op: CanonicalOp, value: string): void {
  if (value === '') {
    throw new FilterParseError(`Empty value for "${field}" (quote the value if it is intentional).`);
  }
  if ((kind === 'numeric' || kind === 'score') && !NUMERIC_VALUE_RE.test(value)) {
    throw new FilterParseError(
      `Field "${field}" expects a numeric value but got "${value}".`,
    );
  }
  if (kind === 'status' && !STATUS_VALUES.has(value.toUpperCase())) {
    throw new FilterParseError(
      `Invalid status value "${value}". Allowed: OK, ERROR.`,
    );
  }
  // op param reserved for future per-operator value rules (e.g. range checks).
  void op;
}

const SYMBOL_OPS: Record<'=' | '!=' | '>' | '>=' | '<' | '<=', CanonicalOp> = {
  '=': 'equals',
  '!=': 'notEquals',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

// For error messages: render a canonical operator back in surface syntax.
function canonicalToSurface(op: CanonicalOp): string {
  switch (op) {
    case 'equals': return '=';
    case 'notEquals': return '!=';
    case 'gt': return '>';
    case 'gte': return '>=';
    case 'lt': return '<';
    case 'lte': return '<=';
    case 'contains': return 'contains';
    case 'notContains': return 'not contains';
    case 'startsWith': return 'starts with';
    case 'endsWith': return 'ends with';
    case 'exists': return 'exists';
    case 'doesNotExist': return 'does not exist';
    // JSON-only operators — never parsed from the DSL, but CanonicalOp is
    // shared with the JSON validator, so render them for completeness.
    case 'in': return 'in';
    case 'notIn': return 'not in';
    case 'between': return 'between';
  }
}

function tokenText(t: Token): string {
  return t.type === 'str' ? `"${t.value}"` : t.value;
}
