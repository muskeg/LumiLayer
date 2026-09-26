import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { addBody, MeshBuilder } from './mesh';
import { colorSlabThickness, type LithoResult } from './lithophane';

const MAX_GRID = 320;

export class Preview3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
  private faceMat = new THREE.MeshBasicMaterial();
  private simTex: THREE.CanvasTexture | null = null;
  private frontTex: THREE.CanvasTexture | null = null;
  private backlit = true;
  private framedSize = '';

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#15171c');
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#303040', 1.2));
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(-1, 1.5, -2);
    this.scene.add(key);
    const back = new THREE.DirectionalLight('#ffffff', 0.8);
    back.position.set(1, 1, 2);
    this.scene.add(back);
    this.scene.add(this.group);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    new ResizeObserver(() => this.resize()).observe(container);
  }

  setBacklit(on: boolean) {
    this.backlit = on;
    this.applyFaceTexture();
    this.render();
  }

  update(r: LithoResult, sim: HTMLCanvasElement, front: HTMLCanvasElement) {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    const w = r.cols * r.pixelMm;
    const h = r.rows * r.pixelMm;
    const slab = colorSlabThickness(r);

    const b = new MeshBuilder();
    // The textured face replaces the body's bottom; keeping both causes z-fighting.
    addBody(b, r, {
      zBottom: 0,
      zTop: slab,
      step: Math.max(1, Math.ceil(Math.max(r.cols, r.rows) / MAX_GRID)),
      emitBottom: () => false,
    });
    const m = b.finish();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geo.computeVertexNormals();
    this.bodyMat.color.set(r.filaments[0].color);
    this.group.add(new THREE.Mesh(geo, this.bodyMat));

    // Textured viewing face; the plane is rotated to face -Z (the bed side).
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.faceMat);
    plane.rotation.y = Math.PI;
    plane.position.set(w / 2, h / 2, 0);
    this.group.add(plane);

    this.simTex?.dispose();
    this.frontTex?.dispose();
    this.simTex = new THREE.CanvasTexture(sim);
    this.frontTex = new THREE.CanvasTexture(front);
    for (const t of [this.simTex, this.frontTex]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
    }
    this.applyFaceTexture();

    const size = `${w.toFixed(1)}x${h.toFixed(1)}`;
    if (size !== this.framedSize) {
      this.framedSize = size;
      this.controls.target.set(w / 2, h / 2, 1);
      const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const dist = 1.2 * Math.max(h / 2 / tan, w / 2 / (tan * this.camera.aspect));
      this.camera.position.set(w / 2, h / 2, -dist);
      this.camera.near = dist / 50;
      this.camera.far = dist * 20;
      this.camera.updateProjectionMatrix();
      this.controls.minDistance = dist / 10;
      this.controls.maxDistance = dist * 5;
      this.camera.up.set(0, 1, 0);
      this.controls.update();
    }
    this.render();
  }

  private applyFaceTexture() {
    this.faceMat.map = this.backlit ? this.simTex : this.frontTex;
    this.faceMat.needsUpdate = true;
    this.scene.background = new THREE.Color(this.backlit ? '#0b0c0f' : '#20232a');
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
