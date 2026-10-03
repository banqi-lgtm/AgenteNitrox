const admin = require('firebase-admin');

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
  if (words.length <= 2 && !/^(hola|buenas|quiero|vengo|afiliar|taller)/i.test(words[0])) {
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

async function saveLeadToFirestore(phone, data) {
  try {
    await admin.firestore().collection('talleres_aliados').doc(phone).set({
      telefono: phone,
      nombre_contacto: data.userName || '',
      nombre_taller: data.workshopName || '',
      ubicacion: data.location || '',
      personal: data.teamSize || '',
      maquinaria: data.equipment || '',
      fecha_registro: new Date().toISOString()
    }, { merge: true });
    console.log(`[FIRESTORE] Taller "${data.workshopName}" guardado con exito`);
  } catch (err) {
    console.warn('[FIRESTORE LEAD SAVE]', err.message);
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

  // --- Conversational Flow ---
  if (session.stage === 'INIT') {
    const foundName = extractName(userText);
    if (foundName) session.data.userName = foundName;

    if (textLower.includes('taller') || textLower.includes('afiliar') || textLower.includes('registrar')) {
      if (session.data.userName) {
        messagesToSend = [
          'hola ' + session.data.userName + ', soy Mateo asesor de NITROX. un gusto saludarte',
          'para el registro de tu taller vamos a necesitar unos datos sencillos. como se llama el taller?'
        ];
        session.stage = 'ASK_WORKSHOP_NAME';
      } else {
        messagesToSend = [
          'hola, soy Mateo asesor de NITROX. con todo gusto te ayudo con la afiliacion',
          'como es tu nombre y como se llama el taller?'
        ];
        session.stage = 'ASK_WORKSHOP_NAME';
      }
    } else {
      messagesToSend = [
        'hola, soy Mateo asesor de NITROX',
        'como es tu nombre y que estas buscando en la plataforma hoy?'
      ];
      session.stage = 'AWAITING_NAME_AND_INTENT';
    }

  } else if (session.stage === 'AWAITING_NAME_AND_INTENT') {
    const foundName = extractName(userText);
    if (foundName) session.data.userName = foundName;

    const nameGreeting = session.data.userName ? 'un gusto ' + session.data.userName + '. ' : '';

    if (textLower.includes('taller') || textLower.includes('afiliar') || textLower.includes('registrar') || textLower.includes('alianza') || textLower.includes('socio') || textLower.includes('servicio')) {
      messagesToSend = [
        nameGreeting + 'de una, para afiliar tu taller a la red de aliados NITROX te voy a pedir unos datos breves',
        'como se llama tu taller?'
      ];
      session.stage = 'ASK_WORKSHOP_NAME';
    } else {
      messagesToSend = [
        nameGreeting + 'cuentame, vienes a registrar tu taller como aliado NITROX o necesitas alguna otra informacion?'
      ];
    }

  } else if (session.stage === 'ASK_WORKSHOP_NAME') {
    if (!session.data.userName) {
      const foundName = extractName(userText);
      if (foundName) session.data.userName = foundName;
    }
    session.data.workshopName = userText;
    messagesToSend = [
      'buen nombre, ' + userText,
      'en que ciudad estan ubicados y cual es la direccion del taller?'
    ];
    session.stage = 'ASK_LOCATION';

  } else if (session.stage === 'ASK_LOCATION') {
    session.data.location = userText;
    messagesToSend = [
      'listo, anotada la direccion',
      'cuantas personas o mecanicos trabajan alla contigo?'
    ];
    session.stage = 'ASK_TEAM_SIZE';

  } else if (session.stage === 'ASK_TEAM_SIZE') {
    session.data.teamSize = userText;
    messagesToSend = [
      'excelente equipo',
      'y que maquinaria o herramientas tienen? por ejemplo elevadores, escaner, torno, prensa, desmontadora de llantas...'
    ];
    session.stage = 'ASK_EQUIPMENT';

  } else if (session.stage === 'ASK_EQUIPMENT') {
    session.data.equipment = userText;
    const clientName = session.data.userName ? ' ' + session.data.userName : '';
    messagesToSend = [
      'perfecto, tienen muy buen equipo de trabajo',
      'listo' + clientName + ', ya te tome todos los datos:\n\n• Taller: ' + (session.data.workshopName || 'Aliado') + '\n• Ubicacion: ' + (session.data.location || 'Registrada') + '\n• Personal: ' + (session.data.teamSize || 'Registrado') + '\n• Maquinaria: ' + session.data.equipment,
      'con esto quedan registrados en la red de talleres aliados NITROX. en un momento te contactaremos para los siguientes pasos. cualquier duda me avisas'
    ];
    session.stage = 'COMPLETED';

    saveLeadToFirestore(fromNumber, session.data);

  } else if (session.stage === 'COMPLETED') {
    const clientName = session.data.userName ? ' ' + session.data.userName : '';
    messagesToSend = [
      'hola de nuevo' + clientName + ', los datos de tu taller ya quedaron radicados en NITROX',
      'si necesitas registrar otro taller o corregir algun dato me avisas y lo hacemos de una'
    ];
  }

  session.history.push({ role: 'assistant', content: messagesToSend.join(' '), timestamp: Date.now() });
  await saveSession(fromNumber, session);

  return messagesToSend;
}

module.exports = {
  generateMateoResponse
};