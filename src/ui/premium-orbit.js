// Una sola pasada, a resolución acotada, para el fondo de la oferta.
export function createPremiumOrbit(canvas) {
  const options = { alpha: false, antialias: false };
  const gl2 = canvas.getContext('webgl2', options);
  const gl = gl2 || canvas.getContext('webgl', options);
  if (!gl) return null;

  const program = gl.createProgram();
  const version = gl2 ? '#version 300 es\n' : '';
  const vertexInput = gl2 ? 'in' : 'attribute';
  const output = gl2 ? 'orbitColor' : 'gl_FragColor';
  const sources = [
    [gl.VERTEX_SHADER, `${version}${vertexInput} vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`],
    [gl.FRAGMENT_SHADER, `${version}
      precision mediump float;
      ${gl2 ? 'out vec4 orbitColor;' : ''}
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
        ${output} = vec4(color, 1.);
      }
    `],
  ];
  for (const [type, source] of sources) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const size = gl.getUniformLocation(program, 'size');
  const time = gl.getUniformLocation(program, 'time');
  return (elapsed) => {
    if (gl.isContextLost()) return false;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(size, canvas.width, canvas.height);
    gl.uniform1f(time, elapsed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  };
}
