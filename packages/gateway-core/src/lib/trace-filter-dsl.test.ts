/**
 * Unit tests for the trace/span `filter` string-DSL parser.
 *
 * The properties these tests pin:
 *  1. A valid expression compiles to the EXACT `AnalyticsFilter[]` the SQL
 *     builder expects (field verbatim, canonical operator, value/'' ).
 *  2. Anything malformed/unsupported THROWS `FilterParseError` — it is never
 *     silently dropped, because a dropped filter returns every row instead
 *     of none. Each throw case pins a distinct failure class.
 */

import { describe, it, expect } from 'vitest';
import { parseFilterExpression, FilterParseError } from './trace-filter-dsl';

describe('parseFilterExpression — valid expressions', () => {
  it('parses metadata exists (valueless op → empty value)', () => {
    expect(parseFilterExpression('metadata.debug_screenshot_url exists')).toEqual([
      { field: 'metadata.debug_screenshot_url', operator: 'exists', value: '' },
    ]);
  });

  it('parses metadata "does not exist"', () => {
    expect(parseFilterExpression('metadata.foo does not exist')).toEqual([
      { field: 'metadata.foo', operator: 'doesNotExist', value: '' },
    ]);
  });

  it('parses a quoted equality value, preserving spaces and the URL verbatim', () => {
    expect(parseFilterExpression('metadata.debug_screenshot_url = "https://example.com/x y"')).toEqual([
      { field: 'metadata.debug_screenshot_url', operator: 'equals', value: 'https://example.com/x y' },
    ]);
  });

  it('maps every symbol operator to its canonical name', () => {
    expect(parseFilterExpression('cost = 1 and cost != 2 and cost > 3 and cost >= 4 and cost < 5 and cost <= 6')).toEqual([
      { field: 'cost', operator: 'equals', value: '1' },
      { field: 'cost', operator: 'notEquals', value: '2' },
      { field: 'cost', operator: 'gt', value: '3' },
      { field: 'cost', operator: 'gte', value: '4' },
      { field: 'cost', operator: 'lt', value: '5' },
      { field: 'cost', operator: 'lte', value: '6' },
    ]);
  });

  it('maps every multi-word string operator', () => {
    expect(parseFilterExpression(
      'model contains "gpt" and model not contains "claude" and model starts with "gpt-4" and model ends with "turbo"',
    )).toEqual([
      { field: 'model', operator: 'contains', value: 'gpt' },
      { field: 'model', operator: 'notContains', value: 'claude' },
      { field: 'model', operator: 'startsWith', value: 'gpt-4' },
      { field: 'model', operator: 'endsWith', value: 'turbo' },
    ]);
  });

  it('combines metadata + status predicates with "and"', () => {
    expect(parseFilterExpression('metadata.env = "prod" and status = ERROR')).toEqual([
      { field: 'metadata.env', operator: 'equals', value: 'prod' },
      { field: 'status', operator: 'equals', value: 'ERROR' },
    ]);
  });

  it('accepts a single-quoted value and an unquoted bareword value', () => {
    expect(parseFilterExpression("metadata.env = 'prod' and status = ok")).toEqual([
      { field: 'metadata.env', operator: 'equals', value: 'prod' },
      // value preserved verbatim; status validity is case-insensitive
      { field: 'status', operator: 'equals', value: 'ok' },
    ]);
  });

  it('parses score__ numeric predicates', () => {
    expect(parseFilterExpression('score__correctness >= 0.8')).toEqual([
      { field: 'score__correctness', operator: 'gte', value: '0.8' },
    ]);
  });

  it('tolerates operators written without surrounding spaces', () => {
    expect(parseFilterExpression('cost>=4')).toEqual([
      { field: 'cost', operator: 'gte', value: '4' },
    ]);
  });

  it('accepts decimal and scientific-notation numeric values', () => {
    expect(parseFilterExpression('cost > 0.01 and latency_ms <= 2e3 and cost != -5')).toEqual([
      { field: 'cost', operator: 'gt', value: '0.01' },
      { field: 'latency_ms', operator: 'lte', value: '2e3' },
      { field: 'cost', operator: 'notEquals', value: '-5' },
    ]);
  });

  it('accepts up to the predicate cap', () => {
    const expr = Array.from({ length: 20 }, () => 'cost = 1').join(' and ');
    expect(parseFilterExpression(expr)).toHaveLength(20);
  });

  it('preserves the field name verbatim (case + dots) for the SQL builder', () => {
    // Field is passed through unchanged; only validation is case-insensitive.
    expect(parseFilterExpression('Status = ERROR')).toEqual([
      { field: 'Status', operator: 'equals', value: 'ERROR' },
    ]);
  });
});

describe('parseFilterExpression — rejects malformed input (400 surface)', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['empty string', '', /empty/i],
    ['unknown field', 'foobar = "x"', /unknown filter field/i],
    ['operator invalid for numeric field', 'cost contains "x"', /not valid for numeric field/i],
    ['exists invalid for non-metadata field', 'cost exists', /not valid for numeric field/i],
    ['non-numeric value for numeric field', 'cost = abc', /numeric value/i],
    ['invalid status value', 'status = WEIRD', /invalid status value/i],
    ['invalid metadata key (dotted)', 'metadata.a.b exists', /invalid metadata key/i],
    ['invalid metadata key (leading digit)', 'metadata.1foo exists', /invalid metadata key/i],
    ['unterminated quote', 'metadata.env = "prod', /unterminated quoted string/i],
    ['dangling and', 'status = ERROR and', /dangling "and"/i],
    ['bare or outside parentheses', 'status = ERROR or status = OK', /"or" is only allowed inside parentheses/i],
    ['missing value', 'metadata.env =', /expected a value/i],
    ['missing operator', 'cost', /expected an operator/i],
    ['two predicates without and', 'status = ERROR status = OK', /combine predicates with "and"/i],
    ['bare "!"', 'cost ! 5', /did you mean "!="/i],
    ['hex number (parseFloat divergence)', 'cost = 0x10', /numeric value/i],
    ['Infinity is not finite', 'cost > Infinity', /numeric value/i],
    ['too many predicates', `${Array.from({ length: 21 }, () => 'cost = 1').join(' and ')}`, /too many filter predicates/i],
    ['over-long expression', `metadata.x = "${'a'.repeat(2001)}"`, /too long/i],
  ];

  it.each(cases)('throws on %s', (_label, input, messageRe) => {
    expect(() => parseFilterExpression(input)).toThrow(FilterParseError);
    expect(() => parseFilterExpression(input)).toThrow(messageRe);
  });
});

// ---------------------------------------------------------------------------
// Branch + boundary coverage (kills mutants the behavior tests above miss):
// tokenizer escapes, exact caps, every multi-word-operator failure path, and
// the operator-surface rendering used in error messages.
// ---------------------------------------------------------------------------

describe('parseFilterExpression — tokenizer + boundary edges', () => {
  it('unescapes a backslash-escaped quote inside a quoted value', () => {
    // Exercises the `\\` escape branch in the tokenizer.
    expect(parseFilterExpression('metadata.x = "a\\"b"')).toEqual([
      { field: 'metadata.x', operator: 'equals', value: 'a"b' },
    ]);
  });

  it('keeps a backslash before a non-quote char (escape only consumes the next char)', () => {
    expect(parseFilterExpression('metadata.x = "a\\nb"')).toEqual([
      { field: 'metadata.x', operator: 'equals', value: 'anb' },
    ]);
  });

  it('accepts a filter exactly at the length cap (2000) — boundary is inclusive', () => {
    const value = 'a'.repeat(1985);
    const expr = `metadata.x = "${value}"`;
    expect(expr.length).toBe(2000); // pins MAX_FILTER_LENGTH boundary: `>` not `>=`
    expect(parseFilterExpression(expr)).toEqual([
      { field: 'metadata.x', operator: 'equals', value },
    ]);
  });

  it('accepts exactly the predicate cap but rejects one more', () => {
    const ok = Array.from({ length: 20 }, () => 'cost = 1').join(' and ');
    expect(parseFilterExpression(ok)).toHaveLength(20); // 20 > 20 is false
    const tooMany = Array.from({ length: 21 }, () => 'cost = 1').join(' and ');
    expect(() => parseFilterExpression(tooMany)).toThrow(/Too many filter predicates \(max 20\)/);
  });

  it('parses `> ` and `< ` as distinct from `>=`/`<=`', () => {
    expect(parseFilterExpression('cost > 1 and cost < 2')).toEqual([
      { field: 'cost', operator: 'gt', value: '1' },
      { field: 'cost', operator: 'lt', value: '2' },
    ]);
  });
});

describe('parseFilterExpression — every operator failure path', () => {
  const opCases: Array<[string, string, RegExp]> = [
    ['"starts" without "with"', 'model starts "x"', /Expected "with" after "starts"/],
    ['"ends" without "with"', 'model ends "x"', /Expected "with" after "ends"/],
    ['"not" without "contains"', 'model not "x"', /did you mean "not contains"/],
    ['"does" without "not exist"', 'metadata.x does not foo', /Expected "does not exist"/],
    ['unknown operator word', 'model wat "x"', /Unknown operator "wat"/],
    ['value where operator expected', 'model "x"', /Expected an operator after "model" but found a value/],
    ['operator at end of input', 'model', /Expected an operator after "model" but reached end of filter/],
    ['symbol where field expected', '= "x"', /Expected a field name but found "="/],
    ['string where field expected', '"x" = "y"', /Expected a field name but found ""x""/],
    ['empty quoted value', 'metadata.x = ""', /Empty value for "metadata.x"/],
    ['invalid score name', 'score__1bad = 5', /Invalid score name "1bad"/],
    ['trailing token after a predicate', 'status = ERROR "x"', /Unexpected ""x"" after a predicate/],
  ];

  it.each(opCases)('throws on %s', (_label, input, re) => {
    expect(() => parseFilterExpression(input)).toThrow(FilterParseError);
    expect(() => parseFilterExpression(input)).toThrow(re);
  });

  // Two assertions cover all 12 canonicalToSurface branches: the invalid-op
  // surface AND the rendered "Allowed:" list for the field kind.
  it('renders numeric-field allowed operators (=, !=, >, >=, <, <=) in the error', () => {
    expect(() => parseFilterExpression('latency_ms contains "x"')).toThrow(
      /Operator "contains" is not valid for numeric field "latency_ms"\. Allowed: =, !=, >, >=, <, <=\./,
    );
  });

  it('renders metadata-field allowed operators (incl. exists / does not exist) in the error', () => {
    expect(() => parseFilterExpression('metadata.x > 1')).toThrow(
      /Operator ">" is not valid for metadata field "metadata.x"\. Allowed: =, !=, contains, not contains, starts with, ends with, exists, does not exist\./,
    );
  });

  it('rejects exists/does-not-exist on non-metadata kinds', () => {
    expect(() => parseFilterExpression('status exists')).toThrow(/not valid for status field/);
    expect(() => parseFilterExpression('tags does not exist')).toThrow(/not valid for tags field/);
    expect(() => parseFilterExpression('model exists')).toThrow(/not valid for string field/);
  });

  it('rejects status with a non-equals operator', () => {
    expect(() => parseFilterExpression('status != OK')).toThrow(/Operator "!=" is not valid for status field/);
  });
});

// ---------------------------------------------------------------------------
// OR groups: parenthesized disjunctions, one level deep (CNF). The AST gains
// `{ or: AnalyticsFilter[] }` nodes; everything else stays a flat leaf.
// ---------------------------------------------------------------------------

describe('parseFilterExpression — OR groups', () => {
  it('parses a parenthesized disjunction into an { or } node', () => {
    expect(parseFilterExpression('(model = "gpt-4o" or model = "claude-sonnet-4-6")')).toEqual([
      {
        or: [
          { field: 'model', operator: 'equals', value: 'gpt-4o' },
          { field: 'model', operator: 'equals', value: 'claude-sonnet-4-6' },
        ],
      },
    ]);
  });

  it('combines a group with leaf predicates via "and", preserving order', () => {
    expect(parseFilterExpression('status = ERROR and (cost > 1 or latency_ms > 5000) and metadata.env = "prod"')).toEqual([
      { field: 'status', operator: 'equals', value: 'ERROR' },
      {
        or: [
          { field: 'cost', operator: 'gt', value: '1' },
          { field: 'latency_ms', operator: 'gt', value: '5000' },
        ],
      },
      { field: 'metadata.env', operator: 'equals', value: 'prod' },
    ]);
  });

  it('parses a three-member group', () => {
    expect(parseFilterExpression('(status = ERROR or cost > 1 or tags contains "beta")')).toEqual([
      {
        or: [
          { field: 'status', operator: 'equals', value: 'ERROR' },
          { field: 'cost', operator: 'gt', value: '1' },
          { field: 'tags', operator: 'contains', value: 'beta' },
        ],
      },
    ]);
  });

  it('unwraps a one-member group to a plain leaf', () => {
    expect(parseFilterExpression('(status = ERROR)')).toEqual([
      { field: 'status', operator: 'equals', value: 'ERROR' },
    ]);
  });

  it('parses parens written without surrounding spaces', () => {
    expect(parseFilterExpression('(cost>1 or cost<0.5)and status = ERROR')).toEqual([
      {
        or: [
          { field: 'cost', operator: 'gt', value: '1' },
          { field: 'cost', operator: 'lt', value: '0.5' },
        ],
      },
      { field: 'status', operator: 'equals', value: 'ERROR' },
    ]);
  });

  it('keeps parens inside quoted values literal (no tokenizer confusion)', () => {
    expect(parseFilterExpression('metadata.note = "a (weird) value"')).toEqual([
      { field: 'metadata.note', operator: 'equals', value: 'a (weird) value' },
    ]);
  });

  it('counts grouped predicates against the 20-predicate cap', () => {
    const members = Array.from({ length: 21 }, () => 'cost = 1').join(' or ');
    expect(() => parseFilterExpression(`(${members})`)).toThrow(/too many filter predicates/i);
  });

  const groupErrorCases: Array<[string, string, RegExp]> = [
    ['"and" inside a group', '(status = ERROR and cost > 1)', /"and" is not allowed inside parentheses/i],
    ['unterminated group', '(status = ERROR or cost > 1', /unterminated group/i],
    ['empty group', '()', /expected a field name but found "\)"/i],
    ['nested group', '((status = ERROR or cost > 1) or model = "x")', /expected a field name but found "\("/i],
    ['dangling or inside group', '(status = ERROR or)', /expected a field name but found "\)"/i],
    ['stray closing paren', 'status = ERROR)', /unexpected "\)" after a predicate/i],
    ['paren in value position', 'model = (', /expected a value/i],
    ['group not followed by and', '(status = ERROR or cost > 1) model = "x"', /combine predicates with "and"/i],
  ];

  it.each(groupErrorCases)('throws on %s', (_label, input, messageRe) => {
    expect(() => parseFilterExpression(input)).toThrow(FilterParseError);
    expect(() => parseFilterExpression(input)).toThrow(messageRe);
  });
});
