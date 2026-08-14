import { describe, expect, it } from 'vitest';
import * as costMod from './cost-mapping';

type ModelsDoc = {
  models: Record<
    string,
    { pricing?: { inputCostPerToken: number; outputCostPerToken: number } }
  >;
};

/**
 * Stand-in for the KV binding the gateway passes: a map of key → document.
 * A key that is absent resolves to null, which is what an unseeded namespace
 * returns.
 */
function stubSource(models?: ModelsDoc, overrides?: ModelsDoc) {
  const docs: Record<string, unknown> = {};
  if (models) docs['models.json'] = models;
  if (overrides) docs['overrides.json'] = overrides;
  return {
    get: async (key: string) => (key in docs ? JSON.stringify(docs[key]) : null),
  };
}

// 0.5 / 0.25 / 0.125 are exact in binary, so ×1000 carries no float drift and
// the expected per-1k values can be asserted exactly.
describe('refreshModelPricing — building the map', () => {
  it('converts per-token pricing to per-1k tokens (×1000)', async () => {
    await costMod.refreshModelPricing(
      stubSource({ models: { m1: { pricing: { inputCostPerToken: 0.5, outputCostPerToken: 0.25 } } } }),
    );
    expect(costMod.modelsCostMapping.m1).toEqual({ promptPrice: 500, completionPrice: 250 });
  });

  it('drops models that have no pricing block', async () => {
    await costMod.refreshModelPricing(
      stubSource({
        models: {
          priced: { pricing: { inputCostPerToken: 0.125, outputCostPerToken: 0.125 } },
          unpriced: {},
        },
      }),
    );
    expect(costMod.modelsCostMapping.priced).toEqual({ promptPrice: 125, completionPrice: 125 });
    expect(costMod.modelsCostMapping.unpriced).toBeUndefined();
  });

  // proves AC-070-04
  it('lets overrides replace the base model entry', async () => {
    await costMod.refreshModelPricing(
      stubSource(
        { models: { m1: { pricing: { inputCostPerToken: 0.5, outputCostPerToken: 0.5 } } } },
        { models: { m1: { pricing: { inputCostPerToken: 0.125, outputCostPerToken: 0.125 } } } },
      ),
    );
    expect(costMod.modelsCostMapping.m1).toEqual({ promptPrice: 125, completionPrice: 125 });
  });

  it('falls back to models-only when overrides are absent', async () => {
    await costMod.refreshModelPricing(
      stubSource({ models: { m1: { pricing: { inputCostPerToken: 0.25, outputCostPerToken: 0.25 } } } }),
    );
    expect(costMod.modelsCostMapping.m1).toEqual({ promptPrice: 250, completionPrice: 250 });
  });
});


describe('refreshModelPricing — registry source', () => {
  /** A stand-in for the KV binding: a map of key → raw JSON text. */
  const source = (docs: Record<string, unknown>, opts: { throwOn?: string } = {}) => ({
    get: async (key: string) => {
      if (opts.throwOn === key) throw new Error('unreadable');
      const doc = docs[key];
      return doc === undefined ? null : JSON.stringify(doc);
    },
  });

  const priced = { models: { m1: { pricing: { inputCostPerToken: 0.5, outputCostPerToken: 0.25 } } } };

  it('replaces the map from the source and reports success', async () => {
    expect(await costMod.refreshModelPricing(source({ 'models.json': priced }))).toEqual({
      refreshed: true,
    });
    expect(costMod.modelsCostMapping.m1).toEqual({ promptPrice: 500, completionPrice: 250 });
  });

  it('keeps the bundled map when no source is supplied, rather than failing', async () => {
    // The CLI has no runtime source; bundled pricing is the correct answer for
    // it, not an error.
    const before = costMod.modelsCostMapping;
    expect(await costMod.refreshModelPricing()).toEqual({ refreshed: false, reason: 'no_source' });
    expect(costMod.modelsCostMapping).toBe(before);
  });

  it('reports an unseeded namespace as absent instead of silently continuing', async () => {
    expect(await costMod.refreshModelPricing(source({}))).toEqual({
      refreshed: false,
      reason: 'absent',
    });
  });

  it('reports a read failure', async () => {
    expect(
      await costMod.refreshModelPricing(source({ 'models.json': priced }, { throwOn: 'models.json' })),
    ).toEqual({ refreshed: false, reason: 'read_error' });
  });

  // proves AC-070-05
  it('keeps the bundled map when the stored document is not a registry', async () => {
    // A truncated or placeholder write would otherwise install an EMPTY price
    // map and unprice every model — worse than serving a stale one.
    const before = costMod.modelsCostMapping;
    expect(await costMod.refreshModelPricing(source({ 'models.json': { notModels: true } }))).toEqual({
      refreshed: false,
      reason: 'malformed',
    });
    expect(costMod.modelsCostMapping).toBe(before);
  });

  it('survives missing overrides — they are optional, models are not', async () => {
    expect(await costMod.refreshModelPricing(source({ 'models.json': priced }))).toEqual({
      refreshed: true,
    });
  });

  it('lets overrides win over models for the same id', async () => {
    await costMod.refreshModelPricing(
      source({
        'models.json': priced,
        'overrides.json': { models: { m1: { pricing: { inputCostPerToken: 1, outputCostPerToken: 2 } } } },
      }),
    );
    expect(costMod.modelsCostMapping.m1).toEqual({ promptPrice: 1000, completionPrice: 2000 });
  });

  it('keeps both maps in lockstep', async () => {
    // A caller pricing cache tokens must never see a different model set than
    // one pricing prompt/completion.
    await costMod.refreshModelPricing(source({ 'models.json': priced }));
    expect(Object.keys(costMod.modelsCostMapping)).toEqual(Object.keys(costMod.modelsTokenPricing));
  });
});
