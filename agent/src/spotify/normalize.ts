import type {
  NormalizedPlayback,
  SpotifyCurrentPlayback,
  SpotifyImage,
  SpotifyTrack,
} from "./types.js";

const MAX_TEXT_LENGTH = 256;

function boundedText(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = "";
  let length = 0;
  for (const character of value) {
    if (length === MAX_TEXT_LENGTH) break;
    text += character;
    length += 1;
  }
  return text;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function coverImage(images: SpotifyImage[] | undefined): string | null {
  if (!Array.isArray(images)) {
    return null;
  }

  const candidates = images.filter((image) => {
    if (typeof image !== "object" || image === null || typeof image.url !== "string") {
      return false;
    }

    try {
      return new URL(image.url).protocol === "https:";
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) {
    return null;
  }

  const selected = candidates.reduce((best, image) => {
    const imageArea = nonNegativeInteger(image.width) * nonNegativeInteger(image.height);
    const bestArea = nonNegativeInteger(best.width) * nonNegativeInteger(best.height);
    return imageArea > bestArea ? image : best;
  });

  return selected.url;
}

export function normalizeSpotifyPlayback(
  playback: SpotifyCurrentPlayback | null,
  sampledAtUnixMs: number,
): NormalizedPlayback | null {
  const item = playback?.item as SpotifyTrack | null | undefined;
  if (!item || item.type !== "track") {
    return null;
  }

  const trackId = boundedText(item.id || item.uri);
  if (trackId.length === 0) {
    return null;
  }

  const durationMs = nonNegativeInteger(item.duration_ms);
  const progressMs = Math.min(nonNegativeInteger(playback?.progress_ms), durationMs);
  const title = boundedText(item.name);
  const artist = boundedText(Array.isArray(item.artists)
    ? item.artists
        .filter((entry) => typeof entry === "object" && entry !== null)
        .map((entry) => entry.name)
        .filter((name): name is string => typeof name === "string")
        .join(", ")
    : "");
  const isPlaying = playback?.is_playing === true;

  return {
    status: isPlaying ? "playing" : "paused",
    nowPlaying: {
      trackId,
      title,
      artist,
      isPlaying,
      durationMs,
      progressMs,
      sampledAtUnixMs: nonNegativeInteger(sampledAtUnixMs),
    },
    coverUrl: coverImage(item.album?.images),
  };
}
