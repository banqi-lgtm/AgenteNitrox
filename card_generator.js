const sharp = require('sharp');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

async function generateCardImage(data) {
  const uniqueId = data.id_unico || 'RN-MED-PILOTO';
  const workshopName = (data.nombre_taller || 'Taller Aliado').toUpperCase();
  const mechanicName = data.nombres_apellidos || 'Mecánico Vinculado';
  const city = data.ciudad_taller || data.ciudad_residencia || 'Medellín';
  const role = data.relacion_taller || 'Mecánico';
  const volume = data.motos_por_semana ? (data.motos_por_semana.includes('motos') ? data.motos_por_semana : `${data.motos_por_semana} motos/sem`) : 'Alto Flujo';

  const targetUrl = `https://webhook-my2e3j2ecq-uc.a.run.app/carnet/${encodeURIComponent(uniqueId)}`;

  // Generate crisp QR code data URI
  const qrDataUrl = await QRCode.toDataURL(targetUrl, {
    width: 320,
    margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' }
  });

  // Read logo
  let logoDataUri = '';
  try {
    const logoPath = path.join(__dirname, 'public/nitrox-logo.png');
    if (fs.existsSync(logoPath)) {
      const logoBuf = fs.readFileSync(logoPath);
      logoDataUri = `data:image/png;base64,${logoBuf.toString('base64')}`;
    }
  } catch (e) {
    console.warn('Logo read error:', e.message);
  }

  // Escape XML strings
  const escapeXml = (str) => String(str || '').replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return m;
    }
  });

  const safeWorkshop = escapeXml(workshopName);
  const safeMechanic = escapeXml(mechanicName);
  const safeCity = escapeXml(city);
  const safeRole = escapeXml(role);
  const safeVolume = escapeXml(volume);
  const safeId = escapeXml(uniqueId);

  const svg = `
  <svg width="600" height="960" viewBox="0 0 600 960" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="cardBg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#181922"/>
        <stop offset="100%" stop-color="#090a0d"/>
      </linearGradient>
      <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#FFBA3B"/>
        <stop offset="50%" stop-color="#F5A623"/>
        <stop offset="100%" stop-color="#E69D00"/>
      </linearGradient>
    </defs>

    <!-- Outer Frame -->
    <rect width="600" height="960" rx="32" fill="#060608"/>
    <rect x="16" y="16" width="568" height="928" rx="26" fill="url(#cardBg)" stroke="#F5A623" stroke-width="2.5" stroke-opacity="0.6"/>
    <rect x="16" y="16" width="568" height="6" rx="3" fill="url(#goldGrad)"/>

    <!-- NITROX Logo -->
    ${logoDataUri ? `<image href="${logoDataUri}" x="150" y="38" width="300" height="80" preserveAspectRatio="xMidYMid meet"/>` : ''}

    <!-- Top Badge -->
    <rect x="165" y="132" width="270" height="28" rx="14" fill="#1b170c" stroke="#F5A623" stroke-width="1.2"/>
    <circle cx="184" cy="146" r="4.5" fill="#10B981"/>
    <text x="198" y="150" fill="#F5A623" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="bold" letter-spacing="1.5">TALLER ALIADO • PILOTO MEDELLIN</text>

    <!-- Subtitle -->
    <text x="300" y="192" text-anchor="middle" fill="#8E92A4" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="bold" letter-spacing="2">FICHA MAESTRA • TALLER VINCULADO</text>

    <!-- Workshop Name (Bold Prominent) -->
    <text x="300" y="234" text-anchor="middle" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="900" letter-spacing="0.5">${safeWorkshop}</text>

    <!-- Mechanic Name -->
    <text x="300" y="268" text-anchor="middle" fill="#F5A623" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="bold">${safeMechanic}</text>

    <!-- Meta Tags -->
    <g transform="translate(300, 298)">
      <rect x="-220" y="-12" width="135" height="25" rx="6" fill="#1f212c"/>
      <text x="-152" y="5" text-anchor="middle" fill="#C8CBD5" font-family="Arial, Helvetica, sans-serif" font-size="11">${safeCity}, Antioquia</text>

      <rect x="-75" y="-12" width="110" height="25" rx="6" fill="#1f212c"/>
      <text x="-20" y="5" text-anchor="middle" fill="#C8CBD5" font-family="Arial, Helvetica, sans-serif" font-size="11">${safeRole}</text>

      <rect x="45" y="-12" width="125" height="25" rx="6" fill="#1f212c"/>
      <text x="107" y="5" text-anchor="middle" fill="#C8CBD5" font-family="Arial, Helvetica, sans-serif" font-size="11">${safeVolume}</text>
    </g>

    <!-- QR Box Container -->
    <rect x="135" y="340" width="330" height="330" rx="22" fill="#FFFFFF" stroke="#F5A623" stroke-width="4"/>
    <image href="${qrDataUrl}" x="150" y="355" width="300" height="300" preserveAspectRatio="xMidYMid meet"/>

    <!-- QR Badge -->
    <rect x="230" y="656" width="140" height="24" rx="12" fill="#08080A" stroke="#F5A623" stroke-width="1.5"/>
    <text x="300" y="672" text-anchor="middle" fill="#F5A623" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="bold" letter-spacing="1.5">QR OFICIAL</text>

    <!-- Unique ID -->
    <g transform="translate(300, 720)">
      <rect x="-140" y="-16" width="280" height="34" rx="10" fill="#1c180e" stroke="#F5A623" stroke-width="1.2" stroke-dasharray="4,3"/>
      <text x="0" y="6" text-anchor="middle" fill="#F5A623" font-family="Courier, monospace" font-size="15" font-weight="bold" letter-spacing="2">${safeId}</text>
    </g>

    <!-- Caption -->
    <text x="300" y="776" text-anchor="middle" fill="#8E92A4" font-family="Arial, Helvetica, sans-serif" font-size="11.5">Escanea este codigo o ingresa al enlace para certificar</text>
    <text x="300" y="794" text-anchor="middle" fill="#8E92A4" font-family="Arial, Helvetica, sans-serif" font-size="11.5">la vinculacion oficial del taller en la RED NITROX Medellin.</text>

    <!-- Benefits Line -->
    <line x1="50" y1="826" x2="550" y2="826" stroke="#262835" stroke-width="1"/>
    <g transform="translate(85, 856)">
      <text x="0" y="0" fill="#F5A623" font-family="Arial, Helvetica, sans-serif" font-size="14">★</text>
      <text x="16" y="-1" fill="#C8CBD5" font-family="Arial, Helvetica, sans-serif" font-size="11.5">Muestras y Catalogo</text>

      <text x="230" y="0" fill="#F5A623" font-family="Arial, Helvetica, sans-serif" font-size="14">★</text>
      <text x="246" y="-1" fill="#C8CBD5" font-family="Arial, Helvetica, sans-serif" font-size="11.5">Capacitacion Tecnica</text>
    </g>
    <g transform="translate(85, 888)">
      <text x="0" y="0" fill="#F5A623" font-family="Arial, Helvetica, sans-serif" font-size="14">★</text>
      <text x="16" y="-1" fill="#C8CBD5" font-family="Arial, Helvetica, sans-serif" font-size="11.5">Precios Especiales</text>

      <text x="230" y="0" fill="#F5A623" font-family="Arial, Helvetica, sans-serif" font-size="14">★</text>
      <text x="246" y="-1" fill="#C8CBD5" font-family="Arial, Helvetica, sans-serif" font-size="11.5">Respaldo de Marca</text>
    </g>

    <text x="300" y="930" text-anchor="middle" fill="#5A5E70" font-family="Arial, Helvetica, sans-serif" font-size="10">RED NITROX Medellin 2026 • Impulsando los talleres de motos</text>
  </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateCardImage };

if (require.main === module) {
  generateCardImage({
    id_unico: 'RN-MED-5796DRQW',
    nombre_taller: 'Taller La 30 Leon',
    nombres_apellidos: 'Federico Gutiérrez',
    ciudad_taller: 'Medellín',
    relacion_taller: 'Propietario',
    motos_por_semana: '6 motos/semana'
  }).then(buf => {
    fs.writeFileSync(path.join(__dirname, 'test_card_out.png'), buf);
    console.log('Generated test_card_out.png successfully, size:', buf.length);
  }).catch(console.error);
}
