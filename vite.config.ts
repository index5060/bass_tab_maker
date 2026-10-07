import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { alphaTab } from '@coderline/alphatab-vite';
import { copyAlphaTabAssets } from './scripts/alphatabAssets.ts';
import { copyBasicPitchModel } from './scripts/basicPitchModel.ts';

const publicDir = path.resolve(import.meta.dirname, 'public');

const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// Runs at config evaluation time, i.e. BEFORE Vite snapshots publicDir and before the dev
// server starts serving. Doing it here (rather than from a plugin hook) is what makes a cold
// `npm run dev` work on the first try — see scripts/alphatabAssets.ts for the full story.
const assets = copyAlphaTabAssets(publicDir);
if (assets.copied.length > 0) {
  console.log(`[alphaTab] 에셋 ${assets.copied.length}개 복사 완료 → public/`);
}
// Same timing, same reason: the AI transcriber's model has to be on disk before serving starts.
const pitchModel = copyBasicPitchModel(publicDir);
if (pitchModel.copied.length > 0) {
  console.log(`[basic-pitch] 모델 파일 ${pitchModel.copied.length}개 복사 완료 → public/models/basic-pitch/`);
}

export default defineConfig({
  base: './',
  publicDir,
  plugins: [
    react(),
    // Keep the plugin for its web worker + audio worklet wiring, but turn off its asset
    // copying: it runs too late to be useful and would only duplicate the work above.
    alphaTab({ assetOutputDir: false }),
  ],
  // onnxruntime-web (used by the stem separator) needs SharedArrayBuffer, which browsers
  // only hand out on a cross-origin-isolated page.
  //
  // COEP is `credentialless` rather than `require-corp` on purpose: require-corp refuses any
  // cross-origin subresource that does not send CORP, which would block fetching the 172MB
  // model straight from Hugging Face. credentialless still enables isolation but loads
  // cross-origin resources without credentials, which is all a public model file needs.
  // (Self-hosting the model under public/models/ avoids the question entirely.)
  server: { port: 5173, headers: CROSS_ORIGIN_ISOLATION },
  preview: { port: 5173, headers: CROSS_ORIGIN_ISOLATION },

  // onnxruntime-web ships prebuilt wasm; leave it out of the dep optimizer so its worker
  // and wasm assets are served as-is.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
