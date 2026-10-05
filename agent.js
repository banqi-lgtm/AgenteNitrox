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

// Helper to detect generic greetings
function isGreeting(text) {
  return /^(?:hola|buenas|buenos dias|buenas tardes|buenas noches|que mas|saludos|hey|alo|info|informacion|afiliacion|afiliar|red nitrox)[\s.,!]*$/i.test((text || '').trim());
}

// Helper to extract and clean personal name
function cleanPersonName(str) {
  if (!str) return '';
  let s = str.trim();
  if (isGreeting(s)) return '';
  s = s.replace(/^(?:hola|buenas|buenos dias|buenas tardes|soy|me llamo|mi nombre es)\s+/gi, '');
  s = s.replace(/(?:taller|motos|repuestos).*$/gi, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  if (isGreeting(s)) return '';
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 1 && /^(hola|buenas|quiero|taller|motos|info)$/i.test(words[0])) return '';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Helper to extract and clean workshop name
function cleanWorkshopName(str) {
  if (!str) return '';
  let s = str.replace(/^(?:y mi taller es|mi taller se llama|el taller es|el taller se llama|el taller|taller:\s*)\s*/gi, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  if (!/taller|motos|garage|repuestos/i.test(s)) {
    s = 'Taller ' + s;
  }
  return s.split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Intelligently parse Name and Workshop differentiating when only one or both are provided
function parseNameAndWorkshop(text) {
  let name = '';
  let workshop = '';
  const clean = (text || '').trim();

  if (isGreeting(clean)) {
    return { name: '', workshop: '' };
  }

  // 1. Multiline detection (User wrote name on line 1, workshop on line 2 or vice versa)
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const workshopRegex = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i;
    if (workshopRegex.test(lines[1]) && !workshopRegex.test(lines[0])) {
      name = cleanPersonName(lines[0]);
      workshop = cleanWorkshopName(lines[1]);
      return { name, workshop };
    } else if (workshopRegex.test(lines[0]) && !workshopRegex.test(lines[1])) {
      workshop = cleanWorkshopName(lines[0]);
      name = cleanPersonName(lines[1]);
      return { name, workshop };
    } else {
      name = cleanPersonName(lines[0]);
      workshop = cleanWorkshopName(lines[1]);
      return { name, workshop };
    }
  }

  // 2. Explicit patterns: "Soy Walter Gonzalez de Taller La 22" or "Walter Gonzalez del Taller La 22"
  const deMatch = clean.match(/(?:soy|me llamo|mi nombre es)?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+?)\s+(?:de|del|y mi taller es|y el taller es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+)/i);
  if (deMatch && deMatch[1].trim() && deMatch[2].trim()) {
    const candidateName = cleanPersonName(deMatch[1]);
    const candidateWorkshop = cleanWorkshopName(deMatch[2]);
    if (candidateName && candidateWorkshop) {
      return { name: candidateName, workshop: candidateWorkshop };
    }
  }

  // 3. Comma / " y " separator: "Walter Gonzalez, Taller La 22"
  if (clean.includes(',') || /\s+y\s+/i.test(clean)) {
    const parts = clean.split(/,|\s+y\s+/i).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const workshopRegex = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i;
      if (workshopRegex.test(parts[1]) && !workshopRegex.test(parts[0])) {
        return { name: cleanPersonName(parts[0]), workshop: cleanWorkshopName(parts[1]) };
      } else if (workshopRegex.test(parts[0]) && !workshopRegex.test(parts[1])) {
        return { name: cleanPersonName(parts[1]), workshop: cleanWorkshopName(parts[0]) };
      }
    }
  }

  // 4. Workshop only: "Taller La 22" or "Moto Taller El Paisa"
  const workshopOnlyRegex = /^(?:taller|el taller|moto taller|motos|repuestos|garage)\s+[A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+$/i;
  if (workshopOnlyRegex.test(clean) || (/(?:taller|repuestos|garage)/i.test(clean) && !/(?:soy|me llamo|mi nombre)/i.test(clean) && clean.split(/\s+/).length <= 4)) {
    return { name: '', workshop: cleanWorkshopName(clean) };
  }

  // 5. Person name only: "Walter Gonzalez" or "Me llamo Walter Gonzalez"
  const personOnlyMatch = clean.match(/(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+)/i);
  if (personOnlyMatch) {
    return { name: cleanPersonName(personOnlyMatch[1]), workshop: '' };
  }

  if (!/(?:taller|repuestos|motos|garage)/i.test(clean) && clean.split(/\s+/).length <= 4) {
    return { name: cleanPersonName(clean), workshop: '' };
  }

  return { name: cleanPersonName(clean), workshop: '' };
}

// Helpers to extract location and role
function extractLocationAndRole(text) {
  let ciudad = 'Medellín';
  let barrio = '';
  let rol = '';

  const lower = (text || '').toLowerCase();
  if (/bello/i.test(lower)) ciudad = 'Bello';
  else if (/itagui|itaguí/i.test(lower)) ciudad = 'Itagüí';
  else if (/envigado/i.test(lower)) ciudad = 'Envigado';
  else if (/sabaneta/i.test(lower)) ciudad = 'Sabaneta';
  else if (/estrella/i.test(lower)) ciudad = 'La Estrella';
  else if (/caldas/i.test(lower)) ciudad = 'Caldas';
  else if (/copacabana/i.test(lower)) ciudad = 'Copacabana';
  else if (/girardota/i.test(lower)) ciudad = 'Girardota';
  else ciudad = 'Medellín';

  if (/propietario|dueño|dueno/i.test(lower)) rol = 'Propietario';
  else if (/administrador/i.test(lower)) rol = 'Administrador';
  else if (/socio/i.test(lower)) rol = 'Socio';
  else if (/mecanico|mecánico|empleado/i.test(lower)) rol = 'Mecánico-empleado';

  const cleanBarrio = text
    .replace(/(?:medellin|medellín|bello|itagui|itaguí|envigado|sabaneta|la estrella|caldas|copacabana|girardota)/gi, '')
    .replace(/(?:propietario|dueño|dueno|administrador|socio|mecanico|mecánico|empleado)/gi, '')
    .replace(/[,.-]/g, ' ')
    .trim();
  if (cleanBarrio.length > 2) {
    barrio = cleanBarrio.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  } else {
    barrio = 'Sector Principal';
  }

  return { ciudad, barrio, rol };
}

// Helpers to extract volume and brands
function extractVolumeAndBrands(text) {
  let volume = (text || '').trim();
  const brands = [];
  const lower = (text || '').toLowerCase();

  if (/yamaha/i.test(lower)) brands.push('Yamaha');
  if (/bajaj|pulsar|boxer|bjaja/i.test(lower)) brands.push('Bajaj');
  if (/akt|nkd/i.test(lower)) brands.push('AKT');
  if (/honda/i.test(lower)) brands.push('Honda');
  if (/suzuki/i.test(lower)) brands.push('Suzuki');
  if (/tvs/i.test(lower)) brands.push('TVS');
  if (/hero/i.test(lower)) brands.push('Hero');
  if (/ktm/i.test(lower)) brands.push('KTM');
  if (/todas/i.test(lower)) brands.push('Todas las marcas');

  const types = [];
  if (/scooter|automatica|bws|nmax/i.test(lower)) types.push('Scooter / Automáticas');
  if (/trabajo|100|125|150|mensajeria/i.test(lower)) types.push('Motos de trabajo (100 - 150 cc)');
  if (/mediana|200|250|300|399/i.test(lower)) types.push('Media cilindrada (151 - 399 cc)');
  if (/alta|400|600|1000/i.test(lower)) types.push('Alta cilindrada (400 cc o más)');
  if (types.length === 0) types.push('Motos de trabajo (100 - 150 cc)', 'Scooter / Automáticas');

  const hasBrands = brands.length > 0;
  return { volume, brands, types, hasBrands };
}

// Helpers to extract parts
function extractParts(text) {
  const parts = [];
  const lower = (text || '').toLowerCase();
  if (/freno|pastilla|banda|disco/i.test(lower)) parts.push('Pastillas y bandas de freno');
  if (/arrastre|kit|cadena|pinon|corona/i.test(lower)) parts.push('Kit de arrastre');
  if (/motor|valvula|cilindro|piston|ajuste/i.test(lower)) parts.push('Motor y ajuste');
  if (/aceite|filtro|preventivo|mantenimiento/i.test(lower)) parts.push('Mantenimiento preventivo / lubricación');
  if (/suspension|amortiguador/i.test(lower)) parts.push('Suspensión y amortiguadores');
  if (/electr|bateria|luces|inyeccion/i.test(lower)) parts.push('Electricidad e inyección');
  if (/todo|todos|varias/i.test(lower) || parts.length === 0) {
    parts.push('Pastillas de freno', 'Kit de arrastre', 'Partes de motor');
  }
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
  if (!data.id_unico) {
    const rawId = (cleanPhone.slice(-4) || 'RN') + Math.random().toString(36).substring(2, 6).toUpperCase();
    data.id_unico = `RN-MED-${rawId}`;
  }

  const normalized = normalizeMechanicData({
    ...data,
    celular_whatsapp: cleanPhone,
    telefono: cleanPhone,
    tiene_whatsapp: true,
    promotor: 'Agente WhatsApp Mateo (Canal Principal)',
    origen_registro: 'WhatsApp'
  }, 'WhatsApp');

  // Update in-memory localMecanicosStore without duplicates
  const existingIdx = localMecanicosStore.findIndex(m => m.id_unico === normalized.id_unico || (cleanPhone && m.celular_whatsapp === cleanPhone));
  if (existingIdx >= 0) {
    localMecanicosStore[existingIdx] = Object.assign(localMecanicosStore[existingIdx], normalized);
  } else {
    localMecanicosStore.unshift(normalized);
  }

  try {
    await admin.firestore().collection('mecanicos_red_nitrox').doc(normalized.id_unico).set(normalized, { merge: true });
    console.log(`[FIRESTORE] Mecánico/Taller "${normalized.nombre_taller || 'En progreso'}" guardado vía WhatsApp con ID: ${normalized.id_unico}`);
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
    const parsed = parseNameAndWorkshop(userText);
    if (parsed.name && parsed.workshop) {
      session.data.nombres_apellidos = parsed.name;
      session.data.nombre_taller = parsed.workshop;
      await saveMechanicToFirestore(fromNumber, session.data);
      const firstName = parsed.name.split(' ')[0];
      messagesToSend = [
        '¡Hola! Soy Mateo, asesor de la RED NITROX en Medellín.',
        `¡Un gusto ${firstName}! Bienvenido a la RED NITROX junto con tu taller "${parsed.workshop}".`,
        '¿En qué municipio y barrio está ubicado tu taller (ej: Medellín Guayabal, Bello Centro, Itagüí, etc.)?'
      ];
      session.stage = 'AWAITING_LOCATION';
    } else if (parsed.name) {
      session.data.nombres_apellidos = parsed.name;
      await saveMechanicToFirestore(fromNumber, session.data);
      const firstName = parsed.name.split(' ')[0];
      messagesToSend = [
        `¡Hola ${firstName}! Soy Mateo, asesor de la RED NITROX en Medellín.`,
        '¿Cómo se llama tu taller de motos?'
      ];
      session.stage = 'AWAITING_WORKSHOP_ONLY';
    } else if (parsed.workshop) {
      session.data.nombre_taller = parsed.workshop;
      await saveMechanicToFirestore(fromNumber, session.data);
      messagesToSend = [
        '¡Hola! Soy Mateo, asesor de la RED NITROX en Medellín.',
        `¡Excelente taller "${parsed.workshop}"! ¿Y cuál es tu nombre completo?`
      ];
      session.stage = 'AWAITING_NAME_ONLY';
    } else {
      messagesToSend = [
        '¡Hola! Soy Mateo, asesor de la RED NITROX en Medellín.',
        '¿Cómo es tu nombre completo y cómo se llama tu taller de motos?'
      ];
      session.stage = 'AWAITING_NAME_AND_WORKSHOP';
    }

  } else if (session.stage === 'AWAITING_NAME_AND_WORKSHOP') {
    const parsed = parseNameAndWorkshop(userText);
    if (parsed.name && parsed.workshop) {
      session.data.nombres_apellidos = parsed.name;
      session.data.nombre_taller = parsed.workshop;
      await saveMechanicToFirestore(fromNumber, session.data);
      const firstName = parsed.name.split(' ')[0];
      messagesToSend = [
        `¡Un gusto ${firstName}! Bienvenido a la RED NITROX junto con tu taller "${parsed.workshop}".`,
        '¿En qué municipio y barrio está ubicado tu taller (ej: Medellín Guayabal, Bello Centro, Itagüí, etc.)?'
      ];
      session.stage = 'AWAITING_LOCATION';
    } else if (parsed.name) {
      session.data.nombres_apellidos = parsed.name;
      await saveMechanicToFirestore(fromNumber, session.data);
      const firstName = parsed.name.split(' ')[0];
      messagesToSend = [
        `¡Un gusto ${firstName}!`,
        '¿Y cómo se llama tu taller de motos?'
      ];
      session.stage = 'AWAITING_WORKSHOP_ONLY';
    } else if (parsed.workshop) {
      session.data.nombre_taller = parsed.workshop;
      await saveMechanicToFirestore(fromNumber, session.data);
      messagesToSend = [
        `¡Excelente taller "${parsed.workshop}"!`,
        '¿Y cuál es tu nombre completo?'
      ];
      session.stage = 'AWAITING_NAME_ONLY';
    } else {
      messagesToSend = [
        '¿Cómo es tu nombre completo y cómo se llama tu taller de motos?'
      ];
    }

  } else if (session.stage === 'AWAITING_WORKSHOP_ONLY') {
    const workshop = cleanWorkshopName(userText);
    session.data.nombre_taller = workshop || userText.trim();
    await saveMechanicToFirestore(fromNumber, session.data);
    const firstName = (session.data.nombres_apellidos || '').split(' ')[0] || '';
    messagesToSend = [
      `¡Excelente taller "${session.data.nombre_taller}"!`,
      '¿En qué municipio y barrio está ubicado tu taller (ej: Medellín Guayabal, Bello Centro, Itagüí, etc.)?'
    ];
    session.stage = 'AWAITING_LOCATION';

  } else if (session.stage === 'AWAITING_NAME_ONLY') {
    const name = cleanPersonName(userText);
    session.data.nombres_apellidos = name || userText.trim();
    await saveMechanicToFirestore(fromNumber, session.data);
    const firstName = session.data.nombres_apellidos.split(' ')[0] || '';
    messagesToSend = [
      `¡Un gusto ${firstName}!`,
      '¿En qué municipio y barrio está ubicado tu taller (ej: Medellín Guayabal, Bello Centro, Itagüí, etc.)?'
    ];
    session.stage = 'AWAITING_LOCATION';

  } else if (session.stage === 'AWAITING_LOCATION') {
    const { ciudad, barrio, rol } = extractLocationAndRole(userText);
    session.data.ciudad_taller = ciudad;
    session.data.ciudad_residencia = ciudad;
    session.data.barrio_taller = barrio;
    if (rol) session.data.relacion_taller = rol;
    await saveMechanicToFirestore(fromNumber, session.data);

    if (rol) {
      messagesToSend = [
        `Anotada la zona en ${ciudad} y tu labor como ${rol.toLowerCase().includes('mecanico') ? 'mecánico' : rol.toLowerCase()}.`,
        '¿Aproximadamente cuántas motos atienden por semana en el taller?'
      ];
      session.stage = 'AWAITING_VOLUME';
    } else {
      messagesToSend = [
        `Anotada la zona en ${ciudad}${barrio && barrio !== 'Sector Principal' ? ', ' + barrio : ''}.`,
        '¿Y cuál es tu rol en el taller: eres propietario, mecánico o socio?'
      ];
      session.stage = 'AWAITING_ROLE';
    }

  } else if (session.stage === 'AWAITING_ROLE') {
    const { rol } = extractLocationAndRole(userText);
    session.data.relacion_taller = rol || (/socio/i.test(userText) ? 'Socio' : /propietario|dueño|dueno/i.test(userText) ? 'Propietario' : 'Mecánico-empleado');
    await saveMechanicToFirestore(fromNumber, session.data);
    messagesToSend = [
      '¡Perfecto!',
      '¿Aproximadamente cuántas motos atienden por semana en el taller?'
    ];
    session.stage = 'AWAITING_VOLUME';

  } else if (session.stage === 'AWAITING_VOLUME') {
    const { volume, brands, types, hasBrands } = extractVolumeAndBrands(userText);
    session.data.motos_por_semana = volume;
    if (hasBrands) {
      session.data.marcas_motos = brands;
      session.data.tipo_motos = types;
      await saveMechanicToFirestore(fromNumber, session.data);
      messagesToSend = [
        '¡Buen volumen! Esas marcas representan la mayor parte de las motos en Medellín.',
        'En tu taller, ¿quién decide generalmente la marca de repuestos a instalar (tú como mecánico o el dueño de la moto)?'
      ];
      session.stage = 'AWAITING_DECISION';
    } else {
      await saveMechanicToFirestore(fromNumber, session.data);
      messagesToSend = [
        'Buen volumen de trabajo.',
        '¿Y qué marcas o tipos de motos son las que más ingresan a tu taller? (ej: Yamaha, Bajaj, AKT, automáticas/scooter, etc.)'
      ];
      session.stage = 'AWAITING_BRANDS';
    }

  } else if (session.stage === 'AWAITING_BRANDS') {
    const { brands, types } = extractVolumeAndBrands(userText);
    session.data.marcas_motos = brands.length > 0 ? brands : ['Yamaha', 'Bajaj', 'AKT'];
    session.data.tipo_motos = types;
    await saveMechanicToFirestore(fromNumber, session.data);
    messagesToSend = [
      '¡Clave esa rotación!',
      'En tu taller, ¿quién decide generalmente la marca de repuestos a instalar (tú como mecánico o el dueño de la moto)?'
    ];
    session.stage = 'AWAITING_DECISION';

  } else if (session.stage === 'AWAITING_DECISION') {
    const lower = userText.toLowerCase();
    if (/yo|sujier|sugier|recomiend|mecanico|mecánico|le digo|ambos|taller/i.test(lower)) {
      session.data.quien_decide_repuesto = 'Mecánico';
      session.data.frecuencia_recomendacion = 'Siempre';
    } else {
      session.data.quien_decide_repuesto = 'Propietario de la moto';
      session.data.frecuencia_recomendacion = 'Algunas veces';
    }
    session.data.repuestos_frecuentes = extractParts(userText);
    session.data.marcas_repuestos_usadas = ['NITROX'];
    await saveMechanicToFirestore(fromNumber, session.data);
    messagesToSend = [
      '¡Clave ese criterio! La recomendación del mecánico es lo más importante para la seguridad del cliente.',
      '¿Ya conoces o has utilizado repuestos de la marca NITROX en tu taller? ¿Qué tal te ha parecido la calidad?'
    ];
    session.stage = 'AWAITING_NITROX';

  } else if (session.stage === 'AWAITING_NITROX') {
    const lower = userText.toLowerCase();
    if (/si|sí|claro|usado|probado|conozco|buen|excelente/i.test(lower)) {
      session.data.conoce_nitrox = 'Sí';
      session.data.ha_usado_nitrox = 'Sí';
      session.data.calificacion_experiencia_nitrox = /excelente/i.test(lower) ? 'Excelente' : 'Buena';
      session.data.recomendaria_nitrox = 'Definitivamente sí';
    } else {
      session.data.conoce_nitrox = 'No';
      session.data.ha_usado_nitrox = 'No';
      session.data.calificacion_experiencia_nitrox = 'No aplica';
      session.data.recomendaria_nitrox = 'Probablemente sí';
    }

    const normalized = await saveMechanicToFirestore(fromNumber, session.data);
    const firstName = (session.data.nombres_apellidos || '').split(' ')[0] || '';
    const workshopName = session.data.nombre_taller || 'tu taller';
    const idDisplay = normalized?.id_unico || 'RN-MED-PILOTO';
    const nivelDisplay = normalized ? `Nivel ${normalized.nivel_relacion_numero}: ${normalized.nivel_relacion_nombre}` : 'Nivel 1: Registrado';
    const cleanPhone = (fromNumber || '').replace(/\D/g, '');

    messagesToSend = [
      `¡Listo ${firstName}! Con estos datos ${workshopName} ya quedó 100% REGISTRADO y ACTIVO en la base de datos oficial de RED NITROX (Piloto Medellín).`,
      `Tu código oficial de aliado es ${idDisplay} (${nivelDisplay}). Ya quedas habilitado para visitas técnicas de ruta, muestras de repuestos y capacitaciones.`,
      `De forma 100% opcional, si deseas consultar tu ficha completa o elegir temas de cursos técnicos presenciales/virtuales, puedes ingresar aquí: https://webhook-my2e3j2ecq-uc.a.run.app/formulario?id=${idDisplay}&tel=${cleanPhone}`,
      'Cualquier duda o repuesto me escribes directamente por acá. ¡Bienvenido a RED NITROX!'
    ];
    session.stage = 'COMPLETED';

  } else if (session.stage === 'COMPLETED') {
    const firstName = (session.data.nombres_apellidos || '').split(' ')[0] || '';
    const workshopName = session.data.nombre_taller || 'Aliado';
    const idDisplay = session.data.id_unico || 'RN-MED-PILOTO';
    const cleanPhone = (fromNumber || '').replace(/\D/g, '');

    messagesToSend = [
      `¡Hola ${firstName}! Tu taller "${workshopName}" ya está 100% registrado y activo con código ${idDisplay}.`,
      `Si necesitas registrar otro taller o mecánico, me avisas y lo hacemos de una. Y si deseas ver temas de capacitación técnica opcionales: https://webhook-my2e3j2ecq-uc.a.run.app/formulario?id=${idDisplay}&tel=${cleanPhone}`
    ];
  }

  session.history.push({ role: 'assistant', content: messagesToSend.join(' '), timestamp: Date.now() });
  await saveSession(fromNumber, session);

  return messagesToSend;
}

function resetMemoryCache() {
  for (const k in memoryCache) {
    delete memoryCache[k];
  }
}

module.exports = {
  generateMateoResponse,
  admin,
  localMecanicosStore,
  resetMemoryCache
};