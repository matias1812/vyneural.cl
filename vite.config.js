import { defineConfig } from 'vite';
import { resolve } from 'path';

// Quita el atributo `crossorigin` del HTML generado. Dentro de la APK la web
// corre sobre file:///android_asset/bineural/index.html: ahí no hay servidor
// ni headers CORS, y Chromium (WebView) trata cada recurso file:// como un
// origen opaco, por lo que bloquea en silencio los <script>/<link> marcados
// con crossorigin — la página carga sin CSS ni módulos. Es seguro quitarlo:
// todos los recursos son del mismo origen y no se usa SRI.
function stripCrossorigin() {
  return {
    name: 'strip-crossorigin',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s*crossorigin(="[^"]*")?/g, '');
    },
  };
}

// App multi-página: cada HTML raíz se compila como entrada independiente.
// Añade aquí cualquier página nueva que crees.
export default defineConfig({
  // Rutas relativas: necesarias para que la web empaquetada dentro de la APK
  // (file:///android_asset/bineural/index.html) cargue CSS/JS/iconos.
  base: './',
  plugins: [stripCrossorigin()],
  // Proxy de desarrollo al backend local (FASE 17). El frontend sigue
  // funcionando sin él; solo es necesario al integrar la API.
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'que-son-las-ondas-binaurales': resolve(__dirname, 'que-son-las-ondas-binaurales.html'),
        beneficios: resolve(__dirname, 'beneficios.html'),
        'como-usar': resolve(__dirname, 'como-usar.html'),
        'sobre-nosotros': resolve(__dirname, 'sobre-nosotros.html'),
        privacidad: resolve(__dirname, 'privacidad.html'),
        descargar: resolve(__dirname, 'descargar.html'),
        'codigo-abierto': resolve(__dirname, 'codigo-abierto.html'),
        'hoja-de-ruta': resolve(__dirname, 'hoja-de-ruta.html'),
        rutina: resolve(__dirname, 'rutina.html'),
        cuenta: resolve(__dirname, 'cuenta.html'),
        verificar: resolve(__dirname, 'verificar.html'),
        restablecer: resolve(__dirname, 'restablecer.html'),
        'preguntas-frecuentes': resolve(__dirname, 'preguntas-frecuentes.html'),
      },
    },
  },
});
