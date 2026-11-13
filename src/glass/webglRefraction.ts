import type { TargetSnapshot } from './domSnapshot'

export interface WebGLBevelParams {
  width: number
  height: number
  borderRadius: number
  effectiveDepth: number
  maxRadialSlope: number
  splayExp: number
  cornerExponent: number
  bufWidth: number
  bufHeight: number
}

interface CachedSnapTexture {
  tex: WebGLTexture
  version: number
  width: number
  height: number
}

interface GlState {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  program: WebGLProgram
  posBuf: WebGLBuffer
  uSnapshot: WebGLUniformLocation | null
  uSize: WebGLUniformLocation | null
  uHalfSize: WebGLUniformLocation | null
  uBoxHalf: WebGLUniformLocation | null
  uRadius: WebGLUniformLocation | null
  uEffectiveDepth: WebGLUniformLocation | null
  uSplayExp: WebGLUniformLocation | null
  uCornerExp: WebGLUniformLocation | null
  uSnapOffset: WebGLUniformLocation | null
  uSnapSize: WebGLUniformLocation | null
  uSnapTexel: WebGLUniformLocation | null
  uDispCssPx: WebGLUniformLocation | null
  uSpread: WebGLUniformLocation | null
  uTint: WebGLUniformLocation | null
  textures: WeakMap<HTMLCanvasElement, CachedSnapTexture>
  contextLost: boolean
}

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAG_SRC = `
precision highp float;
varying vec2 v_uv;

uniform sampler2D u_snapshot;
uniform vec2 u_size;
uniform vec2 u_halfSize;
uniform vec2 u_boxHalf;
uniform float u_radius;
uniform float u_effectiveDepth;
uniform float u_splayExp;
uniform float u_cornerExp;
uniform vec2 u_snapOffset;
uniform vec2 u_snapSize;
uniform vec2 u_snapTexel;
uniform float u_dispCssPx;
uniform float u_spread;
uniform vec4 u_tint;

float evalBevelMag(float u, float p) {
  if (u <= 0.0) return 0.0;
  if (u >= 1.0) return 1.0;
  float c0 = (p + 1.0) * (p + 2.0);
  float c1 = -2.0 * (p - 1.0) * (p + 2.0);
  float c2 = (p - 1.0) * p;
  return (pow(u, p) * (c0 + c1 * u + c2 * u * u)) / 6.0;
}

vec4 sampleSnap(vec2 cssPos) {
  vec2 uv = (u_snapOffset + cssPos) / u_snapSize;
  uv = clamp(uv, u_snapTexel, 1.0 - u_snapTexel);
  return texture2D(u_snapshot, uv);
}

void main() {
  if (u_effectiveDepth <= 0.5 || u_dispCssPx <= 0.001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 fragCss = v_uv * u_size;
  vec2 rel = fragCss - u_halfSize;
  float cx = abs(rel.x);
  float cy = abs(rel.y);

  float qx = cx - u_boxHalf.x;
  float qy = cy - u_boxHalf.y;
  float ox = max(qx, 0.0);
  float oy = max(qy, 0.0);
  float outLen = length(vec2(ox, oy));
  float sd = outLen + min(max(qx, qy), 0.0) - u_radius;

  if (sd > 0.75) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float distInward = sd < 0.0 ? -sd : 0.0;
  if (distInward >= u_effectiveDepth) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float outerAlpha = sd <= 0.0 ? 1.0 : 1.0 - sd / 0.75;
  float u = clamp(1.0 - distInward / u_effectiveDepth, 0.0, 1.0);
  float innerAlpha = smoothstep(0.0, 0.08, u);
  float bevelAlpha = outerAlpha * innerAlpha;
  if (bevelAlpha <= 0.002) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float mag = evalBevelMag(u, u_splayExp) * outerAlpha;

  float ux = 0.0;
  float uy = 0.0;
  if (ox > 0.0 && oy > 0.0) {
    float n1 = u_cornerExp - 1.0;
    float gx = pow(ox, n1);
    float gy = pow(oy, n1);
    float gl = length(vec2(gx, gy));
    if (gl > 0.0) {
      ux = gx / gl;
      uy = gy / gl;
    }
  } else if (outLen > 1e-6) {
    ux = ox / outLen;
    uy = oy / outLen;
  } else if (qx > qy) {
    ux = 1.0;
  } else if (qy > qx) {
    uy = 1.0;
  } else {
    ux = 0.70710678;
    uy = 0.70710678;
  }

  float sxSign = fragCss.x < u_halfSize.x ? 1.0 : -1.0;
  float sySign = fragCss.y < u_halfSize.y ? 1.0 : -1.0;
  vec2 disp = vec2(ux * sxSign, uy * sySign) * (mag * u_dispCssPx);

  vec3 rgb;
  float sA;
  if (u_spread <= 0.0005) {
    vec4 s = sampleSnap(fragCss + disp);
    rgb = s.rgb;
    sA = s.a;
  } else {
    float m0 = 1.0 - u_spread;
    float m1 = 1.0 - u_spread * 0.5;
    float m3 = 1.0 + u_spread * 0.5;
    float m4 = 1.0 + u_spread;

    vec4 s0 = sampleSnap(fragCss + disp * m0);
    vec4 s1 = sampleSnap(fragCss + disp * m1);
    vec4 s2 = sampleSnap(fragCss + disp);
    vec4 s3 = sampleSnap(fragCss + disp * m3);
    vec4 s4 = sampleSnap(fragCss + disp * m4);

    rgb.r = s0.r * 0.65 + s1.r * 0.35;
    rgb.g = s1.g * 0.22 + s2.g * 0.56 + s3.g * 0.22;
    rgb.b = s3.b * 0.35 + s4.b * 0.65;
    sA = s2.a;
  }

  float outA = bevelAlpha * sA;
  if (u_tint.a > 0.001) {
    rgb = mix(rgb, u_tint.rgb, u_tint.a);
  }

  gl_FragColor = vec4(rgb, outA);
}
`

let glState: GlState | null = null
let glSupported: boolean | null = null

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function initGlState(): GlState | null {
  if (glSupported === false) return null
  if (glState && !glState.contextLost) return glState
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256

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

  if (!gl) {
    glSupported = false
    return null
  }

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs)
    if (fs) gl.deleteShader(fs)
    glSupported = false
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    glSupported = false
    return null
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    glSupported = false
    return null
  }

  const posBuf = gl.createBuffer()
  if (!posBuf) {
    gl.deleteProgram(program)
    glSupported = false
    return null
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  const aPos = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  gl.useProgram(program)

  const state: GlState = {
    canvas,
    gl,
    program,
    posBuf,
    uSnapshot: gl.getUniformLocation(program, 'u_snapshot'),
    uSize: gl.getUniformLocation(program, 'u_size'),
    uHalfSize: gl.getUniformLocation(program, 'u_halfSize'),
    uBoxHalf: gl.getUniformLocation(program, 'u_boxHalf'),
    uRadius: gl.getUniformLocation(program, 'u_radius'),
    uEffectiveDepth: gl.getUniformLocation(program, 'u_effectiveDepth'),
    uSplayExp: gl.getUniformLocation(program, 'u_splayExp'),
    uCornerExp: gl.getUniformLocation(program, 'u_cornerExp'),
    uSnapOffset: gl.getUniformLocation(program, 'u_snapOffset'),
    uSnapSize: gl.getUniformLocation(program, 'u_snapSize'),
    uSnapTexel: gl.getUniformLocation(program, 'u_snapTexel'),
    uDispCssPx: gl.getUniformLocation(program, 'u_dispCssPx'),
    uSpread: gl.getUniformLocation(program, 'u_spread'),
    uTint: gl.getUniformLocation(program, 'u_tint'),
    textures: new WeakMap(),
    contextLost: false,
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    state.contextLost = true
    glState = null
  })
  canvas.addEventListener('webglcontextrestored', () => {
    glState = null
  })

  glState = state
  glSupported = true
  return state
}

export function isWebGLRefractionAvailable(): boolean {
  return initGlState() !== null
}

/** Parses CSS computed `rgb(...)` / `rgba(...)` into normalized `[r, g, b, a]`, or `null` if unparsed. */
export function parseCssColorRgba(color: string): [number, number, number, number] | null {
  if (!color) return null
  const m = /^rgba?\(([^)]+)\)$/i.exec(color.trim())
  if (!m) return null
  const body = m[1].trim()
  let rgbParts: string[]
  let alphaStr: string | undefined
  if (body.includes('/')) {
    const [left, right] = body.split('/')
    rgbParts = left.trim().split(/[\s,]+/)
    alphaStr = right.trim()
  } else {
    rgbParts = body.split(',').map((s) => s.trim())
    alphaStr = rgbParts[3]
  }
  if (rgbParts.length < 3) return null
  const r = parseFloat(rgbParts[0]) / 255
  const g = parseFloat(rgbParts[1]) / 255
  const b = parseFloat(rgbParts[2]) / 255
  const a = alphaStr !== undefined ? parseFloat(alphaStr) : 1
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) {
    return null
  }
  return [
    r < 0 ? 0 : r > 1 ? 1 : r,
    g < 0 ? 0 : g > 1 ? 1 : g,
    b < 0 ? 0 : b > 1 ? 1 : b,
    a < 0 ? 0 : a > 1 ? 1 : a,
  ]
}

export function renderRefractedBevelWebGL(
  targetCtx: CanvasRenderingContext2D,
  field: WebGLBevelParams,
  snapshot: TargetSnapshot,
  offsetX: number,
  offsetY: number,
  dispCssPx: number,
  spread: number,
  tintRgba: [number, number, number, number] | null,
): boolean {
  const state = initGlState()
  if (!state) return false

  const { gl, canvas } = state
  if (gl.isContextLost()) {
    state.contextLost = true
    glState = null
    return false
  }

  const { bufWidth, bufHeight } = field
  if (canvas.width < bufWidth || canvas.height < bufHeight) {
    canvas.width = Math.max(canvas.width, bufWidth)
    canvas.height = Math.max(canvas.height, bufHeight)
  }

  let texEntry = state.textures.get(snapshot.canvas)
  if (!texEntry) {
    const tex = gl.createTexture()
    if (!tex) return false
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    texEntry = { tex, version: -1, width: 0, height: 0 }
    state.textures.set(snapshot.canvas, texEntry)
  } else {
    gl.bindTexture(gl.TEXTURE_2D, texEntry.tex)
  }

  if (
    texEntry.version !== snapshot.version ||
    texEntry.width !== snapshot.width ||
    texEntry.height !== snapshot.height
  ) {
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshot.canvas)
    } catch {
      return false
    }
    texEntry.version = snapshot.version
    texEntry.width = snapshot.width
    texEntry.height = snapshot.height
  }

  gl.viewport(0, 0, bufWidth, bufHeight)
  gl.enable(gl.SCISSOR_TEST)
  gl.scissor(0, 0, bufWidth, bufHeight)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const hw = field.width * 0.5
  const hh = field.height * 0.5
  const bx = Math.max(0, hw - field.borderRadius)
  const by = Math.max(0, hh - field.borderRadius)

  gl.uniform1i(state.uSnapshot, 0)
  gl.uniform2f(state.uSize, field.width, field.height)
  gl.uniform2f(state.uHalfSize, hw, hh)
  gl.uniform2f(state.uBoxHalf, bx, by)
  gl.uniform1f(state.uRadius, field.borderRadius)
  gl.uniform1f(state.uEffectiveDepth, field.effectiveDepth)
  gl.uniform1f(state.uSplayExp, field.splayExp)
  gl.uniform1f(state.uCornerExp, field.cornerExponent)
  gl.uniform2f(state.uSnapOffset, offsetX, offsetY)
  gl.uniform2f(state.uSnapSize, snapshot.cssWidth, snapshot.cssHeight)
  gl.uniform2f(state.uSnapTexel, 0.5 / snapshot.width, 0.5 / snapshot.height)
  gl.uniform1f(state.uDispCssPx, dispCssPx)
  gl.uniform1f(state.uSpread, spread)
  if (tintRgba) {
    gl.uniform4f(state.uTint, tintRgba[0], tintRgba[1], tintRgba[2], tintRgba[3])
  } else {
    gl.uniform4f(state.uTint, 0, 0, 0, 0)
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  targetCtx.clearRect(0, 0, bufWidth, bufHeight)
  targetCtx.drawImage(canvas, 0, canvas.height - bufHeight, bufWidth, bufHeight, 0, 0, bufWidth, bufHeight)
  return true
}
