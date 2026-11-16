import type { RefObject } from 'react'
import type {
  AcquiredBevel,
  BevelField,
  BevelSpec,
  DisplacementMapSpec,
  EngineStats,
  TargetSnapshot,
} from './types'

export const DEFAULT_LENS_SIZE = 166
export const MIN_MAGNIFICATION = 0.25
export const MAX_MAGNIFICATION = 4
export const DEFAULT_GLASS_CONFIG = {
  refraction: 70,
  depth: 30,
  dispersion: 20,
  frost: 6,
  splay: 20,
  magnification: 1,
  lightMode: 'natural' as const,
  lightAngle: 0,
  lightIntensity: 40,
  glow: 28,
}
export const DEFAULTS = DEFAULT_GLASS_CONFIG
export const OPTICAL_MATERIAL_DEFAULTS = {
  fill: '#101010',
  fillOverlay: 'rgb(255 255 255 / 0.04)',
  shadow:
    '-1.25px 0 0 -0.75px #d0d0d0, 1.25px 0 0 -0.75px #d0d0d0, 0 -1.25px 0 -0.75px rgb(255 255 255 / 0.35), 0 1.25px 0 -0.75px rgb(0 0 0 / 0.35)',
} as const
export const MAX_BITMAP_CACHE = 40
export const MAX_ASSET_CACHE = 40
export const REDUCED_MOTION_DISPLACEMENT_SCALE = 0.25

const PYRAMID_LEVELS = 5
const IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const EMPTY_U32 = new Uint32Array(0)
const EMPTY_U16 = new Uint16Array(0)
const EMPTY_F32 = new Float32Array(0)
const EMPTY_U8 = new Uint8Array(0)
const EMPTY_U8C = new Uint8ClampedArray(0)

// ── Shared math, color & box utils ───────────────────────────────────────────

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v)
export const clamp01 = (v: number): number => clamp(v, 0, 1)
export const degToRad = (deg: number): number => (deg * Math.PI) / 180
export const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()

export function parseCssColorRgba(color: string): [number, number, number, number] | null {
  const s = color?.trim()
  if (!s) return null
  if (s.toLowerCase() === 'transparent') return [0, 0, 0, 0]
  const m = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (!m) return null
  const [rgb, aStr] = m[1].split('/')
  const p = rgb.trim().split(/[\s,]+/)
  if (p.length < 3) return null
  const ch = (raw: string, div: number) => {
    const t = raw.trim()
    const n = parseFloat(t)
    return Number.isFinite(n) ? clamp01(t.endsWith('%') ? n / 100 : n / div) : Number.NaN
  }
  const r = ch(p[0], 255)
  const g = ch(p[1], 255)
  const b = ch(p[2], 255)
  const aRaw = aStr ?? p[3]
  const a = aRaw !== undefined ? ch(aRaw, 1) : 1
  return Number.isFinite(r + g + b + a) ? [r, g, b, a] : null
}

export function isTransparentColor(color: string): boolean {
  if (!color || color === 'transparent') return true
  const parsed = parseCssColorRgba(color)
  return parsed !== null && parsed[3] <= 0.001
}

function parseLengthPx(raw: string, refSize: number): number {
  const tok = raw.trim().split(/\s+/)[0]
  const val = tok ? parseFloat(tok) : NaN
  return Number.isFinite(val) ? (tok.endsWith('%') ? (val / 100) * refSize : val) : 0
}

function parseCornerRadii(
  cs: CSSStyleDeclaration,
  w: number,
  h: number,
  pctRef = w,
): [number, number, number, number] {
  const maxR = Math.min(w, h) * 0.5
  return [
    clamp(parseLengthPx(cs.borderTopLeftRadius, pctRef), 0, maxR),
    clamp(parseLengthPx(cs.borderTopRightRadius, pctRef), 0, maxR),
    clamp(parseLengthPx(cs.borderBottomRightRadius, pctRef), 0, maxR),
    clamp(parseLengthPx(cs.borderBottomLeftRadius, pctRef), 0, maxR),
  ]
}

export function measureElementBox(el: HTMLElement, explicitRadius?: number | string) {
  const width = Math.max(0, Math.round(el.offsetWidth || el.getBoundingClientRect().width))
  const height = Math.max(0, Math.round(el.offsetHeight || el.getBoundingClientRect().height))
  if (!width || !height) return { width: 0, height: 0, borderRadius: 0 }
  const minDim = Math.min(width, height)
  if (typeof explicitRadius === 'number' && Number.isFinite(explicitRadius)) {
    return { width, height, borderRadius: clamp(explicitRadius, 0, minDim * 0.5) }
  }
  return { width, height, borderRadius: Math.max(...parseCornerRadii(getComputedStyle(el), width, height, minDim)) }
}

export const resolveTarget = (t: RefObject<HTMLElement | null> | HTMLElement | null | undefined): HTMLElement | null =>
  !t ? null : 'current' in t ? t.current : t

// ── WebGL SDF refraction & 5-level bicubic frost pyramid ────────────────────

type BlurLevel = { tex: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number }
type CachedSnapTex = {
  tex: WebGLTexture
  version: number
  width: number
  height: number
  blurLevels: BlurLevel[] | null
  blurVersion: number
}
type GlState = {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  program: WebGLProgram
  dsProgram: WebGLProgram
  u: (WebGLUniformLocation | null)[] // [p0,p1,p2,p3,p4,ti,sa,im,bs]
  dsTexel: WebGLUniformLocation | null
  blurSizesBuf: Float32Array
  textures: WeakMap<HTMLCanvasElement, CachedSnapTex>
  lost: boolean
}

// Single shared vertex shader flips V via uniform `y` (-0.5 for main pass, +0.5 for FBO pyramid).
const V_SRC =
  'attribute vec2 a;varying vec2 v;uniform float y;void main(){v=vec2(a.x*.5+.5,.5+a.y*y);gl_Position=vec4(a,0.,1.);}'

// 13-tap dual-filter downsample kernel prevents mip-level ringing.
const DS_F_SRC =
  'precision highp float;varying vec2 v;uniform sampler2D s;uniform vec2 t;' +
  'vec4 T(float x,float y){return texture2D(s,v+vec2(x,y)*t);}' +
  'void main(){gl_FragColor=T(0.,0.)*.125+(T(0.,-2.)+T(-2.,0.)+T(2.,0.)+T(0.,2.))*.0625+(T(-2.,-2.)+T(2.,-2.)+T(-2.,2.)+T(2.,2.))*.03125+(T(-1.,-1.)+T(1.,-1.)+T(-1.,1.)+T(1.,1.))*.125;}'

// Packed uniforms: p0=(w,h,hw,hh) p1=(bx,by,r,ed) p2=(splayExp,cornerExp,disp,spread) p3=(ox,oy,sw,sh) p4=(tx,ty,dpr,frostPx).
const F_SRC =
  'precision highp float;varying vec2 v;' +
  'uniform sampler2D s,b1,b2,b3,b4,b5;uniform vec2 bs[5];uniform vec4 p0,p1,p2,p3,p4,ti;uniform float sa,im;' +
  'vec4 B(sampler2D t,vec2 u,vec2 z){vec2 i=1./z,c=u*z-.5,f=fract(c),f1=1.-f,f2=f*f;c-=f;' +
  'vec2 w0=f1*f1*f1/6.,w1=(4.-6.*f2+3.*f2*f)/6.,w3=f2*f/6.,g0=w0+w1,g1=1.-g0,lo=.5*i,hi=1.-lo,' +
  'h0=clamp((c-.5+w1/g0)*i,lo,hi),h1=clamp((c+1.5+w3/g1)*i,lo,hi);' +
  'return mix(mix(texture2D(t,h1),texture2D(t,vec2(h0.x,h1.y)),g0.x),mix(texture2D(t,vec2(h1.x,h0.y)),texture2D(t,h0),g0.x),g0.y);}' +
  'vec4 L(int i,vec2 u){if(i<=0)return texture2D(s,clamp(u,p4.xy,1.-p4.xy));if(i==1)return B(b1,u,bs[0]);' +
  'if(i==2)return B(b2,u,bs[1]);if(i==3)return B(b3,u,bs[2]);if(i==4)return B(b4,u,bs[3]);return B(b5,u,bs[4]);}' +
  'vec4 F(vec2 c){vec2 u=(p3.xy+c)/p3.zw;if(p4.w<=.05)return texture2D(s,clamp(u,p4.xy,1.-p4.xy));' +
  'float l=clamp(log2(1.+p4.w*p4.z*.75),0.,5.),f=fract(l);int i=int(floor(l)),j=i<5?i+1:5;' +
  'vec4 a=j==i||f<.02?L(i,u):f>.98?L(j,u):mix(L(i,u),L(j,u),f);' +
  'a.rgb=clamp(mix(vec3(dot(a.rgb,vec3(.2126,.7152,.0722))),a.rgb,sa),0.,1.);return a;}' +
  'vec3 D(vec3 c,bool hf){if(ti.a>.001)c=mix(c,ti.rgb,ti.a);' +
  'return hf?clamp(c+(fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5)/255.,0.,1.):c;}' +
  'void main(){bool hr=p1.w>.5&&p2.z>.001,hf=p4.w>.05,hm=abs(im-1.)>.001;if(!hr&&!hf&&!hm){gl_FragColor=vec4(0.);return;}' +
  'vec2 fc=v*p0.xy,mc=p0.zw+(fc-p0.zw)*im,q=abs(fc-p0.zw)-p1.xy,o=max(q,0.);float ol=length(o),sd=ol+min(max(q.x,q.y),0.)-p1.z;' +
  'if(sd>.75){gl_FragColor=vec4(0.);return;}float oa=sd<=0.?1.:1.-sd/.75,di=sd<0.?-sd:0.;' +
  'if(!hr||di>=p1.w){vec4 x=F(mc);gl_FragColor=vec4(D(x.rgb,hf),oa*x.a);return;}' +
  'if(oa<=.002){gl_FragColor=vec4(0.);return;}' +
  'float u=clamp(1.-di/p1.w,0.,1.),mg=(u<=0.?0.:u>=1.?1.:pow(u,p2.x))*oa,ux=0.,uy=0.;' +
  'if(o.x>0.&&o.y>0.){float n=p2.y-1.,gx=pow(o.x,n),gy=pow(o.y,n),gl=length(vec2(gx,gy));if(gl>0.){ux=gx/gl;uy=gy/gl;}}' +
  'else if(ol>1e-6){ux=o.x/ol;uy=o.y/ol;}else if(q.x>q.y)ux=1.;else if(q.y>q.x)uy=1.;else{ux=.70710678;uy=.70710678;}' +
  'vec2 dp=vec2(ux*(fc.x<p0.z?1.:-1.),uy*(fc.y<p0.w?1.:-1.))*(mg*p2.z);vec3 c;float a;' +
  'if(p2.w<=.0005){vec4 x=F(mc+dp);c=x.rgb;a=x.a;}else{float m=p2.w,h=m*.5;' +
  'vec4 x0=F(mc+dp*(1.-m)),x1=F(mc+dp*(1.-h)),x2=F(mc+dp),x3=F(mc+dp*(1.+h)),x4=F(mc+dp*(1.+m));' +
  'c=vec3(x0.r*.65+x1.r*.35,x1.g*.22+x2.g*.56+x3.g*.22,x3.b*.35+x4.b*.65);a=x2.a;}' +
  'gl_FragColor=vec4(D(c,hf),oa*a);}'

let glState: GlState | null = null
let glSupported: boolean | null = null

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh
  gl.deleteShader(sh)
  return null
}

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fragSrc: string): WebGLProgram | null {
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  const prog = fs && gl.createProgram()
  if (!fs || !prog) {
    if (fs) gl.deleteShader(fs)
    return null
  }
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.bindAttribLocation(prog, 0, 'a')
  gl.linkProgram(prog)
  gl.deleteShader(fs)
  if (gl.getProgramParameter(prog, gl.LINK_STATUS)) return prog
  gl.deleteProgram(prog)
  return null
}

function bindClampLinearTex(gl: WebGLRenderingContext, tex: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
}

function initGlState(): GlState | null {
  if (glSupported === false) return null
  if (glState && !glState.lost) return glState
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const opts: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  }
  const gl =
    (canvas.getContext('webgl', opts) as WebGLRenderingContext | null) ||
    (canvas.getContext('experimental-webgl', opts) as WebGLRenderingContext | null)
  const vs = gl && compileShader(gl, gl.VERTEX_SHADER, V_SRC)
  const program = gl && vs && linkProgram(gl, vs, F_SRC)
  const dsProgram = gl && vs && linkProgram(gl, vs, DS_F_SRC)
  if (vs && gl) gl.deleteShader(vs)

  const posBuf = gl && program && dsProgram ? gl.createBuffer() : null
  if (!gl || !program || !dsProgram || !posBuf) {
    if (gl && program) gl.deleteProgram(program)
    if (gl && dsProgram) gl.deleteProgram(dsProgram)
    glSupported = false
    return null
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  gl.useProgram(dsProgram)
  gl.uniform1f(gl.getUniformLocation(dsProgram, 'y'), 0.5)
  gl.uniform1i(gl.getUniformLocation(dsProgram, 's'), 0)

  gl.useProgram(program)
  gl.uniform1f(gl.getUniformLocation(program, 'y'), -0.5)
  ;['s', 'b1', 'b2', 'b3', 'b4', 'b5'].forEach((n, i) => gl.uniform1i(gl.getUniformLocation(program, n), i))

  const state: GlState = {
    canvas,
    gl,
    program,
    dsProgram,
    u: ['p0', 'p1', 'p2', 'p3', 'p4', 'ti', 'sa', 'im', 'bs[0]'].map((n) => gl.getUniformLocation(program, n)),
    dsTexel: gl.getUniformLocation(dsProgram, 't'),
    blurSizesBuf: new Float32Array(PYRAMID_LEVELS * 2),
    textures: new WeakMap(),
    lost: false,
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    state.lost = true
    glState = null
  })
  canvas.addEventListener('webglcontextrestored', () => {
    glState = null
  })

  glSupported = true
  return (glState = state)
}

export const isWebGLRefractionAvailable = (): boolean => initGlState() !== null

function releaseWebGLSnapshot(snapCanvas: HTMLCanvasElement): void {
  const s = glState
  const entry = s?.textures.get(snapCanvas)
  if (!s || !entry) return
  s.textures.delete(snapCanvas)
  if (s.lost || s.gl.isContextLost()) return
  s.gl.deleteTexture(entry.tex)
  if (entry.blurLevels) {
    for (const lvl of entry.blurLevels) {
      s.gl.deleteTexture(lvl.tex)
      s.gl.deleteFramebuffer(lvl.fbo)
    }
    entry.blurLevels = null
  }
}

function ensureBlurPyramid(state: GlState, texEntry: CachedSnapTex): boolean {
  const { gl } = state
  if (texEntry.blurVersion === texEntry.version && texEntry.blurLevels) return true

  if (!texEntry.blurLevels) {
    const levels: BlurLevel[] = []
    for (let i = 0; i < PYRAMID_LEVELS; i++) {
      const tex = gl.createTexture()
      const fbo = gl.createFramebuffer()
      if (!tex || !fbo) {
        if (tex) gl.deleteTexture(tex)
        if (fbo) gl.deleteFramebuffer(fbo)
        for (const l of levels) {
          gl.deleteTexture(l.tex)
          gl.deleteFramebuffer(l.fbo)
        }
        return false
      }
      bindClampLinearTex(gl, tex)
      levels.push({ tex, fbo, width: 0, height: 0 })
    }
    texEntry.blurLevels = levels
  }

  gl.disable(gl.SCISSOR_TEST)
  gl.disable(gl.BLEND)
  gl.useProgram(state.dsProgram)
  gl.activeTexture(gl.TEXTURE0)

  let srcTex = texEntry.tex
  let srcW = texEntry.width
  let srcH = texEntry.height

  for (const level of texEntry.blurLevels) {
    const dstW = Math.max(1, Math.ceil(srcW * 0.5))
    const dstH = Math.max(1, Math.ceil(srcH * 0.5))
    if (level.width !== dstW || level.height !== dstH) {
      gl.bindTexture(gl.TEXTURE_2D, level.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dstW, dstH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, level.tex, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.useProgram(state.program)
        return false
      }
      level.width = dstW
      level.height = dstH
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.fbo)
    }
    gl.viewport(0, 0, dstW, dstH)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform2f(state.dsTexel, 1 / srcW, 1 / srcH)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    srcTex = level.tex
    srcW = dstW
    srcH = dstH
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.useProgram(state.program)
  texEntry.blurVersion = texEntry.version
  return true
}

function renderRefractedBevelWebGL(
  targetCtx: CanvasRenderingContext2D,
  field: BevelField,
  snapshot: TargetSnapshot,
  offsetX: number,
  offsetY: number,
  dispCssPx: number,
  spread: number,
  tintRgba: [number, number, number, number] | null,
  frost: number,
  invMag: number,
): boolean {
  const state = initGlState()
  if (!state) return false
  const { gl, canvas, u, blurSizesBuf } = state
  if (gl.isContextLost()) {
    state.lost = true
    glState = null
    return false
  }

  const { bufWidth, bufHeight } = field
  if (canvas.width < bufWidth) canvas.width = bufWidth
  if (canvas.height < bufHeight) canvas.height = bufHeight

  gl.activeTexture(gl.TEXTURE0)
  let texEntry = state.textures.get(snapshot.canvas)
  if (!texEntry) {
    const tex = gl.createTexture()
    if (!tex) return false
    bindClampLinearTex(gl, tex)
    texEntry = { tex, version: -1, width: 0, height: 0, blurLevels: null, blurVersion: -1 }
    state.textures.set(snapshot.canvas, texEntry)
  } else {
    gl.bindTexture(gl.TEXTURE_2D, texEntry.tex)
  }

  if (texEntry.version !== snapshot.version || texEntry.width !== snapshot.width || texEntry.height !== snapshot.height) {
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshot.canvas)
    } catch {
      return false
    }
    texEntry.version = snapshot.version
    texEntry.width = snapshot.width
    texEntry.height = snapshot.height
  }

  const frostClamped = clamp(frost, 0, 100)
  const frostPx = frostClamped * 0.2
  const hasBlur = frostPx > 0.05 && ensureBlurPyramid(state, texEntry)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texEntry.tex)
  for (let i = 0; i < PYRAMID_LEVELS; i++) {
    gl.activeTexture(gl.TEXTURE1 + i)
    const lvl = hasBlur && texEntry.blurLevels ? texEntry.blurLevels[i] : null
    gl.bindTexture(gl.TEXTURE_2D, lvl ? lvl.tex : texEntry.tex)
    blurSizesBuf[i * 2] = lvl && lvl.width > 0 ? lvl.width : snapshot.width
    blurSizesBuf[i * 2 + 1] = lvl && lvl.height > 0 ? lvl.height : snapshot.height
  }
  gl.activeTexture(gl.TEXTURE0)

  gl.viewport(0, 0, bufWidth, bufHeight)
  gl.enable(gl.SCISSOR_TEST)
  gl.scissor(0, 0, bufWidth, bufHeight)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.uniform4f(u[0], field.width, field.height, field.hw, field.hh)
  gl.uniform4f(u[1], field.bx, field.by, field.borderRadius, field.effectiveDepth)
  gl.uniform4f(u[2], field.splayExp, field.cornerExponent, dispCssPx, spread)
  gl.uniform4f(u[3], offsetX, offsetY, snapshot.cssWidth, snapshot.cssHeight)
  gl.uniform4f(
    u[4],
    0.5 / snapshot.width,
    0.5 / snapshot.height,
    snapshot.cssWidth > 0 ? snapshot.width / snapshot.cssWidth : 1,
    hasBlur ? frostPx : 0,
  )
  gl.uniform4f(u[5], tintRgba?.[0] ?? 0, tintRgba?.[1] ?? 0, tintRgba?.[2] ?? 0, tintRgba?.[3] ?? 0)
  gl.uniform1f(u[6], 1 + (frostClamped * 0.8) / 100)
  gl.uniform1f(u[7], invMag)
  gl.uniform2fv(u[8], blurSizesBuf)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  targetCtx.clearRect(0, 0, bufWidth, bufHeight)
  targetCtx.drawImage(canvas, 0, canvas.height - bufHeight, bufWidth, bufHeight, 0, 0, bufWidth, bufHeight)
  return true
}

// ── 1/4-quadrant SDF bevel engine & CPU fallback ────────────────────────────

let sharedCanvas: HTMLCanvasElement | null = null
let sharedCtx: CanvasRenderingContext2D | null = null
let revisionCounter = 0

const bitmapCache = new Map<string, string>()
const activeBevels = new Map<string, { field: BevelField; dataUrl: string; refCount: number }>()
const statListeners = new Set<() => void>()
const sdfScratch = new Float64Array(3) // [dx, dy, outerAlpha]

let cachedStats: EngineStats = { fields: 0, consumers: 0, bitmaps: 0, snapshots: 0 }
let snapshotUnsub: (() => void) | null = null

function notifyStats(): void {
  let consumers = 0
  for (const e of activeBevels.values()) consumers += e.refCount
  cachedStats = { fields: activeBevels.size, consumers, bitmaps: bitmapCache.size, snapshots: snapshotRegistry.size }
  for (const fn of statListeners) fn()
}

export function getEngineStats(): EngineStats {
  if (cachedStats.snapshots !== snapshotRegistry.size) {
    cachedStats = { ...cachedStats, snapshots: snapshotRegistry.size }
  }
  return cachedStats
}

export function subscribeEngineStats(listener: () => void): () => void {
  if (!snapshotUnsub) snapshotUnsub = subscribeSnapshotStats(notifyStats)
  statListeners.add(listener)
  return () => {
    statListeners.delete(listener)
    if (!statListeners.size && snapshotUnsub) {
      snapshotUnsub()
      snapshotUnsub = null
    }
  }
}

function getScratchContext(w: number, h: number) {
  if (typeof document === 'undefined') return null
  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas')
    sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (!sharedCtx) return null
  if (sharedCanvas.width !== w) sharedCanvas.width = w
  if (sharedCanvas.height !== h) sharedCanvas.height = h
  return { canvas: sharedCanvas, ctx: sharedCtx }
}

function normalizeSpec(spec: DisplacementMapSpec) {
  const w = Math.max(2, Math.round(spec.width))
  const h = Math.max(2, Math.round(spec.height))
  const r = Math.round(clamp(spec.borderRadius, 0, Math.min(w, h) * 0.5) * 2) / 2
  const depth = clamp(spec.depth, 0, 100)
  const splay = clamp(spec.splay, 0, 100)
  return { w, h, r, depth, splay, key: `${w}x${h}_r${r.toFixed(1)}_d${depth.toFixed(1)}_s${splay.toFixed(1)}` }
}

export function buildBevelHash(spec: BevelSpec): string {
  const { key } = normalizeSpec(spec)
  return `${key}_sc${clamp(spec.scale, 1, 2).toFixed(2)}`
}

export function chooseRenderScale(width: number, height: number, depth: number): number {
  const maxDpr = typeof window !== 'undefined' ? clamp(window.devicePixelRatio || 1, 1, 2) : 1
  if (isWebGLRefractionAvailable()) {
    return Math.round(clamp(Math.sqrt(140_000 / Math.max(1, width * height)), 0.4, maxDpr) * 4) / 4
  }
  const effD = clamp(depth, 0, Math.min(width, height) * 0.5)
  const approxPx = Math.min(width * height, 2 * (width + height) * effD)
  return Math.round(clamp(Math.sqrt(72_000 / Math.max(1, approxPx)), 1, maxDpr) * 4) / 4
}

function makeCurve(w: number, h: number, r: number, depth: number, splay: number) {
  const hw = w * 0.5
  const hh = h * 0.5
  const bx = Math.max(0, hw - r)
  const by = Math.max(0, hh - r)
  const effectiveDepth = Math.max(0, Math.min(depth, hw, hh))
  const splayExp = 1.5 + (clamp(splay, 0, 100) / 100) * 3
  // Blend circle (2.0) toward squircle (2.8) only along straight segments so circles stay exact.
  const cornerExponent = 2 + 0.8 * clamp01(Math.min(bx, by) / Math.max(1, r))
  return { hw, hh, bx, by, borderRadius: r, effectiveDepth, splayExp, cornerExponent }
}

function evalBevelNormal(
  qx: number,
  qy: number,
  ox: number,
  oy: number,
  oyPow: number,
  outLen: number,
  distIn: number,
  effDepth: number,
  splayExp: number,
  n1: number,
  outerAlpha: number,
): void {
  const u = clamp01(1 - distIn / effDepth)
  const mag = (u <= 0 ? 0 : u >= 1 ? 1 : Math.pow(u, splayExp)) * outerAlpha

  let ux = 0
  let uy = 0
  if (ox > 0 && oy > 0) {
    const gx = Math.pow(ox, n1)
    const gl = Math.hypot(gx, oyPow) || 1
    ux = gx / gl
    uy = oyPow / gl
  } else if (outLen > 1e-6) {
    ux = ox / outLen
    uy = oy / outLen
  } else if (qx > qy) {
    ux = 1
  } else if (qy > qx) {
    uy = 1
  } else {
    ux = uy = Math.SQRT1_2
  }

  sdfScratch[0] = ux * mag
  sdfScratch[1] = uy * mag
  sdfScratch[2] = outerAlpha
}

// Writes [dx, dy, outerAlpha] into `sdfScratch`; returns false in flat interior or outside AA rim.
function evalBevelPixel(
  cx: number,
  qy: number,
  oy: number,
  oyPow: number,
  bx: number,
  r: number,
  effDepth: number,
  splayExp: number,
  n1: number,
): boolean {
  const qx = cx - bx
  const ox = qx > 0 ? qx : 0
  const outLen = Math.hypot(ox, oy)
  const qMax = qx > qy ? qx : qy
  const sd = outLen + (qMax < 0 ? qMax : 0) - r
  if (sd > 0.75) return false
  const distIn = sd < 0 ? -sd : 0
  if (distIn >= effDepth) return false

  evalBevelNormal(qx, qy, ox, oy, oyPow, outLen, distIn, effDepth, splayExp, n1, sd <= 0 ? 1 : 1 - sd / 0.75)
  return true
}

export function generateDisplacementMap(spec: DisplacementMapSpec): string {
  const { w, h, r, depth, splay, key } = normalizeSpec(spec)
  const cached = bitmapCache.get(key)
  if (cached) {
    bitmapCache.delete(key)
    bitmapCache.set(key, cached)
    return cached
  }

  const surface = getScratchContext(w, h)
  if (!surface) return ''
  const { canvas, ctx } = surface
  const imageData = ctx.createImageData(w, h)
  const data = imageData.data

  if (IS_LE) {
    new Uint32Array(data.buffer).fill(0xff808080)
  } else {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = 128
      data[i + 3] = 255
    }
  }

  const c = makeCurve(w, h, r, depth, splay)
  if (c.effectiveDepth > 0.5) {
    const qW = Math.ceil(w * 0.5)
    const qH = Math.ceil(h * 0.5)
    const n1 = c.cornerExponent - 1

    for (let y = 0; y < qH; y++) {
      const qy = c.hh - (y + 0.5) - c.by
      const oy = qy > 0 ? qy : 0
      const oyPow = oy > 0 ? Math.pow(oy, n1) : 0
      const rowTop = y * w * 4
      const rowBot = (h - 1 - y) * w * 4

      for (let x = 0; x < qW; x++) {
        if (!evalBevelPixel(c.hw - (x + 0.5), qy, oy, oyPow, c.bx, r, c.effectiveDepth, c.splayExp, n1)) continue
        const rVal = Math.round(128 + sdfScratch[0] * 127)
        const gVal = Math.round(128 + sdfScratch[1] * 127)
        const rMir = 256 - rVal
        const gMir = 256 - gVal
        const x4 = x * 4
        const mx4 = (w - 1 - x) * 4
        data[rowTop + x4] = rVal
        data[rowTop + x4 + 1] = gVal
        data[rowTop + mx4] = rMir
        data[rowTop + mx4 + 1] = gVal
        data[rowBot + x4] = rVal
        data[rowBot + x4 + 1] = gMir
        data[rowBot + mx4] = rMir
        data[rowBot + mx4 + 1] = gMir
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const dataUrl = canvas.toDataURL('image/png')
  if (bitmapCache.size >= MAX_BITMAP_CACHE) {
    const oldest = bitmapCache.keys().next().value
    if (oldest !== undefined) bitmapCache.delete(oldest)
  }
  bitmapCache.set(key, dataUrl)
  return dataUrl
}

function populateCpuBevelArrays(field: BevelField): void {
  if (field.cpuReady) return
  const { width: w, height: h, borderRadius: r, effectiveDepth, splay, scale, bufWidth, bufHeight } = field
  const maxN = bufWidth * bufHeight
  const indices = new Uint32Array(maxN)
  const px = new Uint16Array(maxN)
  const py = new Uint16Array(maxN)
  const vecX = new Float32Array(maxN)
  const vecY = new Float32Array(maxN)
  const alpha = new Uint8Array(maxN)
  let count = 0

  if (effectiveDepth > 0.5) {
    const c = makeCurve(w, h, r, effectiveDepth, splay)
    const qW = Math.ceil(bufWidth * 0.5)
    const qH = Math.ceil(bufHeight * 0.5)
    const invS = 1 / scale
    const n1 = c.cornerExponent - 1

    const push = (col: number, row: number, vx: number, vy: number, a: number) => {
      indices[count] = row * bufWidth + col
      px[count] = col
      py[count] = row
      vecX[count] = vx
      vecY[count] = vy
      alpha[count] = a
      count++
    }

    for (let y = 0; y < qH; y++) {
      const qy = c.hh - (y + 0.5) * invS - c.by
      const oy = qy > 0 ? qy : 0
      const oyPow = oy > 0 ? Math.pow(oy, n1) : 0
      const my = bufHeight - 1 - y

      for (let x = 0; x < qW; x++) {
        if (!evalBevelPixel(c.hw - (x + 0.5) * invS, qy, oy, oyPow, c.bx, r, c.effectiveDepth, c.splayExp, n1)) {
          continue
        }
        const aByte = Math.round(sdfScratch[2] * 255)
        if (!aByte) continue
        const dx = sdfScratch[0]
        const dy = sdfScratch[1]
        const mx = bufWidth - 1 - x
        push(x, y, dx, dy, aByte)
        if (mx !== x) push(mx, y, -dx, dy, aByte)
        if (my !== y) push(x, my, dx, -dy, aByte)
        if (mx !== x && my !== y) push(mx, my, -dx, -dy, aByte)
      }
    }
  }

  field.count = count
  field.indices = indices.subarray(0, count)
  field.px = px.subarray(0, count)
  field.py = py.subarray(0, count)
  field.vecX = vecX.subarray(0, count)
  field.vecY = vecY.subarray(0, count)
  field.alpha = alpha.subarray(0, count)
  field.cpuReady = true
}

export function acquireBevelField(spec: BevelSpec, needDataUrl = true): AcquiredBevel {
  const hash = buildBevelHash(spec)
  const existing = activeBevels.get(hash)
  if (existing) {
    existing.refCount++
    if (needDataUrl && !existing.dataUrl) existing.dataUrl = generateDisplacementMap(spec)
    notifyStats()
    return { field: existing.field, dataUrl: existing.dataUrl }
  }

  const { w, h, r, depth, splay } = normalizeSpec(spec)
  const scale = clamp(spec.scale, 1, 2)
  const field: BevelField = {
    fieldId: `lg-b${++revisionCounter}`,
    hash,
    width: w,
    height: h,
    ...makeCurve(w, h, r, depth, splay),
    splay,
    scale,
    bufWidth: Math.max(2, Math.round(w * scale)),
    bufHeight: Math.max(2, Math.round(h * scale)),
    count: 0,
    indices: EMPTY_U32,
    px: EMPTY_U16,
    py: EMPTY_U16,
    vecX: EMPTY_F32,
    vecY: EMPTY_F32,
    alpha: EMPTY_U8,
    cpuReady: false,
  }
  if (!isWebGLRefractionAvailable()) populateCpuBevelArrays(field)

  const dataUrl = needDataUrl ? generateDisplacementMap(spec) : ''
  activeBevels.set(hash, { field, dataUrl, refCount: 1 })
  notifyStats()
  return { field, dataUrl }
}

export function releaseBevelField(hash: string): void {
  const entry = activeBevels.get(hash)
  if (!entry) return
  if (--entry.refCount <= 0) {
    activeBevels.delete(hash)
    if (!activeBevels.size && sharedCanvas) {
      sharedCanvas.width = sharedCanvas.height = 0
      sharedCanvas = sharedCtx = null
    }
  }
  notifyStats()
}

function sampleChannel(
  srcData: Uint8ClampedArray,
  srcW: number,
  maxX: number,
  maxY: number,
  sx: number,
  sy: number,
  ch: number,
): number {
  const cx = clamp(sx, 0, maxX)
  const cy = clamp(sy, 0, maxY)
  const x0 = cx | 0
  const y0 = cy | 0
  const x1 = x0 < maxX ? x0 + 1 : x0
  const y1 = y0 < maxY ? y0 + 1 : y0
  const fx = cx - x0
  const fy = cy - y0
  const invFx = 1 - fx
  const r0 = y0 * srcW
  const r1 = y1 * srcW
  return (
    (srcData[(r0 + x0) * 4 + ch] * invFx + srcData[(r0 + x1) * 4 + ch] * fx) * (1 - fy) +
    (srcData[(r1 + x0) * 4 + ch] * invFx + srcData[(r1 + x1) * 4 + ch] * fx) * fy
  )
}

function writeSampledPixel(
  srcData: Uint8ClampedArray,
  srcW: number,
  maxX: number,
  maxY: number,
  out: Uint8ClampedArray,
  dst: number,
  bx: number,
  by: number,
  dx: number,
  dy: number,
  alphaByte: number,
  spread: number,
): void {
  if (spread <= 0.0005 || (dx === 0 && dy === 0)) {
    const cx = clamp(bx + dx, 0, maxX)
    const cy = clamp(by + dy, 0, maxY)
    const x0 = cx | 0
    const y0 = cy | 0
    const x1 = x0 < maxX ? x0 + 1 : x0
    const y1 = y0 < maxY ? y0 + 1 : y0
    const fx = cx - x0
    const fy = cy - y0
    const invFx = 1 - fx
    const invFy = 1 - fy
    const w00 = invFx * invFy
    const w10 = fx * invFy
    const w01 = invFx * fy
    const w11 = fx * fy
    const i00 = (y0 * srcW + x0) * 4
    const i10 = (y0 * srcW + x1) * 4
    const i01 = (y1 * srcW + x0) * 4
    const i11 = (y1 * srcW + x1) * 4
    out[dst] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11
    out[dst + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11
    out[dst + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11
    out[dst + 3] =
      (alphaByte * (srcData[i00 + 3] * w00 + srcData[i10 + 3] * w10 + srcData[i01 + 3] * w01 + srcData[i11 + 3] * w11)) /
      255
    return
  }

  const m0 = 1 - spread
  const m1 = 1 - spread * 0.5
  const m3 = 1 + spread * 0.5
  const m4 = 1 + spread
  out[dst] =
    sampleChannel(srcData, srcW, maxX, maxY, bx + dx * m0, by + dy * m0, 0) * 0.65 +
    sampleChannel(srcData, srcW, maxX, maxY, bx + dx * m1, by + dy * m1, 0) * 0.35
  out[dst + 1] =
    sampleChannel(srcData, srcW, maxX, maxY, bx + dx * m1, by + dy * m1, 1) * 0.22 +
    sampleChannel(srcData, srcW, maxX, maxY, bx + dx, by + dy, 1) * 0.56 +
    sampleChannel(srcData, srcW, maxX, maxY, bx + dx * m3, by + dy * m3, 1) * 0.22
  out[dst + 2] =
    sampleChannel(srcData, srcW, maxX, maxY, bx + dx * m3, by + dy * m3, 2) * 0.35 +
    sampleChannel(srcData, srcW, maxX, maxY, bx + dx * m4, by + dy * m4, 2) * 0.65
  out[dst + 3] = (alphaByte * sampleChannel(srcData, srcW, maxX, maxY, bx + dx, by + dy, 3)) / 255
}

export function renderRefractedBevel(
  ctx: CanvasRenderingContext2D,
  outImageData: ImageData | null,
  field: BevelField,
  snapshot: TargetSnapshot,
  offsetX: number,
  offsetY: number,
  refraction: number,
  dispersion: number,
  tintColor = '',
  frost = 0,
  magnification = 1,
): void {
  const dispCssPx = (clamp(refraction, 0, 100) / 100) * field.effectiveDepth * 1.5
  const hasRefract = dispCssPx > 0.001 && field.effectiveDepth > 0.5
  const normMag = Number.isFinite(magnification) ? clamp(magnification, MIN_MAGNIFICATION, MAX_MAGNIFICATION) : 1
  const invMag = 1 / normMag
  const hasMag = Math.abs(invMag - 1) > 0.001
  if (!hasRefract && !hasMag && frost <= 0.05) {
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    return
  }

  const spread = (clamp(dispersion, 0, 100) / 100) * 0.36
  const parsedTint = tintColor ? parseCssColorRgba(tintColor) : null
  const usedWebGL = renderRefractedBevelWebGL(
    ctx,
    field,
    snapshot,
    offsetX,
    offsetY,
    hasRefract ? dispCssPx : 0,
    spread,
    parsedTint,
    frost,
    invMag,
  )

  if (!usedWebGL) {
    if (!hasRefract && !hasMag) {
      ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
      return
    }
    const srcData = snapshot.data
    if (!srcData.length) {
      ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
      return
    }

    const srcW = snapshot.width
    const srcScale = snapshot.scale
    const maxX = srcW - 1
    const maxY = snapshot.height - 1
    const dispScale = hasRefract ? dispCssPx * srcScale : 0

    if (hasMag) {
      const imgData = outImageData ?? ctx.createImageData(field.bufWidth, field.bufHeight)
      const out = imgData.data
      out.fill(0)

      const { hw, hh, bx, by, borderRadius: r, effectiveDepth, splayExp, cornerExponent, scale, bufWidth, bufHeight } =
        field
      const qW = Math.ceil(bufWidth * 0.5)
      const qH = Math.ceil(bufHeight * 0.5)
      const invS = 1 / scale
      const n1 = cornerExponent - 1

      for (let y = 0; y < qH; y++) {
        const cyCss = hh - (y + 0.5) * invS
        const qy = cyCss - by
        const oy = qy > 0 ? qy : 0
        const oyPow = oy > 0 ? Math.pow(oy, n1) : 0
        const byT = (offsetY + hh - cyCss * invMag) * srcScale - 0.5
        const byB = (offsetY + hh + cyCss * invMag) * srcScale - 0.5
        const my = bufHeight - 1 - y
        const rowT = y * bufWidth
        const rowB = my * bufWidth

        for (let x = 0; x < qW; x++) {
          const cxCss = hw - (x + 0.5) * invS
          const qx = cxCss - bx
          const ox = qx > 0 ? qx : 0
          const outLen = Math.hypot(ox, oy)
          const qMax = qx > qy ? qx : qy
          const sd = outLen + (qMax < 0 ? qMax : 0) - r
          if (sd > 0.75) continue

          const outerAlpha = sd <= 0 ? 1 : 1 - sd / 0.75
          const aByte = Math.round(outerAlpha * 255)
          if (!aByte) continue

          const distIn = sd < 0 ? -sd : 0
          let dx = 0
          let dy = 0
          if (hasRefract && distIn < effectiveDepth) {
            evalBevelNormal(qx, qy, ox, oy, oyPow, outLen, distIn, effectiveDepth, splayExp, n1, outerAlpha)
            dx = sdfScratch[0] * dispScale
            dy = sdfScratch[1] * dispScale
          }

          const bxL = (offsetX + hw - cxCss * invMag) * srcScale - 0.5
          const bxR = (offsetX + hw + cxCss * invMag) * srcScale - 0.5
          const mx = bufWidth - 1 - x

          writeSampledPixel(srcData, srcW, maxX, maxY, out, (rowT + x) * 4, bxL, byT, dx, dy, aByte, spread)
          if (mx !== x) {
            writeSampledPixel(srcData, srcW, maxX, maxY, out, (rowT + mx) * 4, bxR, byT, -dx, dy, aByte, spread)
          }
          if (my !== y) {
            writeSampledPixel(srcData, srcW, maxX, maxY, out, (rowB + x) * 4, bxL, byB, dx, -dy, aByte, spread)
          }
          if (mx !== x && my !== y) {
            writeSampledPixel(srcData, srcW, maxX, maxY, out, (rowB + mx) * 4, bxR, byB, -dx, -dy, aByte, spread)
          }
        }
      }

      ctx.putImageData(imgData, 0, 0)
    } else {
      populateCpuBevelArrays(field)
      if (!field.count) {
        ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
        return
      }

      const imgData = outImageData ?? ctx.createImageData(field.bufWidth, field.bufHeight)
      const out = imgData.data
      out.fill(0)

      const { count, indices, px, py, vecX, vecY, alpha } = field
      const ratio = srcScale / field.scale
      const baseX = offsetX * srcScale - 0.5
      const baseY = offsetY * srcScale - 0.5

      for (let i = 0; i < count; i++) {
        writeSampledPixel(
          srcData,
          srcW,
          maxX,
          maxY,
          out,
          indices[i] * 4,
          baseX + (px[i] + 0.5) * ratio,
          baseY + (py[i] + 0.5) * ratio,
          vecX[i] * dispScale,
          vecY[i] * dispScale,
          alpha[i],
          spread,
        )
      }

      const surface = getScratchContext(field.bufWidth, field.bufHeight)
      if (!surface) {
        ctx.putImageData(imgData, 0, 0)
      } else {
        surface.ctx.putImageData(imgData, 0, 0)
        ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
        const sx = offsetX * srcScale
        const sy = offsetY * srcScale
        const sw = field.width * srcScale
        const sh = field.height * srcScale
        if (sx >= 0 && sy >= 0 && sx + sw <= snapshot.width && sy + sh <= snapshot.height) {
          ctx.drawImage(snapshot.canvas, sx, sy, sw, sh, 0, 0, field.bufWidth, field.bufHeight)
        } else {
          const csx = clamp(sx, 0, snapshot.width)
          const csy = clamp(sy, 0, snapshot.height)
          const csw = clamp(sx + sw, 0, snapshot.width) - csx
          const csh = clamp(sy + sh, 0, snapshot.height) - csy
          if (csw > 0 && csh > 0) {
            ctx.drawImage(
              snapshot.canvas,
              csx,
              csy,
              csw,
              csh,
              ((csx - sx) / sw) * field.bufWidth,
              ((csy - sy) / sh) * field.bufHeight,
              (csw / sw) * field.bufWidth,
              (csh / sh) * field.bufHeight,
            )
          }
        }
        ctx.drawImage(surface.canvas, 0, 0)
      }
    }
  }

  if (tintColor && (!usedWebGL || !parsedTint)) {
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = tintColor
    ctx.fillRect(0, 0, field.bufWidth, field.bufHeight)
    ctx.restore()
  }
}

// ── Shared DOM backdrop snapshotter ─────────────────────────────────────────

type AssetEntry = { status: 'loading' | 'ready' | 'error'; img: HTMLImageElement; waiters: Set<() => void> }
type ConsumerRec = {
  onUpdate: () => void
  rootEl: HTMLElement | null
  scopeEl: HTMLElement | null
  compCanvas: HTMLCanvasElement | null
  compCtx: CanvasRenderingContext2D | null
  compVersion: number
  compSnapshot: TargetSnapshot | null
  lastOverlapped: Set<HTMLElement>
  cachedRect: DOMRect | null
  cachedRectAt: number
}
type SnapEntry = {
  target: HTMLElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  snapshot: TargetSnapshot | null
  version: number
  isVisible: boolean
  deferred: boolean
  hasVideo: boolean
  lastVideoAt: number
  videoCbs: WeakSet<HTMLVideoElement>
  consumers: Map<() => void, ConsumerRec>
  notifyingScopes: Set<HTMLElement>
  dirtyScopes: Set<HTMLElement>
  dirtyRaf: number
  ro: ResizeObserver
  mo: MutationObserver
  io: IntersectionObserver | null
  onMedia: () => void
  onVis: () => void
  rafId: number
}

const POS_KW: Record<string, string> = { left: '0%', center: '50%', right: '100%', top: '0%', bottom: '100%' }
const assetCache = new Map<string, AssetEntry>()
const snapshotRegistry = new Map<HTMLElement, SnapEntry>()
const snapStatsListeners = new Set<() => void>()

function subscribeSnapshotStats(fn: () => void): () => void {
  snapStatsListeners.add(fn)
  return () => snapStatsListeners.delete(fn)
}
const notifySnapshotStats = () => snapStatsListeners.forEach((fn) => fn())

// Splits CSS lists at depth-0 commas or top-level whitespace while respecting quotes & nested `(...)`.
function splitCss(input: string, bySpace = false): string[] {
  const out: string[] = []
  let depth = 0
  let start = bySpace ? -1 : 0
  let quote: string | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      if (bySpace && start === -1) start = i
      quote = ch
    } else if (ch === '(') {
      if (bySpace && start === -1) start = i
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (!depth && (bySpace ? /\s/.test(ch) : ch === ',')) {
      if (bySpace) {
        if (start !== -1) {
          out.push(input.slice(start, i))
          start = -1
        }
      } else {
        out.push(input.slice(start, i).trim())
        start = i + 1
      }
    } else if (bySpace && start === -1) {
      start = i
    }
  }
  if (bySpace) {
    if (start !== -1) out.push(input.slice(start))
  } else {
    const tail = input.slice(start).trim()
    if (tail) out.push(tail)
  }
  return out
}

function loadAsset(url: string, onReady: () => void): HTMLImageElement | null {
  const cached = assetCache.get(url)
  if (cached) {
    assetCache.delete(url)
    assetCache.set(url, cached)
    if (cached.status === 'ready') return cached.img
    if (cached.status === 'loading') cached.waiters.add(onReady)
    return null
  }
  const img = new Image()
  if (!url.startsWith('data:') && !url.startsWith('blob:') && typeof window !== 'undefined') {
    try {
      if (new URL(url, window.location.href).origin !== window.location.origin) img.crossOrigin = 'anonymous'
    } catch {
      /* ignore malformed url */
    }
  }
  const entry: AssetEntry = { status: 'loading', img, waiters: new Set([onReady]) }
  if (assetCache.size >= MAX_ASSET_CACHE) {
    const oldest = assetCache.keys().next().value
    if (oldest !== undefined) {
      const ev = assetCache.get(oldest)
      if (ev) {
        ev.img.onload = ev.img.onerror = null
        ev.waiters.clear()
      }
      assetCache.delete(oldest)
    }
  }
  assetCache.set(url, entry)
  const finish = (ok: boolean) => {
    entry.status = ok && img.naturalWidth > 0 ? 'ready' : 'error'
    const waiters = Array.from(entry.waiters)
    entry.waiters.clear()
    if (entry.status === 'ready') waiters.forEach((fn) => fn())
  }
  img.onload = () => finish(true)
  img.onerror = () => finish(false)
  img.src = url
  if (img.complete && img.naturalWidth > 0) {
    entry.status = 'ready'
    entry.waiters.clear()
    return img
  }
  return null
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): void {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radii)
    return
  }
  const [tl, tr, br, bl] = radii
  ctx.moveTo(x + tl, y)
  ctx.lineTo(x + w - tr, y)
  ctx.arcTo(x + w, y, x + w, y + tr, tr)
  ctx.lineTo(x + w, y + h - br)
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br)
  ctx.lineTo(x + bl, y + h)
  ctx.arcTo(x, y + h, x, y + h - bl, bl)
  ctx.lineTo(x, y + tl)
  ctx.arcTo(x, y, x + tl, y, tl)
  ctx.closePath()
}

function withClip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
  hasRadius: boolean,
  draw: () => void,
): void {
  ctx.save()
  if (hasRadius) {
    traceRoundedRect(ctx, x, y, w, h, radii)
    ctx.clip()
  }
  draw()
  ctx.restore()
}

function parseStops(rawStops: string[], axisLen: number): { color: string; offset: number }[] {
  const list: { color: string; offset: number | null }[] = []
  for (const s of rawStops) {
    const tokens = splitCss(s, true)
    if (!tokens.length) continue
    if (tokens.length === 1) {
      list.push({ color: tokens[0], offset: null })
    } else {
      for (let j = 1; j < tokens.length; j++) {
        const t = tokens[j]
        const v = parseFloat(t)
        if (Number.isFinite(v)) {
          list.push({ color: tokens[0], offset: clamp01(t.endsWith('%') ? v / 100 : axisLen > 0 ? v / axisLen : 0) })
        }
      }
    }
  }
  if (!list.length) return []
  if (list[0].offset === null) list[0].offset = 0
  if (list[list.length - 1].offset === null) list[list.length - 1].offset = 1
  let prev = 0
  for (const s of list) if (s.offset !== null) prev = s.offset = Math.max(prev, s.offset)
  for (let i = 0; i < list.length; ) {
    if (list[i].offset === null) {
      let next = i + 1
      while (next < list.length && list[next].offset === null) next++
      const s0 = list[i - 1].offset!
      const step = (list[next].offset! - s0) / (next - i + 1)
      for (let k = 0; k < next - i; k++) list[i + k].offset = s0 + step * (k + 1)
      i = next
    } else i++
  }
  return list as { color: string; offset: number }[]
}

function addStops(grad: CanvasGradient, stops: { color: string; offset: number }[]): void {
  for (const s of stops) {
    try {
      grad.addColorStop(s.offset, s.color)
    } catch {
      /* skip unsupported color tokens */
    }
  }
}

function drawGradient(ctx: CanvasRenderingContext2D, expr: string, w: number, h: number): void {
  const isRadial = expr.startsWith('radial-gradient(')
  const isRepeat = expr.startsWith('repeating-linear-gradient(')
  const body = expr.slice(expr.indexOf('(') + 1, -1)
  const args = splitCss(body, false)
  if (!args.length) return

  if (isRadial) {
    const first = args[0]
    const hasSpec =
      /(?:^|\s)(circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|at)(?:\s|$)/i.test(first) ||
      /^\d/.test(first)
    const spec = hasSpec ? first : ''
    let cx = w * 0.5
    let cy = h * 0.5
    let sizePart = spec
    const atIdx = spec.toLowerCase().indexOf(' at ')
    if (atIdx !== -1 || spec.toLowerCase().startsWith('at ')) {
      const pos = spec.slice(atIdx === -1 ? 3 : atIdx + 4).trim().split(/\s+/)
      sizePart = atIdx === -1 ? '' : spec.slice(0, atIdx).trim()
      cx = parseLengthPx(POS_KW[pos[0]?.toLowerCase()] ?? pos[0] ?? '50%', w)
      cy = parseLengthPx(POS_KW[pos[1]?.toLowerCase()] ?? pos[1] ?? '50%', h)
    }
    let rx = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
    let ry = rx
    const sz = sizePart.replace(/\b(circle|ellipse)\b/gi, '').trim().split(/\s+/).filter(Boolean)
    if (sz.length && !sz[0].endsWith('side') && !sz[0].endsWith('corner')) {
      rx = Math.max(1, parseLengthPx(sz[0], sz.length === 2 ? w : Math.max(w, h)))
      ry = sz.length === 2 ? Math.max(1, parseLengthPx(sz[1], h)) : rx
    } else if (sizePart.includes('closest-side')) {
      rx = Math.max(1, Math.min(cx, w - cx))
      ry = Math.max(1, Math.min(cy, h - cy))
      if (sizePart.includes('circle')) rx = ry = Math.min(rx, ry)
    }
    const stops = parseStops(hasSpec ? args.slice(1) : args, Math.max(rx, ry))
    if (!stops.length) return
    ctx.save()
    ctx.translate(cx, cy)
    if (Math.abs(ry - rx) > 0.5) ctx.scale(1, ry / rx)
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
    addStops(grad, stops)
    ctx.fillStyle = grad
    ctx.fillRect(-cx, -cy * (rx / ry), w, h * (rx / ry))
    ctx.restore()
    return
  }

  const d0 = args[0].toLowerCase().trim()
  let angle: number | null = d0.endsWith('deg')
    ? parseFloat(d0)
    : d0.endsWith('turn')
      ? parseFloat(d0) * 360
      : d0.endsWith('rad')
        ? (parseFloat(d0) * 180) / Math.PI
        : null
  if (angle === null && d0.startsWith('to ')) {
    const p = new Set(d0.slice(3).trim().split(/\s+/))
    const vx = p.has('right') ? w : p.has('left') ? -w : 0
    const vy = p.has('bottom') ? h : p.has('top') ? -h : 0
    if (vx || vy) angle = (Math.atan2(vx, -vy) * 180) / Math.PI
  }
  const rad = degToRad(angle ?? 180)
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) * 0.5
  const cx = w * 0.5
  const cy = h * 0.5
  const grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  const raw = parseStops(angle !== null ? args.slice(1) : args, half * 2)
  let stops = raw
  if (isRepeat && raw.length >= 2) {
    const period = raw[raw.length - 1].offset - raw[0].offset
    if (period > 0.002 && period < 0.99) {
      stops = []
      const reps = Math.min(128, Math.ceil((1 - raw[0].offset) / period))
      for (let r = 0; r < reps; r++) {
        for (const s of raw) {
          const off = Math.min(1, s.offset + r * period)
          stops.push({ color: s.color, offset: off })
          if (off >= 1) break
        }
      }
    }
  }
  addStops(grad, stops)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
}

function computeTileSize(raw: string, w: number, h: number, img?: HTMLImageElement): [number, number] {
  const t = raw.trim().toLowerCase()
  if (!t || t === 'auto') return img ? [img.naturalWidth || w, img.naturalHeight || h] : [w, h]
  if ((t === 'cover' || t === 'contain') && img && img.naturalWidth > 0) {
    const s = (t === 'cover' ? Math.max : Math.min)(w / img.naturalWidth, h / img.naturalHeight)
    return [img.naturalWidth * s, img.naturalHeight * s]
  }
  const [rw, rh = 'auto'] = t.split(/\s+/)
  const aspect = img && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1
  let tw = rw === 'auto' ? NaN : parseLengthPx(rw, w)
  let th = rh === 'auto' ? NaN : parseLengthPx(rh, h)
  if (Number.isNaN(tw) && Number.isNaN(th)) return [w, h]
  if (Number.isNaN(tw)) tw = img ? th / aspect : w
  if (Number.isNaN(th)) th = img ? tw * aspect : h
  return [Math.max(1, tw), Math.max(1, th)]
}

function paintBgLayers(
  ctx: CanvasRenderingContext2D,
  cs: CSSStyleDeclaration,
  x: number,
  y: number,
  w: number,
  h: number,
  snapScale: number,
  onAssetReady: () => void,
): void {
  if (!isTransparentColor(cs.backgroundColor)) {
    ctx.fillStyle = cs.backgroundColor
    ctx.fillRect(x, y, w, h)
  }
  const bg = cs.backgroundImage
  if (!bg || bg === 'none') return
  const layers = splitCss(bg)
  const sizes = splitCss(cs.backgroundSize || 'auto')
  const positions = splitCss(cs.backgroundPosition || '0% 0%')
  const repeats = splitCss(cs.backgroundRepeat || 'repeat')
  const posRes = (tok: string, boxD: number, tileD: number) =>
    tok.endsWith('%') ? (boxD - tileD) * (parseFloat(tok) / 100) : parseFloat(tok) || 0

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    const sizeSpec = sizes[i % sizes.length] || 'auto'
    const posToks = (positions[i % positions.length] || '0% 0%').trim().toLowerCase().split(/\s+/)
    const noRep = /^no-repeat(?:\s+no-repeat)?$/.test((repeats[i % repeats.length] || 'repeat').toLowerCase())

    if (layer.startsWith('url(')) {
      const img = loadAsset(layer.slice(4, -1).trim().replace(/^["']|["']$/g, ''), onAssetReady)
      if (!img) continue
      const [dw, dh] = computeTileSize(sizeSpec, w, h, img)
      const px = posRes(POS_KW[posToks[0]] ?? posToks[0] ?? '0%', w, dw)
      const py = posRes(POS_KW[posToks[1]] ?? posToks[1] ?? '0%', h, dh)
      if (noRep) {
        ctx.drawImage(img, x + px, y + py, dw, dh)
      } else {
        const pat = ctx.createPattern(img, 'repeat')
        if (pat) {
          ctx.save()
          ctx.translate(x + px, y + py)
          ctx.scale(dw / img.naturalWidth, dh / img.naturalHeight)
          ctx.fillStyle = pat
          ctx.fillRect(
            -px * (img.naturalWidth / dw),
            -py * (img.naturalHeight / dh),
            w * (img.naturalWidth / dw),
            h * (img.naturalHeight / dh),
          )
          ctx.restore()
        }
      }
      continue
    }

    if (/^(?:repeating-)?linear-gradient\(|^radial-gradient\(/.test(layer)) {
      const [tw, th] = computeTileSize(sizeSpec, w, h)
      const px = posRes(POS_KW[posToks[0]] ?? posToks[0] ?? '0%', w, tw)
      const py = posRes(POS_KW[posToks[1]] ?? posToks[1] ?? '0%', h, th)
      if (noRep || (Math.abs(tw - w) < 0.5 && Math.abs(th - h) < 0.5 && Math.abs(px) < 0.5 && Math.abs(py) < 0.5)) {
        ctx.save()
        ctx.translate(x + px, y + py)
        drawGradient(ctx, layer, tw, th)
        ctx.restore()
        continue
      }
      const tile = document.createElement('canvas')
      tile.width = Math.max(1, Math.round(tw * snapScale))
      tile.height = Math.max(1, Math.round(th * snapScale))
      const tCtx = tile.getContext('2d')
      if (!tCtx) continue
      tCtx.scale(snapScale, snapScale)
      drawGradient(tCtx, layer, tw, th)
      const pat = ctx.createPattern(tile, 'repeat')
      if (pat) {
        ctx.save()
        ctx.translate(x + px, y + py)
        if (typeof pat.setTransform === 'function' && typeof DOMMatrix !== 'undefined') {
          pat.setTransform(new DOMMatrix().scale(1 / snapScale))
          ctx.fillStyle = pat
          ctx.fillRect(-px, -py, w, h)
        } else {
          ctx.scale(1 / snapScale, 1 / snapScale)
          ctx.fillStyle = pat
          ctx.fillRect(-px * snapScale, -py * snapScale, w * snapScale, h * snapScale)
        }
        ctx.restore()
      }
    }
  }
}

function renderTextNode(
  ctx: CanvasRenderingContext2D,
  node: Text,
  cs: CSSStyleDeclaration,
  targetRect: DOMRect,
): void {
  const raw = node.nodeValue
  const tm = raw && /\S(?:[\s\S]*\S)?/.exec(raw)
  if (!raw || !tm) return

  const range = document.createRange()
  range.setStart(node, tm.index)
  range.setEnd(node, tm.index + tm[0].length)
  if (!range.getClientRects().length) return

  ctx.save()
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  ctx.fillStyle = cs.color
  ctx.textAlign = 'left'
  if ('letterSpacing' in ctx) {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
  }

  const probe = typeof ctx.measureText === 'function' ? ctx.measureText('Mg') : null
  const asc = probe?.fontBoundingBoxAscent
  const desc = probe?.fontBoundingBoxDescent
  const hasMetrics =
    typeof asc === 'number' && typeof desc === 'number' && Number.isFinite(asc + desc) && asc + desc > 0
  ctx.textBaseline = hasMetrics ? 'alphabetic' : 'middle'
  const baseRatio = hasMetrics ? asc / (asc + desc) : 0.52

  const xform = cs.textTransform
  const draws: { text: string; x: number; y: number }[] = []
  const wordRe = /\S+/g
  let m: RegExpExecArray | null
  while ((m = wordRe.exec(raw)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const rawWord = raw.slice(start, end)
    const word =
      xform === 'uppercase'
        ? rawWord.toUpperCase()
        : xform === 'lowercase'
          ? rawWord.toLowerCase()
          : xform === 'capitalize'
            ? rawWord.replace(/\b\w/g, (c) => c.toUpperCase())
            : rawWord
    if (!word) continue

    range.setStart(node, start)
    range.setEnd(node, end)
    const rects = range.getClientRects()
    const box = rects.length === 1 ? rects[0] : range.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) continue

    const measW = probe ? ctx.measureText(word).width : box.width
    const perGlyph =
      word.length > 1 &&
      word.length === rawWord.length &&
      (rects.length > 1 || (Number.isFinite(measW) && Math.abs(measW - box.width) > 0.6)) &&
      /^[\x21-\x7E\u00C0-\u024F\u2013\u2014]+$/.test(word)

    if (perGlyph) {
      for (let ci = 0; ci < word.length; ci++) {
        range.setStart(node, start + ci)
        range.setEnd(node, start + ci + 1)
        const cb = range.getBoundingClientRect()
        if (cb.width > 0 && cb.height > 0) {
          draws.push({ text: word[ci], x: cb.left - targetRect.left, y: cb.top - targetRect.top + cb.height * baseRatio })
        }
      }
    } else {
      draws.push({ text: word, x: box.left - targetRect.left, y: box.top - targetRect.top + box.height * baseRatio })
    }
  }

  if (draws.length) {
    let hasShadow = false
    if (cs.textShadow && cs.textShadow !== 'none') {
      const toks = splitCss(splitCss(cs.textShadow)[0], true)
      let color = 'transparent'
      const nums: number[] = []
      for (const t of toks) {
        if (/^-?[\d.]+(?:px)?$/i.test(t)) nums.push(parseFloat(t))
        else color = t
      }
      if (nums.length >= 2 && !isTransparentColor(color)) {
        hasShadow = true
        ctx.shadowColor = color
        ctx.shadowOffsetX = nums[0]
        ctx.shadowOffsetY = nums[1]
        ctx.shadowBlur = nums[2] ?? 0
      }
    }
    for (const d of draws) ctx.fillText(d.text, d.x, d.y)
    // Re-stamp opaque glyphs without shadow so adjacent kerned letters do not over-darken each other.
    if (hasShadow && draws.length > 1 && !/rgba\([^,]+,[^,]+,[^,]+,\s*0\.\d+\)|\/\s*0\.\d+\s*\)/i.test(cs.color)) {
      ctx.shadowColor = 'transparent'
      ctx.shadowOffsetX = ctx.shadowOffsetY = ctx.shadowBlur = 0
      for (const d of draws) ctx.fillText(d.text, d.x, d.y)
    }
  }
  ctx.restore()
}

function paintElementTree(
  ctx: CanvasRenderingContext2D,
  el: Element,
  targetRect: DOMRect,
  snapScale: number,
  onAssetReady: () => void,
  isRootTarget: boolean,
  onVideo?: (video: HTMLVideoElement) => void,
  skip?: Set<Element>,
): void {
  if (skip?.has(el)) return
  if (!isRootTarget && !skip && (el.hasAttribute('data-lg-root') || el.hasAttribute('data-lg-ignore'))) return

  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden') return
  const opacity = parseFloat(cs.opacity)
  if (Number.isFinite(opacity) && opacity <= 0.001) return

  const rect = el.getBoundingClientRect()
  const x = rect.left - targetRect.left
  const y = rect.top - targetRect.top
  const w = rect.width
  const h = rect.height
  if (w <= 0 || h <= 0) return

  const radii = parseCornerRadii(cs, w, h)
  const hasR = radii[0] > 0 || radii[1] > 0 || radii[2] > 0 || radii[3] > 0

  ctx.save()
  if (Number.isFinite(opacity) && opacity < 0.999) ctx.globalAlpha *= opacity

  withClip(ctx, x, y, w, h, radii, hasR, () => paintBgLayers(ctx, cs, x, y, w, h, snapScale, onAssetReady))

  const bw = parseFloat(cs.borderTopWidth) || 0
  if (bw > 0 && cs.borderTopStyle !== 'none' && !isTransparentColor(cs.borderTopColor)) {
    ctx.save()
    traceRoundedRect(ctx, x + bw * 0.5, y + bw * 0.5, Math.max(0, w - bw), Math.max(0, h - bw), radii)
    ctx.strokeStyle = cs.borderTopColor
    ctx.lineWidth = bw
    ctx.stroke()
    ctx.restore()
  }

  const tag = el.tagName.toUpperCase()
  if (tag === 'IMG') {
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src
    const img = src ? loadAsset(src, onAssetReady) : null
    if (img) withClip(ctx, x, y, w, h, radii, hasR, () => ctx.drawImage(img, x, y, w, h))
    ctx.restore()
    return
  }
  if (tag === 'VIDEO') {
    const vid = el as HTMLVideoElement
    if (vid.readyState >= 2 && vid.videoWidth > 0 && vid.videoHeight > 0) {
      withClip(ctx, x, y, w, h, radii, hasR, () => {
        if (cs.objectFit === 'cover') {
          const ir = vid.videoWidth / vid.videoHeight
          const dw = ir > w / h ? h * ir : w
          const dh = ir > w / h ? h : w / ir
          ctx.drawImage(vid, x + (w - dw) * 0.5, y + (h - dh) * 0.5, dw, dh)
        } else {
          ctx.drawImage(vid, x, y, w, h)
        }
      })
      if (!vid.paused && !vid.ended) onVideo ? onVideo(vid) : onAssetReady()
    }
    ctx.restore()
    return
  }
  if (tag === 'CANVAS') {
    const cvs = el as HTMLCanvasElement
    if (cvs.width > 0 && cvs.height > 0) withClip(ctx, x, y, w, h, radii, hasR, () => ctx.drawImage(cvs, x, y, w, h))
    ctx.restore()
    return
  }
  if (tag === 'SVG') {
    const clone = el.cloneNode(true) as SVGSVGElement
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(Math.round(w)))
    clone.setAttribute('height', String(Math.round(h)))
    const img = loadAsset(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`,
      onAssetReady,
    )
    if (img) ctx.drawImage(img, x, y, w, h)
    ctx.restore()
    return
  }

  if (cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden') {
    traceRoundedRect(ctx, x, y, w, h, radii)
    ctx.clip()
  }

  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) renderTextNode(ctx, child as Text, cs, targetRect)
  }

  const children = Array.from(el.children)
  const ordered =
    children.length <= 1
      ? children
      : children
          .map((c, idx) => {
            const z = getComputedStyle(c).zIndex
            return { el: c, z: z === 'auto' ? 0 : parseInt(z, 10) || 0, idx }
          })
          .sort((a, b) => (a.z !== b.z ? a.z - b.z : a.idx - b.idx))
          .map((k) => k.el)

  for (const c of ordered) paintElementTree(ctx, c, targetRect, snapScale, onAssetReady, false, onVideo, skip)
  ctx.restore()
}

function isTargetActive(entry: SnapEntry): boolean {
  if (!entry.isVisible || (typeof document !== 'undefined' && document.hidden)) return false
  if (!entry.consumers.size) return true
  for (const rec of entry.consumers.values()) {
    const el = rec.rootEl as (HTMLElement & { checkVisibility?: (o: object) => boolean }) | null
    if (!el || typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return true
    }
  }
  return false
}

function scheduleVideoFrame(entry: SnapEntry, video: HTMLVideoElement): void {
  entry.hasVideo = true
  if (!isTargetActive(entry)) {
    entry.deferred = true
    return
  }
  const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
    .requestVideoFrameCallback
  if (typeof rvfc !== 'function') {
    scheduleSnapshotRefresh(entry)
    return
  }
  if (entry.videoCbs.has(video)) return
  entry.videoCbs.add(video)
  rvfc.call(video, () => {
    entry.videoCbs.delete(video)
    if (!snapshotRegistry.has(entry.target)) return
    if (!isTargetActive(entry)) {
      entry.deferred = true
      return
    }
    if (nowMs() - entry.lastVideoAt < 32) {
      if (!video.paused && !video.ended) scheduleVideoFrame(entry, video)
      return
    }
    scheduleSnapshotRefresh(entry)
  })
}

function makeSnapshot(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  version: number,
  width: number,
  height: number,
  scale: number,
  cssWidth: number,
  cssHeight: number,
): TargetSnapshot {
  let cached: Uint8ClampedArray | null = null
  let failed = false
  return {
    canvas,
    version,
    width,
    height,
    scale,
    cssWidth,
    cssHeight,
    get data() {
      if (cached) return cached
      if (failed) return EMPTY_U8C
      try {
        return (cached = ctx.getImageData(0, 0, width, height).data)
      } catch {
        failed = true
        return EMPTY_U8C
      }
    },
  }
}

function resolveGlassScope(rootEl: HTMLElement, targetEl: HTMLElement): HTMLElement {
  for (let cur = rootEl.parentElement; cur && cur !== targetEl; cur = cur.parentElement) {
    if (cur.hasAttribute('data-lg-root')) return rootEl
    if (cur.hasAttribute('data-lg-ignore')) return cur
  }
  return rootEl
}

function getStackingPath(el: HTMLElement, root: HTMLElement): { el: HTMLElement; z: number }[] {
  const path: { el: HTMLElement; z: number }[] = []
  for (let cur: HTMLElement | null = el; cur && cur !== root; cur = cur.parentElement) {
    const cs = getComputedStyle(cur)
    const z = cs.zIndex !== 'auto' ? parseInt(cs.zIndex, 10) || 0 : 0
    const sc =
      cs.zIndex !== 'auto' ||
      cs.position === 'fixed' ||
      cs.position === 'sticky' ||
      parseFloat(cs.opacity) < 0.999 ||
      cs.transform !== 'none' ||
      cs.isolation === 'isolate' ||
      cs.filter !== 'none' ||
      cs.backdropFilter !== 'none'
    if (cur === el || sc) path.push({ el: cur, z })
  }
  return path.reverse()
}

function comparePaintOrder(a: HTMLElement, b: HTMLElement, root: HTMLElement): number {
  if (a === b) return 0
  if (a.contains(b)) return -1
  if (b.contains(a)) return 1
  const pA = getStackingPath(a, root)
  const pB = getStackingPath(b, root)
  const len = Math.min(pA.length, pB.length)
  for (let i = 0; i < len; i++) {
    if (pA[i].el === pB[i].el) continue
    if (pA[i].z !== pB[i].z) return pA[i].z - pB[i].z
    return pA[i].el.compareDocumentPosition(pB[i].el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  }
  return pA.length - pB.length
}

const rectsOverlap = (a: DOMRect, b: DOMRect): boolean =>
  a.left < b.right + 64 && a.right > b.left - 64 && a.top < b.bottom + 64 && a.bottom > b.top - 64

function getScopeRect(rec: ConsumerRec, now: number): DOMRect | null {
  if (!rec.scopeEl) return null
  if (rec.cachedRect && now - rec.cachedRectAt < 12) return rec.cachedRect
  rec.cachedRectAt = now
  return (rec.cachedRect = rec.scopeEl.getBoundingClientRect())
}

function notifyScopesAbove(entry: SnapEntry, scopes: Iterable<HTMLElement>): void {
  const scopeSet = new Set(scopes)
  if (!scopeSet.size || entry.consumers.size <= 1) return
  const now = nowMs()
  const scopeRects = new Map<HTMLElement, DOMRect>()
  for (const s of scopeSet) scopeRects.set(s, s.getBoundingClientRect())

  const toNotify: ConsumerRec[] = []
  for (const rec of entry.consumers.values()) {
    const recRect = getScopeRect(rec, now)
    if (!rec.scopeEl || !recRect) continue
    for (const s of scopeSet) {
      if (rec.scopeEl === s) continue
      if (
        (rec.lastOverlapped.has(s) || rectsOverlap(scopeRects.get(s)!, recRect)) &&
        comparePaintOrder(s, rec.scopeEl, entry.target) < 0
      ) {
        toNotify.push(rec)
        break
      }
    }
  }
  if (toNotify.length > 1) toNotify.sort((a, b) => comparePaintOrder(a.scopeEl!, b.scopeEl!, entry.target))
  for (const rec of toNotify) rec.onUpdate()
}

function captureSnapshotNow(entry: SnapEntry): void {
  entry.rafId = 0
  entry.deferred = false
  const rect = entry.target.getBoundingClientRect()
  const cssW = Math.max(0, Math.round(rect.width))
  const cssH = Math.max(0, Math.round(rect.height))
  if (cssW < 2 || cssH < 2) {
    entry.snapshot = null
    return
  }

  const rawDpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, entry.hasVideo ? 1 : 2) : 1
  const cap = Math.min(rawDpr, (entry.hasVideo ? 960 : 2200) / cssW, (entry.hasVideo ? 960 : 2200) / cssH)
  const scale = Math.max(entry.hasVideo ? 0.5 : 1, Math.min(rawDpr, cap > 0 ? cap : 1))
  const bufW = Math.max(2, Math.round(cssW * scale))
  const bufH = Math.max(2, Math.round(cssH * scale))
  if (entry.canvas.width !== bufW) entry.canvas.width = bufW
  if (entry.canvas.height !== bufH) entry.canvas.height = bufH

  const { ctx } = entry
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, bufW, bufH)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)

  entry.hasVideo = false
  paintElementTree(
    ctx,
    entry.target,
    rect,
    scale,
    () => scheduleSnapshotRefresh(entry),
    true,
    (v) => scheduleVideoFrame(entry, v),
  )
  if (entry.hasVideo) entry.lastVideoAt = nowMs()

  entry.snapshot = makeSnapshot(entry.canvas, ctx, ++entry.version, bufW, bufH, scale, cssW, cssH)

  const list = Array.from(entry.consumers.values())
  if (list.length > 1 && list.length <= 16) {
    list.sort((a, b) => (a.scopeEl && b.scopeEl ? comparePaintOrder(a.scopeEl, b.scopeEl, entry.target) : 0))
  }
  for (const rec of list) rec.onUpdate()
}

function scheduleSnapshotRefresh(entry: SnapEntry): void {
  if (!isTargetActive(entry)) {
    entry.deferred = true
    return
  }
  if (!entry.rafId && typeof requestAnimationFrame !== 'undefined') {
    entry.rafId = requestAnimationFrame(() => captureSnapshotNow(entry))
  }
}

function releaseConsumerBuffers(rec: ConsumerRec): void {
  if (rec.compCanvas) {
    rec.compCanvas.width = rec.compCanvas.height = 0
    rec.compCanvas = rec.compCtx = null
  }
  rec.compSnapshot = null
}

export function getTargetSnapshot(target: HTMLElement, rootEl?: HTMLElement | null): TargetSnapshot | null {
  const entry = snapshotRegistry.get(target)
  if (!entry) return null
  if (entry.deferred && isTargetActive(entry)) {
    entry.deferred = false
    scheduleSnapshotRefresh(entry)
  }
  const base = entry.snapshot
  if (!base || !rootEl || entry.consumers.size <= 1) return base

  const cScope = resolveGlassScope(rootEl, target)
  let cRec: ConsumerRec | undefined
  for (const rec of entry.consumers.values()) {
    if (rec.rootEl === rootEl) {
      cRec = rec
      break
    }
  }
  if (!cRec) return base

  const now = nowMs()
  const cRect = getScopeRect(cRec, now) ?? cScope.getBoundingClientRect()
  const lower: HTMLElement[] = []
  const seen = new Set<HTMLElement>()
  const skip = new Set<Element>([cScope, rootEl])

  for (const rec of entry.consumers.values()) {
    const oScope = rec.scopeEl
    if (!oScope || oScope === cScope) continue
    const oRect = getScopeRect(rec, now)
    if (!oRect || !rectsOverlap(oRect, cRect)) continue
    if (comparePaintOrder(oScope, cScope, target) >= 0) {
      skip.add(oScope)
      continue
    }
    if (!seen.has(oScope)) {
      seen.add(oScope)
      lower.push(oScope)
    }
  }

  cRec.lastOverlapped = new Set(lower)
  if (!lower.length) {
    releaseConsumerBuffers(cRec)
    return base
  }

  lower.sort((a, b) => comparePaintOrder(a, b, target))
  if (!cRec.compCanvas) {
    cRec.compCanvas = document.createElement('canvas')
    cRec.compCtx = cRec.compCanvas.getContext('2d')
  }
  const { compCanvas, compCtx } = cRec
  if (!compCtx) return base
  if (compCanvas.width !== base.width) compCanvas.width = base.width
  if (compCanvas.height !== base.height) compCanvas.height = base.height

  compCtx.setTransform(1, 0, 0, 1, 0, 0)
  compCtx.clearRect(0, 0, base.width, base.height)
  compCtx.drawImage(base.canvas, 0, 0)
  compCtx.setTransform(base.scale, 0, 0, base.scale, 0, 0)

  const targetRect = target.getBoundingClientRect()
  const sched = () => scheduleSnapshotRefresh(entry)
  const onVid = (v: HTMLVideoElement) => scheduleVideoFrame(entry, v)
  for (const ls of lower) paintElementTree(compCtx, ls, targetRect, base.scale, sched, true, onVid, skip)

  return (cRec.compSnapshot = makeSnapshot(
    compCanvas,
    compCtx,
    ++cRec.compVersion,
    base.width,
    base.height,
    base.scale,
    base.cssWidth,
    base.cssHeight,
  ))
}

export function notifyGlassRedrawn(target: HTMLElement, rootEl: HTMLElement | null): void {
  const entry = snapshotRegistry.get(target)
  if (!entry || !rootEl || entry.consumers.size <= 1) return
  const scopeEl = resolveGlassScope(rootEl, target)
  if (entry.notifyingScopes.has(scopeEl)) return
  entry.notifyingScopes.add(scopeEl)
  try {
    notifyScopesAbove(entry, [scopeEl])
  } finally {
    entry.notifyingScopes.delete(scopeEl)
  }
}

export function subscribeTargetSnapshot(
  target: HTMLElement,
  onUpdate: () => void,
  rootEl?: HTMLElement | null,
): () => void {
  if (typeof document === 'undefined' || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }

  let entry = snapshotRegistry.get(target)
  if (!entry) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return () => {}

    const created: SnapEntry = {
      target,
      canvas,
      ctx,
      snapshot: null,
      version: 0,
      isVisible: true,
      deferred: false,
      hasVideo: false,
      lastVideoAt: 0,
      videoCbs: new WeakSet(),
      consumers: new Map(),
      notifyingScopes: new Set(),
      dirtyScopes: new Set(),
      dirtyRaf: 0,
      rafId: 0,
      io: null,
      onMedia: () => scheduleSnapshotRefresh(created),
      onVis: () => {
        if (isTargetActive(created) && created.deferred) {
          created.deferred = false
          scheduleSnapshotRefresh(created)
        }
      },
      ro: new ResizeObserver(() => scheduleSnapshotRefresh(created)),
      mo: new MutationObserver((records) => {
        for (const rec of records) {
          const el = rec.target instanceof Element ? rec.target : rec.target.parentElement
          if (!el || el.closest('[data-lg-root]')) continue
          const ignored = el.closest('[data-lg-ignore]')
          if (ignored instanceof HTMLElement && ignored !== created.target) {
            created.dirtyScopes.add(ignored)
            if (!created.dirtyRaf && typeof requestAnimationFrame !== 'undefined') {
              created.dirtyRaf = requestAnimationFrame(() => {
                created.dirtyRaf = 0
                if (!created.dirtyScopes.size) return
                const scopes = Array.from(created.dirtyScopes)
                created.dirtyScopes.clear()
                notifyScopesAbove(created, scopes)
              })
            }
            continue
          }
          scheduleSnapshotRefresh(created)
          break
        }
      }),
    }

    if (typeof IntersectionObserver !== 'undefined') {
      created.io = new IntersectionObserver(
        (entries) => {
          const hit = entries[entries.length - 1]
          if (!hit) return
          created.isVisible = hit.isIntersecting
          if (hit.isIntersecting && created.deferred && !document.hidden) {
            created.deferred = false
            scheduleSnapshotRefresh(created)
          }
        },
        { rootMargin: '200px' },
      )
      created.io.observe(target)
    }

    created.ro.observe(target)
    created.mo.observe(target, { childList: true, subtree: true, attributes: true, characterData: true })
    for (const evt of ['loadeddata', 'play', 'seeked'] as const) target.addEventListener(evt, created.onMedia, true)
    document.addEventListener('visibilitychange', created.onVis)
    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (snapshotRegistry.has(target)) scheduleSnapshotRefresh(created)
      })
    }

    snapshotRegistry.set(target, created)
    captureSnapshotNow(created)
    entry = created
    notifySnapshotStats()
  }

  const resolvedRoot = rootEl ?? null
  entry.consumers.set(onUpdate, {
    onUpdate,
    rootEl: resolvedRoot,
    scopeEl: resolvedRoot ? resolveGlassScope(resolvedRoot, target) : null,
    compCanvas: null,
    compCtx: null,
    compVersion: 0,
    compSnapshot: null,
    lastOverlapped: new Set(),
    cachedRect: null,
    cachedRectAt: 0,
  })
  if (!entry.snapshot) captureSnapshotNow(entry)

  return () => {
    const cur = snapshotRegistry.get(target)
    if (!cur) return
    const rec = cur.consumers.get(onUpdate)
    if (rec) {
      releaseConsumerBuffers(rec)
      cur.consumers.delete(onUpdate)
    }
    if (!cur.consumers.size) {
      if (cur.rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(cur.rafId)
      if (cur.dirtyRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(cur.dirtyRaf)
      cur.ro.disconnect()
      cur.mo.disconnect()
      cur.io?.disconnect()
      for (const evt of ['loadeddata', 'play', 'seeked'] as const) target.removeEventListener(evt, cur.onMedia, true)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', cur.onVis)
      releaseWebGLSnapshot(cur.canvas)
      cur.canvas.width = cur.canvas.height = 0
      snapshotRegistry.delete(target)
      notifySnapshotStats()
    }
  }
}
