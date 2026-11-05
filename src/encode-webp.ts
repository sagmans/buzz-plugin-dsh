// Replaces buzz-app's WebP encoder in the bundle (scripts/build-plugin.mjs, SWAPS). Buzz encodes in a
// web worker, a file beside its module, and an installed plugin is one module
// with no other file. WebKit's canvas has no WebP encoder, but it has a lossless
// PNG one, and prepareAttachment takes a PNG from this step and renames the file.
// So the picture keeps its pixels and changes only its format, with no codec or
// worker added to the bundle. The `picture` input of the Buzz agent tools is the
// only caller here, and only for a static WebP that needs its pixels changed.

/** The format prepareAttachment accepts in place of WebP. */
const OUTPUT_TYPE = "image/png";
/** buzz-app's deadline for this step: a canvas encode cannot be cancelled. */
const ENCODE_TIMEOUT_MS = 60_000;

/** The picture's pixels could not become an upload: what the agent reads. */
export class PictureEncodeError extends Error {
  override name = "PictureEncodeError";
}

/** The pixels as a PNG, under buzz-app's signature. Rejects when `signal` ends. */
export async function encodeWebp(
  pixels: ImageData,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new PictureEncodeError(
        `No canvas to convert a ${pixels.width}x${pixels.height} WebP picture. Use a PNG or JPEG.`,
      );
    }
    context.putImageData(pixels, 0, 0);
    return await toBlob(
      canvas,
      AbortSignal.any([signal, AbortSignal.timeout(ENCODE_TIMEOUT_MS)]),
    );
  } finally {
    // Frees the pixel memory at once, as the caller does with its own canvas.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** The canvas's PNG. The abort path only stops the wait: the encode runs on. */
function toBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    canvas.toBlob((blob) => {
      signal.removeEventListener("abort", abort);
      if (blob) resolve(blob);
      else {
        reject(
          new PictureEncodeError(
            `Could not encode a ${canvas.width}x${canvas.height} WebP picture as PNG. Use a PNG or JPEG.`,
          ),
        );
      }
    }, OUTPUT_TYPE);
  });
}
