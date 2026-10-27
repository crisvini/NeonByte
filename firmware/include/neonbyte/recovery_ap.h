#pragma once
namespace neonbyte {
// Fail closed if the protected AP or any part of its network setup fails.
template <typename Backend>
bool startCheckedRecoveryAp(Backend& backend) {
    if (backend.startProtectedAp() && backend.configureNetwork() && backend.networkMatches()) return true;
    backend.disableAp();
    return false;
}
} // namespace neonbyte
