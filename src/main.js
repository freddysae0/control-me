import { createScene } from './scene.js';
import { Avatar }      from './avatar.js';
import { Ragdoll }     from './ragdoll.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const canvas    = document.getElementById('canvas');
const overlayEl = document.getElementById('ui-overlay');
const statusEl  = document.getElementById('overlay-status');
const fillEl    = document.getElementById('loading-fill');

function setStatus(msg, progress = null) {
  statusEl.textContent = msg;
  if (progress !== null) fillEl.style.width = `${Math.round(progress * 100)}%`;
}

function fadeOutOverlay() {
  overlayEl.classList.add('fade-out');
  overlayEl.addEventListener('transitionend', () => {
    overlayEl.style.display = 'none';
  }, { once: true });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setStatus('Building scene…', 0.15);
  const { renderer, scene, camera, composer } = createScene(canvas);

  setStatus('Loading avatar…', 0.4);
  const avatar = new Avatar();
  let ragdoll  = null;

  try {
    await avatar.load(scene);
    setStatus('Building physics…', 0.85);

    if (avatar.hipsBone) {
      ragdoll = new Ragdoll(avatar.rootObject, avatar.hipsBone, camera, canvas);
    } else {
      console.warn('[Main] No hips bone — ragdoll disabled.');
    }

    setStatus('Drag any bone!', 1.0);
    setTimeout(fadeOutOverlay, 1200);
  } catch (err) {
    console.error('[Main] Avatar load failed:', err);
    setStatus('⚠ Avatar not found — place avatar.glb in public/');
  }

  // ── Animation loop ──────────────────────────────────────────────────────────
  let prevTime = performance.now();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt  = (now - prevTime) / 1000;  // seconds
    prevTime  = now;

    if (ragdoll) ragdoll.step(dt);

    composer.render();
  });
}

init().catch((err) => {
  console.error('[Main] Fatal init error:', err);
  setStatus('⚠ Unexpected error — check console.');
});
