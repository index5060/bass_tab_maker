"""
`basic_pitch.inference.predict` stand-in.

Emits one quarter note (A1, midi 33) every half second for the duration of the input file.
Entirely fabricated — the point is that the sidecar can call predict(), read note events in
the real shape (start_s, end_s, midi, amplitude, bends), and hand them to the browser.
"""

import wave


def predict(
    audio_path,
    model=None,
    onset_threshold=None,
    frame_threshold=None,
    minimum_note_length=None,
    minimum_frequency=None,
    maximum_frequency=None,
):
    with wave.open(str(audio_path), "rb") as w:
        duration = w.getnframes() / w.getframerate()

    events = []
    t = 0.0
    while t + 0.45 <= duration:
        events.append((t, t + 0.45, 33, 0.8, None))
        t += 0.5

    return None, None, events
