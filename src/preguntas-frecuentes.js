// src/preguntas-frecuentes.js
// Página /preguntas-frecuentes: acordeón accesible por grupos (generador,
// cuenta, alarmas/itinerarios/push, APK). Aditivo: si el JS no corre, las
// preguntas quedan visibles igual (los <details> no se necesitan).

const FAQ = {
  generator: [
    {
      q: '¿Necesito audífonos para que funcione?',
      a: 'Sí, es imprescindible. El efecto binaural se produce cuando cada oído recibe una sola frecuencia ligeramente distinta. Sin audífonos estéreo, ambos oídos escuchan la mezcla y el efecto desaparece.',
    },
    {
      q: '¿Es gratis? ¿Hay planes de pago?',
      a: 'Es 100% gratis y no hay planes de pago. El generador funciona sin cuenta y sin registrarte. La cuenta es opcional: solo sirve para sincronizar tus favoritos y frecuencias entre dispositivos.',
    },
    {
      q: '¿Qué es la portadora y qué es el ritmo?',
      a: 'La portadora es la frecuencia base que suena en ambos oídos (define el tono). El ritmo (o latido) es la diferencia entre lo que oye cada oído: 10 Hz de ritmo con portadora 220 Hz significa 220 Hz en un oído y 230 Hz en el otro. El efecto binaural depende solo del ritmo; la portadora cambia el timbre.',
    },
    {
      q: '¿Las ondas binaurales curan o inducen estados garantizados?',
      a: 'No. Son una herramienta de relajación con evidencia mixta y preliminar: algunas personas reportan calma o mejor concentración, pero no hay garantías. En Vyneural distinguimos siempre lo físico (la diferencia de frecuencias es exacta) de lo estimado (el efecto en el cerebro es variable y personal). No sustituyen el consejo médico.',
    },
    {
      q: '¿Puedo usarlas mientras conduzco o manejo maquinaria?',
      a: 'No. Como cualquier audio inmersivo, no las uses mientras conduces, operás maquinaria o necesitás atención plena. Mantené un volumen cómodo y seguro.',
    },
  ],
  cuenta: [
    {
      q: '¿Para qué sirve crear una cuenta?',
      a: 'Con una cuenta, tus favoritos, frecuencias personalizadas, alarmas, itinerarios y el estado de las notificaciones viven en la nube y viajan entre web, PWA y APK. Es opcional y gratuita: sin cuenta, todo sigue funcionando local.',
    },
    {
      q: '¿Por qué me piden confirmar el correo al registrarme?',
      a: 'Para proteger tu cuenta: si olvidás la contraseña, el correo confirmado es la vía segura para recuperarla. Te llega un enlace de confirmación (revisá el spam). Podés reenviarlo desde tu página de cuenta.',
    },
    {
      q: 'Olvidé mi contraseña, ¿cómo la recupero?',
      a: 'En el modal de inicio de sesión tocá “¿Olvidaste tu contraseña?”. Te enviamos un enlace válido por 30 minutos para crear una nueva. Al restablecerla, cerramos la sesión en todos tus dispositivos por seguridad.',
    },
    {
      q: '¿Qué datos guarda mi cuenta? ¿Hay rastreo?',
      a: 'Guardamos lo que vos creás: perfil, favoritos, frecuencias, alarmas, itinerarios y la suscripción de notificaciones. No hay publicidad, no hay rastreo entre sitios y podés pedir la baja de tus datos cuando quieras.',
    },
    {
      q: 'Cambié mi contraseña y me cerró la sesión en otros dispositivos. ¿Por qué?',
      a: 'Es una medida de seguridad: al cambiar la contraseña (o restablecerla), invalidamos las sesiones antiguas para que solo los dispositivos donde vuelvas a iniciar sesión con la nueva clave accedan a tu cuenta.',
    },
  ],
  alarmas: [
    {
      q: '¿Qué diferencia hay entre una alarma y un itinerario?',
      a: 'Una alarma es un recordatorio a una hora concreta (una vez o con repetición). Un itinerario es una secuencia planificada: una lista de frecuencias con su duración, en orden. En tu página de cuenta, cada itinerario tiene una vista de horario con sus pasos y sus alarmas.',
    },
    {
      q: '¿Las alarmas suenan solas en la web?',
      a: 'En la web/PWA, la alarma es un dato sincronizado: la ejecución depende del cliente (notificación local cuando la pestaña o la PWA está activa). La APK es la única que garantiza avisos con la app cerrada y pantalla bloqueada.',
    },
    {
      q: '¿Cómo funcionan las notificaciones push?',
      a: 'Con sesión iniciada podés activar push desde tu página de cuenta. El servidor guarda la suscripción de tu dispositivo y te avisa aunque cierres la pestaña (requiere HTTPS; en localhost funciona igual). Un aviso push nunca reproduce audio solo: vos decidís con un gesto.',
    },
    {
      q: '¿Por qué no me llegan las notificaciones?',
      a: 'Revisá: (1) que el dispositivo esté suscrito en tu página de cuenta (dice “este dispositivo ya está suscrito”), (2) que el navegador no tenga bloqueado el permiso de notificaciones, y (3) que estés en un contexto seguro (HTTPS o localhost).',
    },
    {
      q: '¿Qué es un itinerario sin pasos?',
      a: 'Un itinerario puede existir solo como ancla de horario: sin pasos, funciona como un aviso de “arrancá tu sesión” a la hora que definas. Con pasos, además muestra la secuencia completa con sus duraciones.',
    },
  ],
  apk: [
    {
      q: '¿En qué se diferencia la APK de la web?',
      a: 'La cuenta, los favoritos y la sincronización son idénticos en todas las plataformas. La APK suma lo que la web no puede garantizar: audio nativo en segundo plano y con pantalla bloqueada, controles en la pantalla de bloqueo, alarmas exactas con la app cerrada y recuperación ante cierres forzados. Funciona sin internet.',
    },
    {
      q: '¿Las alarmas de la APK aparecen en la app de Reloj del teléfono?',
      a: 'No. Android no permite que las apps escriban en la app de Reloj. La hora la dispara el sistema y Vyneural muestra su propia notificación a esa hora.',
    },
    {
      q: 'Mi teléfono (Xiaomi, Huawei, Samsung) no me avisa. ¿Qué hago?',
      a: 'Si cerrás la app con “Eliminar” desde recientes o la forzás a detener, Android congela sus alarmas. Es una limitación de los fabricantes, no de la app: no fuerces el cierre y desactivá la optimización agresiva de batería para Vyneural si la ofrece tu teléfono.',
    },
    {
      q: '¿Cómo descargo la APK?',
      a: 'Desde la página <a href="/descargar">Descargar APK</a> de esta web. Permití la instalación desde fuentes desconocidas cuando Android lo pida (es la app de Vyneural, firmada por nosotros).',
    },
  ],
};

function renderGroup(containerId, items) {
  const container = document.getElementById(containerId);
  if (!container) return;
  items.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faq-q';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', `${containerId}-a-${i}`);
    btn.innerHTML = `<span>${item.q}</span><svg class="faq-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

    const ans = document.createElement('div');
    ans.id = `${containerId}-a-${i}`;
    ans.className = 'faq-a';
    ans.hidden = true;
    ans.innerHTML = `<p>${item.a}</p>`;

    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      ans.hidden = open;
    });

    container.appendChild(btn);
    container.appendChild(ans);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderGroup('faq-generator', FAQ.generator);
  renderGroup('faq-cuenta', FAQ.cuenta);
  renderGroup('faq-alarmas', FAQ.alarmas);
  renderGroup('faq-apk', FAQ.apk);
}, { once: true });
