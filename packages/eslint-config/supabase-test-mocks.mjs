import { isBannedSupabaseTestMockSpecifier } from './supabase-test-mocks-shared.mjs';

const DEFAULT_MESSAGE =
  'Do not add module-level Supabase mocks in tests. Use MSW for boundary tests and app-owned seams or injected fakes for narrower unit tests.';

const noSupabaseTestMocksRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow module-level Supabase mocks in tests',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: {
            type: 'string',
          },
        },
      },
    ],
  },
  create(context) {
    const option = context.options[0] ?? {};
    const message = option.message ?? DEFAULT_MESSAGE;

    return {
      CallExpression(node) {
        if (
          node.callee?.type !== 'MemberExpression' ||
          node.callee.object?.type !== 'Identifier' ||
          node.callee.object.name !== 'vi' ||
          node.callee.property?.type !== 'Identifier' ||
          node.callee.property.name !== 'mock'
        ) {
          return;
        }

        const specifierNode = node.arguments[0];
        if (
          !specifierNode ||
          specifierNode.type !== 'Literal' ||
          typeof specifierNode.value !== 'string'
        ) {
          return;
        }

        if (!isBannedSupabaseTestMockSpecifier(specifierNode.value)) {
          return;
        }

        context.report({
          node: specifierNode,
          message,
        });
      },
    };
  },
};

export default {
  rules: {
    'no-supabase-test-mocks': noSupabaseTestMocksRule,
  },
};
