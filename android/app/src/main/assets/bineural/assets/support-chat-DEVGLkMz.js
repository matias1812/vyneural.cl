import{post as x,get as we,ApiError as T}from"./client-phMsNx2l.js";import{o as Ee}from"./support-ws-client-BH16Spc0.js";import{i as Le}from"./premium-gate-CjQbULM3.js";import{e as D}from"./auth-CnC5MWUM.js";import{E as Ce,L as P}from"./site-BTsHEHx8.js";import"./marketing-DPaaUnh_.js";const _e=()=>x("/api/v1/support/conversations",{}),ke=(n,e)=>x(`/api/v1/support/conversations/${n}/messages`,{content:e}),re=(n,e)=>{const o=e?`?since=${encodeURIComponent(e)}`:"";return we(`/api/v1/support/conversations/${n}/messages${o}`)},qe=(n,e,o)=>x(`/api/v1/support/conversations/${n}/rate`,{rating:e,...o?{canned_message:o}:{}}),Ne=(n,e)=>x("/api/v1/support/report",{message:n,...e?{context:e}:{}}),V="vyneural_support_last_seen_at",Be=["Rápido y claro","Buena atención","No se resolvió mi problema","Tardó mucho","Otro"],Te=4e3,De=45e3;function oe(n){try{return localStorage.getItem(n)||""}catch{return""}}function I(n,e){try{e?localStorage.setItem(n,e):localStorage.removeItem(n)}catch{}}function ae(n){return String(n??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function ie(){return!!(window.__vyneuralAuth&&window.__vyneuralAuth.isLoggedIn())}function Ie(n){if(!n)return"";try{return new Date(n).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}catch{return""}}function ue(n){return n.replace(/[\p{Cf}\p{Cc}]/gu,"").length===0}function E(n){const e=new Date(n);return Number.isNaN(e.getTime())?String(n):`${e.getFullYear()}-${e.getMonth()}-${e.getDate()}`}function xe(n){const e=new Date(n);if(Number.isNaN(e.getTime()))return"";const o=new Date,p=new Date;return p.setDate(o.getDate()-1),E(n)===E(o)?"Hoy":E(n)===E(p)?"Ayer":e.toLocaleDateString("es-ES",{day:"numeric",month:"short"})}function Ae(){const n=Ce(),e=document.createElement("div");return e.id="support-modal",e.className="support-modal",e.hidden=!0,e.innerHTML=`
    <div class="support-modal-card" role="dialog" aria-modal="true" aria-labelledby="support-modal-title">
      <div class="support-modal-head">
        <h3 id="support-modal-title">💬 Chat de soporte<span class="support-conn-dot" id="support-conn-dot" title="Sincronizando…" aria-hidden="true"></span></h3>
        <button type="button" id="support-close" class="support-close" aria-label="Cerrar">✕</button>
      </div>

      <div id="support-chat-view">
        <p class="support-sub">
          Hablá en vivo con el equipo de Vyneural. Te contestamos apenas podamos —
          quedate tranquilo, tu conversación sigue acá si cerrás y volvés más tarde.
        </p>
        <div id="support-messages" class="support-messages" role="log" aria-live="polite"></div>
        <p id="support-status" class="support-status hidden"></p>
        <form id="support-form" class="support-form" novalidate>
          <input
            type="text"
            id="support-input"
            name="mensaje"
            maxlength="2000"
            placeholder="Escribí tu mensaje…"
            autocomplete="off"
          />
          <button type="submit" id="support-send" class="support-send">Enviar</button>
        </form>
        <button type="button" id="support-rate-open" class="support-rate-link">Cerrar y calificar</button>
      </div>

      <div id="support-rate-view" hidden>
        <p class="support-sub">¿Cómo fue la atención? Tu conversación se cierra al calificar.</p>
        <div class="support-star-input" id="support-star-input" role="radiogroup" aria-label="Valoración en estrellas">
          <button type="button" class="c-star" data-r="1" aria-label="1 estrella" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="2" aria-label="2 estrellas" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="3" aria-label="3 estrellas" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="4" aria-label="4 estrellas" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="5" aria-label="5 estrellas" aria-pressed="false">★</button>
        </div>
        <p id="support-rate-error" class="support-status support-status-error hidden"></p>
        <div class="support-canned-list" id="support-canned-list">
          ${Be.map(o=>`<button type="button" class="support-canned-btn" data-msg="${ae(o)}">${ae(o)}</button>`).join("")}
        </div>
        <button type="button" id="support-rate-skip" class="support-rate-link">Finalizar sin comentario</button>
        <button type="button" id="support-rate-back" class="support-rate-link">Volver al chat</button>
      </div>

      <div id="support-report-view" hidden>
        <p class="support-sub">
          El chat en vivo es para cuentas Premium. Contanos qué pasó y te
          respondemos por correo apenas podamos.
        </p>
        <form id="support-report-form" class="support-form-stack" novalidate>
          <textarea
            id="support-report-input"
            name="mensaje"
            maxlength="2000"
            rows="4"
            placeholder="Contanos qué problema encontraste…"
            required
          ></textarea>
          <button type="submit" id="support-report-send" class="support-send">Enviar reporte</button>
        </form>
        <p id="support-report-status" class="support-status hidden"></p>
      </div>
    </div>
  `,document.body.appendChild(n),document.body.appendChild(e),{fab:n,modal:e}}const Me=`
<div id="support-new-message-banner" class="support-new-message-banner hidden" role="status">
  <span class="support-new-message-text" id="support-new-message-text">💬 Tenés un mensaje nuevo de soporte.</span>
  <button type="button" id="support-banner-open" class="support-banner-open">Ver</button>
  <button type="button" id="support-banner-dismiss" class="support-banner-dismiss" aria-label="Ahora no">✕</button>
</div>`;let de=!1;function $e(n){if(de)return;de=!0;const e=document.createElement("div");e.innerHTML=Me.trim();const o=e.firstElementChild;document.body.insertBefore(o,document.body.firstChild),document.getElementById("support-banner-open").addEventListener("click",()=>{L(),n()}),document.getElementById("support-banner-dismiss").addEventListener("click",L)}function Re(){const n=document.getElementById("support-new-message-banner");n&&n.classList.remove("hidden")}function L(){const n=document.getElementById("support-new-message-banner");n&&n.classList.add("hidden")}let w=null;function ce(){if(w)return w;const{fab:n,modal:e}=Ae(),o=e.querySelector("#support-chat-view"),p=e.querySelector("#support-rate-view"),j=e.querySelector("#support-report-view"),m=e.querySelector("#support-messages"),F=e.querySelector("#support-status"),pe=e.querySelector("#support-form"),u=e.querySelector("#support-input"),z=e.querySelector("#support-send"),le=e.querySelector("#support-close"),me=e.querySelector("#support-rate-open"),fe=e.querySelector("#support-rate-back"),ve=e.querySelector("#support-rate-skip"),f=e.querySelector("#support-rate-error"),be=e.querySelector("#support-canned-list"),G=e.querySelector("#support-star-input"),c=e.querySelector("#support-conn-dot"),he=e.querySelector("#support-report-form"),v=e.querySelector("#support-report-input"),U=e.querySelector("#support-report-send"),A=e.querySelector("#support-report-status");let a=oe(P)||null,i=oe(V)||null,C=null,_=null,b=0,k=new Set,g=null,q=null,y=null;function K(t){c&&(c.classList.remove("is-open","is-connecting","is-down"),t==="open"?(c.classList.add("is-open"),c.title="En vivo"):t==="connecting"?(c.classList.add("is-connecting"),c.title="Conectando…"):(c.classList.add("is-down"),c.title="Sincronizando (sin conexión en vivo)"))}function Y(){g&&(g.close(),g=null),K("down")}function ge(){!a||g||(g=Ee(a,{onMessage:t=>B([t]),onStatusChange:K}))}function d(t,r,s=F){s.textContent=t,s.classList.toggle("support-status-error",!!r),s.classList.remove("hidden")}function J(t=F){t.classList.add("hidden"),t.textContent=""}function N(){I(P,a||""),I(V,i||"")}function Q(){Y(),a=null,i=null,b=0,k=new Set,q=null,y=null,I(P,""),I(V,""),m.innerHTML="",L()}function B(t){let r=!1;(t||[]).forEach(s=>{if(s.id){if(k.has(s.id))return;k.add(s.id)}r=!0;const R=E(s.created_at);if(R!==y){const l=document.createElement("div");l.className="support-date-separator",l.textContent=xe(s.created_at),m.appendChild(l)}const Se=R!==y||s.sender!==q;y=R,q=s.sender;const S=document.createElement("div");if(S.className=`support-msg support-msg-${s.sender==="admin"?"admin":"user"}`,Se){const l=document.createElement("span");l.className="support-msg-sender",l.textContent=s.sender==="admin"?"Soporte":"Tú",S.appendChild(l)}const H=document.createElement("p");H.className="support-msg-text",H.textContent=s.content;const O=document.createElement("span");O.className="support-msg-time",O.textContent=Ie(s.created_at),S.appendChild(H),S.appendChild(O),m.appendChild(S),s.created_at&&(!i||s.created_at>i)&&(i=s.created_at)}),r&&(m.scrollTop=m.scrollHeight)}function W(){o.hidden=!0,p.hidden=!1,b=0,ne(),f.classList.add("hidden")}async function X(){if(!ie())return d("Necesitás iniciar sesión para usar el chat de soporte.",!0),window.__vyneuralAuth&&typeof window.__vyneuralAuth.open=="function"&&window.__vyneuralAuth.open("login"),!1;try{const t=await _e();return a=t.id,m.innerHTML="",i=null,k=new Set,q=null,y=null,B(t.messages),N(),L(),J(),t.admin_marked_resolved&&W(),!0}catch(t){return t instanceof T&&t.status===429?d("Estás enviando demasiadas solicitudes — esperá un momento.",!0):d(D(t,"No se pudo conectar con soporte. Probá de nuevo en un momento."),!0),!1}}function Z(){C&&(clearInterval(C),C=null)}function ye(){Z(),C=setInterval(async()=>{if(a)try{const t=await re(a,i);t&&t.length&&B(t)}catch{}},Te)}function M(){_&&(clearInterval(_),_=null)}async function ee(){if(e.hidden&&!(!a||document.hidden))try{const t=await re(a,i);if(t&&t.length){const r=t.some(s=>s.sender==="admin");t.forEach(s=>{s.created_at&&(!i||s.created_at>i)&&(i=s.created_at)}),N(),r&&($e($),Re())}}catch(t){t instanceof T&&(t.status===404||t.status===401)&&(Q(),M())}}function te(){M(),_=setInterval(ee,De)}async function $(){if(e.hidden=!1,document.body.classList.add("support-modal-open"),L(),M(),!ie()){o.hidden=!1,j.hidden=!0,p.hidden=!0,window.setTimeout(()=>u&&u.focus(),30),X();return}const t=await Le();o.hidden=!t,j.hidden=t,p.hidden=!0,t?(window.setTimeout(()=>u&&u.focus(),30),X().then(r=>{r&&(ye(),ge())})):window.setTimeout(()=>v&&v.focus(),30)}function h(){e.hidden=!0,document.body.classList.remove("support-modal-open"),Z(),Y(),N(),a&&te(),n.focus()}w={open:$,close:h,fab:n},window.__bugReport=w,n.addEventListener("click",$),le.addEventListener("click",h),e.addEventListener("click",t=>{t.target===e&&h()}),document.addEventListener("keydown",t=>{t.key==="Escape"&&!e.hidden&&h()}),pe.addEventListener("submit",async t=>{t.preventDefault();const r=(u.value||"").trim();if(!ue(r)){if(!a){d("Todavía no se pudo abrir el chat — probá de nuevo en un momento.",!0);return}z.disabled=!0,u.disabled=!0;try{const s=await ke(a,r);B([s]),N(),u.value="",J()}catch(s){s instanceof T&&s.status===429?d("Estás enviando mensajes muy rápido — esperá un momento antes de reintentar.",!0):d(D(s,"No se pudo enviar el mensaje."),!0)}finally{z.disabled=!1,u.disabled=!1,u.focus()}}}),he.addEventListener("submit",async t=>{t.preventDefault();const r=(v.value||"").trim();if(!ue(r)){U.disabled=!0,v.disabled=!0;try{await Ne(r,window.location.pathname),v.value="",d("Listo, recibimos tu reporte — te respondemos por correo apenas podamos.",!1,A)}catch(s){s instanceof T&&s.status===429?d("Estás enviando demasiadas solicitudes — esperá un momento.",!0,A):d(D(s,"No se pudo enviar el reporte."),!0,A)}finally{U.disabled=!1,v.disabled=!1}}});function ne(){G.querySelectorAll(".c-star").forEach(t=>{const s=Number(t.dataset.r)<=b;t.classList.toggle("on",s),t.setAttribute("aria-pressed",String(s))})}G.addEventListener("click",t=>{const r=t.target.closest(".c-star");r&&(b=Number(r.dataset.r),ne(),f.classList.add("hidden"))}),me.addEventListener("click",W),fe.addEventListener("click",()=>{p.hidden=!0,o.hidden=!1});async function se(t){if(!b){f.textContent="Elegí una valoración de 1 a 5 estrellas.",f.classList.remove("hidden");return}if(!a){h();return}try{await qe(a,b,t||void 0),Q(),h()}catch(r){f.textContent=D(r,"No se pudo enviar la calificación. Probá de nuevo."),f.classList.remove("hidden")}}return be.addEventListener("click",t=>{const r=t.target.closest(".support-canned-btn");r&&se(r.dataset.msg)}),ve.addEventListener("click",()=>se(null)),document.addEventListener("visibilitychange",()=>{!document.hidden&&e.hidden&&a&&ee()}),a&&te(),w}typeof document<"u"&&document.readyState!=="loading"?ce():typeof document<"u"&&document.addEventListener("DOMContentLoaded",ce);export{ce as initSupportChat};
