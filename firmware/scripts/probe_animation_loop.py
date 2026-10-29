#!/usr/bin/env python3
"""Run the real decoder/display loop tests, optionally against a Git baseline."""

import argparse
import os
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-ref", help="Read production sources from this Git revision")
    parser.add_argument("--measure-only", action="store_true", help="Skip candidate performance gates")
    arguments = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    unity = repository / "firmware/.pio/libdeps/native/Unity/src"
    if not (unity / "unity.c").is_file():
        parser.error("Run the PlatformIO native suite first to obtain its existing Unity dependency.")
    sanitizer_flags = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
                       if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
    with tempfile.TemporaryDirectory(prefix="neonbyte-loop-") as temporary:
        build = Path(temporary)
        production = repository
        if arguments.source_ref:
            production = build / "baseline"
            files = ["firmware/src/animation_decoder.cpp", "firmware/src/esp8266/display.cpp"]
            files.extend(str(path.relative_to(repository)) for path in
                         (repository / "firmware/include").rglob("*.h"))
            for filename in files:
                destination = production / filename
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(subprocess.check_output(
                    ["git", "show", f"{arguments.source_ref}:{filename}"], cwd=repository))
        hooks = build / "hooks.c"
        hooks.write_text("void setUp(void) {}\nvoid tearDown(void) {}\n", encoding="utf-8")
        for source, name in ((unity / "unity.c", "unity"), (hooks, "hooks")):
            subprocess.run([os.environ.get("CC", "cc"), "-O1", "-g", *sanitizer_flags,
                            "-I" + str(unity), "-c", str(source), "-o", str(build / f"{name}.o")], check=True)
        display = production / "firmware/src/esp8266/display.cpp"
        command = [os.environ.get("CXX", "c++"), "-std=c++17", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
                   *sanitizer_flags, "-I" + str(repository / "firmware/test/test_display/fakes"),
                   "-I" + str(production / "firmware/include"), "-I" + str(unity),
                   f'-DNEONBYTE_DISPLAY_SOURCE="{display}"']
        if arguments.measure_only:
            command.append("-DNEONBYTE_LOOP_MEASUREMENT_ONLY=1")
        command.extend([str(repository / "firmware/test/test_animation_loop/test_main.cpp"),
                        str(production / "firmware/src/animation_decoder.cpp"),
                        str(repository / "firmware/src/animation_reader.cpp"),
                        str(repository / "firmware/src/scene_manager.cpp"),
                        str(build / "unity.o"), str(build / "hooks.o"), "-o", str(build / "probe")])
        subprocess.run(command, check=True)
        subprocess.run([str(build / "probe")], check=True)


if __name__ == "__main__":
    main()
