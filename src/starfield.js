// Fondo espacial místico: nebulosas de colores que giran con el scroll,
// estrellas en 3D que avanzan como un viaje y dejan estelas al acelerar,
// y estrellas fugaces de vez en cuando. El viaje espacial es parte de la
// identidad de la app: siempre se anima, aunque el sistema pida reducir
// movimiento (el usuario lo pide explícitamente).

const COLORS = ['#ffffff', '#93c5fd', '#c4b5fd', '#f9a8d4', '#a5f3fc'];

export function initStarfield() {
  const canvas = document.getElementById('starfield');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let stars = [];
  let shooting = [];
  let speed = 0.35;
  let scrollBoost = 0;
  let lastY = window.scrollY;
  let resizeT = null;

  // Nebulosas místicas: nubes de color que respiran y giran; el scroll las
  // hace rotar (el viaje gira a tu alrededor).
  const nebulae = [
    { hue: '167,139,250', x: 0.2, y: 0.3, r: 0.44, phase: 0, spin: 1 },
    { hue: '96,165,250', x: 0.82, y: 0.22, r: 0.36, phase: 2.1, spin: -0.8 },
    { hue: '244,114,182', x: 0.5, y: 0.78, r: 0.46, phase: 4.2, spin: 1.25 },
  ];

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(260, Math.floor((w * h) / 5200));
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random() * 0.9 + 0.1,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        tw: Math.random() * Math.PI * 2,
        _px: undefined,
        _py: undefined,
      });
    }
  }

  // El desplazamiento del usuario impulsa un viaje suave y sutil: antes el
  // impulso era tan fuerte que al hacer scroll las estrellas hacían estelas
  // por todas partes (se veía como un glitch). Ahora es un leve desplazamiento.
  function onScroll() {
    const delta = window.scrollY - lastY;
    lastY = window.scrollY;
    scrollBoost = Math.max(-0.9, Math.min(0.9, delta * 0.012));
    clearTimeout(onScroll._t);
    onScroll._t = setTimeout(() => (scrollBoost = 0), 250);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  function spawnShooting() {
    shooting.push({
      x: Math.random() * w * 0.8 + w * 0.1,
      y: Math.random() * h * 0.5,
      vx: (Math.random() * 6 + 5) * (Math.random() < 0.5 ? -1 : 1),
      vy: Math.random() * 3 + 2,
      life: 1,
    });
  }

  function frame() {
    // FIX (auditoría P7 2026-09-03): este loop corría para siempre sin
    // importar la pestaña — a diferencia de drawVisual() (main.js), que se
    // congela con document.hidden. Mismo criterio acá: en segundo plano
    // nadie ve el fondo, así que se salta el trabajo de dibujo (pero se
    // sigue reprogramando el rAF, igual que drawVisual, para no necesitar un
    // listener de visibilitychange aparte que lo reanude).
    if (document.hidden) {
      if (!paused) requestAnimationFrame(frame);
      return;
    }
    ctx.clearRect(0, 0, w, h);
    const sp = speed + scrollBoost;
    const rot = window.scrollY * 0.00035;

    // Nebulosas: giran con el scroll y respiran lentamente.
    for (const n of nebulae) {
      n.phase += 0.0016 * n.spin + scrollBoost * 0.0016 * n.spin;
      const a = n.phase + rot * n.spin;
      const cx = w * n.x + Math.cos(a) * w * 0.05;
      const cy = h * n.y + Math.sin(a) * h * 0.05;
      const r = Math.min(w, h) * n.r * (1 + Math.sin(a) * 0.07);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${n.hue},0.17)`);
      g.addColorStop(0.6, `rgba(${n.hue},0.06)`);
      g.addColorStop(1, `rgba(${n.hue},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Estrellas 3D: viajan hacia el espectador; al deslizar muy rápido dejan
    // estelas luminosas (sensación de atravesar el espacio).
    for (const s of stars) {
      const prevPx = s._px;
      const prevPy = s._py;
      s.z -= sp * 0.0016 * (1.1 - s.z) * 2;
      if (s.z <= 0.02) {
        s.z = 1;
        s.x = Math.random() * w;
        s.y = Math.random() * h;
        s._px = undefined;
        s._py = undefined;
        continue;
      }
      s.tw += 0.05;
      const twinkle = 0.65 + 0.35 * Math.sin(s.tw);
      const scale = 1 / s.z;
      const px = s.x + (s.x - w / 2) * (scale - 1) * 0.06;
      const py = s.y + (s.y - h / 2) * (scale - 1) * 0.06;
      const size = Math.min(2.6, 1.4 * scale) * twinkle;
      ctx.globalAlpha = Math.min(1, twinkle * (1.05 - s.z));
      ctx.fillStyle = s.color;
      if (sp > 1.1 && prevPx != null) {
        ctx.globalAlpha *= 0.45;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(0.6, size * 0.7);
        ctx.beginPath();
        ctx.moveTo(prevPx, prevPy);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.globalAlpha = Math.min(1, twinkle * (1.05 - s.z));
      }
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
      s._px = px;
      s._py = py;
    }
    ctx.globalAlpha = 1;

    // Estrellas fugaces ocasionales.
    if (Math.random() < 0.004) spawnShooting();
    for (let i = shooting.length - 1; i >= 0; i--) {
      const sh = shooting[i];
      sh.x += sh.vx;
      sh.y += sh.vy;
      sh.life -= 0.012;
      if (sh.life <= 0 || sh.x < -80 || sh.x > w + 80 || sh.y > h + 80) {
        shooting.splice(i, 1);
        continue;
      }
      const tail = 3;
      const grad = ctx.createLinearGradient(
        sh.x,
        sh.y,
        sh.x - sh.vx * tail,
        sh.y - sh.vy * tail,
      );
      grad.addColorStop(0, `rgba(255,255,255,${0.85 * sh.life})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(sh.x - sh.vx * tail, sh.y - sh.vy * tail);
      ctx.stroke();
    }

    if (!paused) requestAnimationFrame(frame);
  }

  // En modo cimática el fondo espacial se atenúa (solo CSS) y no aporta
  // nada visual, así que se pausa su bucle para no gastar CPU junto a la
  // simulación de la placa; al volver al modo gotas se reanuda.
  let paused = false;

  resize();
  // Con retardo: en móvil la barra del navegador redimensiona la ventana
  // varias veces seguidas al hacer scroll y repoblar las estrellas a cada
  // frame las hace "saltar" (glitch).
  window.addEventListener(
    'resize',
    () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(resize, 120);
    },
    { passive: true },
  );
  frame();
  return {
    setPaused(p) {
      if (paused === !!p) return;
      paused = !!p;
      if (!paused) requestAnimationFrame(frame);
    },
  };
}
