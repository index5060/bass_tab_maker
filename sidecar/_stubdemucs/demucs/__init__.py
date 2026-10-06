"""
Stand-in for demucs, used only to test the sidecar's protocol.

Real demucs pulls in PyTorch and a few hundred MB of model weights, which makes it useless
for verifying that the HTTP layer, the progress parsing and the file handoff are correct.
This stub speaks the same command line, prints the same shape of tqdm progress, and writes
files where demucs writes them — so every part of the sidecar except the maths gets
exercised in about a second.

Put its parent directory on PYTHONPATH to shadow the real package.
"""

__version__ = "0.0.0-stub"
