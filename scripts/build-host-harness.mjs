import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(new URL("../build/", import.meta.url), { recursive: true });
const sources = ["protocol", "scene_manager", "animation_reader", "transfer", "hash_job", "atomic_file", "safe_startup", "wifi_configuration", "http_headers", "maintenance_info"];
const result = spawnSync(process.env.CXX || "c++", [
  "-std=c++17", "-Wall", "-Wextra", "-Werror", "-g", "-Ifirmware/include",
  ...(process.env.NEONBYTE_HOST_SANITIZERS === "1" ? ["-O1", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"] : ["-O2"]),
  "firmware/host/main.cpp", "firmware/host/storage.cpp",
  ...sources.map((name) => `firmware/src/${name}.cpp`), "-lcrypto", "-o", "build/neonbyte-host",
], { cwd: root, stdio: "inherit" });
process.exitCode = result.status ?? 1;
