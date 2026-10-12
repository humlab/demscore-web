// Encoding a downloaded animation. The frames are drawn on a canvas and handed
// to the browser's own encoder (WebCodecs) one at a time, each with a timestamp
// of its own, so the video plays at the speed asked for however long a year's
// tiles took to arrive. Recording the live map instead (MediaRecorder on a
// canvas stream) would have timed the video by the wall clock: a slow year
// would be a long frame.
//
// Mediabunny writes the container. It is loaded on first use, not with the
// page: it is the largest dependency the app has, and most readers never
// download a video.

const loadMediabunny = () => import(/* webpackChunkName: "mediabunny" */ "mediabunny");

// In order of preference. MP4 with H.264 is what plays everywhere a video is
// likely to be put -- slides, phones, social media; WebM is the fallback for
// browsers that cannot encode H.264 (some Linux builds of Chromium and
// Firefox), and plays in browsers and VLC but not in PowerPoint or QuickTime.
export const VIDEO_FORMATS = {
  mp4: { label: "MP4", extension: "mp4", codecs: ["avc"] },
  webm: { label: "WebM", extension: "webm", codecs: ["vp9", "vp8", "av1"] },
};

const CODEC_LABELS = { avc: "H.264", hevc: "H.265", vp8: "VP8", vp9: "VP9", av1: "AV1" };

export function describeCodec(codec) {
  return CODEC_LABELS[codec] || codec;
}

export function canEncodeVideoAtAll() {
  return typeof window.VideoEncoder === "function";
}

// Which codec each format would use for a frame of this size, or null where
// the browser cannot encode any of that format's codecs. Asked per size: an
// encoder can take 1920 x 1080 and refuse a 4K "as on screen" frame.
export async function detectVideoSupport(width, height) {
  const support = {};
  if (!canEncodeVideoAtAll()) {
    for (const key of Object.keys(VIDEO_FORMATS)) support[key] = null;
    return support;
  }
  const mediabunny = await loadMediabunny();
  for (const [key, format] of Object.entries(VIDEO_FORMATS)) {
    try {
      support[key] = await mediabunny.getFirstEncodableVideoCodec(format.codecs, { width, height });
    } catch (_) {
      support[key] = null;
    }
  }
  return support;
}

// A video at a constant `frameRate`, built by capturing `canvas` each time
// addFrame() is called. A year is held for several frames rather than written
// as one long one: a constant rate is what every player and every upload
// service agrees on, and an unchanged frame costs almost nothing to encode.
export async function createVideoWriter({ canvas, format, codec, frameRate, metadata }) {
  const mediabunny = await loadMediabunny();
  const output = new mediabunny.Output({
    format:
      format === "mp4"
        ? // The index at the front, so a browser can start playing the file
          // before it has all of it. The file is in memory anyway.
          new mediabunny.Mp4OutputFormat({ fastStart: "in-memory" })
        : new mediabunny.WebMOutputFormat(),
    target: new mediabunny.BufferTarget(),
  });
  const source = new mediabunny.CanvasSource(canvas, {
    codec,
    quality: mediabunny.QUALITY_HIGH,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate });
  if (metadata) output.setMetadataTags(metadata);
  await output.start();

  let frameIndex = 0;
  return {
    // Captures the canvas as it is now and holds it for `repeat` frames.
    async addFrame(repeat = 1) {
      for (let index = 0; index < repeat; index += 1) {
        await source.add(frameIndex / frameRate, 1 / frameRate);
        frameIndex += 1;
      }
    },
    get duration() {
      return frameIndex / frameRate;
    },
    async finish() {
      await output.finalize();
      const mimeType = await output.getMimeType().catch(() => output.format.mimeType);
      return new Blob([output.target.buffer], { type: mimeType.split(";")[0] });
    },
    async cancel() {
      if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
    },
  };
}
