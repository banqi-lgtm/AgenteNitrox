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

// Helper to count words
function countWords(str) {
  if (!str) return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
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

// Helper to parse Name & Workshop if provided together or separately
function parseNameAndWorkshop(raw) {
  let name = '';
  let workshop = '';
  const clean = (raw || '').trim();

  if (isGreeting(clean)) return { name: '', workshop: '' };

  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const isW0 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(lines[0]);
    const isW1 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(lines[1]);
    if (isW1 && !isW0) {
      name = cleanPersonName(lines[0]);
      workshop = cleanWorkshopName(lines[1]);
    } else if (isW0 && !isW1) {
      workshop = cleanWorkshopName(lines[0]);
      name = cleanPersonName(lines[1]);
    } else {
      name = cleanPersonName(lines[0]);
      workshop = cleanWorkshopName(lines[1]);
    }
    return { name, workshop };
  }

  if (clean.includes(',') || /\s+y\s+/i.test(clean)) {
    const parts = clean.split(/,|\s+y\s+/i).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const isW0 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(parts[0]);
      const isW1 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(parts[1]);
      if (isW1 && !isW0) {
        name = cleanPersonName(parts[0]);
        workshop = cleanWorkshopName(parts[1]);
      } else if (isW0 && !isW1) {
        workshop = cleanWorkshopName(parts[0]);
        name = cleanPersonName(parts[1]);
      }
      return { name, workshop };
    }
  }

  const deMatch = clean.match(/(?:soy|me llamo|mi nombre es)?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+?)\s+(?:de|del|y mi taller es|y el taller es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+)/i);
  if (deMatch && deMatch[1].trim() && deMatch[2].trim()) {
    name = cleanPersonName(deMatch[1]);
    workshop = cleanWorkshopName(deMatch[2]);
    return { name, workshop };
  }

  if (/^(?:taller|el taller|moto taller|motos|repuestos|garage)\s+[A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+$/i.test(clean) || (/(?:taller|repuestos|garage)/i.test(clean) && clean.split(/\s+/).length <= 4)) {
    workshop = cleanWorkshopName(clean);
    return { name: '', workshop };
  }

  if (!isGreeting(clean) && clean.split(/\s+/).length <= 4 && !/(?:bello|itagui|medellin|mecanico|dueño|motos|akt|repuestos)/i.test(clean)) {
    name = cleanPersonName(clean);
    return { name, workshop: '' };
  }

  return { name: '', workshop: '' };
}

// Semantic entity extractor for real-world messages, typos and Colombian mechanic slang
function extractEntities(text, sessionData) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();
  const updates = {};

  // 1. Name & Workshop if missing
  if (!sessionData.nombres_apellidos || !sessionData.nombre_taller) {
    const { name, workshop } = parseNameAndWorkshop(raw);
    if (name && !sessionData.nombres_apellidos) updates.nombres_apellidos = name;
    if (workshop && !sessionData.nombre_taller) updates.nombre_taller = workshop;
  }

  // 2. Municipality & Barrio
  if (/bello/i.test(lower)) updates.ciudad_taller = 'Bello';
  else if (/itagui|itaguí/i.test(lower)) updates.ciudad_taller = 'Itagüí';
  else if (/envigado/i.test(lower)) updates.ciudad_taller = 'Envigado';
  else if (/sabaneta/i.test(lower)) updates.ciudad_taller = 'Sabaneta';
  else if (/estrella/i.test(lower)) updates.ciudad_taller = 'La Estrella';
  else if (/caldas/i.test(lower)) updates.ciudad_taller = 'Caldas';
  else if (/copacabana/i.test(lower)) updates.ciudad_taller = 'Copacabana';
  else if (/girardota/i.test(lower)) updates.ciudad_taller = 'Girardota';
  else if (/medellin|medellín|guayabal|belen|laureles|castilla|robledo|poblado/i.test(lower)) updates.ciudad_taller = 'Medellín';

  if (updates.ciudad_taller) updates.ciudad_residencia = updates.ciudad_taller;

  // 3. Role
  if (/mecanico|mecánico|empleado|las arreglo yo|yo arreglo/i.test(lower)) updates.relacion_taller = 'Mecánico';
  else if (/dueño|dueno|propietario|el taller es mio|es mio|yo lo manejo/i.test(lower)) updates.relacion_taller = 'Propietario';
  else if (/socio|copropietario/i.test(lower)) updates.relacion_taller = 'Socio';

  // 4. Volume (only if asked or explicit volume keywords, never from workshop name)
  const isVolumeQuestion = sessionData._lastQuestion === 'VOLUMEN';
  if ((isVolumeQuestion || /muchas|bastantes|un monton|monton|harto|full|motos por semana|por semana/i.test(lower)) && !sessionData.motos_por_semana) {
    if (/mucha|bastante|harto|montón|monton|full|de todo/i.test(lower)) {
      updates.motos_por_semana = 'Muchas / Alto flujo';
    } else {
      const numMatch = lower.match(/\b\d+\b/);
      if (numMatch) updates.motos_por_semana = `${numMatch[0]} motos/semana`;
      else updates.motos_por_semana = raw;
    }
  }

  // 5. Brands
  const brands = [];
  if (/yamaha/i.test(lower)) brands.push('Yamaha');
  if (/bajaj|pulsar|boxer|bjaja/i.test(lower)) brands.push('Bajaj');
  if (/akt|nkd/i.test(lower)) brands.push('AKT');
  if (/honda/i.test(lower)) brands.push('Honda');
  if (/suzuki/i.test(lower)) brands.push('Suzuki');
  if (/tvs/i.test(lower)) brands.push('TVS');
  if (/hero/i.test(lower)) brands.push('Hero');
  if (/ktm/i.test(lower)) brands.push('KTM');
  if (/todas|de todas|variadas|de todo/i.test(lower)) brands.push('Variadas / Todas');
  if (brands.length > 0) updates.marcas_motos = brands;

  // 6. Frequent parts
  const parts = [];
  if (/freno|pastilla|banda|disco/i.test(lower)) parts.push('Frenos');
  if (/arrastre|kit|cadena|pinon|corona/i.test(lower)) parts.push('Kit de arrastre');
  if (/motor|valvula|cilindro|piston|ajuste/i.test(lower)) parts.push('Partes de motor');
  if (/aceite|filtro|lubricante/i.test(lower)) parts.push('Lubricación / Filtros');
  if (/suspension|amortiguador/i.test(lower)) parts.push('Suspensión');
  if (/electr|bateria|inyeccion/i.test(lower)) parts.push('Electricidad');
  if (parts.length > 0) updates.repuestos_frecuentes = parts;

  // 7. Decision maker
  if (/yo le sujiero|yo le sugiero|yo recomiendo|yo decido|yo les digo|yo|mecanico|mecánico/i.test(lower) && !sessionData.quien_decide_repuesto) {
    updates.quien_decide_repuesto = 'Mecánico';
    updates.frecuencia_recomendacion = 'Siempre';
  } else if (/cliente|dueno de la moto|dueño de la moto|ellos traen/i.test(lower)) {
    updates.quien_decide_repuesto = 'Cliente';
    updates.frecuencia_recomendacion = 'Algunas veces';
  }

  // 8. NITROX experience
  if (sessionData._lastQuestion === 'NITROX_EXP' || /repuestos nitrox|marca nitrox/i.test(lower)) {
    if (/si|sí|claro|bueno|buenos|excelente|bien|salido buenos/i.test(lower)) {
      updates.conoce_nitrox = 'Sí';
      updates.ha_usado_nitrox = 'Sí';
      updates.calificacion_experiencia_nitrox = /excelente/i.test(lower) ? 'Excelente' : 'Buena';
      updates.recomendaria_nitrox = 'Definitivamente sí';
    } else if (/no|nunca|todavia no|todavía no/i.test(lower)) {
      updates.conoce_nitrox = 'No';
      updates.ha_usado_nitrox = 'No';
      updates.calificacion_experiencia_nitrox = 'No aplica';
      updates.recomendaria_nitrox = 'Probablemente sí';
    }
  }

  // 9. Purchase channel / criteria
  if (sessionData._lastQuestion === 'CANAL_COMPRA' || /distribuidor|directo|barato|almacen/i.test(lower)) {
    if (/distribuidor|distribuidora|ruta|preventista/i.test(lower)) {
      updates.canal_compra = 'Distribuidor';
    } else if (/directo|fabrica|fábrica/i.test(lower)) {
      updates.canal_compra = 'Directo';
    } else if (/barato|economico|económico|precio|donde salga/i.test(lower)) {
      updates.canal_compra = 'Donde salga más barato';
      updates.criterio_compra = 'Precio';
    } else if (/almacen|almacenes|repuestera/i.test(lower)) {
      updates.canal_compra = 'Almacén de repuestos';
    }
  }

  return updates;
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

  const existingIdx = localMecanicosStore.findIndex(m => m.id_unico === normalized.id_unico || (cleanPhone && m.celular_whatsapp === cleanPhone));
  if (existingIdx >= 0) {
    localMecanicosStore[existingIdx] = Object.assign(localMecanicosStore[existingIdx], normalized);
  } else {
    localMecanicosStore.unshift(normalized);
  }

  try {
    await admin.firestore().collection('mecanicos_red_nitrox').doc(normalized.id_unico).set(normalized, { merge: true });
  } catch (err) {
    console.warn('[FIRESTORE MECHANIC SAVE (fallback local)]', err.message);
  }
  return normalized;
}

// Core Prompt Maestro conversational response generator
async function generateMateoResponse(fromNumber, userText) {
  const session = await getSession(fromNumber);
  session.history = session.history || [];
  session.data = session.data || {};
  session.history.push({ role: 'user', content: userText, timestamp: Date.now() });

  const data = session.data;
  const raw = userText.trim();
  const lower = raw.toLowerCase();

  // Reset if user requests
  if (/(otro taller|nuevo taller|registrar otro|reiniciar|borrar datos)/i.test(lower)) {
    session.data = {};
    session.history = [];
    await saveSession(fromNumber, session);
    const reply = "¡Listo! Empecemos de nuevo. ¿Cómo te llamas y cómo se llama tu taller?";
    return [reply];
  }

  // 1. Extract newly provided entities
  const newEntities = extractEntities(userText, data);
  Object.assign(data, newEntities);

  // 2. Synchronize progressively to Firestore / CRM
  if (data.nombres_apellidos || data.nombre_taller) {
    await saveMechanicToFirestore(fromNumber, data);
  }

  const firstName = (data.nombres_apellidos || '').split(' ')[0] || '';
  const workshopName = data.nombre_taller || '';

  // 3. User inquiry interceptor (if user asks what RED NITROX is)
  if (/(que es red nitrox|de que se trata|para que es|que beneficios|quien es nitrox)/i.test(lower)) {
    let reply = "Es una red de talleres aliados de NITROX en Medellín con capacitaciones, muestras de repuestos y beneficios directos.";
    if (!data.nombres_apellidos || !data.nombre_taller) {
      reply += " ¿Cómo te llamas y cómo se llama tu taller?";
      data._lastQuestion = 'NOMBRE_Y_TALLER';
    }
    session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
    await saveSession(fromNumber, session);
    return [reply];
  }

  // 4. Decide the SINGLE logical next response based on memory and context (Prompt Maestro)
  let reply = '';

  // Initial greeting / Missing both name and workshop
  if (!data.nombres_apellidos && !data.nombre_taller) {
    data._lastQuestion = 'NOMBRE_Y_TALLER';
    reply = "¡Hola! Soy Mateo, asesor de la RED NITROX. ¿Cómo te llamas y cómo se llama tu taller?";
  }
  // Missing workshop
  else if (data.nombres_apellidos && !data.nombre_taller) {
    data._lastQuestion = 'TALLER';
    reply = `Mucho gusto, ${firstName}. ¿Cómo se llama tu taller?`;
  }
  // Missing name
  else if (!data.nombres_apellidos && data.nombre_taller) {
    data._lastQuestion = 'NOMBRE';
    reply = `Excelente taller ${workshopName}. ¿Y cuál es tu nombre?`;
  }
  // Missing location (municipio)
  else if (!data.ciudad_taller) {
    data._lastQuestion = 'UBICACION';
    reply = `Mucho gusto, ${firstName}. ¿En qué zona está el taller?`;
  }
  // Missing role
  else if (!data.relacion_taller) {
    data._lastQuestion = 'ROL';
    reply = `Anotado. ¿Cuál es tu rol en el taller: eres propietario o mecánico?`;
  }
  // Missing volume
  else if (!data.motos_por_semana) {
    data._lastQuestion = 'VOLUMEN';
    reply = `Perfecto. ¿Más o menos cuántas motos atiendes por semana?`;
  }
  // Missing brands
  else if (!data.marcas_motos || data.marcas_motos.length === 0) {
    data._lastQuestion = 'MARCAS';
    reply = `Buen volumen. ¿Qué marcas son las que más te llegan?`;
  }
  // Missing frequent parts
  else if (!data.repuestos_frecuentes || data.repuestos_frecuentes.length === 0) {
    data._lastQuestion = 'REPUESTOS';
    reply = `Sí, se mueve de todo entonces. ¿Qué repuestos cambias más seguido?`;
  }
  // Missing NITROX experience
  else if (!data.conoce_nitrox) {
    data._lastQuestion = 'NITROX_EXP';
    reply = `Buen dato. ¿Y ya has trabajado con repuestos NITROX?`;
  }
  // NITROX answered "Sí" / "Bueno", missing purchase channel
  else if (data.conoce_nitrox === 'Sí' && !data.canal_compra) {
    data._lastQuestion = 'CANAL_COMPRA';
    reply = `Excelente. ¿Los compras directamente o con algún distribuidor?`;
  }
  // NITROX answered "No"
  else if (data.conoce_nitrox === 'No' && !data._ofertaVisita) {
    data._ofertaVisita = true;
    reply = `Entendido. En NITROX manejamos muy buena calidad y precios para talleres. ¿Te gustaría recibir muestras y catálogo?`;
  }
  // If price / channel was answered
  else if (data.criterio_compra === 'Precio' && !data._marcaPreguntada) {
    data._marcaPreguntada = true;
    reply = `Claro, el precio pesa bastante. ¿Qué marca compras más?`;
  }
  // Final closing / Natural human farewell (concise, warm, respectful)
  else {
    reply = `Listo ${firstName}, anotado todo. Muy bacano tu taller ${workshopName}. Quedo súper atento por acá para lo que necesites.`;
  }

  // Word count checklist enforcement
  const wc = countWords(reply);
  if (wc > 25) {
    console.warn(`[WARNING: REPLY OVER 25 WORDS (${wc})]:`, reply);
  }

  session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
  await saveSession(fromNumber, session);

  // Return single clean, natural WhatsApp bubble
  return [reply];
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