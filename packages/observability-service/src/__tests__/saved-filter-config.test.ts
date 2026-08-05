/**
 * SavedFilterConfig type guard tests.
 */

import { isFilterConfigV2, isViewConfigV3 } from '../types';
import type { SavedFilterConfigV1, SavedFilterConfig, SavedViewConfig } from '../types';

describe('isFilterConfigV2', () => {
  it('should return true for v2 config', () => {
    const config: SavedFilterConfig = {
      version: 2,
      userId: 'user-123',
    };
    expect(isFilterConfigV2(config)).toBe(true);
  });

  it('should return false for v1 config (no version field)', () => {
    const config: SavedFilterConfigV1 = {
      search: 'test',
      searchField: 'all',
    };
    expect(isFilterConfigV2(config)).toBe(false);
  });

  it('should return false for config with version !== 2', () => {
    const config = {
      version: 1,
      search: 'test',
    } as any;
    expect(isFilterConfigV2(config)).toBe(false);
  });

  it('should throw TypeError for null input', () => {
    expect(() => isFilterConfigV2(null as any)).toThrow();
  });

  it('should throw TypeError for undefined input', () => {
    expect(() => isFilterConfigV2(undefined as any)).toThrow();
  });

  it('should handle v2 config with all fields', () => {
    const config: SavedFilterConfig = {
      version: 2,
      filters: [{ field: 'model', operator: 'equals', value: 'gpt-4' }],
      userId: 'user-123',
    };
    expect(isFilterConfigV2(config)).toBe(true);
  });

  it('should return false for v3 config', () => {
    const config: SavedViewConfig = {
      version: 3,
      displayMode: 'aggregate',
      groupBy: 'model',
    };
    expect(isFilterConfigV2(config)).toBe(false);
  });
});

describe('isViewConfigV3', () => {
  it('should return true for v3 view config', () => {
    const config: SavedViewConfig = {
      version: 3,
      displayMode: 'aggregate',
      groupBy: 'model',
      filters: [{ field: 'status', operator: 'equals', value: 'OK' }],
    };
    expect(isViewConfigV3(config)).toBe(true);
  });

  it('should return true for v3 list mode config', () => {
    const config: SavedViewConfig = {
      version: 3,
      displayMode: 'list',
    };
    expect(isViewConfigV3(config)).toBe(true);
  });

  it('should return false for v2 config', () => {
    const config: SavedFilterConfig = {
      version: 2,
    };
    expect(isViewConfigV3(config)).toBe(false);
  });

  it('should return false for v1 config', () => {
    const config: SavedFilterConfigV1 = {
      search: 'test',
    };
    expect(isViewConfigV3(config)).toBe(false);
  });

  it('should throw TypeError for null input', () => {
    expect(() => isViewConfigV3(null as any)).toThrow();
  });

  it('should throw TypeError for undefined input', () => {
    expect(() => isViewConfigV3(undefined as any)).toThrow();
  });

  it('should handle v3 config with all optional fields', () => {
    const config: SavedViewConfig = {
      version: 3,
      displayMode: 'aggregate',
      groupBy: 'metadata.environment',
      filters: [{ field: 'model_used', operator: 'equals', value: 'gpt-4' }],
      dateRange: { preset: '7d' },
      sortBy: { field: 'cost', order: 'desc' },
      columns: [
        { field: 'dimensionValue', visible: true },
        { field: 'cost', visible: true },
        { field: 'tokens', visible: false },
      ],
    };
    expect(isViewConfigV3(config)).toBe(true);
  });
});
