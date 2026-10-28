#pragma once

namespace neonbyte {
struct StorageMountState {
    bool mounted = false;
    bool prepared = false;
};

// The configuration path mounts LittleFS without creating or cleaning paths.
template <typename Backend>
bool mountFilesystemForConfiguration(StorageMountState& state, Backend& backend) {
    if (state.mounted) return true;
    backend.disableAutoFormat();
    if (!backend.mount()) return false;
    state.mounted = true;
    return true;
}

// Explicit storage preparation retains the existing namespace and cleanup behavior.
template <typename Backend>
bool prepareFilesystem(StorageMountState& state, Backend& backend) {
    if (state.prepared) return true;
    if (!mountFilesystemForConfiguration(state,backend)) return false;
    if (!backend.ensureNamespace()) return false;
    backend.cleanupTemporaryFiles();
    state.prepared = true;
    return true;
}
}
