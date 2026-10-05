const admin = require('firebase-admin');
const { normalizeMechanicData, calculateMechanicScore, calculateNitroxLevel } = require('./scoring');

// Initialize Firebase Admin for Firestore
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      projectId: 'agente-nitrox'
    });
  } catch (e) {
    // Local fallback
  }
}

const memoryCache = {};

// Helper to extract personal name
function extractName(text) {
  const match = text.match(/(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/i);
  if (match) return match[1];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && !/^(hola|buenas|quiero|vengo|afiliar|taller|red)/i.test(words[0])) {
    return words[0];
  }
  return '';
}

// Helpers to extract brand, bikes, parts and nitro feedback
function extractBrandsAndBikes(text) {
  const brands = [];
  const types = [];
  const lower = text.toLowerCase();

  if (/yamaha/i.test(lower)) brands.push('Yamaha');
  if (/bajaj|pulsar|boxer/i.test(lower)) brands.push('Bajaj');
  if (/akt|nkd/i.test(lower)) brands.push('AKT');
  if (/honda/i.test(lower)) brands.push('Honda');
  if (/suzuki/i.test(lower)) brands.push('Suzuki');
  if (/tvs/i.test(lower)) brands.push('TVS');
  if (/hero/i.test(lower)) brands.push('Hero');
  if (/ktm/i.test(lower)) brands.push('KTM');
  if (brands.length === 0) brands.push('Yamaha', 'Bajaj', 'AKT');

  if (/scooter|automatica|bws|nmax/i.test(lower)) types.push('Scooter / Automáticas');
  if (/trabajo|100|125|150|mensajeria/i.test(lower)) types.push('Motos de trabajo (100 - 150 cc)');
  if (/mediana|200|250|300|399/i.test(lower)) types.push('Media cilindrada (151 - 399 cc)');
  if (/alta|400|600|1000/i.test(lower)) types.push('Alta cilindrada (400 cc o más)');
  if (types.length === 0) types.push('Motos de trabajo (100 - 150 cc)', 'Scooter / Automáticas');

  return { brands, types };
}

function extractParts(text) {
  const parts = [];
  const lower = text.toLowerCase();
  if (/freno|pastilla|banda|disco/i.test(lower)) parts.push('Pastillas y bandas de freno');
  if (/arrastre|kit|cadena|pinon|corona/i.test(lower)) parts.push('Kit de arrastre');
  if (/motor|valvula|cilindro|piston|ajuste/i.test(lower)) parts.push('Motor y ajuste');
  if (/aceite|filtro|preventivo|mantenimiento/i.test(lower)) parts.push('Mantenimiento preventivo / lubricación');
  if (/suspension|amortiguador/i.test(lower)) parts.push('Suspensión y amortiguadores');
  if (/electr|bateria|luces|inyeccion/i.test(lower)) parts.push('Electricidad e inyección');
  if (parts.length === 0) parts.push('Pastillas de freno', 'Kit de arrastre');
  return parts;
}

// Persistent session management via Firestore + RAM cache
async function getSession(phoneNumber) {
  if (memoryCache[phoneNumber]) {
    return memoryCache[phoneNumber];
  }

  try {
    const doc = await admin.firestore().collection('sesiones_mateo').doc(phoneNumber).get();
    if (doc.exists) {
      memoryCache[phoneNumber] = doc.data();
      return memoryCache[phoneNumber];
    }
  } catch (e) {
    console.warn('[FIRESTORE GET SESSION]', e.message);
  }

  const newSession = {
    stage: 'INIT',
    data: {},
    history: []
  };
  memoryCache[phoneNumber] = newSession;
  return newSession;
}

async function saveSession(phoneNumber, session) {
  memoryCache[phoneNumber] = session;
  try {
    await admin.firestore().collection('sesiones_mateo').doc(phoneNumber).set(session, { merge: true });
  } catch (e) {
    console.warn('[FIRESTORE SAVE SESSION]', e.message);
  }
}

// Global in-memory cache for mechanics fallback
const localMecanicosStore = [];

async function saveMechanicToFirestore(phone, data) {
  const cleanPhone = (phone || '').replace(/\D/g, '');
  const normalized = normalizeMechanicData({
    ...data,
    celular_whatsapp: cleanPhone,
    telefono: cleanPhone,
    tiene_whatsapp: true,
    promotor: 'Agente WhatsApp Mateo (Canal Principal)',
    origen_registro: 'WhatsApp'
  }, 'WhatsApp');

  localMecanicosStore.unshift(normalized);

  try {
    await admin.firestore().collection('mecanicos_red_nitrox').doc(normalized.id_unico).set(normalized, { merge: true });
    console.log(`[FIRESTORE] Mecánico/Taller "${normalized.nombre_taller}" guardado vía WhatsApp con ID: ${normalized.id_unico}`);
  } catch (err) {
    console.warn('[FIRESTORE MECHANIC SAVE (fallback local)]', err.message);
  }
  return normalized;
}

async function generateMateoResponse(fromNumber, userText) {
  const session = await getSession(fromNumber);
  session.history = session.history || [];
  session.data = session.data || {};
  session.history.push({ role: 'user', content: userText, timestamp: Date.now() });

  const textLower = userText.toLowerCase().trim();
  let messagesToSend = [];

  // Reset ONLY if user explicitly requests another workshop or reset
  if (session.stage === 'COMPLETED') {
    if (/(otro taller|nuevo taller|registrar otro|reiniciar|nueva afiliacion|borrar datos)/i.test(textLower)) {
      session.stage = 'INIT';
      session.data = {};
    }
  }

  // --- Conversational Flow (Canal Principal de Registro RED NITROX) ---
  if (session.stage === 'INIT') {
    const foundName = extractName(userText);
    const hasDetails = foundName && (/(?:taller|motos|moto)/i.test(userText) || userText.split(/\s+/).length > 4);

    if (!hasDetails) {
      if (foundName) session.data.nombres_apellidos = foundName;
      messagesToSend = [
        '¡Hola! Soy Mateo, asesor de la RED NITROX en Medellín.',
        '¿Cómo es tu nombre completo y cómo se llama tu taller de motos?'
      ];
      session.stage = 'AWAITING_NAME_AND_WORKSHOP';
    } else {
      session.data.nombres_apellidos = foundName;
      const workshopMatch = userText.match(/(?:taller|motos|moto)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+)/i);
      session.data.nombre_taller = workshopMatch ? workshopMatch[0].trim() : 'Taller Aliado';

      const saludoName = session.data.nombres_apellidos ? '¡Un gusto ' + session.data.nombres_apellidos + '! ' : '';
      messagesToSend = [
        saludoName + '¿En qué municipio y barrio está ubicado tu taller (ej: Medellín Guayabal, Bello, Itagüí, etc.)? ¿Y cuál es tu rol allá (propietario, mecánico o socio)?'
      ];
      session.stage = 'AWAITING_LOCATION_AND_ROLE';
    }

  } else if (session.stage === 'AWAITING_NAME_AND_WORKSHOP') {
    // Parse name and workshop
    const parts = userText.split(/,| y | taller /i);
    if (!session.data.nombres_apellidos) {
      session.data.nombres_apellidos = parts[0]?.trim() || userText.trim();
    }
    session.data.nombre_taller = parts.length > 1 ? parts[1]?.trim() : userText.trim();

    const saludoName = session.data.nombres_apellidos ? '¡Un gusto ' + session.data.nombres_apellidos + '! ' : '';
    messagesToSend = [
      saludoName + '¿En qué municipio y barrio está ubicado tu taller (ej: Medellín Guayabal, Bello, Itagüí, etc.)? ¿Y cuál es tu rol allá (propietario, mecánico o socio)?'
    ];
    session.stage = 'AWAITING_LOCATION_AND_ROLE';

  } else if (session.stage === 'AWAITING_LOCATION_AND_ROLE') {
    // Detect city and role
    session.data.ubicacion_raw = userText;
    if (/bello/i.test(userText)) session.data.ciudad_taller = 'Bello';
    else if (/itagui|itaguí/i.test(userText)) session.data.ciudad_taller = 'Itagüí';
    else if (/envigado/i.test(userText)) session.data.ciudad_taller = 'Envigado';
    else if (/sabaneta/i.test(userText)) session.data.ciudad_taller = 'Sabaneta';
    else if (/estrella/i.test(userText)) session.data.ciudad_taller = 'La Estrella';
    else if (/caldas/i.test(userText)) session.data.ciudad_taller = 'Caldas';
    else session.data.ciudad_taller = 'Medellín';

    session.data.ciudad_residencia = session.data.ciudad_taller;
    session.data.barrio_taller = userText.replace(/propietario|dueño|dueno|administrador|socio|mecanico|empleado/gi, '').trim() || 'Barrio Principal';

    if (/propietario|dueño|dueno/i.test(userText)) session.data.relacion_taller = 'Propietario';
    else if (/administrador/i.test(userText)) session.data.relacion_taller = 'Administrador';
    else if (/socio/i.test(userText)) session.data.relacion_taller = 'Socio';
    else session.data.relacion_taller = 'Mecánico-empleado';

    messagesToSend = [
      'Anotada la zona.',
      '¿Cuántas motos atienden por semana aproximadamente? ¿Y qué marcas o tipos de motos son las que más ingresan a tu taller (Yamaha, Bajaj, AKT, scooters, etc.)?'
    ];
    session.stage = 'AWAITING_VOLUME_AND_BIKES';

  } else if (session.stage === 'AWAITING_VOLUME_AND_BIKES') {
    session.data.motos_por_semana = userText;
    const { brands, types } = extractBrandsAndBikes(userText);
    session.data.marcas_motos = brands;
    session.data.tipo_motos = types;

    messagesToSend = [
      'Buen volumen de trabajo.',
      'En tu taller, ¿quién decide generalmente la marca de repuestos a instalar (tú como mecánico o el dueño de la moto)? ¿Y qué repuestos cambias con mayor frecuencia (frenos, kit de arrastre, partes de motor, etc.)?'
    ];
    session.stage = 'AWAITING_DECISION_AND_PARTS';

  } else if (session.stage === 'AWAITING_DECISION_AND_PARTS') {
    if (/yo|mecanico|mecánico|ambos|nosotros|taller/i.test(userText)) {
      session.data.quien_decide_repuesto = 'Mecánico';
      session.data.frecuencia_recomendacion = 'Siempre';
    } else {
      session.data.quien_decide_repuesto = 'Propietario de la moto';
      session.data.frecuencia_recomendacion = 'Algunas veces';
    }
    session.data.repuestos_frecuentes = extractParts(userText);
    session.data.marcas_repuestos_usadas = ['NITROX'];

    messagesToSend = [
      '¡Clave ese criterio!',
      '¿Ya conoces o has utilizado repuestos de la marca NITROX en tu taller? ¿Qué tal te ha parecido la calidad?'
    ];
    session.stage = 'AWAITING_NITROX_RELATION';

  } else if (session.stage === 'AWAITING_NITROX_RELATION') {
    if (/si|sí|claro|usado|probado|conozco|buen|excelente/i.test(textLower)) {
      session.data.conoce_nitrox = 'Sí';
      session.data.ha_usado_nitrox = 'Sí';
      session.data.calificacion_experiencia_nitrox = /excelente/i.test(textLower) ? 'Excelente' : 'Buena';
      session.data.recomendaria_nitrox = 'Definitivamente sí';
    } else {
      session.data.conoce_nitrox = 'No';
      session.data.ha_usado_nitrox = 'No';
      session.data.calificacion_experiencia_nitrox = 'No aplica';
      session.data.recomendaria_nitrox = 'Probablemente sí';
    }

    // Direct registration to Firestore as primary channel
    const normalized = await saveMechanicToFirestore(fromNumber, session.data);
    const clientName = session.data.nombres_apellidos ? ' ' + session.data.nombres_apellidos : '';
    const idDisplay = normalized?.id_unico || 'RN-MED-PILOTO';
    const nivelDisplay = normalized ? `Nivel ${normalized.nivel_relacion_numero}: ${normalized.nivel_relacion_nombre}` : 'Nivel 1: Registrado';
    const cleanPhone = (fromNumber || '').replace(/\D/g, '');

    messagesToSend = [
      `¡Listo${clientName}! Con estos datos ya quedaste 100% REGISTRADO y ACTIVO en la base de datos oficial de RED NITROX (Piloto Medellín).`,
      `Tu código oficial de aliado es ${idDisplay} (${nivelDisplay}). Ya quedas habilitado para visitas técnicas de ruta, muestras de repuestos y capacitaciones.`,
      `Tu registro principal por aquí ya está completo. De forma 100% opcional, si deseas consultar tu ficha o seleccionar temas específicos de cursos técnicos presenciales/virtuales, puedes ingresar aquí: https://webhook-my2e3j2ecq-uc.a.run.app/formulario?id=${idDisplay}&tel=${cleanPhone}`,
      'Cualquier duda o repuesto me escribes directamente por acá. ¡Bienvenido a RED NITROX!'
    ];
    session.stage = 'COMPLETED';

  } else if (session.stage === 'COMPLETED') {
    const clientName = session.data.nombres_apellidos ? ' ' + session.data.nombres_apellidos : '';
    const idDisplay = session.data.id_unico || 'RN-MED-PILOTO';
    const cleanPhone = (fromNumber || '').replace(/\D/g, '');

    messagesToSend = [
      `¡Hola de nuevo${clientName}! Tu taller "${session.data.nombre_taller || 'Aliado'}" ya está 100% registrado y activo en RED NITROX con el código ${idDisplay}.`,
      `Si deseas ver los temas de capacitación técnica opcionales, puedes verlos aquí: https://webhook-my2e3j2ecq-uc.a.run.app/formulario?id=${idDisplay}&tel=${cleanPhone}. O si necesitas registrar otro taller o mecánico, me avisas y lo hacemos de una.`
    ];
  }

  session.history.push({ role: 'assistant', content: messagesToSend.join(' '), timestamp: Date.now() });
  await saveSession(fromNumber, session);

  return messagesToSend;
}

module.exports = {
  generateMateoResponse,
  admin,
  localMecanicosStore
};