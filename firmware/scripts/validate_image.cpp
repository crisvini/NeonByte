// Offline harness for the exact validators used by the ESP8266 OTA adapter.
#include "neonbyte/firmware_image.h"
#include <fstream>
#include <iostream>
class LocalImage final : public neonbyte::ImageSource {
public:
    explicit LocalImage(const char* path) : file_(path,std::ios::binary) {
        if (file_) { file_.seekg(0,std::ios::end); length_ = file_.tellg(); }
    }
    std::uint32_t size() const override { return length_; }
    bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override {
        if (!file_ || offset > length_ || length > length_-offset) return false;
        file_.seekg(offset); file_.read(reinterpret_cast<char*>(destination),length);
        return file_.good();
    }
private:
    mutable std::ifstream file_;
    std::uint32_t length_ = 0;
};
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    LocalImage image(argv[1]);
    const bool valid = neonbyte::validateEsp8266Image(image) && neonbyte::validateArduinoImageCrc(image);
    std::cout << (valid ? "Image structure and modern CRC valid; installation remains blocked.\n" : "Image rejected.\n");
    return valid ? 0 : 1;
}
