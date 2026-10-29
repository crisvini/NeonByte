#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <vector>
#include <string>

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
    int x = 0, width = 0;
    int y = -1;
    std::uint16_t firstPixel = 0;
    std::size_t pixelCount = 0;
    std::vector<std::uint16_t> pixels;
};

struct Rectangle { int x, y, width, height; std::uint16_t color; };
struct TextWrite { int x, y; std::uint8_t size; std::string text; };

struct PanelState {
    std::array<std::uint16_t, 240 * 240> pixels{};
    std::vector<RowWrite> rows;
    std::vector<Rectangle> rectangles;
    std::vector<TextWrite> texts;
    unsigned screenClears = 0;
    std::uint32_t initializationFrequency = 0;
    std::uint32_t drawingFrequency = 0;
    std::uint8_t mode = 0, rotation = 255, madctl = 0;
    bool inverted = false;
};

inline PanelState panelState;

} // namespace neonbyte::display_test

class Adafruit_ST7789 {
public:
    virtual ~Adafruit_ST7789() = default;
    Adafruit_ST7789(int chipSelect, int dataCommand, int reset) {
        static_cast<void>(chipSelect);
        static_cast<void>(dataCommand);
        static_cast<void>(reset);
    }

    void init(std::uint16_t width, std::uint16_t height, std::uint8_t mode) {
        static_cast<void>(width);
        static_cast<void>(height);
        neonbyte::display_test::panelState.mode = mode;
        begin(0);
        neonbyte::display_test::panelState.initializationFrequency = frequency_;
    }
    virtual void begin(std::uint32_t frequency) { frequency_ = frequency ? frequency : 32000000; }
    void setSPISpeed(std::uint32_t frequency) { frequency_ = frequency; neonbyte::display_test::panelState.drawingFrequency = frequency; }
    void setRotation(std::uint8_t rotation) { neonbyte::display_test::panelState.rotation = rotation; }
    void sendCommand(std::uint8_t command, const std::uint8_t* data, std::size_t length) {
        if (command == ST77XX_MADCTL && length == 1) neonbyte::display_test::panelState.madctl = data[0];
    }
    void invertDisplay(bool inverted) { neonbyte::display_test::panelState.inverted = inverted; }
    void fillScreen(std::uint16_t color) { neonbyte::display_test::panelState.pixels.fill(color); ++neonbyte::display_test::panelState.screenClears; }
    void setCursor(int x, int y) { cursorX_ = x; cursorY_ = y; newText_ = true; }
    void setTextColor(std::uint16_t color) { textColor_ = color; }
    void setTextSize(std::uint8_t size) { textSize_ = size; }
    void setTextWrap(bool enabled) { static_cast<void>(enabled); }
    std::size_t write(std::uint8_t value) {
        auto& texts = neonbyte::display_test::panelState.texts;
        if (newText_) { texts.push_back({cursorX_, cursorY_, textSize_, {}}); newText_ = false; }
        const int glyphX = cursorX_ + static_cast<int>(texts.back().text.size()) * 6 * textSize_;
        for (int y = cursorY_; y < cursorY_ + 8 * textSize_; ++y) {
            for (int x = glyphX; x < glyphX + 6 * textSize_; ++x) {
                if (x >= 0 && x < 240 && y >= 0 && y < 240)
                    neonbyte::display_test::panelState.pixels[y * 240 + x] = textColor_;
            }
        }
        texts.back().text.push_back(static_cast<char>(value));
        return 1;
    }
    void fillRect(int x, int y, int width, int height, std::uint16_t color) {
        neonbyte::display_test::panelState.rectangles.push_back({x, y, width, height, color});
        for (int row = y; row < y + height; ++row) for (int col = x; col < x + width; ++col)
            if (col >= 0 && col < 240 && row >= 0 && row < 240)
                neonbyte::display_test::panelState.pixels[row * 240 + col] = color;
    }
    void startWrite() {}
    void setAddrWindow(int x, int y, int width, int height) {
        activeRow_ = -1;
        if (x >= 0 && y >= 0 && y < 240 && x + width <= 240 && height == 1) {
            neonbyte::display_test::panelState.rows.push_back({x, width, y, 0, 0, {}});
            activeRow_ = static_cast<int>(neonbyte::display_test::panelState.rows.size() - 1);
        }
    }
    void SPI_WRITE16(std::uint16_t pixel) {
        if (activeRow_ < 0) return;
        auto& row = neonbyte::display_test::panelState.rows[static_cast<std::size_t>(activeRow_)];
        if (row.pixelCount == 0) row.firstPixel = pixel;
        if (row.pixelCount < static_cast<std::size_t>(row.width))
            neonbyte::display_test::panelState.pixels[row.y * 240 + row.x + row.pixelCount] = pixel;
        ++row.pixelCount;
        row.pixels.push_back(pixel);
    }
    void endWrite() {}

private:
    int activeRow_ = -1;
    std::uint32_t frequency_ = 0;
    int cursorX_ = 0, cursorY_ = 0;
    std::uint8_t textSize_ = 1;
    std::uint16_t textColor_ = 0;
    bool newText_ = true;
};

using Adafruit_ST77xx = Adafruit_ST7789;
