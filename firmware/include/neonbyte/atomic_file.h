#pragma once
#include "neonbyte/firmware_image.h"
namespace neonbyte {
class AtomicFileBackend : public ImageSource {
public:
    // Must flush and close the candidate before returning; readAt reopens it.
    virtual bool writeCandidate(const std::uint8_t* bytes, std::size_t length) = 0;
    virtual bool promoteCandidate() = 0;
    virtual void discardCandidate() = 0;
};
bool replaceAtomicFile(AtomicFileBackend& backend, const std::uint8_t* bytes, std::size_t length);
} // namespace neonbyte
