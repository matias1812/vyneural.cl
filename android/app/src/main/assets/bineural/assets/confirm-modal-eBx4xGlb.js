function s(){return`
  <div class="auth-modal hidden" id="confirm-modal" role="dialog" aria-modal="true">
    <div class="auth-card">
      <button type="button" class="auth-close" id="confirm-modal-close" aria-label="Cerrar">✕</button>
      <h3 id="confirm-modal-title"></h3>
      <p id="confirm-modal-text" class="rutina-hint"></p>
      <button type="button" class="auth-submit" id="confirm-modal-ok"></button>
    </div>
  </div>`}let c=!1,d=null;function m(){if(c)return;c=!0;const o=document.createElement("div");o.innerHTML=s(),document.body.appendChild(o.firstElementChild);const e=document.getElementById("confirm-modal"),t=n=>{if(e.classList.add("hidden"),d){const i=d;d=null,i(n)}};e.querySelector("#confirm-modal-close").addEventListener("click",()=>t(!1)),e.querySelector("#confirm-modal-ok").addEventListener("click",()=>t(!0)),e.addEventListener("click",n=>{n.target===e&&t(!1)}),document.addEventListener("keydown",n=>{n.key==="Escape"&&!e.classList.contains("hidden")&&t(!1)})}function r({title:o,text:e,confirmLabel:t,danger:n}){if(m(),d){const l=d;d=null,l(!1)}const i=document.getElementById("confirm-modal");document.getElementById("confirm-modal-title").textContent=o,document.getElementById("confirm-modal-text").textContent=e;const a=document.getElementById("confirm-modal-ok");return a.textContent=t,a.classList.toggle("cuenta-btn-danger",!!n),i.classList.remove("hidden"),new Promise(l=>{d=l})}function u({title:o,text:e,confirmLabel:t="Confirmar",danger:n=!1}){return r({title:o,text:e,confirmLabel:t,danger:n})}function f({title:o,text:e,confirmLabel:t="Entendido"}){return r({title:o,text:e,confirmLabel:t,danger:!1})}export{u as c,f as n};
