# Feedback de usuarios — FormSubmit + Google Sheets

La burbuja flotante **🐞 Reportar un problema** (todas las páginas) envía los
reportes con un servicio de terceros gratuito, sin backend propio.

## 1. Activar FormSubmit (una sola vez)

1. El email receptor está en `src/report-bug.js` → `BUG_EMAIL`
   (actualmente `soporte@vyneural.cl`).
2. Al **primer envío real** (o al reporte de activación), FormSubmit manda un
   correo de confirmación a esa dirección.
3. Abrir ese correo y pulsar el enlace **"Activate"** una sola vez.
4. Desde entonces, todos los reportes llegan al inbox, con el contexto técnico
   (página, navegador, estado del audio, dentro de la APK o no).

> Si el envío por fetch falla (offline/CORS), la burbuja cae a un POST nativo
> de FormSubmit; si tampoco hay red, ofrece un correo prefabricado. Ningún
> reporte se pierde silenciosamente.

## 2. Volcar los reportes a una hoja de Google Sheets (opcional)

La burbuja reenvía cada reporte a un **Google Apps Script** si `BUG_WEBHOOK`
(en `src/report-bug.js`) tiene la URL del script. Pasos:

1. Crear una hoja de cálculo nueva en Google Sheets (p. ej. "Reportes Vyneural").
2. Menú **Extensiones → Apps Script**.
3. Pegar el siguiente código y guardar:

```js
function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Reportes');
    if (!sheet) {
      sheet = ss.insertSheet('Reportes');
      sheet.appendRow(['Fecha', 'Tipo', 'Mensaje', 'Email', 'Contexto', 'Página']);
    }
    let d = {};
    if (e.postData && e.postData.contents) {
      try { d = JSON.parse(e.postData.contents); }
      catch (_) { d = e.parameter || {}; }
    }
    sheet.appendRow([
      new Date().toISOString(),
      d.tipo || '',
      d.mensaje || d.message || '',
      d.email || '',
      d.contexto || '',
      d.pagina || d._subject || ''
    ]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

4. **Implementar → Nueva implementación → Aplicación web**:
   - *Ejecutar como*: **Tú**.
   - *Acceso*: **Cualquier persona** (la URL pública es la que llama la web).
5. Copiar la URL `https://script.google.com/macros/s/XXXX/exec` y pegarla en
   `src/report-bug.js` → `BUG_WEBHOOK`. La primera llamada puede requerir
   aprobar el acceso ("Review permissions") una sola vez.
6. Rebuild y deploy (`npm run build` + `vercel --prod`).

El vuelco a Sheets es fire-and-forget: si falla, el reporte por correo sigue
llegando igual.
