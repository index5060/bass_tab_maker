/**
 * Copy the basic-pitch model (model.json + its weight shard) into publicDir.
 *
 * The model has to be served as two sibling files: TensorFlow.js reads model.json and then
 * fetches the shard by a path relative to it. A bundler `?url` import would hash and move the
 * json on its own and break that link, so the pair is copied as-is instead — synchronously,
 * from vite.config.ts, for the same cold-start reason as the alphaTab assets
 * (see scripts/alphatabAssets.ts).
 *
 * Served same-origin, so it works under the page's cross-origin isolation with no extra
 * headers, and it is under a megabyte — nothing like the separation model.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/** Where the page fetches the model from — must match BASIC_PITCH_MODEL_URL in the app. */
export const BASIC_PITCH_PUBLIC_DIR = 'models/basic-pitch';

export function copyBasicPitchModel(publicDir: string): { copied: string[] } {
  const require_ = createRequire(import.meta.url);
  let source: string;
  try {
    // The package's own model folder sits beside package.json.
    source = path.join(path.dirname(require_.resolve('@spotify/basic-pitch/package.json')), 'model');
  } catch {
    // Missing package: the AI transcriber falls back to the built-in detector at runtime.
    // Never fail the whole dev server over an optional feature.
    return { copied: [] };
  }

  const dest = path.join(publicDir, BASIC_PITCH_PUBLIC_DIR);
  fs.mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(dest, name);
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
    fs.copyFileSync(from, to);
    copied.push(name);
  }
  return { copied };
}
