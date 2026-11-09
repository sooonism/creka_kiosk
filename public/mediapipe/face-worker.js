// Face detection off the main thread. Classic worker (not module): MediaPipe loads its wasm loader with importScripts,
// and the ESM bundle falls back to a <script> tag that doesn't exist in a worker.
var exports = {}; // vision_bundle.cjs is CommonJS and writes its API onto `exports`
importScripts("/mediapipe/vision_bundle.cjs");

let detector = null;
const ready = (async () => {
  const vision = await exports.FilesetResolver.forVisionTasks("/mediapipe/");
  // ponytail: CPU only; at ~1 frame/s it is plenty and avoids an OffscreenCanvas GL context on the Pi
  detector = await exports.FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "/mediapipe/blaze_face_short_range.tflite", delegate: "CPU" },
    runningMode: "IMAGE",
    minDetectionConfidence: 0.5,
  });
})();

ready.then(
  () => postMessage({ type: "ready" }),
  (e) => postMessage({ type: "error", message: String(e?.message ?? e) })
);

onmessage = async ({ data: { bmp } }) => {
  try {
    await ready;
    const { detections } = detector.detect(bmp);
    postMessage({ type: "result", w: bmp.width, detections });
  } catch (e) {
    postMessage({ type: "error", message: String(e?.message ?? e) });
  } finally {
    bmp.close();
  }
};
