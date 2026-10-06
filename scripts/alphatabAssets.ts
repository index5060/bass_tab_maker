/**
 * Copy alphaTab's Bravura fonts and soundfont into publicDir.
 *
 * Why this exists instead of letting @coderline/alphatab-vite do it:
 *
 * Vite snapshots the file list of `publicDir` once, when the dev server boots, and serves
 * public assets from that snapshot. The alphaTab plugin does its copying from a plugin hook,
 * which runs *after* that snapshot. So on a cold checkout (no public/font yet) the very first
 * `npm run dev` serves the SPA fallback `index.html` for /font/Bravura.woff2 and
 * /soundfont/sonivox.sf3 instead of the real bytes. You then get:
 *
 *   OTS parsing error: invalid sfntVersion: 1008821359     <- 0x3C21444F, i.e. "<!DO"
 *   Error: Soundfont is not a valid Soundfont2 file
 *
 * ...and nothing renders. Restarting the dev server "fixes" it, which makes the bug look
 * intermittent and is a miserable thing to debug.
 *
 * Calling this synchronously from vite.config.ts (which is evaluated before the server
 * starts) removes the race entirely, for both `vite` and `vite build`.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const FONT_FILES = [
  'Bravura.woff2',
  'Bravura.woff',
  'Bravura.otf',
  'Bravura.svg',
  'Bravura.eot',
  'Bravura-OFL.txt',
];

const SOUNDFONT_FILES = ['sonivox.sf3', 'LICENSE', 'README.md'];

export interface CopyResult {
  sourceDir: string;
  copied: string[];
  skipped: number;
}

/**
 * Find alphaTab's `dist` directory (the one holding `font/` and `soundfont/`).
 *
 * Note: we cannot `require.resolve('@coderline/alphatab/package.json')` — the package's
 * `exports` map does not expose it, and Node throws ERR_PACKAGE_PATH_NOT_EXPORTED. So resolve
 * the entry point instead and walk up until we see the asset folders.
 */
function resolveAlphaTabDist(): string {
  const require_ = createRequire(import.meta.url);
  let dir: string;
  try {
    dir = path.dirname(require_.resolve('@coderline/alphatab'));
  } catch {
    throw new Error('@coderline/alphatab을 찾지 못했습니다. "npm install"을 먼저 실행하세요.');
  }

  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'font')) && fs.existsSync(path.join(dir, 'soundfont'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('alphaTab의 font/soundfont 디렉토리를 찾지 못했습니다.');
}

export function copyAlphaTabAssets(publicDir: string): CopyResult {
  const sourceDir = resolveAlphaTabDist();

  const copied: string[] = [];
  let skipped = 0;

  const copyGroup = (subdir: string, files: string[]) => {
    const from = path.join(sourceDir, subdir);
    const to = path.join(publicDir, subdir);
    fs.mkdirSync(to, { recursive: true });

    for (const name of files) {
      const src = path.join(from, name);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(to, name);

      // Skip identical files so we do not churn mtimes on every dev server restart.
      const srcStat = fs.statSync(src);
      if (fs.existsSync(dst)) {
        const dstStat = fs.statSync(dst);
        if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
          skipped++;
          continue;
        }
      }
      fs.copyFileSync(src, dst);
      copied.push(`${subdir}/${name}`);
    }
  };

  copyGroup('font', FONT_FILES);
  copyGroup('soundfont', SOUNDFONT_FILES);

  // Fail loudly and early rather than shipping a page that renders nothing.
  const mustExist = [
    path.join(publicDir, 'font', 'Bravura.woff2'),
    path.join(publicDir, 'soundfont', 'sonivox.sf3'),
  ];
  for (const f of mustExist) {
    if (!fs.existsSync(f)) {
      throw new Error(`alphaTab 필수 에셋을 복사하지 못했습니다: ${f}`);
    }
  }

  return { sourceDir, copied, skipped };
}
