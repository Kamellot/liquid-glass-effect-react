import { bevelWidth, CHROMA_SPREAD, profileExponent, profilePeak, profileSpread, STRENGTH_GAIN } from './optics'
import type { SceneHandle } from './scene'

/**
 * Shared WebGL refraction engine.
 *
 *  • ONE offscreen WebGL context for the whole page (iOS caps live contexts at ~8-16).
 *  • ONE shader program; every optical parameter is a uniform, so changing a slider
 *    costs a uniform write, never a bitmap / filter rebuild.
 *  • ONE texture per <GlassScene>, uploaded only when the scene is re-captured.
 *  • Each <LiquidGlass /> owns a plain 2D <canvas>; a frame is "draw into the shared
 *    context, then drawImage() the viewport into the instance canvas" (GPU → GPU).
 *  • The render loop only does work when something changed (params, scene capture,
 *    or the glass moved relative to its scene) and goes to sleep when idle.
 */

export interface GlassGLParams {
  width: number
  height: number
  radius: number
  strength: number
  curvature: number
  depth: number
  splay: number
  chroma: number
  blur: number
}

export interface GlassGLHandle {
  update(p: GlassGLParams): void
  destroy(): void
}

const VERT = `
attribute vec2 a_pos;
uniform vec2 u_size;
varying vec2 v_pos;
void main() {
  v_pos = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5) * u_size;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define TAPS 20
#define EPS 0.0001
#define IOR 1.5

varying vec2 v_pos;            // css px inside the element, y down
uniform vec2  u_size;          // element size, css px
uniform float u_radius;        // corner radius, css px
uniform float u_bevel;         // bevel thickness, css px
uniform float u_n;             // squircle exponent
uniform float u_spread;        // splay spread
uniform float u_peak;          // profile normaliser
uniform float u_disp;          // peak displacement, css px
uniform float u_chroma;        // relative R/B spread
uniform float u_blur;          // frosted blur sigma, css px
uniform float u_dpr;           // device px per css px
uniform sampler2D u_scene;
uniform vec2  u_sceneSize;     // captured scene size, css px
uniform vec2  u_origin;        // element origin inside the scene, css px

float magnitude(float t) {
  float tp   = pow(max(t, EPS), u_spread);
  float inv  = 1.0 - tp;
  float base = max(EPS, 1.0 - pow(inv, u_n));
  float slope = pow(base, 1.0 / u_n - 1.0) * pow(max(inv, EPS), u_n - 1.0);
  float th  = atan(slope);
  float thr = asin(sin(th) / IOR);
  return tan(th - thr);
}

vec3 sceneAt(vec2 sp, float rot) {
  if (u_blur < 0.05) return texture2D(u_scene, sp / u_sceneSize).rgb;
  vec3 acc = vec3(0.0);
  float rad = u_blur * 2.0;               // disc radius ≈ 2σ
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / float(TAPS)) * rad;
    float th = fi * 2.39996323 + rot;      // golden-angle spiral
    acc += texture2D(u_scene, (sp + rr * vec2(cos(th), sin(th))) / u_sceneSize).rgb;
  }
  return acc / float(TAPS);
}

void main() {
  vec2 hs = 0.5 * u_size;
  vec2 p  = v_pos - hs;
  vec2 s  = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
  vec2 q  = abs(p) - (hs - u_radius);

  // Rounded-rect SDF (negative inside) + outward normal.
  vec2 nrm;
  float sdf;
  if (q.x > 0.0 && q.y > 0.0) { float l = length(q); nrm = q / l * s; sdf = l - u_radius; }
  else if (q.x > q.y)         { nrm = vec2(s.x, 0.0); sdf = q.x - u_radius; }
  else                        { nrm = vec2(0.0, s.y); sdf = q.y - u_radius; }
  float d = -sdf;
  float cover = clamp(0.5 + d * u_dpr, 0.0, 1.0);

  vec2 disp = vec2(0.0);
  if (d > 0.0 && d < u_bevel) {
    float t = d / u_bevel;
    float m = clamp(magnitude(t) / u_peak, 0.0, 1.0);
    if (t > 0.85) m *= max(0.0, (1.0 - t) / 0.15);
    disp = -nrm * m * u_disp;             // inward, like the SVG displacement map
  }

  vec2 sp = u_origin + v_pos;
  float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 c;
  if (u_chroma > 0.001) {
    c.r = sceneAt(sp + disp * (1.0 + u_chroma), rot).r;
    c.g = sceneAt(sp + disp, rot).g;
    c.b = sceneAt(sp + disp * (1.0 - u_chroma), rot).b;
  } else {
    c = sceneAt(sp + disp, rot);
  }

  // Same tint as the SVG path: saturate(1.12) brightness(1.04).
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 1.12) * 1.04;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * cover, cover);   // premultiplied
}`

const UNIFORMS = ['u_size', 'u_radius', 'u_bevel', 'u_n', 'u_spread', 'u_peak', 'u_disp', 'u_chroma', 'u_blur', 'u_dpr', 'u_scene', 'u_sceneSize', 'u_origin'] as const
type UniformName = (typeof UNIFORMS)[number]

interface Derived {
  bevel: number
  n: number
  spread: number
  peak: number
  disp: number
  chroma: number
}

class Instance implements GlassGLHandle {
  params: GlassGLParams | null = null
  derived: Derived | null = null
  dirty = true
  visible = true
  readonly ctx: CanvasRenderingContext2D
  private io: IntersectionObserver | null = null
  last = { x: NaN, y: NaN, v: -1, dpr: 0 }

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly scene: SceneHandle,
    private engine: Engine,
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
    if ('IntersectionObserver' in window) {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) this.visible = e.isIntersecting
          if (this.visible) {
            this.dirty = true
            this.engine.wake()
          }
        },
        { rootMargin: '120px' },
      )
      this.io.observe(canvas)
    }
  }

  update(p: GlassGLParams) {
    this.params = p
    const n = profileExponent(p.curvature)
    const spread = profileSpread(p.splay)
    this.derived = {
      bevel: bevelWidth(p.width, p.height, p.depth),
      n,
      spread,
      peak: profilePeak(n, spread),
      disp: p.strength * Math.min(p.width, p.height) * STRENGTH_GAIN,
      chroma: CHROMA_SPREAD * p.chroma,
    }
    this.dirty = true
    this.engine.wake()
  }

  destroy() {
    this.io?.disconnect()
    this.engine.unregister(this)
  }
}

const IDLE_FRAMES = 24
const WAKE_EVENTS = ['pointermove', 'pointerdown', 'pointerup', 'touchmove', 'keydown', 'scroll', 'resize', 'transitionstart', 'transitionrun', 'animationstart'] as const

class Engine {
  private canvas = document.createElement('canvas')
  private gl: WebGLRenderingContext | null = null
  private program: WebGLProgram | null = null
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>
  private textures = new Map<SceneHandle, { tex: WebGLTexture; version: number }>()
  private instances = new Set<Instance>()
  private sceneSubs = new Map<SceneHandle, () => void>()
  private listeners = new Set<() => void>()
  private raf = 0
  private idle = 0
  private tried = false
  private wakeBound = () => this.wake()

  /** Lazily creates the shared context. Returns false when WebGL is unavailable. */
  init(): boolean {
    if (this.gl && !this.gl.isContextLost()) return true
    if (this.tried && !this.gl) return false
    this.tried = true
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    }) as WebGLRenderingContext | null
    if (!gl) return false
    this.gl = gl
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.textures.clear()
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.textures.clear()
      this.program = null
      if (this.build()) this.instances.forEach((i) => (i.dirty = true))
      this.wake()
    })
    return this.build()
  }

  private build(): boolean {
    const gl = this.gl
    if (!gl) return false
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('[liquid-glass] shader error:', gl.getShaderInfoLog(sh))
        return null
      }
      return sh
    }
    const vs = compile(gl.VERTEX_SHADER, VERT)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return false
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.bindAttribLocation(prog, 0, 'a_pos')
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[liquid-glass] link error:', gl.getProgramInfoLog(prog))
      return false
    }
    this.program = prog
    gl.useProgram(prog)
    for (const u of UNIFORMS) this.loc[u] = gl.getUniformLocation(prog, u)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.uniform1i(this.loc.u_scene, 0)
    return true
  }

  register(inst: Instance) {
    this.instances.add(inst)
    if (!this.sceneSubs.has(inst.scene)) {
      this.sceneSubs.set(
        inst.scene,
        inst.scene.onCapture(() => this.wake()),
      )
    }
    if (this.instances.size === 1) WAKE_EVENTS.forEach((e) => window.addEventListener(e, this.wakeBound, { capture: true, passive: true }))
    this.emit()
    this.wake()
  }

  unregister(inst: Instance) {
    this.instances.delete(inst)
    const scene = inst.scene
    if (![...this.instances].some((i) => i.scene === scene)) {
      this.sceneSubs.get(scene)?.()
      this.sceneSubs.delete(scene)
      const t = this.textures.get(scene)
      if (t && this.gl) this.gl.deleteTexture(t.tex)
      this.textures.delete(scene)
    }
    if (!this.instances.size) {
      WAKE_EVENTS.forEach((e) => window.removeEventListener(e, this.wakeBound, { capture: true }))
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    this.emit()
  }

  wake() {
    this.idle = 0
    if (!this.raf && this.instances.size) this.raf = requestAnimationFrame(this.tick)
  }

  stats() {
    return { instances: this.instances.size, scenes: new Set([...this.instances].map((i) => i.scene)).size }
  }
  subscribe(cb: () => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }
  private emit() {
    this.listeners.forEach((l) => l())
  }

  private textureFor(scene: SceneHandle) {
    const gl = this.gl!
    let entry = this.textures.get(scene)
    if (!entry) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      // NPOT-safe: clamp + linear, no mipmaps.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      entry = { tex, version: -1 }
      this.textures.set(scene, entry)
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, entry.tex)
    if (entry.version !== scene.version) {
      entry.version = scene.version
      try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene.canvas)
      } catch (e) {
        console.warn('[liquid-glass] scene upload failed (tainted canvas?)', e)
      }
    }
  }

  private ensureSize(w: number, h: number) {
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w)
      this.canvas.height = Math.max(this.canvas.height, h)
    }
  }

  private tick = () => {
    this.raf = 0
    const gl = this.gl
    if (!gl || gl.isContextLost() || !this.program || !this.instances.size) return
    if (document.hidden) return // woken again by the next pointer/scroll/resize event

    const dpr = window.devicePixelRatio || 1

    // ── read phase (no writes → one layout) ────────────────────────────────────
    const sceneRects = new Map<SceneHandle, DOMRect>()
    const work: { inst: Instance; x: number; y: number }[] = []
    for (const inst of this.instances) {
      const sc = inst.scene
      if (!inst.visible || !inst.params || !sc.el || !sc.version) continue
      let sr = sceneRects.get(sc)
      if (!sr) sceneRects.set(sc, (sr = sc.el.getBoundingClientRect()))
      const r = inst.canvas.getBoundingClientRect()
      work.push({ inst, x: r.left - sr.left, y: r.top - sr.top })
    }

    // ── write phase ────────────────────────────────────────────────────────────
    let drew = false
    for (const { inst, x, y } of work) {
      const p = inst.params!
      const W = Math.max(1, Math.round(p.width * dpr))
      const H = Math.max(1, Math.round(p.height * dpr))
      if (inst.canvas.width !== W || inst.canvas.height !== H) {
        inst.canvas.width = W
        inst.canvas.height = H
        inst.dirty = true
      }
      const l = inst.last
      const moved = Math.abs(x - l.x) > 0.01 || Math.abs(y - l.y) > 0.01 || l.v !== inst.scene.version || l.dpr !== dpr
      if (!inst.dirty && !moved) continue
      inst.dirty = false
      l.x = x
      l.y = y
      l.v = inst.scene.version
      l.dpr = dpr
      this.draw(inst, x, y, W, H)
      drew = true
    }

    this.idle = drew ? 0 : this.idle + 1
    if (this.idle < IDLE_FRAMES) this.raf = requestAnimationFrame(this.tick)
  }

  private draw(inst: Instance, ox: number, oy: number, W: number, H: number) {
    const gl = this.gl!
    const p = inst.params!
    const d = inst.derived!
    const sc = inst.scene
    this.ensureSize(W, H)
    this.textureFor(sc)
    gl.viewport(0, this.canvas.height - H, W, H) // top-left aligned → blit from (0,0)
    const u = this.loc
    gl.uniform2f(u.u_size, p.width, p.height)
    gl.uniform1f(u.u_radius, Math.min(p.radius, Math.min(p.width, p.height) / 2))
    gl.uniform1f(u.u_bevel, d.bevel)
    gl.uniform1f(u.u_n, d.n)
    gl.uniform1f(u.u_spread, d.spread)
    gl.uniform1f(u.u_peak, d.peak)
    gl.uniform1f(u.u_disp, d.disp)
    gl.uniform1f(u.u_chroma, d.chroma)
    gl.uniform1f(u.u_blur, p.blur)
    gl.uniform1f(u.u_dpr, W / p.width)
    gl.uniform2f(u.u_sceneSize, sc.cssWidth, sc.cssHeight)
    gl.uniform2f(u.u_origin, ox, oy)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    inst.ctx.clearRect(0, 0, W, H)
    inst.ctx.drawImage(this.canvas, 0, 0, W, H, 0, 0, W, H)
  }

  create(canvas: HTMLCanvasElement, scene: SceneHandle): GlassGLHandle {
    const inst = new Instance(canvas, scene, this)
    this.register(inst)
    return inst
  }
}

let engine: Engine | null = null
const get = () => (engine ??= new Engine())

export function isWebGLAvailable(): boolean {
  if (typeof document === 'undefined') return false
  return get().init()
}

export function createGlassGL(canvas: HTMLCanvasElement, scene: SceneHandle): GlassGLHandle {
  return get().create(canvas, scene)
}

export const getGLStats = () => get().stats()
export const subscribeGLStats = (cb: () => void) => get().subscribe(cb)

