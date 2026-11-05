// Replaces buzz-app's WebP encoder in the bundle (scripts/build-plugin.mjs, SWAPS).
// Buzz encodes in a web worker, a file beside its module, and an installed plugin
// is one module with no other file. The `picture` input of the Buzz agent tools is
// the only caller here, and only for a static WebP that needs its pixels changed.

/** What the agent reads when its picture needs the app's encoder. */
const NO_ENCODER =
  "This agent cannot convert this WebP picture. Use a PNG or JPEG.";

/** Fails the upload with a reason the agent can act on: buzz-app's signature. */
export function encodeWebp(
  _pixels: ImageData,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  return Promise.reject(new Error(NO_ENCODER));
}
