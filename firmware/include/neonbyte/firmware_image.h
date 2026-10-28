#pragma once
#include "neonbyte/animation_source.h"
#include <cstddef>
#include <cstdint>
namespace neonbyte {
class ImageSource : public AnimationSource {
public:
    virtual ~ImageSource() = default;
};
// Combined, uncompressed DIO/40 MHz/4 MB eboot + E9 application only.
// Structural validation is additional to required whole-file SHA-256.
bool validateEsp8266Image(const ImageSource& source);
bool validateArduinoImageCrc(const ImageSource& source);
} // namespace neonbyte
