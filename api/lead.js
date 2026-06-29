// Vercel Serverless Function — recibe el lead de la landing y lo envía por correo vía Resend.
// Sin dependencias: usa la API REST de Resend con fetch (Node 18+ en Vercel trae fetch global).
// La API key NUNCA se hardcodea: se lee de process.env.RESEND_API_KEY.

const FROM = 'S-Peak Landing <hello@mail.s-peak.com>';
const TO = ['hola@scndal.com', 'nblondel@s-peak.com', 'hola@s-peak.com', 'michel.l@scndal.com'];
const SUBJECT = 'Nuevo lead - Landing Inglés para Empresas';

// Orígenes permitidos para CORS.
const ALLOWED_ORIGINS = ['https://s-peak.com', 'https://www.s-peak.com'];

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
      return res.status(502).json({ ok: false, error: 'No se pudo enviar el correo' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Excepción al enviar con Resend:', err);
    return res.status(500).json({ ok: false, error: 'Error inesperado al enviar el correo' });
  }
};
