const Sequencer = require('@jest/test-sequencer').default;

/**
 * Custom test sequencer that runs ClickHouse-dependent tests last
 * to avoid race conditions when setting up the shared ClickHouse container.
 */
class CustomSequencer extends Sequencer {
  sort(tests) {
    // Identify ClickHouse-dependent tests
    const clickhouseTests = ['health-check.test.ts', 'traces.test.ts'];

    const isClickhouseTest = (test) =>
      clickhouseTests.some(name => test.path.includes(name));

    // Separate tests into two groups
    const regularTests = tests.filter(test => !isClickhouseTest(test));
    const clickhouseTestsGroup = tests.filter(test => isClickhouseTest(test));

    // Sort regular tests by path for consistency
    const sortedRegular = regularTests.sort((a, b) => a.path.localeCompare(b.path));

    // Put ClickHouse tests at the end (they'll run after parallel tests finish)
    return [...sortedRegular, ...clickhouseTestsGroup];
  }
}

module.exports = CustomSequencer;
