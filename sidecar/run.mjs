/**
 * Cross-platform launcher for the sidecar.
 *
 * Two problems this solves.
 *
 * First, `python3` does not exist on Windows. Worse, Windows ships a stub at
 * WindowsApps\python3.exe that exists just enough to fail with "파일을 찾을 수 없습니다", so
 * the error points at a path instead of at the real problem. Windows installs the `py`
 * launcher instead.
 *
 * Second, and more subtly: a machine usually has more than one Python, and picking by version
 * number is wrong. 3.9 is too old for current torch; 3.14 is too new — torch publishes no
 * CUDA wheels for it yet, so you silently get a CPU build and separation crawls. `py -3`
 * happily hands you the newest one, which is exactly the one that cannot use the GPU.
 *
 * So: enumerate every interpreter, ask each what it can actually do (sidecar/probe.py), and
 * pick the one that can run demucs on the GPU. Set BASS_SIDECAR_PYTHON to override.
 *
 *   node sidecar/run.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const HERE = import.meta.dirname;
const SERVER = path.join(HERE, 'server.py');
const PROBE = path.join(HERE, 'probe.py');
const MIN_MINOR = 8; // server.py refuses below this

/* ------------------------------------------------------------ candidates */

function windowsCandidates() {
  const found = [];
  // `py -0p` lists every registered interpreter with its path — the authoritative source,
  // rather than guessing at version numbers.
  const listed = spawnSync('py', ['-0p'], { encoding: 'utf8' });
  if (!listed.error && listed.status === 0) {
    for (const line of (listed.stdout ?? '').split('\n')) {
      const match = /-V:(\d+\.\d+)/.exec(line);
      if (match) found.push({ command: 'py', args: [`-${match[1]}`], label: `py -${match[1]}` });
    }
  }
  found.push({ command: 'py', args: ['-3'], label: 'py -3' });
  found.push({ command: 'python', args: [], label: 'python' });
  return found;
}

function unixCandidates() {
  return [
    { command: 'python3', args: [], label: 'python3' },
    { command: 'python', args: [], label: 'python' },
  ];
}

const override = process.env.BASS_SIDECAR_PYTHON;
const candidates = override
  ? [{ command: override, args: [], label: override }]
  : process.platform === 'win32'
    ? windowsCandidates()
    : unixCandidates();

/* ---------------------------------------------------------------- probing */

/** Ask one interpreter what it has. Returns null when the command does not exist. */
function probe(candidate) {
  const result = spawnSync(candidate.command, [...candidate.args, PROBE], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const info = JSON.parse((result.stdout ?? '').trim().split('\n').pop() ?? '');
    return { ...candidate, ...info };
  } catch {
    return null;
  }
}

/**
 * Higher is better. Being able to reach the GPU dominates everything else, because it is the
 * difference between minutes and tens of minutes per song.
 */
function score(p) {
  if (p.major !== 3 || p.minor < MIN_MINOR) return -1;
  let s = 1;
  if (p.demucs) s += 10;
  if (p.torch) s += 2;
  if (p.cuda) s += 20;
  return s;
}

console.log('Python 확인 중…');
const probed = [];
const seen = new Set();
for (const candidate of candidates) {
  const info = probe(candidate);
  if (!info) continue;
  const key = `${info.version}`;
  if (seen.has(key)) continue; // `py -3` usually duplicates one already listed
  seen.add(key);
  probed.push(info);

  const bits = [
    `Python ${info.version}`,
    info.demucs ? 'demucs 있음' : 'demucs 없음',
    info.cuda ? `CUDA (${info.gpu})` : info.torch ? 'torch CPU 전용' : 'torch 없음',
  ];
  console.log(`  ${info.label.padEnd(10)} ${bits.join(' · ')}`);

  // Nothing will beat this, so stop paying the cost of importing torch again.
  if (score(info) >= 33) break;
}

const usable = probed.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a))[0];

if (!usable) {
  console.error('\n사이드카를 실행할 Python을 찾지 못했습니다.\n');
  if (probed.length > 0) {
    console.error('  찾은 Python이 전부 3.8 미만입니다.');
  } else if (process.platform === 'win32') {
    console.error('  Windows에는 python3 명령이 없습니다. python.org에서 3.12를 설치하시고');
    console.error('  설치 화면의 "Add Python to PATH"를 체크하세요.');
  }
  console.error('\n사이드카 없이도 앱은 그대로 동작합니다 — 브라우저 분리로 돌아갑니다.\n');
  process.exit(1);
}

console.log(`\n선택: ${usable.label} (Python ${usable.version})`);

if (!usable.demucs) {
  console.error(`\n  이 Python에 demucs가 없습니다. 설치하세요:`);
  console.error(`    ${[usable.command, ...usable.args].join(' ')} -m pip install demucs\n`);
} else if (!usable.cuda) {
  const better = probed.find((p) => p.cuda);
  console.log('  GPU를 쓰지 못합니다 — CPU로 돌아갑니다. shifts는 0~1로 두고 시작하세요.');
  if (better) {
    console.log(`  참고: ${better.label}는 GPU를 쓸 수 있지만 demucs가 없습니다.`);
  }
} else {
  console.log(`  GPU 사용: ${usable.gpu}`);
}

/* ----------------------------------------------------------------- launch */

// No shell: probe() already proved this command resolves on its own, and passing args
// alongside shell:true is what produced Node's DEP0190 warning.
const child = spawn(usable.command, [...usable.args, SERVER], { stdio: 'inherit' });

// Ctrl+C should stop the server, not just detach this launcher from it.
const forward = (signal) => () => child.kill(signal);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code) => process.exit(code ?? 0));
