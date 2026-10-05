import{getAccessToken as d}from"./client-C7BbacUb.js";import{p as s}from"./billing-C96w2Tln.js";let r=null;const o=3e4;async function h(){if(!d())return!1;const t=Date.now();if(r&&t-r.at<o)return r.value;try{const e=await s(),i=!!(e&&e.is_premium);return r={value:i,at:t},i}catch{return!0}}function v(){r=null}const u='<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>';function l(){return`
  <div class="auth-modal hidden" id="premium-required-modal" role="dialog" aria-modal="true" aria-label="Función Premium">
    <div class="auth-card">
      <div class="auth-head">
        <span class="auth-logo">${u}</span>
        <div class="auth-title-wrap">
          <h3>Esto es Premium</h3>
          <p id="premium-required-text"></p>
        </div>
        <button type="button" class="auth-close" id="premium-required-close" aria-label="Cerrar">✕</button>
      </div>
      <a href="/premium" class="auth-submit" id="premium-required-cta" style="display:block;text-align:center;text-decoration:none;">Ver planes</a>
    </div>
  </div>`}let n=!1;function c(){if(n)return;n=!0;const t=document.createElement("div");t.innerHTML=l(),document.body.appendChild(t.firstElementChild);const e=document.getElementById("premium-required-modal"),i=()=>e.classList.add("hidden");e.querySelector("#premium-required-close").addEventListener("click",i),e.addEventListener("click",a=>{a.target===e&&i()}),document.addEventListener("keydown",a=>{a.key==="Escape"&&!e.classList.contains("hidden")&&i()})}function f(t){c();const e=document.getElementById("premium-required-modal");document.getElementById("premium-required-text").textContent=t,e.classList.remove("hidden")}export{v as a,h as i,f as o};
