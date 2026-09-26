// src/ui/celebrate.js
// Efecto festivo liviano e independiente de página. A diferencia de
// starfield.js::spawnFireworks (que depende del <canvas id="starfield">,
// presente hoy solo en index.html/premium.html — ver initStarfield, hace
// document.getElementById('starfield') y no-opea si no existe), este no usa
// canvas ni loop de animación propio: unos pocos <span> con una animación
// CSS, montados en un overlay `position: fixed` en <body> (para no quedar
// recortados por ningún ancestro con overflow:hidden). Pensado para
// /cuenta y /rutina, que no cargan el starfield.
const EMOJIS = ['🎉', '✨', '⭐', '🎊'];
const COUNT = 8;

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// anchorEl: elemento DOM cerca del cual anclar el efecto (se usa su
// getBoundingClientRect() como centro). Si no se pasa o no tiene rect,
// cae al centro del viewport.
export function celebrateBurst(anchorEl) {
  if (typeof document === 'undefined') return;
  if (prefersReducedMotion()) return;

  const rect =
    anchorEl && typeof anchorEl.getBoundingClientRect === 'function'
      ? anchorEl.getBoundingClientRect()
      : null;
  const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;

  const layer = document.createElement('div');
  layer.className = 'celebrate-layer';
  document.body.appendChild(layer);

  let pending = COUNT;
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (layer.parentNode) layer.parentNode.removeChild(layer);
  };
  const onOneDone = () => {
    pending -= 1;
    if (pending <= 0) cleanup();
  };

  for (let i = 0; i < COUNT; i++) {
    const span = document.createElement('span');
    span.className = 'celebrate-particle';
    span.textContent = EMOJIS[i % EMOJIS.length];
    const angle = (Math.PI * 2 * i) / COUNT + Math.random() * 0.4;
    const dist = 40 + Math.random() * 40;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 24; // leve sesgo hacia arriba
    const rot = Math.round(Math.random() * 60 - 30);
    const delay = (Math.random() * 0.15).toFixed(2);
    span.style.left = `${cx}px`;
    span.style.top = `${cy}px`;
    span.style.setProperty('--cx', `${dx.toFixed(0)}px`);
    span.style.setProperty('--cy', `${dy.toFixed(0)}px`);
    span.style.setProperty('--rot', `${rot}deg`);
    span.style.animationDelay = `${delay}s`;
    span.addEventListener('animationend', onOneDone, { once: true });
    layer.appendChild(span);
  }

  // Red de seguridad: si animationend no llega por algún motivo (pestaña en
  // segundo plano, etc.), igual se limpia el overlay.
  setTimeout(cleanup, 1600);
}
