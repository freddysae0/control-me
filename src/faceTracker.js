import { FaceLandmarker, PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm';

const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export class FaceTracker {
  constructor() {
    this._landmarker     = null;
    this._poseLandmarker = null;
    this._lastVideoTime  = -1;
    this._stream         = null;
  }

  async init(onStatus) {
    onStatus?.('Loading MediaPipe WASM…');
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    onStatus?.('Loading face model…');
    this._landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

    onStatus?.('Loading pose model…');
    this._poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      outputSegmentationMasks: false,
    });

    console.log('[FaceTracker] FaceLandmarker + PoseLandmarker ready.');
    return this;
  }

  async startWebcam() {
    const constraints = {
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    };

    this._stream = await navigator.mediaDevices.getUserMedia(constraints);

    const inputVideo = document.getElementById('input-video');
    const pipVideo   = document.getElementById('pip-video');

    inputVideo.srcObject = this._stream;
    pipVideo.srcObject   = this._stream;

    await new Promise((resolve) => {
      inputVideo.addEventListener('loadeddata', resolve, { once: true });
    });

    console.log('[FaceTracker] Webcam started.');
    return inputVideo;
  }

  /**
   * Run face + pose detection on a single video frame.
   * @param {HTMLVideoElement} video
   * @returns {{ blendshapes, matrix, poseWorldLandmarks }}
   */
  detect(video) {
    const empty = { blendshapes: null, matrix: null, poseWorldLandmarks: null };
    if (!this._landmarker) return empty;
    if (video.currentTime === this._lastVideoTime) return empty;
    this._lastVideoTime = video.currentTime;

    const nowMs = performance.now();

    const faceResult = this._landmarker.detectForVideo(video, nowMs);
    const blendshapes = faceResult.faceBlendshapes?.[0]?.categories ?? null;
    const matrix      = faceResult.facialTransformationMatrixes?.[0]?.data ?? null;

    const poseResult        = this._poseLandmarker.detectForVideo(video, nowMs);
    const poseWorldLandmarks = poseResult.worldLandmarks?.[0] ?? null;

    return { blendshapes, matrix, poseWorldLandmarks };
  }

  get isReady() {
    return this._landmarker !== null;
  }
}
