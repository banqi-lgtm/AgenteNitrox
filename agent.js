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

// Helper to detect generic greetings (e.g. "Hola", "Buenas tardes", "Hola como estas")
function isPureGreeting(text) {
  const clean = (text || '').trim().toLowerCase().replace(/[.,!¡?¿]+/g, ' ').trim();
  if (/(?:taller|motos|moto|repuestos|llamo|nombre|soy|medellin|bello|itagui|afiliar|registro|inscribir|info|informacion|información)/i.test(clean)) {
    return false;
  }
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  const greetingTokens = /^(?:hola|buenas|buenos|dia|dias|día|días|tarde|tardes|noche|noches|que|qué|mas|más|tal|como|cómo|estas|estás|esta|está|va|todo|bien|amigo|hermano|mateo|sr|señor|senor|nitrox|asesor|saludos|alo|aló|hey)$/i;
  return words.every(w => greetingTokens.test(w));
}

function isGreetingResponse(text) {
  const clean = (text || '').trim().toLowerCase().replace(/[.,!¡?¿]+/g, ' ').trim();
  if (/(?:taller|motos|moto|repuestos|llamo|nombre|soy)/i.test(clean)) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  const tokens = /^(?:bien|muy|todo|gracias|y|tu|tú|vos|usted|hermano|amigo|dios|a|orden|excelente|aca|acá|trabajando|ahi|ahí|vamos|buenas|hola|saludos|al|pelo|firme)$/i;
  return words.every(w => tokens.test(w));
}

function isGreeting(text) {
  return isPureGreeting(text) || isGreetingResponse(text) || /^(?:info|informacion|afiliacion|afiliar|red nitrox)[\s.,!]*$/i.test((text || '').trim());
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
  if (isPureGreeting(s) || isGreetingResponse(s)) return '';
  s = s.replace(/^(?:hola|buenas|buenos dias|buenas tardes|soy|me llamo|mi nombre es)\s+/gi, '');
  s = s.replace(/(?:taller|motos|repuestos).*$/gi, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  if (isPureGreeting(s) || isGreetingResponse(s)) return '';
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
    if (sessionData._lastQuestion === 'NOMBRE' && !sessionData.nombres_apellidos) {
      const p = cleanPersonName(raw);
      if (p) updates.nombres_apellidos = p;
    } else if (sessionData._lastQuestion === 'TALLER' && !sessionData.nombre_taller) {
      const w = cleanWorkshopName(raw);
      if (w) updates.nombre_taller = w;
    } else {
      const { name, workshop } = parseNameAndWorkshop(raw);
      if (name && !sessionData.nombres_apellidos) updates.nombres_apellidos = name;
      if (workshop && !sessionData.nombre_taller) updates.nombre_taller = workshop;
    }
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
  else if (/medellin|medellín|guayabal|belen|laureles|castilla|robledo|poblado|manrique|aranjuez|prado|san javier|buenos aires|centro|la 70|la 80|la 33/i.test(lower)) {
    updates.ciudad_taller = 'Medellín';
  } else if (sessionData._lastQuestion === 'UBICACION') {
    updates.ciudad_taller = 'Medellín';
    updates.barrio_taller = raw;
  }

  if (updates.ciudad_taller) updates.ciudad_residencia = updates.ciudad_taller;

  // 3. Role
  if (/mecanico|mecánico|empleado|las arreglo yo|yo arreglo/i.test(lower)) updates.relacion_taller = 'Mecánico';
  else if (/dueño|dueno|propietario|el taller es mio|es mio|yo lo manejo/i.test(lower)) updates.relacion_taller = 'Propietario';
  else if (/socio|copropietario/i.test(lower)) updates.relacion_taller = 'Socio';
  else if (/ambas|las dos|ambos|jefe|admin|encargado/i.test(lower)) updates.relacion_taller = 'Propietario y Mecánico';
  else if (sessionData._lastQuestion === 'ROL') updates.relacion_taller = raw;

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
  if (brands.length > 0) {
    updates.marcas_motos = brands;
  } else if (sessionData._lastQuestion === 'MARCAS') {
    updates.marcas_motos = [raw];
  }

  // 6. Frequent parts
  const parts = [];
  if (/freno|pastilla|banda|disco/i.test(lower)) parts.push('Frenos');
  if (/arrastre|kit|cadena|pinon|corona/i.test(lower)) parts.push('Kit de arrastre');
  if (/motor|valvula|cilindro|piston|ajuste/i.test(lower)) parts.push('Partes de motor');
  if (/aceite|filtro|lubricante/i.test(lower)) parts.push('Lubricación / Filtros');
  if (/suspension|amortiguador/i.test(lower)) parts.push('Suspensión');
  if (/electr|bateria|inyeccion/i.test(lower)) parts.push('Electricidad');
  if (parts.length > 0) {
    updates.repuestos_frecuentes = parts;
  } else if (sessionData._lastQuestion === 'REPUESTOS') {
    updates.repuestos_frecuentes = [raw];
  }

  // 7. Decision maker
  if (/yo le sujiero|yo le sugiero|yo recomiendo|yo decido|yo les digo|yo|mecanico|mecánico/i.test(lower) && !sessionData.quien_decide_repuesto) {
    updates.quien_decide_repuesto = 'Mecánico';
    updates.frecuencia_recomendacion = 'Siempre';
  } else if (/cliente|dueno de la moto|dueño de la moto|ellos traen|propietarios/i.test(lower)) {
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
    } else if (/poco|apenas|mas o menos|más o menos|regular|algo/i.test(lower)) {
      updates.conoce_nitrox = 'Sí';
      updates.ha_usado_nitrox = 'Sí';
      updates.calificacion_experiencia_nitrox = 'Regular';
      updates.recomendaria_nitrox = 'Probablemente sí';
    } else {
      updates.conoce_nitrox = 'Sí';
      updates.ha_usado_nitrox = 'Sí';
      updates.calificacion_experiencia_nitrox = 'Buena';
    }
  }

  // 9. Purchase channel / criteria
  if (sessionData._lastQuestion === 'CANAL_COMPRA' || /distrib|direct|barato|almacen|propietario|cliente|ellos|vehiculo|vehículo/i.test(lower)) {
    if (/propietario|cliente|ellos lo compran|ellos los traen|traen los repuestos|vehiculo|vehículo/i.test(lower)) {
      updates.canal_compra = 'Los clientes / propietarios los compran';
      updates.quien_decide_repuesto = 'Cliente';
    } else if (/distrib/i.test(lower)) {
      updates.canal_compra = 'Distribuidor';
    } else if (/direct/i.test(lower)) {
      updates.canal_compra = 'Directo';
    } else if (/barato|economico|económico|precio|donde salga/i.test(lower)) {
      updates.canal_compra = 'Donde salga más barato';
      updates.criterio_compra = 'Precio';
    } else if (/almacen|almacenes|repuestera/i.test(lower)) {
      updates.canal_compra = 'Almacén de repuestos';
    } else {
      updates.canal_compra = raw; // Always consume whatever the user answered to prevent looping!
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

  // 1. Pure greeting check: if user sends only a greeting first (Requirement: primero saludar, esperar que salude)
  if (!data._initialGreetingSent && isPureGreeting(raw)) {
    data._initialGreetingSent = true;
    data._lastQuestion = 'WAITING_GREETING_REPLY';
    const reply = "¡Hola! ¿Cómo estás? Soy Mateo, asesor de la RED NITROX en Medellín.";
    session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
    await saveSession(fromNumber, session);
    return [reply];
  }

  // 2. Extract newly provided entities
  const newEntities = extractEntities(userText, data);
  Object.assign(data, newEntities);

  // If user was answering the initial greeting:
  if (data._lastQuestion === 'WAITING_GREETING_REPLY') {
    delete data._lastQuestion;
    if (!data.nombres_apellidos && !data.nombre_taller) {
      data._lastQuestion = 'NOMBRE_Y_TALLER';
      const reply = "Me alegra. ¿Cómo te llamas y cómo se llama tu taller de motos?";
      session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
      await saveSession(fromNumber, session);
      return [reply];
    }
  }

  // 3. Synchronize progressively to Firestore / CRM
  if (data.nombres_apellidos || data.nombre_taller) {
    await saveMechanicToFirestore(fromNumber, data);
  }

  const firstName = (data.nombres_apellidos || '').split(' ')[0] || '';
  const workshopName = data.nombre_taller || '';

  // 4. User inquiry interceptor (if user asks what RED NITROX is)
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

  // 5. Decide the SINGLE logical next response based on memory and context (Prompt Maestro)
  let reply = '';

  // Initial prompt if user didn't start with pure greeting
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
  // If purchase channel was answered
  else if (data.canal_compra && !data._repuestosComprados) {
    data._repuestosComprados = true;
    data._lastQuestion = 'MARCA_REPUESTOS';
    if (/cliente|propietario|ellos/i.test(data.canal_compra)) {
      reply = `Entiendo, el cliente los lleva. ¿Y qué marcas de repuestos te llevan más a instalar?`;
    } else if (/direct/i.test(data.canal_compra)) {
      reply = `Buenísimo directo. ¿Y qué marcas o repuestos compras con más frecuencia?`;
    } else {
      reply = `Claro, se busca buen margen. ¿Qué marca de repuestos compras más?`;
    }
  }
  // Final closing / Natural human farewell with unique link and QR code
  else if (!data._finished) {
    data._finished = true;
    const mechanic = await saveMechanicToFirestore(fromNumber, data);
    const uniqueId = mechanic.id_unico || data.id_unico || (`RN-MED-${Math.random().toString(36).substring(2, 6).toUpperCase()}`);
    const baseUrl = 'https://webhook-my2e3j2ecq-uc.a.run.app';
    const cardUrl = `${baseUrl}/carnet/${encodeURIComponent(uniqueId)}`;
    const qrImageUrl = `${baseUrl}/api/qr/${encodeURIComponent(uniqueId)}.png`;

    const nameLabel = firstName || 'amigo';
    const workshopLabel = workshopName || 'tu taller';

    const bubble1 = `Listo ${nameLabel}, anotado todo. Muy bacano ${workshopLabel}. Quedo súper atento por acá para lo que necesites.`;
    const bubble2 = `🏁 *¡Ya haces parte de la RED NITROX!*\n\nAquí tienes tu enlace único y código QR oficial de ${workshopLabel}:\n👉 ${cardUrl}`;
    const qrBubble = {
      type: 'image',
      url: qrImageUrl,
      caption: `Código QR Oficial RED NITROX • ${workshopLabel}`
    };

    session.history.push({ role: 'assistant', content: `${bubble1}\n${bubble2}`, timestamp: Date.now() });
    await saveSession(fromNumber, session);

    return [bubble1, bubble2, qrBubble];
  } else {
    const uniqueId = data.id_unico || '';
    const linkSuffix = uniqueId ? `\n👉 https://webhook-my2e3j2ecq-uc.a.run.app/carnet/${encodeURIComponent(uniqueId)}` : '';
    reply = `¡Con todo el gusto ${firstName || ''}! Por acá a la orden siempre.${linkSuffix}`;
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