import { defineConfig } from 'vitest/config';

// The evaluation runs real audio through the whole transcription and prints a score table.
// It is slow and it measures rather than asserts, so it is kept out of `npm test`:
//   npm run eval
export default defineConfig({
  test: {
    include: [process.env.EVAL_ONLY ?? 'eval/*.eval.ts'],
    testTimeout: 30 * 60 * 1000,
  },
});
