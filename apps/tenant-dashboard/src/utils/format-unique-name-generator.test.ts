import { fUniqueNameGenerator } from "./format-unique-name-generator";

describe('fUniqueNameGenerator', () => {
  test('should not contain any spaces', () => {
    expect(fUniqueNameGenerator('hello world 123')).toBe('hello_world_123');
  });

  test('should be in lower case', () => {
    expect(fUniqueNameGenerator('HeLLO WOrLd')).toBe('hello_world');
  });
});