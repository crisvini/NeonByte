#include "neonbyte/hash_job.h"
#include <algorithm>
namespace neonbyte {
HashStep HashJob::step(std::uint8_t* buffer, std::size_t capacity) {
    if (failed_) return HashStep::failed;
    if (!buffer || !capacity || prefix_ > source_.size() || length_ != source_.size()-prefix_) { failed_ = true; return HashStep::failed; }
    if (position_ == length_) return HashStep::complete;
    const auto count = std::min<std::size_t>(capacity,length_-position_);
    if (!source_.readAt(prefix_+position_,buffer,count)) { failed_ = true; return HashStep::failed; }
    digest_.update(buffer,count); position_ += count;
    return position_ == length_ ? HashStep::complete : HashStep::pending;
}
} // namespace neonbyte
