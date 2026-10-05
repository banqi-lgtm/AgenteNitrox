const admin = require('firebase-admin');
const { normalizeMechanicData } = require('./scoring');

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

async function saveMechanicToFirestore(phone, data) {
  try {
    const normalized = normalizeMechanicData({
      ...data,
      celular_whatsapp: phone,
      telefono: phone
    }, 'WhatsApp');

    await admin.firestore().collection('mecanicos_red_nitrox').doc(phone).set(normalized, { merge: true });
    console.log(`[FIRESTORE] Mecánico/Taller "${normalized.nombre_taller}" guardado en RED NITROX con ID: ${normalized.id_unico}`);
    return normalized;
  } catch (err) {
    console.warn('[FIRESTORE MECHANIC SAVE]', err.message);
    return null;
  }
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
    if (/(otro taller|nuevo taller|registrar otro|reiniciar|nueva afiliacion)/i.test(textLower)) {
      session.stage = 'INIT';
      session.data = {};
    }
  }

  // --- Conversational Flow (4 Bloques Ágiles RED NITROX) ---
  if (session.stage === 'INIT') {
    const foundName = extractName(userText);
    if (foundName) session.data.nombres_apellidos = foundName;

    messagesToSend = [
      'hola, soy Mateo asesor de RED NITROX',
      'como es tu nombre y como se llama tu taller?'
    ];
    session.stage = 'AWAITING_NAME_AND_WORKSHOP';

  } else if (session.stage === 'AWAITING_NAME_AND_WORKSHOP') {
    // Parse name and workshop
    const parts = userText.split(/,| y | taller /i);
    if (!session.data.nombres_apellidos) {
      session.data.nombres_apellidos = parts[0]?.trim() || userText.trim();
    }
    session.data.nombre_taller = parts.length > 1 ? parts[1]?.trim() : userText.trim();

    const saludoName = session.data.nombres_apellidos ? 'un gusto ' + session.data.nombres_apellidos + '. ' : '';
    messagesToSend = [
      saludoName + 'en que municipio y barrio esta ubicado el taller (ej: Medellin Guayabal, Bello, Itagui)? y cual es tu rol alla (propietario, mecanico o socio)?'
    ];
    session.stage = 'AWAITING_LOCATION_AND_ROLE';

  } else if (session.stage === 'AWAITING_LOCATION_AND_ROLE') {
    // Detect city and role
    session.data.ubicacion_raw = userText;
    if (/bello/i.test(userText)) session.data.ciudad_taller = 'Bello';
    else if (/itagui|itaguí/i.test(userText)) session.data.ciudad_taller = 'Itagüí';
    else if (/envigado/i.test(userText)) session.data.ciudad_taller = 'Envigado';
    else if (/sabaneta/i.test(userText)) session.data.ciudad_taller = 'Sabaneta';
    else session.data.ciudad_taller = 'Medellín';

    session.data.barrio_taller = userText;
    if (/propietario|dueño|dueno/i.test(userText)) session.data.relacion_taller = 'Propietario';
    else if (/administrador/i.test(userText)) session.data.relacion_taller = 'Administrador';
    else if (/socio/i.test(userText)) session.data.relacion_taller = 'Socio';
    else session.data.relacion_taller = 'Mecánico-empleado';

    messagesToSend = [
      'perfecto, anotada la zona',
      'cuantas motos atienden por semana aproximadamente? y en tu taller, quien decide que repuesto instalar (tu o el cliente)?'
    ];
    session.stage = 'AWAITING_VOLUME_AND_DECISION';

  } else if (session.stage === 'AWAITING_VOLUME_AND_DECISION') {
    session.data.motos_por_semana = userText;
    if (/yo|mecanico|mecánico|ambos/i.test(userText)) {
      session.data.quien_decide_repuesto = 'Mecánico';
    } else {
      session.data.quien_decide_repuesto = 'Propietario de la moto';
    }

    messagesToSend = [
      'excelente dato',
      'ya conoces o has utilizado repuestos NITROX en tus trabajos?'
    ];
    session.stage = 'AWAITING_NITROX_RELATION';

  } else if (session.stage === 'AWAITING_NITROX_RELATION') {
    if (/si|sí|claro|usado|utilizado/i.test(textLower)) {
      session.data.conoce_nitrox = 'Sí';
      session.data.ha_usado_nitrox = 'Sí';
      session.data.recomendaria_nitrox = 'Definitivamente sí';
    } else {
      session.data.conoce_nitrox = 'No';
      session.data.ha_usado_nitrox = 'No';
      session.data.recomendaria_nitrox = 'Probablemente sí';
    }

    // Save and compute scoring & level
    const normalized = await saveMechanicToFirestore(fromNumber, session.data);
    const clientName = session.data.nombres_apellidos ? ' ' + session.data.nombres_apellidos : '';
    const idDisplay = normalized?.id_unico || 'RN-MED-PILOTO';
    const nivelDisplay = normalized ? `Nivel ${normalized.nivel_relacion_numero}: ${normalized.nivel_relacion_nombre}` : 'Nivel 1: Registrado';

    messagesToSend = [
      'listo' + clientName + ', ya te tome los datos y quedas radicado como Mecanico Aliado RED NITROX (Piloto Medellin)',
      'tu codigo oficial es ' + idDisplay + ' (' + nivelDisplay + '). con esto quedas habilitado para beneficios, capacitaciones y pruebas de producto',
      'si quieres completar los temas de capacitacion que te interesan puedes ingresar aqui: https://webhook-my2e3j2ecq-uc.a.run.app/formulario. cualquier duda me escribes por aca'
    ];
    session.stage = 'COMPLETED';

  } else if (session.stage === 'COMPLETED') {
    const clientName = session.data.nombres_apellidos ? ' ' + session.data.nombres_apellidos : '';
    messagesToSend = [
      'hola de nuevo' + clientName + ', los datos de tu taller ya estan registrados en RED NITROX',
      'si necesitas actualizar algun dato o inscribir otro mecanico me avisas y lo hacemos de una'
    ];
  }

  session.history.push({ role: 'assistant', content: messagesToSend.join(' '), timestamp: Date.now() });
  await saveSession(fromNumber, session);

  return messagesToSend;
}

module.exports = {
  generateMateoResponse,
  admin
};