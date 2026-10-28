#pragma once

#include <cstddef>
#include <cstdint>

namespace neonbyte {

class AnimationSource {
public:
    virtual ~AnimationSource() = default;
    virtual std::uint32_t size() const = 0;
    virtual bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const = 0;
};

} // namespace neonbyte
