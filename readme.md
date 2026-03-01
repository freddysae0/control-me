# face-avatar

Real-time face-tracking 3D avatar demo. Your webcam drives a GLB character — head rotation, facial expressions, and arm movement all update live in the browser.

## How it works

- **MediaPipe** (`@mediapipe/tasks-vision`) runs `FaceLandmarker` + `PoseLandmarker` on each video frame
- Face blendshapes (52 ARKit-compatible targets) drive morph targets on the avatar mesh
- The facial transformation matrix drives the head bone with coordinate-space conversion from MediaPipe → Three.js
- Pose world landmarks drive the upper-arm and forearm bones via rest-pose-relative quaternion math
- **Three.js** renders the scene with ACES filmic tone mapping, PCF soft shadows, and Unreal Bloom post-processing
- A mirrored picture-in-picture webcam preview sits in the corner

## Stack

| | |
|---|---|
| Renderer | Three.js r172 |
| Face / pose tracking | MediaPipe Tasks Vision 0.10 |
| Build | Vite 6 |
| Avatar format | GLB (GLTF 2.0) |

## Getting started

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` and allow camera access.

### Avatar model

Place your own `avatar.glb` in `public/`. The model is auto-scaled to ~1.6 m and expects:

- ARKit-compatible morph targets on face meshes (e.g. from Ready Player Me or similar)
- A bone named `Head` for head rotation
- Standard Mixamo arm bone names (`LeftArm`, `LeftForeArm`, `LeftHand`, `RightArm`, `RightForeArm`, `RightHand`) for arm tracking
- Optionally a `jaw` / `jaw_joint` bone for bone-driven jaw movement

The app will run without a model — it'll just show an empty scene.

## Project structure

```
src/
  main.js          — init, loading sequence, animation loop
  scene.js         — Three.js renderer, camera, lights, post-processing
  avatar.js        — GLB loading, blendshape/bone driving
  faceTracker.js   — MediaPipe FaceLandmarker + PoseLandmarker wrapper
  style.css        — fullscreen canvas, overlay, PiP video
public/
  avatar.glb       — your character model (not included)
```

## Build

```bash
npm run build    # outputs to dist/
npm run preview  # serve the built dist locally
```

> **Note:** The Vite config sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers, which are required for MediaPipe's WASM threading to work.
