"""Prevent device operations from this provisional build profile."""
Import("env")

blockedTargets = {"upload", "uploadfs", "uploadfsota", "erase", "erase_flash", "program"}
if blockedTargets.intersection(COMMAND_LINE_TARGETS) or any(target.startswith("upload") or target in {"monitor", "buildfs"} for target in COMMAND_LINE_TARGETS):
    raise RuntimeError("Device operations are blocked: this profile is for local compilation only.")
