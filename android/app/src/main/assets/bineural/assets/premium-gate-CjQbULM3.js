import{getAccessToken as b}from"./client-phMsNx2l.js";import{f as g,X as x}from"./auth-CnC5MWUM.js";function y(t){const r={alpha:!1,antialias:!1},a=t.getContext("webgl2",r),e=a||t.getContext("webgl",r);if(!e)return null;const o=e.createProgram(),i=a?`#version 300 es
`:"",n=a?"in":"attribute",c=a?"orbitColor":"gl_FragColor",l=[[e.VERTEX_SHADER,`${i}${n} vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`],[e.FRAGMENT_SHADER,`${i}
      precision mediump float;
      ${a?"out vec4 orbitColor;":""}
      uniform vec2 size;
      uniform float time;
      float hash(vec2 cell) {
        vec3 p = fract(vec3(cell.xyx) * .1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float stars(vec2 p, float scale, float drift) {
        vec2 grid = p * scale + vec2(drift * time, 0.);
        vec2 cell = floor(grid);
        float seed = hash(cell);
        vec2 center = .25 + .5 * vec2(hash(cell + 13.), hash(cell + 47.));
        float point = length(fract(grid) - center);
        float twinkle = .64 + .36 * sin(time * 1.3 + seed * 80.);
        return (1. - smoothstep(.025, .10, point)) * step(.74, seed) * twinkle;
      }
      void main() {
        vec2 p = (2. * gl_FragCoord.xy - size) / size.y;
        float r = length(p);
        float a = atan(p.y, p.x);
        float turn = a - time * .34;
        float bloom = .5 + .5 * sin(time * .88);
        float petals = mix(cos(5. * turn), cos(8. * turn + .7), bloom);
        float contour = r - (.55 + .11 * petals + .06 * sin(time * 1.4));
        float threads = pow(.5 + .5 * cos(83. * contour - time * 3.2), 12.);
        float halo = exp(-6. * abs(contour));
        float crest = exp(-75. * abs(contour));
        float ripple = pow(.5 + .5 * cos(32. * r - time * 3.5), 10.);
        vec3 cyan = vec3(.12, .82, 1.);
        vec3 magenta = vec3(1., .16, .58);
        vec3 hue = mix(cyan, magenta, .5 + .5 * cos(2. * turn + r * 4.));
        float nebula = exp(-2.6 * abs(p.y + .24 * p.x - .13 * sin(p.x * 4. + time * .22)));
        nebula *= exp(-.65 * p.x * p.x);
        vec3 color = vec3(.025, .019, .075) + vec3(.15, .065, .26) * nebula;
        color += vec3(.68, .75, 1.) * stars(p, 18., .24) * .58;
        color += vec3(.94, .83, 1.) * stars(p + 3.1, 9., -.16) * .72;
        color += hue * halo * (.14 + .58 * threads);
        color += mix(hue, vec3(.85, .79, 1.), .65) * crest * .65;
        color += mix(magenta, cyan, bloom) * ripple * .20 * exp(-2.2 * r);
        color += vec3(.47, .24, .9) * (.14 + .09 * bloom) * exp(-7. * r);
        vec2 orbitPlane = vec2(p.x * .8 + p.y * .6, p.y * .8 - p.x * .6);
        orbitPlane.y *= 3.5;
        float orbit = length(orbitPlane);
        float orbitAngle = atan(orbitPlane.y, orbitPlane.x);
        float arc = exp(-100. * abs(orbit - .96)) + .44 * exp(-90. * abs(orbit - 1.16));
        vec3 ice = vec3(.38, .74, 1.);
        color += ice * arc * (.25 + .32 * pow(.5 + .5 * cos(orbitAngle - time * .65), 5.));

        float planetRadius = .40;
        float planet = 1. - smoothstep(planetRadius - .008, planetRadius + .008, r);
        float sunlight = pow(.5 + .5 * cos(a - 2.15), 3.);
        float atmosphere = exp(-45. * abs(r - planetRadius));
        vec3 planetColor = vec3(.022, .017, .06) + vec3(.12, .055, .22) * sunlight * r;
        color = mix(color, planetColor, planet);
        color += mix(magenta, ice, sunlight) * atmosphere * (.16 + .82 * sunlight);
        color += ice * arc * .36 * planet * smoothstep(-.03, .03, orbitPlane.y);

        vec2 satellite = vec2(.96 * cos(time * .8), .96 * sin(time * .8) / 3.5);
        float trail = length(vec2(dot(p, vec2(.8, .6)), dot(p, vec2(-.6, .8))) - satellite);
        color += ice * (.52 * exp(-34. * trail) + .9 * exp(-180. * trail));
        ${c} = vec4(color, 1.);
      }
    `]];for(const[f,v]of l){const m=e.createShader(f);e.shaderSource(m,v),e.compileShader(m),e.attachShader(o,m),e.deleteShader(m)}if(e.linkProgram(o),!e.getProgramParameter(o,e.LINK_STATUS))return e.deleteProgram(o),null;e.useProgram(o),e.bindBuffer(e.ARRAY_BUFFER,e.createBuffer()),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW);const s=e.getAttribLocation(o,"p");e.enableVertexAttribArray(s),e.vertexAttribPointer(s,2,e.FLOAT,!1,0,0);const p=e.getUniformLocation(o,"size"),h=e.getUniformLocation(o,"time");return f=>e.isContextLost()?!1:(e.viewport(0,0,t.width,t.height),e.uniform2f(p,t.width,t.height),e.uniform1f(h,f),e.drawArrays(e.TRIANGLES,0,3),!0)}let u=null;const A=3e4;async function S(){if(!b())return!1;const t=Date.now();if(u&&t-u.at<A)return u.value;try{const r=await g(),a=!!(r&&r.is_premium);return u={value:a,at:t},a}catch{return!0}}function L(){u=null}let d;function w(){const t=document.createElement("dialog");t.className="premium-offer",t.id="premium-required-modal",t.setAttribute("aria-labelledby","premium-offer-title"),t.setAttribute("aria-describedby","premium-required-text"),t.innerHTML=`
    <div class="premium-offer-visual" aria-hidden="true"><canvas width="480" height="240" hidden></canvas></div>
    <div class="premium-offer-brand">
      <span class="premium-offer-brand-icon"><img src="${location.protocol==="file:"?"./icon.svg":"/icon.svg"}" alt="" width="18" height="18"></span>
      Vyneural
    </div>
    <button type="button" class="premium-offer-close" aria-label="Cerrar oferta" autofocus>✕</button>
    <div class="premium-offer-body">
      <h2 id="premium-offer-title">Tu ritmo, a tu medida.</h2>
      <p id="premium-required-text"></p>
      <p class="premium-offer-benefits">Diseña tus frecuencias, arma rutinas y programa recordatorios.</p>
      <p class="premium-offer-price" data-price hidden></p>
      <a class="premium-offer-cta" href="${location.protocol==="file:"?"./premium.html":"/premium"}#plan-monthly">
        Ver el plan mensual <span aria-hidden="true">↗</span>
      </a>
      <p class="premium-offer-terms">Renovación cada 30 días. Cancela cuando quieras desde tu cuenta.</p>
    </div>`;const r=t.querySelector("canvas"),a=document.querySelector(".site-nav .site-brand .brand-ico svg");a&&t.querySelector(".premium-offer-brand-icon").replaceChildren(a.cloneNode(!0));const e=matchMedia("(prefers-reduced-motion: reduce)");let o,i;function n(){cancelAnimationFrame(o),r.hidden=!0}function c(){if(n(),!t.open||e.matches||(i??(i=y(r)),!i||!i(0)))return;r.hidden=!1;const l=performance.now();function s(p){if(!t.open||!i((p-l)/1e3))return n();o=requestAnimationFrame(s)}o=requestAnimationFrame(s)}return t.querySelector("button").addEventListener("click",()=>t.close()),t.addEventListener("click",l=>{l.target===t&&t.close()}),t.addEventListener("close",n),e.addEventListener("change",c),r.addEventListener("webglcontextlost",l=>{l.preventDefault(),n()}),r.addEventListener("webglcontextrestored",()=>{i=null,c()}),document.body.append(t),{modal:t,animate:c}}function R(t){d??(d=w());const{modal:r,animate:a}=d;if(r.querySelector("#premium-required-text").textContent=t,r.open)return;r.showModal(),a();const e=r.querySelector("[data-price]");e.hidden=!0,x().then(({plans:o})=>{var c;const i=(c=o==null?void 0:o.monthly)==null?void 0:c.amount;if(!Number.isFinite(i)||i<=0)return;const n=new Intl.NumberFormat("es-CL",{style:"currency",currency:"CLP"}).format(i);e.textContent=`${n} CLP cada 30 días`,e.hidden=!1}).catch(()=>{})}export{L as a,S as i,R as o};
