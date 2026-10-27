#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

constexpr std::uint8_t SPI_MODE3 = 3;
constexpr std::uint8_t ST77XX_MADCTL = 0x36;
constexpr std::uint16_t ST77XX_BLACK = 0x0000;
constexpr std::uint16_t ST77XX_WHITE = 0xffff;
constexpr std::uint16_t ST77XX_GREEN = 0x07e0;

constexpr int OUTPUT = 1;
constexpr int HIGH = 1;
constexpr int LOW = 0;

inline void pinMode(int pin, int mode) {
    static_cast<void>(pin);
    static_cast<void>(mode);
}

inline void digitalWrite(int pin, int value) {
    static_cast<void>(pin);
    static_cast<void>(value);
}

namespace neonbyte::display_test {

struct RowWrite {
    int y = -1;
    std::uint16_t firstPixel = 0;
    std::size_t pixelCount = 0;
};

struct PanelState {
    std::vector<RowWrite> rows;
};

inline PanelState panelState;

} // namespace neonbyte::display_test

class Adafruit_ST7789 {
public:
    Adafruit_ST7789(int chipSelect, int dataCommand, int reset) {
        static_cast<void>(chipSelect);
        static_cast<void>(dataCommand);
        static_cast<void>(reset);
    }

    void init(std::uint16_t width, std::uint16_t height, std::uint8_t mode) {
        static_cast<void>(width);
        static_cast<void>(height);
        static_cast<void>(mode);
    }
    void setSPISpeed(std::uint32_t frequency) { static_cast<void>(frequency); }
    void setRotation(std::uint8_t rotation) { static_cast<void>(rotation); }
    void sendCommand(std::uint8_t command, const std::uint8_t* data, std::size_t length) {
        static_cast<void>(command);
        static_cast<void>(data);
        static_cast<void>(length);
    }
    void invertDisplay(bool inverted) { static_cast<void>(inverted); }
    void fillScreen(std::uint16_t color) { static_cast<void>(color); }
    void setCursor(int x, int y) { static_cast<void>(x); static_cast<void>(y); }
    void setTextColor(std::uint16_t color) { static_cast<void>(color); }
    void setTextSize(std::uint8_t size) { static_cast<void>(size); }
    void setTextWrap(bool enabled) { static_cast<void>(enabled); }
    std::size_t write(std::uint8_t value) { static_cast<void>(value); return 1; }
    void fillRect(int x, int y, int width, int height, std::uint16_t color) {
        static_cast<void>(x);
        static_cast<void>(y);
        static_cast<void>(width);
        static_cast<void>(height);
        static_cast<void>(color);
    }
    void startWrite() {}
    void setAddrWindow(int x, int y, int width, int height) {
        activeRow_ = -1;
        if (x == 0 && y >= 0 && y < 240 && width == 240 && height == 1) {
            neonbyte::display_test::panelState.rows.push_back({y, 0, 0});
            activeRow_ = static_cast<int>(neonbyte::display_test::panelState.rows.size() - 1);
        }
    }
    void SPI_WRITE16(std::uint16_t pixel) {
        if (activeRow_ < 0) return;
        auto& row = neonbyte::display_test::panelState.rows[static_cast<std::size_t>(activeRow_)];
        if (row.pixelCount == 0) row.firstPixel = pixel;
        ++row.pixelCount;
    }
    void endWrite() {}

private:
    int activeRow_ = -1;
};
