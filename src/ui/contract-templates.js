// src/ui/contract-templates.js
// Datos + lógica de relleno para el generador de contratos del panel admin
// (ver src/admin.js, sección "Admin: Generador de contratos"). 100%
// client-side — no hay backend involucrado, esto es solo texto legal con
// tokens {{TOKEN}} sustituidos por los valores del formulario.
//
// Cada template expone `clauses`: un array [{title, body}] en vez de un
// único string fijo — la primera cláusula es un "preámbulo" sin título
// (title: '') y el resto son las cláusulas numeradas (PRIMERO, SEGUNDO...).
// El admin parte de estas cláusulas por defecto (ver defaultClausesFor) y
// puede editarlas/agregar/borrar libremente en memoria antes de exportar.

// Campos que representan montos en CLP — se formatean con separador de miles
// (es-CL) al sustituir en el cuerpo del contrato, aunque el resto de la app
// siga usando el número crudo para cualquier otro propósito.
const MONEY_FIELD_KEYS = new Set(['MONTO_TOTAL', 'ABONO_MENSUAL']);

export const CONTRACT_TEMPLATES = {
  services: {
    title: 'CONTRATO DE PRESTACIÓN DE SERVICIOS DE CONSULTORÍA Y DESARROLLO DE SOFTWARE',
    fields: [
      {
        key: 'CLIENTE_NOMBRE', label: 'Nombre / Razón Social del Cliente', type: 'text', required: true,
      },
      {
        key: 'CLIENTE_RUT', label: 'RUT del Cliente', type: 'text', required: true,
      },
      {
        key: 'CLIENTE_DOMICILIO', label: 'Domicilio del Cliente', type: 'text', required: true,
      },
      {
        key: 'CLIENTE_REP_LEGAL', label: 'Nombre del Representante Legal del Cliente', type: 'text', required: true,
      },
      {
        key: 'ALCANCE_DETALLE',
        label: 'Alcance del Proyecto',
        type: 'textarea',
        required: true,
        placeholder: 'Desarrollo de sitio web y aplicación móvil',
      },
      {
        key: 'MONTO_TOTAL', label: 'Monto Total ($ CLP)', type: 'number', default: 600000,
      },
      {
        key: 'ABONO_MENSUAL', label: 'Monto de Abono Mensual ($ CLP)', type: 'number', default: 100000,
      },
      {
        key: 'CANTIDAD_CUOTAS', label: 'Cantidad de Cuotas', type: 'number', default: 6,
      },
    ],
    clauses: [
      { title: '', body: 'En La Serena, Chile, entre VYNEURAL SpA, RUT 78.505.157-2, representada por Matías Ignacio Torres Torres, RUT 21.195.909-6, con domicilio en Pasaje María Gutiérrez 648, Las Palmeras, La Serena, en adelante "EL PRESTADOR", y {{CLIENTE_NOMBRE}}, RUT {{CLIENTE_RUT}}, representada por {{CLIENTE_REP_LEGAL}}, con domicilio en {{CLIENTE_DOMICILIO}}, en adelante "EL CLIENTE", se acuerda lo siguiente:' },
      { title: 'PRIMERO (OBJETO)', body: 'EL PRESTADOR brindará servicios de consultoría informática y desarrollo de software consistentes en: {{ALCANCE_DETALLE}}.' },
      { title: 'SEGUNDO (PRECIO Y FORMA DE PAGO)', body: 'El valor total del servicio es de ${{MONTO_TOTAL}} CLP.\nEl pago se condiciona a la entrega del resultado esperado (validación conforme de la web y app). Una vez alcanzado el resultado esperado, EL CLIENTE pagará la suma en {{CANTIDAD_CUOTAS}} abonos mensuales y consecutivos de ${{ABONO_MENSUAL}} CLP cada uno.' },
      { title: 'TERCERO (PROPIEDAD INTELECTUAL)', body: 'Una vez pagado el total del precio acordado, la propiedad intelectual del software desarrollado será transferida a EL CLIENTE.' },
      { title: 'CUARTO (JURISDICCIÓN)', body: 'Las partes se someten a la jurisdicción de los Tribunales Ordinarios de Justicia de La Serena.' },
    ],
    signatures: [
      {
        partyLabel: 'EL PRESTADOR', name: 'Matías Ignacio Torres Torres', rut: '21.195.909-6', dynamic: false,
      },
      {
        partyLabel: 'EL CLIENTE', nameKey: 'CLIENTE_REP_LEGAL', rutKey: 'CLIENTE_RUT', dynamic: true,
      },
    ],
  },

  affiliate: {
    title: 'CONTRATO DE AFILIACIÓN Y PROGRAMA DE REFERIDOS',
    fields: [
      {
        key: 'AFILIADO_NOMBRE', label: 'Nombre del Afiliado / Referidor', type: 'text', required: true,
      },
      {
        key: 'AFILIADO_RUT', label: 'RUT del Afiliado', type: 'text', required: true,
      },
      {
        key: 'AFILIADO_EMAIL', label: 'Correo Electrónico del Afiliado', type: 'email', required: true,
      },
      {
        key: 'AFILIADO_DOMICILIO', label: 'Domicilio del Afiliado', type: 'text', required: true,
      },
      {
        key: 'AFILIADO_EXTRANJERO', label: '¿Afiliado Extranjero / Residente fuera de Chile?', type: 'checkbox',
      },
      {
        key: 'CODIGO_REFERIDO', label: 'Código Único de Referido', type: 'text', required: true,
      },
      {
        key: 'PORCENTAJE_COMISION',
        label: 'Porcentaje de Comisión (%)',
        type: 'number',
        default: 15,
        min: 0,
        max: 100,
      },
      {
        key: 'CONDICION_PAGO',
        label: 'Condición de Pago',
        type: 'text',
        default: 'Venta concretada y pago percibido por VYNEURAL SpA',
      },
    ],
    clauses: [
      { title: '', body: 'En La Serena, Chile, entre VYNEURAL SpA, RUT 78.505.157-2, representada por Matías Ignacio Torres Torres, RUT 21.195.909-6, con domicilio en Pasaje María Gutiérrez 648, Las Palmeras, La Serena, en adelante "LA EMPRESA", y {{AFILIADO_NOMBRE}}, RUT {{AFILIADO_RUT}}, con domicilio en {{AFILIADO_DOMICILIO}} y correo electrónico {{AFILIADO_EMAIL}}, en adelante "EL AFILIADO", se acuerda el siguiente convenio de referidos:' },
      { title: 'PRIMERO (OBJETO Y CÓDIGO DE REFERIDO)', body: 'EL AFILIADO promocionará los servicios de LA EMPRESA utilizando su código único de referido: {{CODIGO_REFERIDO}}.' },
      { title: 'SEGUNDO (COMISIONES)', body: 'Por cada venta efectivamente concretada y pagada a LA EMPRESA atribuible directamente al código {{CODIGO_REFERIDO}}, EL AFILIADO recibirá una comisión equivalente al {{PORCENTAJE_COMISION}}% del valor neto asignado del servicio o producto contratado.' },
      { title: 'TERCERA (LIQUIDACIÓN Y PAGO)', body: 'Las comisiones se liquidarán y pagarán de manera mensual dentro de los primeros 10 días del mes siguiente, previa presentación del documento tributario correspondiente (boleta de honorarios o factura) por parte de EL AFILIADO. Condición de pago aplicable: {{CONDICION_PAGO}}.' },
      { title: 'CUARTA (INDEPENDENCIA)', body: 'El presente contrato no establece relación de subyugación ni vínculo laboral entre las partes, constituyendo una alianza comercial independiente.' },
    ],
    signatures: [
      {
        partyLabel: 'LA EMPRESA', name: 'Matías Ignacio Torres Torres', rut: '21.195.909-6', dynamic: false,
      },
      {
        partyLabel: 'EL AFILIADO', nameKey: 'AFILIADO_NOMBRE', rutKey: 'AFILIADO_RUT', dynamic: true,
      },
    ],
    // Campos/cláusula adicionales para afiliados extranjeros (residentes
    // fuera de Chile) — se activan/desactivan desde el checkbox
    // AFILIADO_EXTRANJERO de `fields` (ver admin.js). No se re-sincronizan
    // solos: domesticClauseIndex es solo el punto de partida por defecto al
    // tildar/destildar, el admin puede haber reordenado/editado cláusulas
    // a mano después.
    foreignFields: [
      { key: 'PAIS_RESIDENCIA', label: 'País de Residencia', type: 'text', required: true },
      {
        key: 'MONEDA_LIQUIDACION', label: 'Moneda de Liquidación', type: 'select', options: ['CLP', 'USD'], default: 'USD',
      },
      {
        key: 'METODO_PAGO', label: 'Método de Pago Preferido', type: 'select', options: ['PayPal', 'Wise', 'SWIFT', 'Payoneer', 'Stripe'], default: 'PayPal',
      },
    ],
    foreignRutLabel: 'Tax ID / Pasaporte',
    foreignClause: {
      title: 'TERCERA (PAGO E IMPUESTOS — AFILIADO EXTRANJERO)',
      body: '1. MONEDA Y PAGO: Las comisiones se calcularán sobre las ventas cobradas y se liquidarán en {{MONEDA_LIQUIDACION}} mediante el método de pago {{METODO_PAGO}}. Las comisiones por transferencia o conversión de divisas serán asumidas por EL AFILIADO.\n\n2. OBLIGACIONES TRIBUTARIAS: EL AFILIADO declara que opera y reside fuera del territorio chileno. Para hacer efectivo el cobro, EL AFILIADO deberá emitir un documento de cobro válido en su país de residencia (Invoice / Factura Internacional). EL AFILIADO es el único responsable del cumplimiento de las obligaciones tributarias que le correspondan en su jurisdicción de residencia.',
    },
    domesticClauseIndex: 3, // índice de TERCERA dentro de `clauses`
  },
};

// Sustituye cada {{TOKEN}} en un string por el valor actual del formulario.
// Si un campo está vacío usa un placeholder visualmente obvio ([TOKEN]) en
// vez de dejar el molde {{TOKEN}} literal o tirar una excepción — así la
// vista previa siempre muestra algo legible incluso antes de que el admin
// termine de llenar el formulario.
export function substituteTokens(text, values) {
  const data = values || {};
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, token) => {
    const raw = data[token];
    const isEmpty = raw === undefined || raw === null || String(raw).trim() === '';
    if (isEmpty) return `[${token}]`;
    if (MONEY_FIELD_KEYS.has(token)) return Number(raw || 0).toLocaleString('es-CL');
    return String(raw);
  });
}

// Aplica substituteTokens a un array de cláusulas {title, body} — usado
// tanto para las cláusulas por defecto de un template como para las que el
// admin ya editó/agregó/borró a mano (ver admin.js, estado mutable
// adminContractClauses) — la sustitución de tokens es independiente de si
// la cláusula vino del template original o la escribió el admin de cero.
export function fillClauses(clauses, values) {
  return (clauses || []).map((c) => ({
    title: substituteTokens(c.title, values),
    body: substituteTokens(c.body, values),
  }));
}

// Clon profundo de las cláusulas por defecto de un template — el admin
// parte de esto y lo edita libremente en memoria (agregar/editar/borrar
// cláusulas), nunca muta el array original del template.
export function defaultClausesFor(templateId) {
  const template = CONTRACT_TEMPLATES[templateId];
  if (!template) return [];
  return template.clauses.map((c) => ({ ...c }));
}
