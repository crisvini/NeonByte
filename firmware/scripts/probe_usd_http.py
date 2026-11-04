#!/usr/bin/env python3
"""Exercise extracted production USD HTTP adapter paths with host I/O doubles."""
import subprocess
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction


def extractBlock(source, signature):
    if source.count(signature) != 1:
        raise ValueError(f"Expected one occurrence of {signature}")
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    state = "code"
    index = opening
    while index < len(source):
        character = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if state == "code":
            if character == '"':
                state = "string"
            elif character == "'":
                state = "character"
            elif character == "/" and following == "/":
                state = "line_comment"
                index += 1
            elif character == "/" and following == "*":
                state = "block_comment"
                index += 1
            elif character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
                if depth == 0:
                    return source[start:index + 1]
        elif state in ("string", "character"):
            if character == "\\":
                index += 1
            elif (state == "string" and character == '"') or (state == "character" and character == "'"):
                state = "code"
        elif state == "line_comment" and character == "\n":
            state = "code"
        elif state == "block_comment" and character == "*" and following == "/":
            state = "code"
            index += 1
        index += 1
    raise ValueError(f"Unterminated block {signature}")


SOURCE = r'''
#include "neonbyte/protocol.h"
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <string_view>
#define PSTR(value) (value)
using namespace neonbyte;
constexpr unsigned JSON_BODY_LIMIT = 12'288;
namespace { bool countAllocations = false; std::size_t allocations = 0; }
void* operator new(std::size_t size) {
    if (countAllocations) ++allocations;
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations) ++allocations;
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
    try { return ::operator new(size); } catch (...) { return nullptr; }
}
void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
    try { return ::operator new[](size); } catch (...) { return nullptr; }
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete(void* memory, const std::nothrow_t&) noexcept { std::free(memory); }
void operator delete[](void* memory, const std::nothrow_t&) noexcept { std::free(memory); }
class ClockDouble final : public Clock {
public:
    std::uint64_t monotonicMillis() const override { return now; }
    std::uint64_t unixMillis() const override { return 0; }
    std::uint64_t now = 0;
};
class StorageDouble final : public Storage {
public:
    bool loadMode(DisplayMode&) const override { return false; }
    bool saveMode(DisplayMode) override { return true; }
    std::uint64_t freeBytes() const override { return 1024; }
    std::uint32_t animationSize() const override { return 0; }
    bool readAnimationAt(std::uint32_t, std::uint8_t*, std::size_t) const override { return false; }
};
class AdapterDouble {
public:
    AdapterDouble(ProtocolHandler& protocol) : protocol_(&protocol) {}
    bool begin(std::string_view path, std::size_t length) {
        headers_.path = path; headers_.contentLength = length;
        expected_ = length; received_ = 0; rejected_ = false; readingBody_ = false; response_ = {};
        headersComplete();
        return !rejected_ && readingBody_;
    }
    void append(std::string_view fragment) {
        assert(fragment.size() <= expected_ - received_);
        const auto bytes = fragment.size();
        std::memcpy(chunk_.data(), fragment.data(), bytes);
        if (binary_) {
            assert(false);
        } else if (animationV2Route_ && animationV2Request_ == AnimationV2Request::chunk) {
            assert(false);
@@RECEIVE_COPY@@
        received_ += fragment.size();
        assert(received_ <= expected_);
        if (received_ == headers_.contentLength) bodyComplete();
    }
    HttpResponse finish(HttpMethod method) {
        if (!rejected_) assert(received_ == expected_);
        static_cast<void>(method);
        return response_;
    }
    bool hasDynamicBody() const { return body_ != nullptr; }
    void close() { body_.reset(); received_ = expected_ = 0; headers_ = {}; readingBody_ = false; }
private:
    struct Headers { std::string_view path; std::size_t contentLength = 0; } headers_;
    enum class AnimationV2Request { none, chunk };
    void headersComplete() {
        const bool binary_ = false;
@@ROUTE_CLASSIFICATION@@
        if (binary_) {
        } else {
@@LIMIT_LINE@@
@@BODY_LIMIT_CHECK@@
@@BODY_ALLOCATION@@
        }
        readingBody_ = true;
    }
    void bodyComplete() {
@@BODY_COMPLETE_DISPATCH@@
    }
    void dispatchJson() {
        bodyData()[received_] = '\0';
        const HttpRequest request{HttpMethod::put, headers_.path, "Bearer probe-only", "application/json",
            {bodyData(), received_}};
@@USD_DISPATCH@@
        response_ = protocol_->handle(request, {});
    }
    void error(unsigned status, const char*, const char*) {
        rejected_ = true; readingBody_ = false; response_ = {}; response_.statusCode = status;
    }
    void prepareResponse() {}
    char* bodyData() { return body_ ? body_.get() : control_.data(); }
    ProtocolHandler* protocol_;
    std::unique_ptr<char[]> body_;
    std::array<char, 513> control_{};
    std::array<char, 512> chunk_{};
    std::size_t expected_ = 0, received_ = 0;
    HttpResponse response_{};
    bool readingBody_ = false, rejected_ = false, binary_ = false, maintenance_ = false, animationV2Route_ = false;
    AnimationV2Request animationV2Request_ = AnimationV2Request::none;
};
int main() {
    ClockDouble clock; StorageDouble storage; SceneManager scenes(clock, storage);
    BearerTokenAuthenticator auth("probe-only"); ProtocolHandler protocol(scenes, storage, auth);
    AdapterDouble adapter(protocol);

    constexpr std::string_view modePath = "/api/v1/mode";
    constexpr std::string_view modeBody = R"({"mode":"gif"})";
    assert(adapter.begin(modePath, modeBody.size()));
    adapter.append(modeBody);
    assert(adapter.finish(HttpMethod::put).statusCode == 204);
    assert(adapter.hasDynamicBody());
    adapter.close();

    constexpr std::string_view usdPath = "/api/v1/usd-state";
    constexpr std::string_view usdBody = R"({"enabled":true,"priceCents":525,"changeBasisPoints":42,"validForMs":300000})";
    assert(usdBody.size() <= 128);
    assert(adapter.begin(usdPath, usdBody.size()));
    assert(!adapter.hasDynamicBody());
    allocations = 0; countAllocations = true;
    adapter.append(usdBody.substr(0, 13));
    assert(!adapter.hasDynamicBody());
    adapter.append(usdBody.substr(13, 29));
    assert(!adapter.hasDynamicBody());
    adapter.append(usdBody.substr(42));
    const auto response = adapter.finish(HttpMethod::put);
    countAllocations = false;
    assert(response.statusCode == 204 && allocations == 0);
    assert(scenes.usdState().priceCents == 525);

    assert(!adapter.begin(usdPath, 129));
    assert(adapter.finish(HttpMethod::put).statusCode == 413);
    return 0;
}
'''


def main():
    repository = Path(__file__).resolve().parents[2]
    adapter_source = (repository / "firmware/src/esp8266/http_server.cpp").read_text()
    header_source = (repository / "firmware/include/neonbyte/esp8266/http_server.h").read_text()
    headers_complete = extractFunction(adapter_source, "void DeviceHttpServer::headersComplete()")
    dispatch_json = extractFunction(adapter_source, "void DeviceHttpServer::dispatchJson()")
    body_loop = extractFunction(adapter_source, "void DeviceHttpServer::tick(")
    body_complete = extractFunction(adapter_source, "void DeviceHttpServer::bodyComplete()")
    close = extractFunction(adapter_source, "void DeviceHttpServer::close()")

    route_classification = 'const bool usdStateRoute = headers_.path == "/api/v1/usd-state";'
    limit_line = next(line.strip() for line in headers_complete.splitlines() if "const auto limit = usdStateRoute ?" in line)
    body_limit_check = extractBlock(headers_complete,
        'if (headers_.contentLength > limit) { error(413,"payload_too_large",PSTR("The request body exceeds the route limit.")); return; }')
    body_allocation = extractBlock(headers_complete, "if (!usdStateRoute && limit == JSON_BODY_LIMIT)")
    receive_copy = "} else memcpy(bodyData()+received_,chunk_.data(),bytes);"
    usd_dispatch = extractBlock(dispatch_json, 'if (request.path == "/api/v1/usd-state")')
    body_complete_dispatch = "if (!binary_) { dispatchJson(); return; }"
    body_reset = "body_.reset();"
    assert route_classification in headers_complete
    assert limit_line in headers_complete
    assert body_limit_check in headers_complete
    assert body_allocation in headers_complete
    assert receive_copy in body_loop
    assert usd_dispatch in dispatch_json
    assert body_complete_dispatch in body_complete
    assert body_reset in close
    assert dispatch_json.index('if (request.path == "/api/v1/usd-state")') < dispatch_json.index("const String ip =")
    assert "std::array<char,513> controlBody_" in header_source
    assert "usd" not in header_source.lower(), "The HTTP adapter must not add a USD-specific receive buffer or member."

    with tempfile.TemporaryDirectory(prefix="neonbyte-usd-http-") as temporary:
        source = Path(temporary) / "probe.cpp"
        executable = Path(temporary) / "probe"
        source_text = SOURCE
        for placeholder, replacement in {
            "@@ROUTE_CLASSIFICATION@@": route_classification,
            "@@LIMIT_LINE@@": limit_line,
            "@@BODY_LIMIT_CHECK@@": body_limit_check,
            "@@BODY_ALLOCATION@@": body_allocation,
            "@@RECEIVE_COPY@@": receive_copy,
            "@@USD_DISPATCH@@": usd_dispatch,
            "@@BODY_COMPLETE_DISPATCH@@": body_complete_dispatch,
        }.items():
            source_text = source_text.replace(placeholder, replacement)
        source.write_text(source_text)
        subprocess.run([
            "g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
            f"-I{repository / 'firmware/include'}", str(source),
            str(repository / "firmware/src/protocol.cpp"),
            str(repository / "firmware/src/scene_manager.cpp"), "-o", str(executable),
        ], check=True)
        subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    main()
