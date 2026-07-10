// Vercel Serverless Function — recibe el lead de la landing y lo envía por correo vía Resend.
// Sin dependencias: usa la API REST de Resend con fetch (Node 18+ en Vercel trae fetch global).
// La API key NUNCA se hardcodea: se lee de process.env.RESEND_API_KEY.

const FROM = 'S-Peak Landing <hello@mail.s-peak.com>';
const TO = ['hola@scndal.com', 'nblondel@s-peak.com', 'hola@s-peak.com', 'michel.l@scndal.com'];
const SUBJECT = 'Nuevo lead - Landing Inglés para Empresas';

// Orígenes permitidos para CORS.
const ALLOWED_ORIGINS = ['https://s-peak.com', 'https://www.s-peak.com'];

// Kommo — el lead se crea en el buzón "Leads Entrantes" (Incoming Leads) del pipeline
// Leads B2B por la ruta Unsorted (POST /leads/unsorted/forms). El token y el subdominio
// SOLO se leen de variables de entorno (process.env), nunca se escriben en el código.
const KOMMO_PIPELINE_ID = 7648487;
const KOMMO_REQUEST_TIMEOUT_MS = 7000;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Petición a la API de Kommo con timeout, para que una llamada lenta no retenga la función.
async function kommoFetch(url, token, method, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KOMMO_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Crea el lead en Kommo por la ruta Unsorted para que caiga en el buzón "Leads Entrantes"
// del pipeline Leads B2B, con el contacto (y empresa si viene) ligados y SIN responsable:
// quien lo acepte en Kommo se vuelve el responsable, por eso no mandamos user_id ni status_id.
// Nunca lanza: cualquier error se registra en log para que no pase silencioso.
async function sendLeadToKommo({ nombre, empresa, correo, telefono, detalles, sourceName, req }) {
  const token = process.env.KOMMO_TOKEN;
  const subdomain = process.env.KOMMO_SUBDOMAIN;
  if (!token || !subdomain) {
    console.error('Kommo: faltan variables de entorno; se omite la creación del lead', {
      hasToken: !!token,
      hasSubdomain: !!subdomain,
    });
    return;
  }

  const base = `https://${subdomain}.kommo.com/api/v4`;
  const nowSec = Math.floor(Date.now() / 1000);
  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || '0.0.0.0';
  const referer = (req.headers['referer'] || req.headers['origin'] || '').toString();

  // Contacto: nombre + email y teléfono como campos de sistema de Kommo.
  const contactFields = [];
  if (correo) {
    contactFields.push({ field_code: 'EMAIL', values: [{ value: correo, enum_code: 'WORK' }] });
  }
  if (telefono) {
    contactFields.push({ field_code: 'PHONE', values: [{ value: telefono, enum_code: 'WORK' }] });
  }
  const contact = { name: nombre || correo || 'Contacto sin nombre' };
  if (contactFields.length) {
    contact.custom_fields_values = contactFields;
  }

  const leadName = `Lead Web — ${nombre || correo || 'Sin nombre'}${empresa ? ` (${empresa})` : ''}`;

  // NO enviamos responsable ni status_id: el lead entra al buzón de aceptación tal cual.
  const embedded = {
    leads: [{ name: leadName, pipeline_id: KOMMO_PIPELINE_ID }],
    contacts: [contact],
  };
  if (empresa) {
    embedded.companies = [{ name: empresa }];
  }

  const payload = [
    {
      source_name: sourceName,
      source_uid: `web-${nowSec}-${Math.random().toString(36).slice(2, 10)}`,
      created_at: nowSec,
      pipeline_id: KOMMO_PIPELINE_ID,
      metadata: {
        form_id: 'formulario-landing',
        form_name: sourceName,
        form_sent_at: nowSec,
        form_page: referer || 'https://s-peak.com',
        ip,
      },
      _embedded: embedded,
    },
  ];

  let leadId = null;
  try {
    const res = await kommoFetch(`${base}/leads/unsorted/forms`, token, 'POST', payload);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      console.error('Kommo: fallo al crear el lead (unsorted/forms):', res.status, text);
      return;
    }
    try {
      const data = JSON.parse(text);
      const unsorted = (((data._embedded || {}).unsorted || [])[0] || {})._embedded || {};
      leadId = unsorted.leads && unsorted.leads[0] ? unsorted.leads[0].id : null;
    } catch (_) {
      // Si no podemos parsear el ID, el lead ya se creó; solo perderíamos la nota.
    }
  } catch (err) {
    console.error('Kommo: excepción al crear el lead (unsorted/forms):', String((err && err.message) || err));
    return;
  }

  // Nota con los detalles del formulario, para que se vean al aceptar el lead en el buzón.
  if (leadId && detalles) {
    try {
      const noteRes = await kommoFetch(`${base}/leads/${leadId}/notes`, token, 'POST', [
        { note_type: 'common', params: { text: detalles } },
      ]);
      if (!noteRes.ok) {
        const noteText = await noteRes.text().catch(() => '');
        console.error('Kommo: lead creado pero falló la nota con los detalles:', noteRes.status, noteText);
      }
    } catch (err) {
      console.error('Kommo: lead creado pero excepción al agregar la nota:', String((err && err.message) || err));
    }
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  // Preflight CORS.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Falta la variable de entorno RESEND_API_KEY');
    return res.status(500).json({ ok: false, error: 'Configuración del servidor incompleta' });
  }

  // Body puede llegar ya parseado (objeto) o como string según el content-type.
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'JSON inválido' });
    }
  }
  body = body || {};

  const nombre = (body.nombre || '').toString().trim();
  const empresa = (body.empresa || '').toString().trim();
  const correo = (body.correo || '').toString().trim();
  const telefono = (body.telefono || '').toString().trim();
  const puesto = (body.puesto || '').toString().trim();
  const mensaje = (body.mensaje || '').toString().trim();
  const origen = (body.origen || '').toString().trim() || 'Desconocido';

  // Etiquetas internas: UTMs de la URL e idioma fijo de la landing.
  const noEspecificado = 'No especificado';
  const utmSource = (body.utm_source || '').toString().trim() || noEspecificado;
  const utmMedium = (body.utm_medium || '').toString().trim() || noEspecificado;
  const utmCampaign = (body.utm_campaign || '').toString().trim() || noEspecificado;
  const utmContent = (body.utm_content || '').toString().trim() || noEspecificado;
  const idioma = (body.idioma || '').toString().trim() || 'Inglés';

  // Validación mínima: nombre y correo son indispensables para un lead útil.
  if (!nombre || !correo) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios (nombre y correo)' });
  }

  const noProporcionado = 'No proporcionado';
  const rows = [
    ['Origen', origen],
    ['Nombre', nombre],
    ['Empresa', empresa || noProporcionado],
    ['Correo', correo],
    ['Teléfono', telefono || noProporcionado],
    ['Puesto', puesto || noProporcionado],
    ['Mensaje', mensaje || noProporcionado],
    ['Idioma', idioma],
    ['UTM Source', utmSource],
    ['UTM Medium', utmMedium],
    ['UTM Campaign', utmCampaign],
    ['UTM Content', utmContent],
  ];

  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; max-width: 560px;">
    <h2 style="color:#1A3C4D; margin:0 0 4px;">Nuevo lead — Landing Inglés para Empresas</h2>
    <p style="margin:0 0 16px; color:#6b7280; font-size:14px;">Recibido desde: <strong>${escapeHtml(origen)}</strong></p>
    <table style="border-collapse:collapse; width:100%; font-size:15px;">
      ${rows
        .map(
          ([k, v]) => `
        <tr>
          <td style="padding:8px 12px; background:#F5F7FA; font-weight:bold; border:1px solid #e5e7eb; white-space:nowrap; vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:8px 12px; border:1px solid #e5e7eb;">${escapeHtml(v).replace(/\n/g, '<br>')}</td>
        </tr>`
        )
        .join('')}
    </table>
  </div>`;

  // Kommo (fire-and-forget): arrancamos la creación del lead en paralelo al correo. Su
  // resultado NUNCA cambia la respuesta al cliente: el correo se manda y la conversión se
  // dispara aunque Kommo falle. sendLeadToKommo ya captura todo; el .catch es cinturón extra.
  const sourceName = `Formulario Sitio Web${origen && origen !== 'Desconocido' ? ` — ${origen}` : ''}`;
  const kommoDone = sendLeadToKommo({
    nombre,
    empresa,
    correo,
    telefono,
    detalles: text,
    sourceName,
    req,
  }).catch((err) => {
    console.error('Kommo: excepción no controlada al crear el lead:', String((err && err.message) || err));
  });

  let emailStatus;
  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: TO,
        subject: SUBJECT,
        html,
        text,
        // Responder al correo va directo al lead.
        reply_to: correo,
      }),
    });

    if (!resendRes.ok) {
      const detail = await resendRes.text().catch(() => '');
      console.error('Error de Resend:', resendRes.status, detail);
      emailStatus = 'failed';
    } else {
      emailStatus = 'ok';
    }
  } catch (err) {
    console.error('Excepción al enviar con Resend:', err);
    emailStatus = 'error';
  }

  // Esperamos a que Kommo termine dentro del ciclo de vida de la función (nunca lanza),
  // pero su resultado no altera el status que devolvemos.
  await kommoDone;

  if (emailStatus === 'ok') {
    return res.status(200).json({ ok: true });
  }
  if (emailStatus === 'failed') {
    return res.status(502).json({ ok: false, error: 'No se pudo enviar el correo' });
  }
  return res.status(500).json({ ok: false, error: 'Error inesperado al enviar el correo' });
};
