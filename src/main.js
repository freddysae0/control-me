import { createScene } from './scene.js';
import { Avatar } from './avatar.js';
import { FaceTracker } from './faceTracker.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const overlayEl = document.getElementById('ui-overlay');
const statusEl = document.getElementById('overlay-status');
const hintEl = document.getElementById('overlay-hint');
const fillEl = document.getElementById('loading-fill');

function setStatus(msg, progress = null) {
  statusEl.textContent = msg;
  if (progress !== null) {
    fillEl.style.width = `${Math.round(progress * 100)}%`;
  }
}

function fadeOutOverlay() {
  overlayEl.classList.add('fade-out');
  overlayEl.addEventListener('transitionend', () => {
    overlayEl.style.display = 'none';
  }, { once: true });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // 1. Scene
  setStatus('Building scene…', 0.1);
  const { renderer, scene, camera, composer } = createScene(canvas);

  // 2. Avatar
  setStatus('Loading avatar…', 0.25);
  const avatar = new Avatar();
  try {
    await avatar.load(scene);
    setStatus('Avatar loaded.', 0.5);
  } catch (err) {
    console.error('[Main] Avatar load failed:', err);
    setStatus('⚠ Avatar not found. Place avatar.glb in public/');
    // Continue — we'll still show the scene without an avatar
  }

  // 3. MediaPipe
  const tracker = new FaceTracker();
  try {
    await tracker.init((msg) => setStatus(msg, 0.7));
    setStatus('Requesting camera…', 0.85);
  } catch (err) {
    console.error('[Main] FaceTracker init failed:', err);
    setStatus('⚠ MediaPipe failed to load.');
  }

  // 4. Webcam
  let inputVideo = null;
  if (tracker.isReady) {
    try {
      hintEl.style.display = 'block';
      inputVideo = await tracker.startWebcam();
      hintEl.style.display = 'none';
      setStatus('Tracking…', 1.0);
      setTimeout(fadeOutOverlay, 800);
    } catch (err) {
      console.error('[Main] Webcam access denied:', err);
      setStatus('⚠ Camera access denied. Enable camera and reload.');
    }
  }

  // 5. Animation loop
  renderer.setAnimationLoop(() => {
    if (inputVideo && tracker.isReady) {
      const { blendshapes, matrix, poseWorldLandmarks } = tracker.detect(inputVideo);
      avatar.applyBlendShapes(blendshapes);
      avatar.rotateHead(matrix);
      avatar.applyPose(poseWorldLandmarks);
    }

    // Only use composer.render(), never renderer.render()
    composer.render();
  });
}

init().catch((err) => {
  console.error('[Main] Fatal init error:', err);
  setStatus('⚠ Unexpected error — check console.');
});
