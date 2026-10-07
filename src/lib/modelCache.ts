/**
 * Download a large model once and keep it in the browser.
 *
 * demucs-web fetches its 172MB model with a plain fetch() on every page load, and that size is
 * past what browsers reliably keep in their HTTP cache — so without this, every visit to the
 * no-install version would start with the same 172MB download. The Cache Storage API is meant
 * for exactly this: it is explicit, survives restarts, and is covered by the persistent-storage
 * request the app already makes.
 *
 * Caching is best effort. If Cache Storage is missing (not a secure context) or full, the
 * model is still returned; it just gets downloaded again next time.
 */

const CACHE_NAME = 'bass-practice-models-v1';

export interface ModelCacheDeps {
  fetch: typeof fetch;
  caches: CacheStorage | undefined;
}

const defaultDeps = (): ModelCacheDeps => ({
  fetch: (...args) => fetch(...args),
  caches: typeof caches === 'undefined' ? undefined : caches,
});

/**
 * The model's bytes, from the cache when they are there.
 * `onProgress(loaded, total)` reports the download; `fromCache` says which way it came.
 */
export async function fetchModelCached(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  deps: ModelCacheDeps = defaultDeps(),
): Promise<{ bytes: ArrayBuffer; fromCache: boolean }> {
  const cache = await deps.caches?.open(CACHE_NAME).catch(() => undefined);
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) return { bytes: await hit.arrayBuffer(), fromCache: true };

  const response = await deps.fetch(url);
  // demucs-web never looked at this, so an error page would have been handed to the model
  // runtime as if it were weights.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const total = Number(response.headers.get('Content-Length') ?? 0);
  let bytes: Uint8Array<ArrayBuffer>;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  try {
    await cache?.put(
      url,
      new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
  } catch {
    // Quota or a browser without Cache Storage: still usable, just not kept.
  }
  return { bytes: bytes.buffer, fromCache: false };
}
