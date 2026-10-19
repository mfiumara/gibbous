// The Moon as it is tonight, huge and faint behind the app. Two baked near-side textures (LRO albedo + LOLA relief
// normals, scripts/icon/textures.py) lit by a tiny WebGL shader for the current phase, tilted the way it stands in
// your sky (moon.ts), reddened during a lunar eclipse. Redrawn every ten minutes; nothing animates while you work.
import { useEffect, useRef } from 'react';
import { moonSky, locate } from './moon';

// Phase and geometry live in moon.ts; re-exported for older imports.
export { moonPhase } from './moon';

const VERT = `attribute vec2 p; varying vec2 uv; void main() { uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
const FRAG = `precision highp float;
varying vec2 uv; uniform sampler2D albedo, normal; uniform vec3 sun; uniform float px, rot, shadow, blood;
void main() {
  vec2 sq = uv * 2. - 1.;
  float r = length(sq);
  float edge = clamp((1. - r) / px, 0., 1.);                  // analytic, resolution-independent limb
  if (edge <= 0.) { gl_FragColor = vec4(0.); return; }
  // Screen → the Moon's own frame (lunar north up): everything below, lighting included, happens there.
  vec2 q = vec2(dot(sq, vec2(cos(rot), sin(rot))), dot(sq, vec2(-sin(rot), cos(rot))));
  vec2 t = vec2(q.x * .5 + .5, .5 - q.y * .5);
  vec3 a = pow(texture2D(albedo, t).rgb, vec3(2.2));
  vec3 n = normalize(texture2D(normal, t).rgb * 2. - 1.);
  vec3 n0 = vec3(q, sqrt(max(0., 1. - r * r)));
  float ci = dot(n, sun), ce = max(n.z, 1e-3);
  float shade = ci > 0. ? .35 * ci + .65 * 2. * ci / (ci + ce) : 0.;   // lunar-Lambert: the Moon's flat, bright look
  shade *= clamp(dot(n0, sun) * 18. + 1., 0., 1.);                    // rims catch light just past the terminator
  vec3 c = a * shade * 1.7;
  c += a * .045 * (.5 - .5 * sun.z) * clamp(1. - ci * 4., 0., 1.);    // earthshine: the ashen night side, strongest near new moon
  c = mix(c, c * vec3(1.15, .34, .17), blood) * (1. - shadow * .6); // eclipse: Earth's shadow, sunsets-red at totality
  c = c / (1. + c * .35);
  c = pow(clamp(c, 0., 1.), vec3(1. / 2.2));
  c = clamp(pow(c, vec3(1.35)) * 1.3, 0., 1.);                       // seen faintly, the maria/highland contrast is what reads
  float alpha = edge * clamp(max(c.r, max(c.g, c.b)) * 6., 0., 1.);  // the night side is simply absent
  gl_FragColor = vec4(c * alpha, alpha);
}`;

// Compile and upload once; the returned function relights for the current phase.
function setup(canvas: HTMLCanvasElement, imgs: HTMLImageElement[]) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  imgs.forEach((img, i) => {
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  });
  gl.uniform1i(gl.getUniformLocation(prog, 'albedo'), 0); gl.uniform1i(gl.getUniformLocation(prog, 'normal'), 1);
  gl.uniform1f(gl.getUniformLocation(prog, 'px'), 2.5 / canvas.width);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  return () => {
    const m = moonSky();
    gl.uniform3f(u('sun'), ...m.sun); gl.uniform1f(u('rot'), m.rot);
    gl.uniform1f(u('shadow'), m.shadow); gl.uniform1f(u('blood'), m.blood);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}

const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// Drawn with WebGL into a scratch canvas, then copied onto the visible (2D) canvas and the WebGL context released.
// A live WebGL context can be taken away at any time (GPU reset, sleep, a video going full screen, or the browser's cap
// on contexts when a preview page opens its own), and a lost one stays blank: the moon used to vanish that way.
function paint(target: HTMLCanvasElement, imgs: HTMLImageElement[]): boolean {
  const scratch = document.createElement('canvas');
  scratch.width = target.width; scratch.height = target.height;
  const render = setup(scratch, imgs);
  if (!render) return false;
  render();
  const ctx = target.getContext('2d');
  if (!ctx) return false;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(scratch, 0, 0);
  (scratch.getContext('webgl') as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

export function SkyMoon() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined, alive = true, imgs: HTMLImageElement[] | null = null;
    const draw = () => { const c = ref.current; if (alive && c && imgs && paint(c, imgs)) c.dataset.ready = ''; };
    const run = async () => {
      const c = ref.current;
      if (!c || document.documentElement.dataset.skymoon === 'off' || imgs) return;
      const got = await Promise.all([load('/moon/albedo.webp'), load('/moon/normal.webp')]).catch(() => null);
      if (!alive || !got || imgs) return;
      imgs = got;
      // Fixed backing size: the moon is a large soft background, 1536px of texture is its real detail ceiling.
      c.width = c.height = Math.min(1536, Math.round(c.clientWidth * Math.min(devicePixelRatio, 2)));
      draw();
      timer = setInterval(draw, 10 * 60_000);   // the tilt turns ~15°/hour as the Moon crosses your sky
      locate().then(draw);
    };
    // Back from sleep or a hidden tab: repaint (cheap), in case the canvas was discarded meanwhile.
    const back = () => { if (document.visibilityState === 'visible') draw(); };
    // Decorative: wait until the app itself is idle.
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
    idle(run);
    addEventListener('gibbous:prefs', run);
    document.addEventListener('visibilitychange', back);
    return () => { alive = false; clearInterval(timer); removeEventListener('gibbous:prefs', run); document.removeEventListener('visibilitychange', back); };
  }, []);
  return <><canvas ref={ref} aria-hidden className="sky-moon" /><div aria-hidden className="moon-wash" /></>;
}
