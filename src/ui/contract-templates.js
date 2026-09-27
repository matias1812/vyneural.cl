// src/ui/contract-templates.js
// Datos + lógica de relleno para el generador de contratos del panel admin
// (ver src/admin.js, sección "Admin: Generador de contratos"). 100%
// client-side — no hay backend involucrado, esto es solo texto legal fijo
// con tokens {{TOKEN}} sustituidos por los valores del formulario.

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
    body: `CONTRATO DE PRESTACIÓN DE SERVICIOS DE CONSULTORÍA Y DESARROLLO DE SOFTWARE

En La Serena, Chile, entre VYNEURAL SpA, RUT 78.505.157-2, representada por Matías Ignacio Torres Torres, RUT 21.195.909-6, con domicilio en Pasaje María Gutiérrez 648, Las Palmeras, La Serena, en adelante "EL PRESTADOR", y {{CLIENTE_NOMBRE}}, RUT {{CLIENTE_RUT}}, representada por {{CLIENTE_REP_LEGAL}}, con domicilio en {{CLIENTE_DOMICILIO}}, en adelante "EL CLIENTE", se acuerda lo siguiente:

PRIMERO (OBJETO): EL PRESTADOR brindará servicios de consultoría informática y desarrollo de software consistentes en: {{ALCANCE_DETALLE}}.

SEGUNDO (PRECIO Y FORMA DE PAGO): El valor total del servicio es de \${{MONTO_TOTAL}} CLP.
El pago se condiciona a la entrega del resultado esperado (validación conforme de la web y app). Una vez alcanzado el resultado esperado, EL CLIENTE pagará la suma en {{CANTIDAD_CUOTAS}} abonos mensuales y consecutivos de \${{ABONO_MENSUAL}} CLP cada uno.

TERCERO (PROPIEDAD INTELECTUAL): Una vez pagado el total del precio acordado, la propiedad intelectual del software desarrollado será transferida a EL CLIENTE.

CUARTO (JURISDICCIÓN): Las partes se someten a la jurisdicción de los Tribunales Ordinarios de Justicia de La Serena.`,
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
    body: `CONTRATO DE AFILIACIÓN Y PROGRAMA DE REFERIDOS

En La Serena, Chile, entre VYNEURAL SpA, RUT 78.505.157-2, representada por Matías Ignacio Torres Torres, RUT 21.195.909-6, con domicilio en Pasaje María Gutiérrez 648, Las Palmeras, La Serena, en adelante "LA EMPRESA", y {{AFILIADO_NOMBRE}}, RUT {{AFILIADO_RUT}}, con domicilio en {{AFILIADO_DOMICILIO}} y correo electrónico {{AFILIADO_EMAIL}}, en adelante "EL AFILIADO", se acuerda el siguiente convenio de referidos:

PRIMERO (OBJETO Y CÓDIGO DE REFERIDO): EL AFILIADO promocionará los servicios de LA EMPRESA utilizando su código único de referido: {{CODIGO_REFERIDO}}.

SEGUNDO (COMISIONES): Por cada venta efectivamente concretada y pagada a LA EMPRESA atribuible directamente al código {{CODIGO_REFERIDO}}, EL AFILIADO recibirá una comisión equivalente al {{PORCENTAJE_COMISION}}% del valor neto asignado del servicio o producto contratado.

TERCERA (LIQUIDACIÓN Y PAGO): Las comisiones se liquidarán y pagarán de manera mensual dentro de los primeros 10 días del mes siguiente, previa presentación del documento tributario correspondiente (boleta de honorarios o factura) por parte de EL AFILIADO. Condición de pago aplicable: {{CONDICION_PAGO}}.

CUARTA (INDEPENDENCIA): El presente contrato no establece relación de subyugación ni vínculo laboral entre las partes, constituyendo una alianza comercial independiente.`,
    signatures: [
      {
        partyLabel: 'LA EMPRESA', name: 'Matías Ignacio Torres Torres', rut: '21.195.909-6', dynamic: false,
      },
      {
        partyLabel: 'EL AFILIADO', nameKey: 'AFILIADO_NOMBRE', rutKey: 'AFILIADO_RUT', dynamic: true,
      },
    ],
  },
};

// Sustituye cada {{TOKEN}} en el body del template por el valor actual del
// formulario. Si un campo está vacío usa un placeholder visualmente obvio
// ([TOKEN]) en vez de dejar el molde {{TOKEN}} literal o tirar una excepción
// — así la vista previa siempre muestra algo legible incluso antes de que el
// admin termine de llenar el formulario.
export function fillContractTemplate(templateId, values) {
  const template = CONTRACT_TEMPLATES[templateId];
  if (!template) return '';
  const data = values || {};
  return template.body.replace(/\{\{(\w+)\}\}/g, (_, token) => {
    const raw = data[token];
    const isEmpty = raw === undefined || raw === null || String(raw).trim() === '';
    if (isEmpty) return `[${token}]`;
    if (MONEY_FIELD_KEYS.has(token)) {
      return Number(raw || 0).toLocaleString('es-CL');
    }
    return String(raw);
  });
}
