#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <vector>
#include <string>

#include "neonbyte/esp8266/fake_clock.h"

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
    std::uint32_t completedAtMicros = 0;
};

struct Rectangle { int x, y, width, height; std::uint16_t color; };
struct TextWrite { int x, y; std::uint8_t size; std::string text; };

struct PanelState {
    std::array<std::uint16_t, 240 * 240> pixels{};
    std::vector<RowWrite> rows;
    std::vector<Rectangle> rectangles;
    std::vector<TextWrite> texts;
    std::size_t totalRowWrites = 0;
    std::size_t spiByteCalls = 0, spiBytes = 0, spiWordWrites = 0;
    std::size_t transactionStarts = 0, transactionEnds = 0;
    std::uint32_t lastSourceReadCountAtSpiWrite = 0;
    int windowX = 0, windowY = 0, windowWidth = 0, windowHeight = 0;
    std::size_t windowPixelCount = 0;
    bool captureRowHistory = true;
    bool windowActive = false, transactionActive = false, spiAlignmentFault = false;
    bool spiWriteOutsideTransaction = false;
    unsigned screenClears = 0;
    std::uint32_t initializationFrequency = 0;
    std::uint32_t drawingFrequency = 0;
    std::uint8_t mode = 0, rotation = 255, madctl = 0;
    bool inverted = false;
};

inline PanelState panelState;

inline void writePanelPixel(std::uint16_t color) {
    auto& panel = panelState;
    if (!panel.transactionActive) panel.spiWriteOutsideTransaction = true;
    if (!panel.windowActive || panel.windowPixelCount >=
        static_cast<std::size_t>(panel.windowWidth) * panel.windowHeight) return;

    const auto rowOffset = panel.windowPixelCount / static_cast<std::size_t>(panel.windowWidth);
    const auto pixelOffset = panel.windowPixelCount % static_cast<std::size_t>(panel.windowWidth);
    const auto x = panel.windowX + static_cast<int>(pixelOffset);
    const auto y = panel.windowY + static_cast<int>(rowOffset);
    panel.pixels[y * 240 + x] = color;
    if (panel.captureRowHistory) {
        if (pixelOffset == 0) {
            panel.rows.push_back({x, panel.windowWidth, y, color, 0, {}, 0});
            panel.rows.back().pixels.reserve(static_cast<std::size_t>(panel.windowWidth));
        }
        auto& row = panel.rows.back();
        if (row.pixelCount == 0) row.firstPixel = color;
        row.pixels.push_back(color);
        ++row.pixelCount;
        if (row.pixelCount == static_cast<std::size_t>(panel.windowWidth)) {
            row.completedAtMicros = micros();
            ++displayTestCompletedAnimationRows;
        }
    }
    ++panel.windowPixelCount;
}

class RecordingDisplaySpi {
public:
    void write16(std::uint16_t pixel) {
        ++panelState.spiWordWrites;
        writePanelPixel(pixel);
        advanceDisplayTestClockForPixels(1);
    }

    void writeBytes(const std::uint8_t* bytes, std::uint32_t length) {
        ++panelState.spiByteCalls;
        panelState.spiBytes += length;
        panelState.lastSourceReadCountAtSpiWrite = displayTestAnimationReadCount;
        if ((reinterpret_cast<std::uintptr_t>(bytes) & 3u) != 0 || length > 480)
            panelState.spiAlignmentFault = true;
        for (std::uint32_t offset = 0; offset + 1 < length; offset += 2) {
            writePanelPixel(static_cast<std::uint16_t>(bytes[offset]) << 8 | bytes[offset + 1]);
            advanceDisplayTestClockForPixels(1);
        }
    }
};

inline RecordingDisplaySpi recordingDisplaySpi;

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
    void startWrite() {
        ++neonbyte::display_test::panelState.transactionStarts;
        neonbyte::display_test::panelState.transactionActive = true;
        displayTestSpiTransactionActive = true;
    }
    void setAddrWindow(int x, int y, int width, int height) {
        auto& panel = neonbyte::display_test::panelState;
        ++panel.totalRowWrites;
        if (!panel.transactionActive) panel.spiWriteOutsideTransaction = true;
        panel.windowActive = x >= 0 && y >= 0 && width > 0 && height > 0 &&
            x + width <= 240 && y + height <= 240;
        if (panel.windowActive) {
            panel.windowX = x;
            panel.windowY = y;
            panel.windowWidth = width;
            panel.windowHeight = height;
            panel.windowPixelCount = 0;
        }
    }
    void SPI_WRITE16(std::uint16_t pixel) {
        neonbyte::display_test::recordingDisplaySpi.write16(pixel);
    }
    void writePixelBytes(const std::uint8_t* bytes, std::size_t length) {
        neonbyte::display_test::recordingDisplaySpi.writeBytes(bytes, static_cast<std::uint32_t>(length));
    }
    void endWrite() {
        ++neonbyte::display_test::panelState.transactionEnds;
        neonbyte::display_test::panelState.transactionActive = false;
        displayTestSpiTransactionActive = false;
    }

protected:
    struct HardwareSpiState { neonbyte::display_test::RecordingDisplaySpi* _spi; };
    HardwareSpiState hwspi{&neonbyte::display_test::recordingDisplaySpi};

private:
    std::uint32_t frequency_ = 0;
    int cursorX_ = 0, cursorY_ = 0;
    std::uint8_t textSize_ = 1;
    std::uint16_t textColor_ = 0;
    bool newText_ = true;
};

using Adafruit_ST77xx = Adafruit_ST7789;
