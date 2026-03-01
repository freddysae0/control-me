import * as THREE from 'three';

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAVITY        = 14;    // world-units / s²
const DAMPING        = 0.985; // velocity retention factor per verlet step
const SUBSTEPS       = 12;    // physics sub-steps per rendered frame
const FLOOR_Y        = 0.0;   // world Y — matches the visual ground plane in scene.js
const PICK_RADIUS    = 0.30;  // max world-space ray-distance to select a joint

// ── Drag-stability limits ──────────────────────────────────────────────────────
// These three clamps stop the simulation from "going to narnia" when the mouse
// moves fast or the ray-plane intersection returns an extreme value.

// Max distance the grabbed particle may travel in a single rendered frame.
// Anything beyond this is clamped toward the previous position along the same
// direction — keeps constraints convergent even on fast mouse sweeps.
const MAX_DRAG_STEP  = 0.14; // world units / frame

// Max Verlet velocity per sub-step.  Normal gravity-only motion stays well
// under 0.02 u/sub-step; capping at 0.10 still allows energetic throws while
// blocking the runaway speeds that come from a single bad intersection.
const MAX_SUBSTEP_VEL = 0.10; // world units / sub-step

// Max throw impulse applied when the user releases a bone.
const MAX_THROW_VEL  = 0.07; // world units / frame (before ×3 multiplier)

// Maximum angle (degrees) at each joint type — prevents body parts from
// tunnelling through each other. Keyed on lowercase substrings of bone names.
const JOINT_ANGLE_LIMITS = {
  spine:     60,   // spinal segments
  neck:      72,   // neck — main guard against head-through-torso
  head:      60,   // sub-head bones (jaw etc.)
  shoulder:  80,   // shoulder blade pivot from spine
  upleg:    155,   // hip joint (thigh from pelvis)
  leg:      150,   // knee
  foot:     100,   // ankle
  toebase:   80,   // toes
  arm:      140,   // upper arm pivot at shoulder
  forearm:  155,   // elbow
  hand:      90,   // wrist
};
const DEFAULT_ANGLE_LIMIT = 110; // degrees — fallback for unrecognised bones

// ── Particle ──────────────────────────────────────────────────────────────────

class Particle {
  /**
   * sleeping = true  → frozen until the user first touches the avatar
   * pinned   = true  → position driven by mouse (exempt from gravity)
   */
  constructor(pos) {
    this.pos      = pos.clone();
    this.prev     = pos.clone();
    this.sleeping = true;
    this.pinned   = false;
  }
}

// ── Distance constraint ───────────────────────────────────────────────────────

class DistConstraint {
  constructor(a, b) {
    this.a    = a;
    this.b    = b;
    this.rest = a.pos.distanceTo(b.pos);
  }
}

// ── Angular constraint ────────────────────────────────────────────────────────
// Limits the angle at pivot B between the incoming segment (A→B) and the
// outgoing segment (B→C), preventing extreme bends that cause interpenetration.

class AngularConstraint {
  constructor(a, b, c, maxDeg) {
    this.a   = a;
    this.b   = b;
    this.c   = c;
    this.cos = Math.cos(maxDeg * Math.PI / 180);
    this.sin = Math.sin(maxDeg * Math.PI / 180);
  }
}

// ── Ragdoll ───────────────────────────────────────────────────────────────────

export class Ragdoll {
  /**
   * @param {THREE.Object3D} avatarRoot  Top-level avatar scene node
   * @param {THREE.Bone}     hipsBone    Root bone of the skeleton (Hips)
   * @param {THREE.Camera}   camera
   * @param {HTMLElement}    domElement  Canvas element for pointer events
   */
  constructor(avatarRoot, hipsBone, camera, domElement) {
    this._root   = avatarRoot;
    this._hips   = hipsBone;
    this._camera = camera;
    this._dom    = domElement;

    /** @type {Map<THREE.Bone, Particle>} */
    this._particleOf      = new Map();
    /** @type {Particle[]} */
    this._particles       = [];
    /** @type {DistConstraint[]} */
    this._distConstraints = [];
    /** @type {AngularConstraint[]} */
    this._angConstraints  = [];

    // Per-bone rest data captured once from the T-pose (world space)
    /** @type {Map<THREE.Bone, THREE.Vector3>}    bone → normalised dir toward first bone child */
    this._restWorldDir = new Map();
    /** @type {Map<THREE.Bone, THREE.Quaternion>} bone → world quaternion */
    this._restWorldQ   = new Map();

    // Mouse / touch drag state
    this._grabbed        = null;
    this._mouseVel       = new THREE.Vector3();
    this._lastMouseWorld = new THREE.Vector3();
    this._raycaster      = new THREE.Raycaster();
    this._ndcMouse       = new THREE.Vector2();

    // Scratch — reused every frame; safe in recursive _applyBoneRec because
    // all reads of each scratch finish before the recursive calls at the bottom.
    this._sv  = new THREE.Vector3();
    this._sd  = new THREE.Vector3();
    this._sqa = new THREE.Quaternion();
    this._sqb = new THREE.Quaternion();

    this._build();
    this._bindEvents();
  }

  // ── Build ─────────────────────────────────────────────────────────────────────

  _build() {
    this._root.updateWorldMatrix(true, true);
    this._traverseBone(this._hips, null);
    this._buildAngularConstraints();
    console.log(
      `[Ragdoll] ${this._particles.length} particles, ` +
      `${this._distConstraints.length} dist-constraints, ` +
      `${this._angConstraints.length} angle-constraints`,
    );
  }

  _traverseBone(bone, parentParticle) {
    const worldPos = new THREE.Vector3();
    bone.getWorldPosition(worldPos);

    const p = new Particle(worldPos);   // starts sleeping
    this._particles.push(p);
    this._particleOf.set(bone, p);

    // Rest world quaternion (for IK back-solve)
    const wq = new THREE.Quaternion();
    bone.getWorldQuaternion(wq);
    this._restWorldQ.set(bone, wq.clone());

    // Normalised direction toward first bone child
    const firstBoneChild = bone.children.find(c => c.isBone);
    if (firstBoneChild) {
      const childPos = new THREE.Vector3();
      firstBoneChild.getWorldPosition(childPos);
      const dir = childPos.sub(worldPos);
      if (dir.lengthSq() > 1e-10) {
        this._restWorldDir.set(bone, dir.normalize());
      }
    }

    // Distance constraint to parent
    if (parentParticle) {
      this._distConstraints.push(new DistConstraint(parentParticle, p));
    }

    for (const child of bone.children) {
      if (child.isBone) this._traverseBone(child, p);
    }
  }

  /** Build one angular constraint for every parent→pivot→child bone triple. */
  _buildAngularConstraints() {
    this._particleOf.forEach((bPart, bBone) => {
      // Need a bone grandparent (A) for the incoming direction reference
      if (!bBone.parent?.isBone) return;
      const aPart = this._particleOf.get(bBone.parent);
      if (!aPart) return;

      // One constraint per child bone of B
      for (const cBone of bBone.children) {
        if (!cBone.isBone) continue;
        const cPart = this._particleOf.get(cBone);
        if (!cPart) continue;
        const maxDeg = this._jointAngleLimit(bBone.name);
        this._angConstraints.push(new AngularConstraint(aPart, bPart, cPart, maxDeg));
      }
    });
  }

  _jointAngleLimit(boneName) {
    const n = boneName.toLowerCase();
    for (const [key, deg] of Object.entries(JOINT_ANGLE_LIMITS)) {
      if (n.includes(key)) return deg;
    }
    return DEFAULT_ANGLE_LIMIT;
  }

  // ── Physics step ──────────────────────────────────────────────────────────────

  step(dt) {
    const clampedDt = Math.min(dt, 0.05);
    const subDt     = clampedDt / SUBSTEPS;

    for (let i = 0; i < SUBSTEPS; i++) {
      this._integrate(subDt);
      this._solveDistConstraints();
      this._solveAngConstraints();
      this._solveFloor();
    }

    this._applyToBones();
  }

  _integrate(subDt) {
    const g      = GRAVITY * subDt * subDt;
    const maxVSq = MAX_SUBSTEP_VEL * MAX_SUBSTEP_VEL;
    for (const p of this._particles) {
      if (p.pinned || p.sleeping) continue;
      // Verlet: velocity = (pos − prev) * damping, then advance
      this._sd.subVectors(p.pos, p.prev).multiplyScalar(DAMPING);
      // Hard cap on speed — prevents constraint divergence from runaway particles
      if (this._sd.lengthSq() > maxVSq) this._sd.setLength(MAX_SUBSTEP_VEL);
      p.prev.copy(p.pos);
      p.pos.add(this._sd);
      p.pos.y -= g;
    }
  }

  _solveDistConstraints() {
    for (const c of this._distConstraints) {
      if (c.rest < 1e-6) continue;
      const aFixed = c.a.pinned || c.a.sleeping;
      const bFixed = c.b.pinned || c.b.sleeping;
      if (aFixed && bFixed) continue;

      this._sd.subVectors(c.b.pos, c.a.pos);
      const dist = this._sd.length();
      if (dist < 1e-8) continue;
      this._sd.multiplyScalar(0.5 * (dist - c.rest) / dist);

      if (!aFixed) c.a.pos.add(this._sd);
      if (!bFixed) c.b.pos.sub(this._sd);
    }
  }

  /**
   * Enforce angle limits at every joint to prevent body parts from
   * tunnelling through each other (e.g. head through torso).
   *
   * For each triple (A, B, C): limit the angle at pivot B between the
   * incoming segment (A→B) and the outgoing segment (B→C).
   * Only C is repositioned — allocation-free using scalar math.
   */
  _solveAngConstraints() {
    for (const { a, b, c, cos: cosMax, sin: sinMax } of this._angConstraints) {
      // Skip if C cannot move
      if (c.pinned || c.sleeping) continue;

      // v1 = incoming bone direction (A→B), written into _sd
      this._sd.subVectors(b.pos, a.pos);
      if (this._sd.lengthSq() < 1e-8) continue;
      this._sd.normalize();                   // _sd = v1

      // outgoing segment B→C, written into _sv (unnormalised to preserve length)
      this._sv.subVectors(c.pos, b.pos);
      const len = this._sv.length();
      if (len < 1e-8) continue;
      this._sv.multiplyScalar(1 / len);       // _sv = v2_norm

      const dot = this._sd.dot(this._sv);     // cos of current angle
      if (dot >= cosMax) continue;            // within limit — nothing to do

      // Perpendicular component of v2 relative to v1: perp = v2 - dot(v2,v1)*v1
      const px = this._sv.x - dot * this._sd.x;
      const py = this._sv.y - dot * this._sd.y;
      const pz = this._sv.z - dot * this._sd.z;
      const perpLen = Math.sqrt(px * px + py * py + pz * pz);

      let tx, ty, tz;
      if (perpLen > 1e-6) {
        // Project v2 onto the boundary of the allowed cone
        const inv = sinMax / perpLen;
        tx = cosMax * this._sd.x + inv * px;
        ty = cosMax * this._sd.y + inv * py;
        tz = cosMax * this._sd.z + inv * pz;
      } else {
        // v2 nearly anti-parallel to v1 — pick an arbitrary perpendicular
        let ax = 0, ay = 1, az = 0;
        if (Math.abs(this._sd.y) > 0.9) { ax = 1; ay = 0; }
        const d  = ax * this._sd.x + ay * this._sd.y + az * this._sd.z;
        ax -= d * this._sd.x; ay -= d * this._sd.y; az -= d * this._sd.z;
        const al = Math.sqrt(ax * ax + ay * ay + az * az);
        tx = cosMax * this._sd.x + sinMax * (ax / al);
        ty = cosMax * this._sd.y + sinMax * (ay / al);
        tz = cosMax * this._sd.z + sinMax * (az / al);
      }

      // Reposition C along the boundary direction at the same distance from B
      c.pos.set(b.pos.x + tx * len, b.pos.y + ty * len, b.pos.z + tz * len);
    }
  }

  _solveFloor() {
    for (const p of this._particles) {
      if (p.sleeping) continue;
      if (p.pos.y < FLOOR_Y) {
        const vy = p.pos.y - p.prev.y;
        p.pos.y  = FLOOR_Y;
        p.prev.y = FLOOR_Y - vy * 0.08; // tiny energy-absorbing bounce
      }
    }
  }

  // ── Apply physics → skeleton ──────────────────────────────────────────────────

  _applyToBones() {
    // 1. Translate avatar root so the hips particle is at its physics position
    const hipsPart = this._particleOf.get(this._hips);
    if (hipsPart && !hipsPart.sleeping) {
      this._hips.getWorldPosition(this._sv);
      this._sd.subVectors(hipsPart.pos, this._sv);
      this._root.position.add(this._sd);
      this._root.updateWorldMatrix(true, true);
    }

    // 2. Set bone rotations top-down so every bone points toward its child particle
    this._applyBoneRec(this._hips);
  }

  /**
   * Recursively rotate each bone to align with the physics particle positions.
   * Scratch objects (_sd, _sqa, _sqb) are reused but are safe because every
   * read of a scratch value completes before the recursive calls at the bottom.
   */
  _applyBoneRec(bone) {
    const childBone = bone.children.find(c => c.isBone && this._particleOf.has(c));

    if (childBone) {
      const pA      = this._particleOf.get(bone);
      const pB      = this._particleOf.get(childBone);
      const restDir = this._restWorldDir.get(bone);
      const restWQ  = this._restWorldQ.get(bone);

      if (pA && pB && restDir && restWQ && !pA.sleeping && !pB.sleeping) {
        this._sd.subVectors(pB.pos, pA.pos);

        if (this._sd.lengthSq() > 1e-8) {
          this._sd.normalize();

          // World-space delta: rotate restDir → target direction
          this._sqa.setFromUnitVectors(restDir, this._sd);

          // New world quaternion: deltaQ * restWorldQ
          this._sqb.multiplyQuaternions(this._sqa, restWQ);

          // Convert to local: inv(parentWorldQ) * newWorldQ
          bone.parent.getWorldQuaternion(this._sqa);
          this._sqa.invert();
          bone.quaternion.multiplyQuaternions(this._sqa, this._sqb);

          // Propagate so children read the correct parent matrix
          bone.updateWorldMatrix(false, false);
        }
      }
    }

    // Recurse — all scratch reads above finish before any of these calls
    for (const child of bone.children) {
      if (child.isBone) this._applyBoneRec(child);
    }
  }

  // ── Mouse / touch interaction ─────────────────────────────────────────────────

  _bindEvents() {
    this._dom.addEventListener('mousedown', this._onDown.bind(this));
    window.addEventListener('mousemove',   this._onMove.bind(this));
    window.addEventListener('mouseup',     this._onUp.bind(this));

    this._dom.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length > 0) this._onDown(e.touches[0]);
    }, { passive: false });
    window.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length > 0) this._onMove(e.touches[0]);
    }, { passive: false });
    window.addEventListener('touchend', () => this._onUp());
  }

  _toNDC(clientX, clientY) {
    this._ndcMouse.set(
      (clientX / window.innerWidth)  *  2 - 1,
      (clientY / window.innerHeight) * -2 + 1,
    );
  }

  _nearestParticle() {
    this._raycaster.setFromCamera(this._ndcMouse, this._camera);
    let best  = null;
    let bestD = PICK_RADIUS;
    for (const p of this._particles) {
      const d = this._raycaster.ray.distanceToPoint(p.pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  _onDown(e) {
    this._toNDC(e.clientX, e.clientY);
    const p = this._nearestParticle();
    if (!p) return;

    // First touch: wake the entire skeleton
    if (this._particles.some(q => q.sleeping)) {
      for (const q of this._particles) {
        q.sleeping = false;
        q.prev.copy(q.pos); // zero velocity at wake-up
      }
    }

    // Use the camera's FORWARD direction as the drag-plane normal.
    // This is always non-parallel to any screen ray, so the intersection
    // can never "fly off to infinity" as the mouse approaches the screen edge.
    const normal = new THREE.Vector3();
    this._camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, p.pos);

    p.pinned = true;
    p.prev.copy(p.pos);
    this._lastMouseWorld.copy(p.pos);
    this._mouseVel.set(0, 0, 0);
    this._grabbed = { particle: p, plane };
    this._dom.style.cursor = 'grabbing';
  }

  _onMove(e) {
    this._toNDC(e.clientX, e.clientY);

    if (!this._grabbed) {
      this._dom.style.cursor = this._nearestParticle() ? 'grab' : 'default';
      return;
    }

    this._raycaster.setFromCamera(this._ndcMouse, this._camera);
    const hit = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(this._grabbed.plane, hit)) return;

    // Safety clamp — discard hits that are unreasonably far from the camera
    // (can happen on degenerate geometries near viewport edges)
    if (hit.distanceTo(this._camera.position) > 12) return;

    // Per-frame travel clamp — prevents fast mouse sweeps from teleporting
    // the grabbed particle beyond what the constraint solver can recover from.
    const delta = hit.clone().sub(this._lastMouseWorld);
    const dist  = delta.length();
    if (dist > MAX_DRAG_STEP) {
      delta.multiplyScalar(MAX_DRAG_STEP / dist);
      hit.copy(this._lastMouseWorld).add(delta);
    }

    // Keep the grabbed point above the floor
    hit.y = Math.max(hit.y, FLOOR_Y + 0.01);

    this._mouseVel.copy(delta);
    this._lastMouseWorld.copy(hit);

    this._grabbed.particle.pos.copy(hit);
    this._grabbed.particle.prev.copy(hit); // zero velocity while held
  }

  _onUp() {
    if (!this._grabbed) return;
    const p = this._grabbed.particle;
    p.pinned = false;
    // Impart throw velocity: set prev so (pos − prev) = mouseVel × factor
    // Cap the throw so a fast release doesn't fling things off-screen.
    const throwVel = this._mouseVel.clone();
    if (throwVel.length() > MAX_THROW_VEL) throwVel.setLength(MAX_THROW_VEL);
    p.prev.subVectors(p.pos, throwVel.multiplyScalar(3));
    this._grabbed = null;
    this._dom.style.cursor = 'default';
  }
}
