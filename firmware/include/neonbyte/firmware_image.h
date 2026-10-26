#pragma once
#include <cstddef>
#include <cstdint>
namespace neonbyte {
class ImageSource {
public:
    virtual ~ImageSource() = default;
    virtual std::uint32_t size() const = 0;
    virtual bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const = 0;
};
// Combined, uncompressed DIO/40 MHz/4 MB eboot + E9 application only.
// Structural validation is additional to required whole-file SHA-256.
bool validateEsp8266Image(const ImageSource& source);
bool validateArduinoImageCrc(const ImageSource& source);
} // namespace neonbyte
