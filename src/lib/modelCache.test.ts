import { describe, it, expect, vi } from 'vitest';
import { fetchModelCached, type ModelCacheDeps } from './modelCache';

const URL_ = 'https://example.test/model.onnx';

/** A Cache Storage that lives in a Map, optionally refusing writes like a full disk. */
function fakeCaches(options: { failPut?: boolean } = {}) {
  const store = new Map<string, Response>();
  const cache = {
    match: async (url: string) => store.get(url)?.clone(),
    put: async (url: string, res: Response) => {
      if (options.failPut) throw new DOMException('quota', 'QuotaExceededError');
      store.set(url, res);
    },
  };
  return { store, caches: { open: async () => cache } as unknown as CacheStorage };
}

function serving(bytes: number[], status = 200) {
  return vi.fn(async () => new Response(new Uint8Array(bytes), { status, headers: { 'Content-Length': String(bytes.length) } }));
}

describe('fetchModelCached', () => {
  it('downloads once, then serves the stored copy without touching the network', async () => {
    const { caches } = fakeCaches();
    const fetch = serving([1, 2, 3, 4]);
    const deps: ModelCacheDeps = { fetch: fetch as unknown as typeof globalThis.fetch, caches };

    const first = await fetchModelCached(URL_, () => {}, deps);
    expect(first.fromCache).toBe(false);
    expect([...new Uint8Array(first.bytes)]).toEqual([1, 2, 3, 4]);

    const second = await fetchModelCached(URL_, () => {}, deps);
    expect(second.fromCache).toBe(true);
    expect([...new Uint8Array(second.bytes)]).toEqual([1, 2, 3, 4]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports download progress against the announced size', async () => {
    const { caches } = fakeCaches();
    const progress: Array<[number, number]> = [];
    await fetchModelCached(URL_, (l, t) => progress.push([l, t]), {
      fetch: serving([9, 9, 9]) as unknown as typeof globalThis.fetch,
      caches,
    });
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it('refuses an error response instead of handing it to the model runtime, and keeps nothing', async () => {
    const { caches, store } = fakeCaches();
    await expect(
      fetchModelCached(URL_, () => {}, { fetch: serving([60, 33], 404) as unknown as typeof globalThis.fetch, caches }),
    ).rejects.toThrow('HTTP 404');
    expect(store.size).toBe(0);
  });

  it('still returns the model when the cache cannot store it', async () => {
    const { caches } = fakeCaches({ failPut: true });
    const result = await fetchModelCached(URL_, () => {}, {
      fetch: serving([5, 6]) as unknown as typeof globalThis.fetch,
      caches,
    });
    expect([...new Uint8Array(result.bytes)]).toEqual([5, 6]);
  });

  it('works where Cache Storage does not exist at all', async () => {
    const result = await fetchModelCached(URL_, () => {}, {
      fetch: serving([7]) as unknown as typeof globalThis.fetch,
      caches: undefined,
    });
    expect(result.fromCache).toBe(false);
    expect([...new Uint8Array(result.bytes)]).toEqual([7]);
  });
});
