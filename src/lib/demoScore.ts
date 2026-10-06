/**
 * A starter score so the app has something to render on first run, written in alphaTex.
 *
 * alphaTex is alphaTab's text notation format, and it is the answer to "I want to type a riff
 * in without building a tab editor". `3.3` means fret 3 on string 3, `:8` sets eighth notes,
 * `|` is a barline. Full syntax: https://alphatab.net/docs/alphatex/
 *
 * This one is an original finger-independence / position-shift exercise, not a transcription.
 */

/**
 * Fixed id for the starter song.
 *
 * It used to get a fresh crypto.randomUUID() on every page load, so the moment anything
 * saved it you got another "Warm-up: Position Shifts" in the library — one per session,
 * forever. A constant id means the starter can only ever occupy one row.
 */
export const DEMO_DOC_ID = 'demo-warmup';

/**
 * An empty 4-string bass staff, for "새 곡".
 *
 * Eight bars of rests: enough of a timeline to hang sync anchors on while you work out a
 * part by ear, and a place to start typing alphaTex if you want to write the tab yourself.
 */
export const BLANK_ALPHATEX = blankAlphaTex(8, 120, '새 곡');

/**
 * An empty bass staff of a given length.
 *
 * The bar count matters: playback stops at the end of the score, so a fixed 8 bars meant a
 * four-minute recording cut out after sixteen seconds. Size it to the audio instead.
 */
export function blankAlphaTex(bars: number, bpm = 120, title = '새 곡'): string {
  const safeBars = Math.max(1, Math.min(2000, Math.round(bars)));
  const safeTitle = title.replace(/["\\]/g, '');
  return [
    `\\title "${safeTitle}"`,
    `\\tempo ${Math.round(bpm)}`,
    '\\instrument 33',
    '.',
    '\\track "Bass"',
    '\\staff{tabs} \\tuning G2 D2 A1 E1',
    '',
    Array.from({ length: safeBars }, () => 'r |').join('\n'),
    '',
  ].join('\n');
}

/** True for a score that is still an untouched blank, whatever its length. */
export function isBlankScore(scoreData: unknown): boolean {
  return typeof scoreData === 'string' && /^(\s*r\s*\|\s*)+$/m.test(scoreData.split('\n\n')[1] ?? '');
}

export const DEMO_ALPHATEX = String.raw`\title "Warm-up: Position Shifts"
\subtitle "4-string bass, E A D G"
\tempo 90
\instrument 33
.
\track "Bass"
// alphaTab lists tuning from string 1 (highest) down to string 4 (lowest),
// so string 4 = E and 0.4 is the open E string.
\staff{tabs} \tuning G2 D2 A1 E1

// Bar 1-2: one-finger-per-fret across the E string, then back
:8 0.4 1.4 2.4 3.4 3.4 2.4 1.4 0.4 |
:8 0.3 1.3 2.3 3.3 3.3 2.3 1.3 0.3 |

// Bar 3-4: string crossing, alternate plucking
:8 3.4 3.3 5.4 5.3 3.4 3.3 5.4 5.3 |
:8 5.2 5.3 3.2 3.3 5.2 5.3 3.2 3.3 |

// Bar 5-6: shift up the neck, same shape
:8 5.4 7.4 5.3 7.3 5.2 7.2 5.1 7.1 |
:8 7.1 5.1 7.2 5.2 7.3 5.3 7.4 5.4 |

// Bar 7-8: settle on a root-fifth-octave figure
:4 3.4 :4 5.3 :4 5.2 :4 3.4 |
:2 3.4 :2 r |
`;
