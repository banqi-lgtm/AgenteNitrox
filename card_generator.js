const sharp = require('sharp');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Logo recortado (el PNG original es un cuadrado negro con mucho margen)
let _logoCache = null;
async function getLogoDataUri() {
  if (_logoCache !== null) return _logoCache;
  try {
    const logoPath = path.join(__dirname, 'public/nitrox-logo.png');
    if (!fs.existsSync(logoPath)) return (_logoCache = '');
    const meta = await sharp(logoPath).metadata();
    const s = meta.width / 447; // proporciones medidas sobre el original de 447px
    const buf = await sharp(logoPath)
      .extract({
        left: Math.round(30 * s),
        top: Math.round(178 * s),
        width: Math.round(392 * s),
        height: Math.round(90 * s)
      })
      .png()
      .toBuffer();
    _logoCache = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('Logo read error:', e.message);
    _logoCache = '';
  }
  return _logoCache;
}

const escapeXml = (str) => String(str || '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
}[m]));

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
}

async function generateCardImage(data) {
  const uniqueId = data.id_unico || 'RN-MED-0000';
  const workshop = String(data.nombre_taller || 'Taller Aliado').toUpperCase();
  const mechanic = titleCase(data.nombres_apellidos || '');
  const city = data.ciudad_taller || data.ciudad_residencia || 'Colombia';
  const location = data.barrio_taller ? `${titleCase(data.barrio_taller)} · ${city}` : city;

  const targetUrl = `https://webhook-my2e3j2ecq-uc.a.run.app/carnet/${encodeURIComponent(uniqueId)}`;
  const qrDataUrl = await QRCode.toDataURL(targetUrl, {
    width: 600,
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#FFFFFF' }
  });
  const logo = await getLogoDataUri();

  // Tamaño del nombre del taller según longitud
  const wsSize = workshop.length > 26 ? 22 : workshop.length > 18 ? 27 : 32;

  const W = 600, H = 900;
  const font = "Arial, Helvetica, sans-serif";

  const svg = `
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#FFFFFF"/>

    <!-- Encabezado de marca -->
    <rect width="${W}" height="150" fill="#000000"/>
    ${logo ? `<image href="${logo}" x="120" y="35" width="360" height="83" preserveAspectRatio="xMidYMid meet"/>` : ''}
    <rect y="150" width="${W}" height="6" fill="#F5B300"/>

    <!-- Identidad -->
    <text x="300" y="206" text-anchor="middle" fill="#9AA0AA" font-family="${font}" font-size="13" font-weight="bold" letter-spacing="4">TALLER ALIADO · RED NITROX</text>
    <text x="300" y="252" text-anchor="middle" fill="#111111" font-family="${font}" font-size="${wsSize}" font-weight="900">${escapeXml(workshop)}</text>
    ${mechanic ? `<text x="300" y="284" text-anchor="middle" fill="#3A3F48" font-family="${font}" font-size="19">${escapeXml(mechanic)}</text>` : ''}
    <text x="300" y="312" text-anchor="middle" fill="#8A909A" font-family="${font}" font-size="15">${escapeXml(location)}</text>

    <!-- QR -->
    <rect x="135" y="340" width="330" height="330" rx="20" fill="#FFFFFF" stroke="#E4E6EA" stroke-width="2"/>
    <image href="${qrDataUrl}" x="160" y="365" width="280" height="280"/>

    <!-- ID -->
    <rect x="190" y="694" width="220" height="38" rx="19" fill="#FFF6DA"/>
    <text x="300" y="719" text-anchor="middle" fill="#7A5A00" font-family="Courier New, monospace" font-size="17" font-weight="bold" letter-spacing="1.5">${escapeXml(uniqueId)}</text>
    <text x="300" y="766" text-anchor="middle" fill="#8A909A" font-family="${font}" font-size="14">Escanea para verificar la vinculación</text>

    <!-- Pie -->
    <rect y="820" width="${W}" height="80" fill="#000000"/>
    <rect y="820" width="${W}" height="4" fill="#F5B300"/>
    <text x="300" y="868" text-anchor="middle" fill="#FFFFFF" font-family="${font}" font-size="14" font-weight="bold" letter-spacing="3">RED NITROX <tspan fill="#F5B300">·</tspan> COLOMBIA</text>
  </svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateCardImage };

if (require.main === module) {
  generateCardImage({
    id_unico: 'RN-MED-5796DRQW',
    nombre_taller: 'La 50',
    nombres_apellidos: 'Dulce Ferrer',
    ciudad_taller: 'Medellín',
    barrio_taller: 'Laureles'
  }).then(buf => {
    fs.writeFileSync(path.join(__dirname, 'test_card_out.png'), buf);
    console.log('Generated test_card_out.png successfully, size:', buf.length);
  }).catch(console.error);
}
