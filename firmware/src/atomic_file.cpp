#include "neonbyte/atomic_file.h"
#include <algorithm>
#include <array>
#include <cstring>
namespace neonbyte {
bool replaceAtomicFile(AtomicFileBackend& backend, const std::uint8_t* bytes, std::size_t length) {
    bool valid = bytes && length && backend.writeCandidate(bytes,length) && backend.size() == length;
    std::array<std::uint8_t,64> actual{};
    for (std::size_t offset=0;valid && offset<length;) {
        const auto count = std::min(actual.size(),length-offset);
        valid = backend.readAt(offset,actual.data(),count) && memcmp(actual.data(),bytes+offset,count) == 0;
        offset += count;
    }
    if (valid && backend.promoteCandidate()) return true;
    backend.discardCandidate(); return false;
}
} // namespace neonbyte
