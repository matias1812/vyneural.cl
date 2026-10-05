import{post as I,get as Se,ApiError as T}from"./client-C7BbacUb.js";import{o as we}from"./support-ws-client-DVdIIg_3.js";import{i as Ee}from"./premium-gate-DHbV5ESL.js";import{Z as Le,_ as O}from"./site-CifDMkpr.js";import"./billing-C96w2Tln.js";const _e=()=>I("/api/v1/support/conversations",{}),Ce=(n,e)=>I(`/api/v1/support/conversations/${n}/messages`,{content:e}),se=(n,e)=>{const o=e?`?since=${encodeURIComponent(e)}`:"";return Se(`/api/v1/support/conversations/${n}/messages${o}`)},ke=(n,e,o)=>I(`/api/v1/support/conversations/${n}/rate`,{rating:e,...o?{canned_message:o}:{}}),qe=(n,e)=>I("/api/v1/support/report",{message:n,...e?{context:e}:{}}),P="vyneural_support_last_seen_at",Ne=["Rápido y claro","Buena atención","No se resolvió mi problema","Tardó mucho","Otro"],Be=4e3,Te=45e3;function re(n){try{return localStorage.getItem(n)||""}catch{return""}}function D(n,e){try{e?localStorage.setItem(n,e):localStorage.removeItem(n)}catch{}}function oe(n){return String(n??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function ae(){return!!(window.__vyneuralAuth&&window.__vyneuralAuth.isLoggedIn())}function De(n){if(!n)return"";try{return new Date(n).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}catch{return""}}function ie(n){return n.replace(/[\p{Cf}\p{Cc}]/gu,"").length===0}function E(n){const e=new Date(n);return Number.isNaN(e.getTime())?String(n):`${e.getFullYear()}-${e.getMonth()}-${e.getDate()}`}function Ie(n){const e=new Date(n);if(Number.isNaN(e.getTime()))return"";const o=new Date,l=new Date;return l.setDate(o.getDate()-1),E(n)===E(o)?"Hoy":E(n)===E(l)?"Ayer":e.toLocaleDateString("es-ES",{day:"numeric",month:"short"})}function xe(){const n=Le(),e=document.createElement("div");return e.id="support-modal",e.className="support-modal",e.hidden=!0,e.innerHTML=`
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
          ${Ne.map(o=>`<button type="button" class="support-canned-btn" data-msg="${oe(o)}">${oe(o)}</button>`).join("")}
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
  `,document.body.appendChild(n),document.body.appendChild(e),{fab:n,modal:e}}const Ae=`
<div id="support-new-message-banner" class="support-new-message-banner hidden" role="status">
  <span class="support-new-message-text" id="support-new-message-text">💬 Tenés un mensaje nuevo de soporte.</span>
  <button type="button" id="support-banner-open" class="support-banner-open">Ver</button>
  <button type="button" id="support-banner-dismiss" class="support-banner-dismiss" aria-label="Ahora no">✕</button>
</div>`;let ue=!1;function Me(n){if(ue)return;ue=!0;const e=document.createElement("div");e.innerHTML=Ae.trim();const o=e.firstElementChild;document.body.insertBefore(o,document.body.firstChild),document.getElementById("support-banner-open").addEventListener("click",()=>{L(),n()}),document.getElementById("support-banner-dismiss").addEventListener("click",L)}function $e(){const n=document.getElementById("support-new-message-banner");n&&n.classList.remove("hidden")}function L(){const n=document.getElementById("support-new-message-banner");n&&n.classList.add("hidden")}let w=null;function de(){if(w)return w;const{fab:n,modal:e}=xe(),o=e.querySelector("#support-chat-view"),l=e.querySelector("#support-rate-view"),V=e.querySelector("#support-report-view"),m=e.querySelector("#support-messages"),j=e.querySelector("#support-status"),ce=e.querySelector("#support-form"),u=e.querySelector("#support-input"),F=e.querySelector("#support-send"),le=e.querySelector("#support-close"),pe=e.querySelector("#support-rate-open"),me=e.querySelector("#support-rate-back"),fe=e.querySelector("#support-rate-skip"),f=e.querySelector("#support-rate-error"),ve=e.querySelector("#support-canned-list"),z=e.querySelector("#support-star-input"),c=e.querySelector("#support-conn-dot"),be=e.querySelector("#support-report-form"),v=e.querySelector("#support-report-input"),G=e.querySelector("#support-report-send"),x=e.querySelector("#support-report-status");let a=re(O)||null,i=re(P)||null,_=null,C=null,b=0,k=new Set,g=null,q=null,y=null;function U(t){c&&(c.classList.remove("is-open","is-connecting","is-down"),t==="open"?(c.classList.add("is-open"),c.title="En vivo"):t==="connecting"?(c.classList.add("is-connecting"),c.title="Conectando…"):(c.classList.add("is-down"),c.title="Sincronizando (sin conexión en vivo)"))}function K(){g&&(g.close(),g=null),U("down")}function he(){!a||g||(g=we(a,{onMessage:t=>B([t]),onStatusChange:U}))}function d(t,r,s=j){s.textContent=t,s.classList.toggle("support-status-error",!!r),s.classList.remove("hidden")}function Y(t=j){t.classList.add("hidden"),t.textContent=""}function N(){D(O,a||""),D(P,i||"")}function Z(){K(),a=null,i=null,b=0,k=new Set,q=null,y=null,D(O,""),D(P,""),m.innerHTML="",L()}function B(t){let r=!1;(t||[]).forEach(s=>{if(s.id){if(k.has(s.id))return;k.add(s.id)}r=!0;const $=E(s.created_at);if($!==y){const p=document.createElement("div");p.className="support-date-separator",p.textContent=Ie(s.created_at),m.appendChild(p)}const ye=$!==y||s.sender!==q;y=$,q=s.sender;const S=document.createElement("div");if(S.className=`support-msg support-msg-${s.sender==="admin"?"admin":"user"}`,ye){const p=document.createElement("span");p.className="support-msg-sender",p.textContent=s.sender==="admin"?"Soporte":"Tú",S.appendChild(p)}const R=document.createElement("p");R.className="support-msg-text",R.textContent=s.content;const H=document.createElement("span");H.className="support-msg-time",H.textContent=De(s.created_at),S.appendChild(R),S.appendChild(H),m.appendChild(S),s.created_at&&(!i||s.created_at>i)&&(i=s.created_at)}),r&&(m.scrollTop=m.scrollHeight)}function J(){o.hidden=!0,l.hidden=!1,b=0,te(),f.classList.add("hidden")}async function Q(){if(!ae())return d("Necesitás iniciar sesión para usar el chat de soporte.",!0),window.__vyneuralAuth&&typeof window.__vyneuralAuth.open=="function"&&window.__vyneuralAuth.open("login"),!1;try{const t=await _e();return a=t.id,m.innerHTML="",i=null,k=new Set,q=null,y=null,B(t.messages),N(),L(),Y(),t.admin_marked_resolved&&J(),!0}catch(t){return t instanceof T&&t.status===429?d("Estás enviando demasiadas solicitudes — esperá un momento.",!0):d(t&&t.detail||"No se pudo conectar con soporte. Probá de nuevo en un momento.",!0),!1}}function W(){_&&(clearInterval(_),_=null)}function ge(){W(),_=setInterval(async()=>{if(a)try{const t=await se(a,i);t&&t.length&&B(t)}catch{}},Be)}function A(){C&&(clearInterval(C),C=null)}async function X(){if(e.hidden&&!(!a||document.hidden))try{const t=await se(a,i);if(t&&t.length){const r=t.some(s=>s.sender==="admin");t.forEach(s=>{s.created_at&&(!i||s.created_at>i)&&(i=s.created_at)}),N(),r&&(Me(M),$e())}}catch(t){t instanceof T&&(t.status===404||t.status===401)&&(Z(),A())}}function ee(){A(),C=setInterval(X,Te)}async function M(){if(e.hidden=!1,document.body.classList.add("support-modal-open"),L(),A(),!ae()){o.hidden=!1,V.hidden=!0,l.hidden=!0,window.setTimeout(()=>u&&u.focus(),30),Q();return}const t=await Ee();o.hidden=!t,V.hidden=t,l.hidden=!0,t?(window.setTimeout(()=>u&&u.focus(),30),Q().then(r=>{r&&(ge(),he())})):window.setTimeout(()=>v&&v.focus(),30)}function h(){e.hidden=!0,document.body.classList.remove("support-modal-open"),W(),K(),N(),a&&ee(),n.focus()}w={open:M,close:h,fab:n},window.__bugReport=w,n.addEventListener("click",M),le.addEventListener("click",h),e.addEventListener("click",t=>{t.target===e&&h()}),document.addEventListener("keydown",t=>{t.key==="Escape"&&!e.hidden&&h()}),ce.addEventListener("submit",async t=>{t.preventDefault();const r=(u.value||"").trim();if(!ie(r)){if(!a){d("Todavía no se pudo abrir el chat — probá de nuevo en un momento.",!0);return}F.disabled=!0,u.disabled=!0;try{const s=await Ce(a,r);B([s]),N(),u.value="",Y()}catch(s){s instanceof T&&s.status===429?d("Estás enviando mensajes muy rápido — esperá un momento antes de reintentar.",!0):d(s&&s.detail||"No se pudo enviar el mensaje.",!0)}finally{F.disabled=!1,u.disabled=!1,u.focus()}}}),be.addEventListener("submit",async t=>{t.preventDefault();const r=(v.value||"").trim();if(!ie(r)){G.disabled=!0,v.disabled=!0;try{await qe(r,window.location.pathname),v.value="",d("Listo, recibimos tu reporte — te respondemos por correo apenas podamos.",!1,x)}catch(s){s instanceof T&&s.status===429?d("Estás enviando demasiadas solicitudes — esperá un momento.",!0,x):d(s&&s.detail||"No se pudo enviar el reporte.",!0,x)}finally{G.disabled=!1,v.disabled=!1}}});function te(){z.querySelectorAll(".c-star").forEach(t=>{const s=Number(t.dataset.r)<=b;t.classList.toggle("on",s),t.setAttribute("aria-pressed",String(s))})}z.addEventListener("click",t=>{const r=t.target.closest(".c-star");r&&(b=Number(r.dataset.r),te(),f.classList.add("hidden"))}),pe.addEventListener("click",J),me.addEventListener("click",()=>{l.hidden=!0,o.hidden=!1});async function ne(t){if(!b){f.textContent="Elegí una valoración de 1 a 5 estrellas.",f.classList.remove("hidden");return}if(!a){h();return}try{await ke(a,b,t||void 0),Z(),h()}catch(r){f.textContent=r&&r.detail||"No se pudo enviar la calificación. Probá de nuevo.",f.classList.remove("hidden")}}return ve.addEventListener("click",t=>{const r=t.target.closest(".support-canned-btn");r&&ne(r.dataset.msg)}),fe.addEventListener("click",()=>ne(null)),document.addEventListener("visibilitychange",()=>{!document.hidden&&e.hidden&&a&&X()}),a&&ee(),w}typeof document<"u"&&document.readyState!=="loading"?de():typeof document<"u"&&document.addEventListener("DOMContentLoaded",de);export{de as initSupportChat};
