"""
Report what this interpreter can actually do, as one line of JSON.

The launcher uses this to pick between the Pythons installed on a machine. Choosing by
version number is not good enough: a box can easily carry 3.9 (too old for current torch),
3.12 (the one that works) and 3.14 (too new — torch publishes no CUDA wheels for it yet, so
you silently get a CPU build). The only question that matters is which one has demucs and a
torch that can see the GPU.

Kept as a file rather than a `-c` one-liner so there is nothing to quote-escape on Windows.
"""

import json
import sys

result = {
    "version": "%d.%d.%d" % sys.version_info[:3],
    "minor": sys.version_info[1],
    "major": sys.version_info[0],
    "demucs": False,
    "torch": None,
    "cuda": False,
    "gpu": "",
}

try:
    import demucs  # noqa: F401

    result["demucs"] = True
except Exception:
    pass

try:
    import torch

    result["torch"] = torch.__version__
    # Wrapped separately: a torch built without CUDA raises here rather than returning False.
    try:
        if torch.cuda.is_available():
            result["cuda"] = True
            result["gpu"] = torch.cuda.get_device_name(0)
    except Exception:
        pass
except Exception:
    pass

print(json.dumps(result))
