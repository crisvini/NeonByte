#!/usr/bin/env python3
"""Exercise the build guard with synthetic targets, without running PlatformIO."""
from pathlib import Path
import runpy

script = Path(__file__).with_name("local_build_only.py")
for targets in ([], ["buildprog"], ["compiledb"], ["upload"], ["uploadfs"], ["erase"], ["program"], ["uploadota"], ["monitor"], ["buildfs"]):
    blocked = bool(set(targets) & {"upload", "uploadfs", "erase", "program", "uploadota", "monitor", "buildfs"})
    try:
        runpy.run_path(str(script), init_globals={"Import": lambda name: None, "COMMAND_LINE_TARGETS": targets})
    except RuntimeError:
        assert blocked, targets
    else:
        assert not blocked, targets
print("Local build guard: permitted builds and blocked synthetic device targets verified.")
