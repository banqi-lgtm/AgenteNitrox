// gemini_brain.js - Cerebro Conversacional Inteligente para MATEO
// RED NITROX Colombia — Reingeniería Total con NLP y Memoria Semántica

require('dotenv').config();
const { ai } = require('./genkit_service');
const { processNlpPipeline } = require('./nlp_pipeline');
const {
  initOrLoadMemory,
  isTopicOrQuestionForbidden,
  integrateFactsIntoMemory,
  recordAskedQuestion,
  buildConversationSummary,
  TOPIC_SEMANTIC_PATTERNS
} = require('./conversation_memory');
const {
  getRegistrationProgress,
  getConversationalPendingTopics
} = require('./registration_engine');
const { getMateoSystemPrompt } = require('./skill_loader');
const { getLiveLearningsForPrompt } = require('./ml_service');

// Prompt del sistema ensamblado dinámicamente desde skills/mateo/*.md y cacheado en memoria RAM
const SYSTEM_PROMPT = getMateoSystemPrompt();

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function cleanResponseText(rawText, userText = '') {
  if (!rawText) return '';
  let s = rawText
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Erradicar completamente risas inapropiadas
  s = s.replace(/^[¡!]?\s*(?:jaj+a*|jej+e*|jij+i*)[\s,!.]*/gi, '');
  s = s.replace(/\b(?:jaj+a*|jej+e*|jij+i*)\b/gi, '');
  // Erradicar excusas inapropiadas
  s = s.replace(/\b(?:se\s+me\s+cruz[oó]\s+con\s+otro\s+cliente|otro\s+cliente)\b/gi, 'qué pena contigo');

  // Eliminar prefijos mecánicos de chatbot
  s = s.replace(/^(?:perfecto|excelente|anotado|listo)[\s,.:!]+\s*/i, '');
  // Eliminar muletillas repetitivas de apertura como "Contame," o "Y contame,"
  s = s.replace(/^(?:y\s+)?contame[\s,.:!]+\s*/i, '');
  s = s.replace(/^(?:y\s+)?cu[eé]ntame[\s,.:!]+\s*/i, '');
  s = s.replace(/^(?:y\s+)?decime[\s,.:!]+\s*/i, '');
  // Filtro estricto: eliminar "hermano" y variantes
  s = s.replace(/[,;]?\s*\b(?:hermano|hermanito|hermana|hermanita)\b[,;.:!]?/gi, '');
  // Filtro estricto: Mateo es 100% asesor humano, cero términos robóticos o de sistema
  s = s.replace(/\b(?:como\s+|soy\s+|somos\s+)?(?:un\s+|una\s+)?(?:sistema|bot|agente|modelo|algoritmo|plataforma)(?:\s+de\s+(?:ia|inteligencia\s+artificial))?\b/gi, '');
  s = s.replace(/\b(?:como\s+|soy\s+)?(?:una?\s+)?(?:ia|inteligencia\s+artificial)\b/gi, '');
  s = s.replace(/\bde\s+ia\b/gi, '');
  s = s.replace(/\b(?:en\s+el\s+sistema|de\s+la\s+plataforma|mi\s+programaci[oó]n|mi\s+base\s+de\s+datos)\b/gi, 'aquí');
  s = s.replace(/\b(?:el\s+sistema\s+(?:se\s+qued[oó]|se\s+demor[oó]|est[aá]\s+lento|fall[oó]))\b/gi, 'se me cruzaron los mensajes');
  // Corregir espacios y signos dobles
  s = s.replace(/\s+([,.:!?])/g, '$1');
  s = s.replace(/([,.:!?]){2,}/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';
}

/**
 * Calcula los temas de vinculación aún pendientes consultando el motor central de la ficha maestra.
 */
function getPendingTopics(memory) {
  const topics = getConversationalPendingTopics({}, memory);
  return topics.map(t => `[${t.section}] ${t.label}${t.mandatory ? ' (Obligatorio)' : ''}`);
}

// ───────────────────────────────────────────────────────────────────────────
// RESILIENCIA GEMINI: cascada con "hedging", cortacircuitos por modelo y timeouts duros.
// Evita que un modelo saturado (429/503) o lento deje al mecánico esperando minutos.
// ───────────────────────────────────────────────────────────────────────────
const MODEL_CHAIN = [
  'googleai/gemini-3-flash-preview',
  'googleai/gemini-3.6-flash',
  'googleai/gemini-flash-lite-latest',
  'googleai/gemini-3.5-flash-lite'
];
const HEDGE_DELAYS_MS = [0, 800, 1800, 2800];   // respuesta ultra-rápida en <800ms
const PER_CALL_TIMEOUT_MS = 3800;
const TOTAL_BUDGET_MS = 6500;
const modelCooldownUntil = {};

function cooldownFor(err) {
  const msg = String((err && err.message) || err || '');
  if (/429|quota|Too Many Requests/i.test(msg)) return 3 * 60 * 1000;     // cuota agotada: reintentar en 3 min
  if (/503|high demand|overloaded|unavailable/i.test(msg)) return 45 * 1000;
  if (/404|no longer available|not found|400|invalid argument/i.test(msg)) return 60 * 60 * 1000;
  if (/HARD-TIMEOUT/i.test(msg)) return 30 * 1000;
  return 20 * 1000;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('HARD-TIMEOUT ' + label + ' ' + ms + 'ms')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Lanza los modelos en cascada: el siguiente arranca de inmediato si el anterior falla,
 * o tras un pequeño retraso si el anterior sigue sin responder. Gana el primero que responda.
 */
function generateResilient(params) {
  const now = Date.now();
  let candidates = MODEL_CHAIN.filter(m => !(modelCooldownUntil[m] > now));
  if (candidates.length === 0) candidates = MODEL_CHAIN.slice();

  return new Promise((resolve, reject) => {
    let settled = false;
    let launched = 0;
    let failed = 0;
    const errors = [];
    const startedAt = Date.now();

    const budgetTimer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('TOTAL-BUDGET agotado: ' + errors.join(' | '))); }
    }, TOTAL_BUDGET_MS);

    const launchNext = () => {
      if (settled || launched >= candidates.length) return;
      const model = candidates[launched++];
      withTimeout(ai.generate({ ...params, model }), PER_CALL_TIMEOUT_MS, model)
        .then(res => {
          if (settled) return;
          settled = true;
          clearTimeout(budgetTimer);
          console.log('⚡ [GEMINI OK] ' + model + ' en ' + (Date.now() - startedAt) + 'ms');
          res.__model = model;
          resolve(res);
        })
        .catch(err => {
          modelCooldownUntil[model] = Date.now() + cooldownFor(err);
          const brief = String(err.message || err).replace(/.*generateContent: /, '').slice(0, 120);
          errors.push(model + ': ' + brief);
          console.warn('⚠️ [GEMINI FALLÓ] ' + model + ' → ' + brief);
          failed++;
          if (settled) return;
          if (launched < candidates.length) launchNext();           // el siguiente entra de inmediato
          else if (failed >= candidates.length) {
            settled = true; clearTimeout(budgetTimer);
            reject(new Error('Todos los modelos fallaron: ' + errors.join(' | ')));
          }
        });
    };

    launchNext();
    // Hedging: si el primero tarda, lanza los siguientes en paralelo
    for (let i = 1; i < candidates.length; i++) {
      setTimeout(launchNext, HEDGE_DELAYS_MS[i] || (1000 * i));
    }
  });
}

/** Recorta localmente (sin llamar a la IA) una respuesta demasiado larga para WhatsApp sin amputar oraciones ni preguntas. */
function trimReplyLocally(reply, maxWords = 32) {
  if (!reply) return '';
  const trimmed = reply.trim();
  if (countWords(trimmed) <= maxWords) return trimmed;
  const sentences = (trimmed.match(/[^.!?¡¿]*[.!?]+|[^.!?]+$/g) || [trimmed]).map(x => x.trim()).filter(Boolean);
  const question = [...sentences].reverse().find(x => x.includes('?'));

  if (question) {
    if (sentences.length > 1 && sentences[0] !== question) {
      const combined = sentences[0] + ' ' + question;
      if (countWords(combined) <= maxWords + 5) return combined;
      return question;
    }
    return question;
  }

  let acc = '';
  for (const s of sentences) {
    if (countWords(acc + ' ' + s) <= maxWords) {
      acc = acc ? (acc + ' ' + s) : s;
    } else {
      break;
    }
  }
  if (acc && countWords(acc) >= 4) return acc;
  return trimmed.split(/\s+/).slice(0, maxWords).join(' ').replace(/[,;:]$/, '') + '…';
}

// Preguntas de respaldo (sin IA) para que la conversación avance con MÁXIMO UNA SOLA PREGUNTA
const FALLBACK_QUESTIONS = {
  nombres_apellidos: '¡Hola! Mi nombre es Mateo de RED NITROX. Bienvenido a la *Ruta NITROX*, un programa creado para apoyar a tu taller de motos con capacitaciones técnicas, muestras y premios. 🏍️ Para comenzar a conversar, ¿cuál es tu nombre?',
  nombre_taller: 'Cuéntame, ¿deseas afiliar tu taller a la RED NITROX o deseas cotizar o comprar repuestos hoy?',
  ciudad_taller: '¿En qué ciudad o municipio queda el taller?',
  celular_whatsapp: '¿Me regalas tu número de celular para tenerte en la red?',
  barrio_taller: '¿En qué barrio o sector queda el taller?',
  direccion_taller: '¿Cuál es la dirección del taller?',
  relacion_taller: '¿Eres el dueño del taller o mecánico?',
  marcas_motos: '¿Qué marcas de motos atiendes más, como Bajaj, AKT o Suzuki?',
  motos_por_semana: '¿Cuántas motos atienden por semana aproximadamente?',
  repuestos_frecuentes: '¿Qué repuestos rotas más, kits de arrastre, frenos o motor?',
  marcas_repuestos_usadas: '¿Recomiendas alguna marca de repuestos a tus clientes?',
  conoce_nitrox: '¿Ya conocías la marca NITROX?',
  quiere_muestras: '¿Te gustaría recibir muestras y beneficios de NITROX para tu taller?',
  correo: '¿Me compartes tu correo electrónico?',
  cedula: '¿Me regalas tu número de cédula para vincularte a los beneficios?',
  autorizacion_tratamiento_datos: '¿Autorizas a RED NITROX a registrar los datos de tu taller?'
};

// ───────────────────────────────────────────────────────────────────────────
// DIRECTORIO OFICIAL DE SEDES MUNDIMOTOS EN COLOMBIA Y LOCALIZADOR INTELIGENTE
// ───────────────────────────────────────────────────────────────────────────
const MUNDIMOTOS_STORES = [
  {
    city: 'medellin',
    cityTitle: 'Medellín',
    name: 'Sede La Bayadera',
    address: 'Calle 38 # 52-30',
    zones: ['la bayadera', 'bayadera', 'barrio antioquia', 'antioquia', 'plaza mayor', 'estadio', 'guayabal', 'poblado', 'el poblado', 'belen', 'belén', 'laureles', 'sur'],
    lat: 6.2404,
    lon: -75.5746,
    phrase: '¡Te queda cerquísima! Vete al Mundimotos de **La Bayadera**, en la **Calle 38 # 52-30** (al ladito de Barrio Antioquia y Plaza Mayor). Allá consigues repuestos oficiales NITROX 🏍️🔧'
  },
  {
    city: 'medellin',
    cityTitle: 'Medellín',
    name: 'Sede La Paz (Centro)',
    address: 'Calle 59 # 51D-72',
    zones: ['la paz', 'paz', 'centro', 'la candelaria', 'candelaria', 'norte', 'aranjuez', 'manrique', 'bello', 'castilla', 'robledo'],
    lat: 6.2575,
    lon: -75.5684,
    phrase: 'Te vas directo al Mundimotos de **La Paz (Centro)**, en la **Calle 59 # 51D-72**. Allá encuentras toda la línea oficial NITROX 🏍️🔧'
  },
  {
    city: 'bogota',
    cityTitle: 'Bogotá',
    name: 'Sede Venecia',
    address: 'Calle 45A Sur # 51D-65',
    zones: ['venecia', 'tunjuelito', 'bosa', 'ciudad bolivar', 'ciudad bolívar', 'soacha', 'sur'],
    lat: 4.5938,
    lon: -74.1378,
    phrase: '¡Te queda ahí al lado! Vete al Mundimotos de **Venecia**, en la **Calle 45A Sur # 51D-65**. Allá pides directo repuestos NITROX 🏍️🔧'
  },
  {
    city: 'bogota',
    cityTitle: 'Bogotá',
    name: 'Sede Primera de Mayo',
    address: 'Carrera 29B # 22-26 Sur',
    zones: ['primera de mayo', '1 de mayo', 'restrepo', 'san cristobal', 'san cristóbal', 'antonio nariño', 'kennedy'],
    lat: 4.5889,
    lon: -74.1086,
    phrase: '¡De una! Te queda perfecto el Mundimotos de la **Primera de Mayo**, en la **Carrera 29B # 22-26 Sur**. Allá pides repuestos oficiales NITROX 🏍️🔧'
  },
  {
    city: 'bogota',
    cityTitle: 'Bogotá',
    name: 'Sede Avenida Boyacá',
    address: 'Carrera 72 # 74A-04',
    zones: ['boyaca', 'boyacá', 'avenida boyaca', 'engativa', 'engativá', 'fontibon', 'fontibón', 'calle 80', 'normandia', 'normandía', 'titan'],
    lat: 4.6865,
    lon: -74.0995,
    phrase: '¡Te queda cerca! Llega al Mundimotos de la **Avenida Boyacá**, en la **Carrera 72 # 74A-04**. Allá consigues toda la línea oficial NITROX 🏍️🔧'
  },
  {
    city: 'bogota',
    cityTitle: 'Bogotá',
    name: 'Sede Suba La Campiña',
    address: 'Carrera 98B # 139-29',
    zones: ['suba', 'suba la campiña', 'campiña', 'rincon', 'rincón', 'tibabuyes'],
    lat: 4.7431,
    lon: -74.0934,
    phrase: '¡Te queda de una! Llega al Mundimotos de **Suba La Campiña**, en la **Carrera 98B # 139-29**. Allá pides tus repuestos NITROX 🏍️🔧'
  },
  {
    city: 'bogota',
    cityTitle: 'Bogotá',
    name: 'Sede Suba Calle 130',
    address: 'Calle 130 Bis # 104-04',
    zones: ['calle 130', 'colina', 'niza'],
    lat: 4.7330,
    lon: -74.0980,
    phrase: '¡Te queda cerca! Llega al Mundimotos de **Suba Calle 130**, en la **Calle 130 Bis # 104-04**. Allá pides tus repuestos NITROX 🏍️🔧'
  },
  {
    city: 'cali',
    cityTitle: 'Cali',
    name: 'Sede Carrera 15',
    address: 'Carrera 15 # 11-52',
    zones: ['cali', 'carrera 15', 'san bosco', 'bretaña', 'centro'],
    lat: 3.4435,
    lon: -76.5298,
    phrase: 'En Cali te vas directo al Mundimotos de la **Carrera 15 # 11-52** (San Bosco). Allá encuentras toda la línea oficial NITROX 🏍️🔧'
  },
  {
    city: 'bucaramanga',
    cityTitle: 'Bucaramanga',
    name: 'Sede La Concordia',
    address: 'Carrera 17B # 49-19',
    zones: ['bucaramanga', 'concordia', 'la concordia', 'floridablanca', 'giron', 'girón'],
    lat: 7.1132,
    lon: -73.1221,
    phrase: 'En Bucaramanga te vas al Mundimotos de **La Concordia**, en la **Carrera 17B # 49-19**. Allá consigues repuestos oficiales NITROX 🏍️🔧'
  },
  {
    city: 'barranquilla',
    cityTitle: 'Barranquilla',
    name: 'Sede La Cordialidad',
    address: 'Calle 47 # 16-45',
    zones: ['barranquilla', 'cordialidad', 'la cordialidad', 'soledad'],
    lat: 10.9632,
    lon: -74.7972,
    phrase: 'En Barranquilla te vas al Mundimotos de **La Cordialidad**, en la **Calle 47 # 16-45**. Allá pides toda la línea NITROX 🏍️🔧'
  },
  {
    city: 'pereira',
    cityTitle: 'Pereira',
    name: 'Sede Centro',
    address: 'Calle 12A # 11-06',
    zones: ['pereira', 'centro', 'dosquebradas'],
    lat: 4.8155,
    lon: -75.6953,
    phrase: 'En Pereira te vas al Mundimotos del **Centro**, en la **Calle 12A # 11-06**. Allá encuentras repuestos oficiales NITROX 🏍️🔧'
  }
];

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function resolveStoreLocation({ text, lat, lon, lastAssistantMsg = '' }) {
  const lower = (text || '').toLowerCase().trim();

  // 1. Coordenadas GPS de WhatsApp
  if (lat !== undefined && lon !== undefined && !isNaN(lat) && !isNaN(lon)) {
    let closest = null;
    let minKm = Infinity;
    for (const store of MUNDIMOTOS_STORES) {
      const d = getDistanceKm(lat, lon, store.lat, store.lon);
      if (d < minKm) {
        minKm = d;
        closest = store;
      }
    }
    if (closest && minKm <= 35) {
      return `¡Recibí tu ubicación! 📍 Tu sede Mundimotos más cercana es **${closest.name}**, en la **${closest.address}** (${closest.cityTitle}). Allá consigues repuestos oficiales NITROX 🏍️🔧. ¿Te queda fácil pasar o prefieres que te lo despachemos a tu taller?`;
    } else {
      return `¡Recibí tu ubicación! 📍 Como te encuentras retirado de tiendas físicas, te lo despachamos directo a donde estás por el WhatsApp oficial +57 302 427 6647 con entrega rápida 🏍️📦.`;
    }
  }

  // 2. Preguntas de insistencia: "¿pero no hay más?", "¿no hay más puntos en medellín?", "¿otra sede?", "¿queda muy lejos?"
  const isAskingMorePoints = /\b(?:no\s+hay\s+m[aá]s|pero\s+no\s+hay|otra\s+sede|otro\s+punto|otra\s+tienda|m[aá]s\s+puntos|queda\s+muy\s+lejos|me\s+queda\s+lejos|lejos\s+de)\b/i.test(lower);
  const mentionsMedellin = /\b(?:medell[ií]n|antioquia|paisa)\b/i.test(lower) || /medell[ií]n|calle\s+59|la\s+paz|bayadera/i.test(lastAssistantMsg);

  if (isAskingMorePoints && mentionsMedellin) {
    if (/calle\s+59|la\s+paz/i.test(lastAssistantMsg)) {
      return '¡Claro que sí! En Medellín también contamos con la sede de **La Bayadera** en la **Calle 38 # 52-30** (al ladito de Plaza Mayor y Barrio Antioquia). ¿Te queda más cerca o prefieres despacho directo a tu taller vía WhatsApp (+57 302 427 6647)? 🏍️📦';
    } else {
      return '¡Totalmente! Además de las sedes de La Bayadera y La Paz en Medellín, te despachamos directo a tu taller o domicilio pidiéndolo al WhatsApp oficial +57 302 427 6647 con entrega rápida 🏍️📦. ¿En qué barrio o dirección te encuentras?';
    }
  }

  // 3. Usuario menciona Barrio Antioquia, Plaza Mayor, Estadio, Bayadera
  if (/\b(?:barrio\s+antioquia|plaza\s+mayor|la\s+bayadera|bayadera|estadio)\b/i.test(lower)) {
    return '¡Te queda cerquísima! Vete al Mundimotos de **La Bayadera**, en la **Calle 38 # 52-30** (al ladito de Barrio Antioquia y Plaza Mayor). Allá consigues repuestos oficiales NITROX 🏍️🔧';
  }

  // 4. Usuario pregunta dónde comprar / puntos de venta sin especificar ubicación
  const isAskingWhereToBuy = /\b(?:d[oó]nde\s+(?:puedo\s+|se\s+puede\s+)?(?:compro|comprar|conseguir|consigo|comprarlos|los\s+consigo|queda|venden|est[aá]n)|tienen\s+(?:tiendas?|puntos?\s+de\s+venta|sedes?|almacenes?)|puntos?\s+de\s+venta)\b/i.test(lower);
  if (isAskingWhereToBuy) {
    // Si especificó zona o barrio conocido
    for (const store of MUNDIMOTOS_STORES) {
      for (const z of store.zones) {
        if (new RegExp(`\\b${z}\\b`, 'i').test(lower)) {
          return store.phrase;
        }
      }
    }
    // Si no ha dado ubicación, indagar barrio, dirección o ubicación WhatsApp
    return '¡Claro que sí! Para indicarte el punto oficial más cercano o coordinar el despacho directo, ¿en qué ciudad, barrio o dirección estás, o compárteme tu ubicación por WhatsApp? 📍🏍️';
  }

  return null;
}

function isVerbatimRepetition(reply, lastAssistantMsg) {
  if (!lastAssistantMsg || !reply) return false;
  const clean = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const c1 = clean(reply);
  const c2 = clean(lastAssistantMsg);
  if (!c1 || !c2) return false;
  if (c1 === c2) return true;
  if ((c1.includes(c2) || c2.includes(c1)) && Math.min(c1.length, c2.length) / Math.max(c1.length, c2.length) > 0.75) {
    return true;
  }
  const w1 = c1.split(' ').filter(Boolean);
  const w2 = new Set(c2.split(' ').filter(Boolean));
  if (w1.length > 0 && w2.size > 0) {
    const common = w1.filter(w => w2.has(w)).length;
    const overlap = common / Math.max(w1.length, w2.size);
    if (overlap > 0.75) return true;
  }
  return false;
}

/**
 * Procesa un turno conversacional aplicando la canalización de NLP, memoria semántica y Gemini Brain.
 */
async function processGeminiBrainTurn(session, userText) {
  // 1. Inicializar o cargar la memoria conversacional persistente
  const memory = initOrLoadMemory(session);
  const currentData = session.data || {};
  const history = session.history || [];

  // 2. Procesamiento de Lenguaje Natural en Español
  const lastAssistantMsg = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  const nlpResult = processNlpPipeline(userText, {
    _waitingHabeasData: Boolean(session._waitingHabeasData),
    _offeringNitrox: Boolean(session._offeringNitrox),
    _lastQuestion: session.data?._lastQuestion,
    lastAssistantMessage: lastAssistantMsg,
    ...(session.data || {})
  });

  // 3. Integración directa de hechos y rechazos de datos en la memoria
  integrateFactsIntoMemory(memory, nlpResult.entities, userText);

  // Sincronizar hechos confirmados en session.data
  for (const [k, v] of Object.entries(memory.confirmedFacts)) {
    session.data[k] = v.value;
  }

  const progress = getRegistrationProgress(session.data, memory);
  const isAlreadyRegistered = Boolean(session.data._finished === true && session.data.id_unico);
  const pendingTopics = getConversationalPendingTopics(session.data, memory);
  const memorySummary = buildConversationSummary(memory);

  // ───────────────────────────────────────────────────────────────────────────
  // GESTIÓN DE ESTADOS Y SEPARACIÓN DE FLUJOS INDEPENDIENTES (FLUJO A vs FLUJO B)
  // Flujo A: Compras, cotizaciones y atención comercial NITROX
  // Flujo B: Formulario de registro y vinculación de talleres a RED NITROX
  // ───────────────────────────────────────────────────────────────────────────
  session.data.active_flow = session.data.active_flow || 'registration';
  session.data.commercial_state = session.data.commercial_state || {};
  session.data.last_user_message = userText;
  session.data.last_updated_at = new Date().toISOString();

  // Actualizar commercial_state si en este mensaje se identificó repuesto, moto o ubicación comercial
  if (nlpResult.entities.repuesto_solicitado) {
    session.data.commercial_state.repuesto = nlpResult.entities.repuesto_solicitado;
  }
  if (nlpResult.entities.moto_solicitada) {
    session.data.commercial_state.moto = nlpResult.entities.moto_solicitada;
  }
  if (nlpResult.entities.barrio_solicitado || nlpResult.entities.ciudad_solicitada || nlpResult.entities.ciudad_taller) {
    const loc = [nlpResult.entities.barrio_solicitado, nlpResult.entities.ciudad_solicitada || nlpResult.entities.ciudad_taller].filter(Boolean).join(', ');
    if (loc) {
      session.data.commercial_state.ciudad_o_barrio = loc;
      session.data.ciudad_taller = nlpResult.entities.ciudad_solicitada || nlpResult.entities.ciudad_taller || session.data.ciudad_taller;
      session.data.ciudad_residencia = session.data.ciudad_taller;
    }
  }

  const isCommercialIntent = Boolean(
    nlpResult.entities.intencion_compra ||
    nlpResult.entities.es_pregunta_comercial ||
    session.data._modo_compra === 'asesoria_compra' ||
    session.data.active_flow === 'commercial'
  );

  const wantsToResumeRegistration = Boolean(
    nlpResult.entities.intencion_retomar_formulario ||
    nlpResult.entities.eleccion_flujo_compra === 'seguir_formulario' ||
    ((session.data.active_flow === 'commercial' && (session.data.commercial_state?.status === 'resuelto' || session.data._modo_compra === 'compra_resuelta')) &&
     /^(?:s[ií]|claro|de\s+una|h[aá]gale|obvio|dale|por\s+supuesto|sigamos|el\s+formulario|retomemos|vincular|registrar)\b/i.test(nlpResult.normalizedText))
  );

  const isExplicitRegistrationRejection = Boolean(nlpResult.entities.rechazo_registro);

  if (isExplicitRegistrationRejection) {
    session.data.previous_flow = session.data.active_flow;
    session.data.active_flow = 'commercial';
    session.data._modo_compra = 'asesoria_compra';
    session.data.rechaza_registro = true;
  } else if (isCommercialIntent && !wantsToResumeRegistration) {
    // Si el usuario manifestó intención de compra o cotización, cambiar DE INMEDIATO a Flujo Comercial
    if (session.data.active_flow !== 'commercial') {
      session.data.previous_flow = session.data.active_flow || 'registration';
    }
    session.data.active_flow = 'commercial';
    session.data.current_intent = nlpResult.entities.pregunta_comercial_tema || 'compra';
    session.data._modo_compra = 'asesoria_compra';
  } else if (wantsToResumeRegistration) {
    // Retomar el formulario de registro donde quedó, conservando todos los datos
    session.data.previous_flow = session.data.active_flow;
    session.data.active_flow = 'registration';
    session.data.current_intent = 'registro_taller';
    delete session.data._modo_compra;
    if (session.data.commercial_state) {
      session.data.commercial_state.status = 'resuelto';
    }
  }

  // Contexto conversacional enriquecido para Gemini
  let contextPrompt;

  if (isAlreadyRegistered) {
    const workshop = session.data.nombre_taller || 'tu taller';
    const name = session.data.nombres_apellidos || 'Mecánico';
    const city = session.data.barrio_taller || session.data.ciudad_taller || 'Medellín';
    const idUnico = session.data.id_unico || '';

    contextPrompt = `HISTORIAL RECIENTE:
${history.slice(-8).map(m => `${m.role === 'user' ? 'Mecánico' : 'Mateo'}: "${m.content}"`).join('\n') || '(Inicio)'}

DATOS DEL MECÁNICO YA VINCULADO A RED NITROX:
- Nombre: ${name} | Taller: ${workshop} | Ubicación: ${city} | ID: ${idUnico}
- ESTADO: ¡VINCULACIÓN OFICIAL COMPLETADA Y ACTIVA!

REGLAS ABSOLUTAS:
1. EL TALLER YA ESTÁ REGISTRADO. PROHIBIDO hacer preguntas de registro o vinculación.
2. Si pide repuestos o hace consultas técnicas: atiéndelo con conocimiento experto y calidez.
3. Si pregunta por sus muestras o carnet: infórmale con amabilidad su estado.
4. Longitud: 5 a 18 palabras. Tono respetuoso y amigable paisa. Cero "hermano". Cero repetición de nombres.

ÚLTIMO MENSAJE DEL MECÁNICO:
"${userText}"`;
  } else if (session.data.active_flow === 'commercial') {
    const name = session.data.nombres_apellidos || '';
    const workshop = session.data.nombre_taller || '';
    const repuesto = session.data.commercial_state?.repuesto || '';
    const moto = session.data.commercial_state?.moto || '';
    // Aislamiento estricto: NUNCA arrastrar ciudad_taller de sesiones previas en cotización comercial
    const location = session.data.commercial_state?.ciudad_o_barrio || session.data.ciudad_solicitada || '';
    const commStatus = session.data.commercial_state?.status || 'indagando';

    contextPrompt = `HISTORIAL RECIENTE:
${history.slice(-8).map(m => `${m.role === 'user' ? 'Cliente' : 'Mateo'}: "${m.content}"`).join('\n') || '(Inicio)'}

🚨 ESTADO ACTIVO: FLUJO A — ATENCIÓN COMERCIAL Y ASESORÍA DE COMPRAS NITROX (INDIVIDUAL Y SEPARADO DEL FORMULARIO)
DATOS COMERCIALES YA CONOCIDOS EN ESTA CONVERSACIÓN:
- Nombre del cliente: ${name || 'Aún no proporcionado'}
- Taller (si lo mencionó): ${workshop || 'No mencionado'}
- Repuesto buscado: ${repuesto || 'Pendiente por identificar'}
- Motocicleta / Modelo: ${moto || 'Pendiente por identificar'}
- Ubicación / Ciudad o Barrio: ${location || 'Aún NO confirmada por el cliente en esta conversación (Preguntar ciudad si es necesario)'}
- Estado comercial: ${commStatus}

PROTOCOLO OBLIGATORIO DE CONTINUIDAD Y 6 PASOS DEL PROCESO COMERCIAL:
Paso 1. Identificar el repuesto: Confirma producto (ej. disco de freno), marca (Kawasaki) y referencia/cilindraje (150).
Paso 2. Completar datos faltantes: Formula una sola pregunta clara a la vez (año o versión si hace falta).
Paso 3. Confirmar disponibilidad y canal/precio: Explica disponibilidad NITROX con garantía total. Para precio exacto o pedido inmediato, canal oficial Mundimotos / WhatsApp oficial (+57 302 427 6647). Cero precios inventados.
Paso 4. Identificar la ubicación del cliente: Pregunta en qué ciudad se encuentra. NUNCA deduzcas la ciudad de sesiones pasadas ni de otros clientes.
Paso 5. Coordinar la entrega: Si hay sede física oficial cercana (ej. La Bayadera o La Paz en Medellín, Venecia en Bogotá, Carrera 15 en Cali), dale la dirección exacta. Si no hay sede o prefiere domicilio, ofrece despacho directo a su taller o casa por el WhatsApp oficial (+57 302 427 6647) pidiéndole barrio o dirección.
Paso 6. Continuar hasta resolver la solicitud: Guía al cliente paso a paso hacia el cierre sin abandonar la conversación.

REGLAS CRÍTICAS DE CALIDAD Y CONTINUIDAD:
1. REGLA DE RECUPERACIÓN ANTE ERRORES O CORRECCIONES:
   Si el cliente indica que te equivocaste o te contradices (ej. "¿Cómo sabes que vivo en Bogotá? Vivo en Medellín" o "??"):
   - Reconoce brevemente el error con profesionalismo y respeto.
   - Acepta la información corregida.
   - Retoma DE INMEDIATO el repuesto y moto pendientes.
   - Formula la siguiente pregunta concreta para avanzar.
   - PROHIBIDO TERMINANTEMENTE: risas ("jajaja", "jejeje"), excusas de "se me cruzó con otro cliente" o respuestas vacías ("Mil disculpas Wilson", "Excelente", "Dime").
   - Ejemplo de respuesta: "Tienes toda la razón, qué pena por la confusión. Me confirmas que estás en Medellín. Retomemos tu solicitud del disco de freno NITROX para tu Kawasaki 150: ¿en qué barrio te encuentras o prefieres despacho directo a tu taller vía WhatsApp (+57 302 427 6647)?"
2. NUNCA ASUMIR INFORMACIÓN DE OTRO CLIENTE:
   Cada chat es un caso nuevo. Prohibido atribuir Bogotá si el cliente no lo ha confirmado. Si tienes duda de la ciudad, pregúntasela con amabilidad.
3. CONTINUIDAD OBLIGATORIA:
   Cada mensaje debe contener una pregunta o llamado a la acción comercial. PROHIBIDO enviar mensajes con solo disculpas o saludos vacíos.
4. EXCLUSIVIDAD 100% NITROX:
   Solo repuestos NITROX, cero marcas competidoras.
5. Longitud: 12 a 28 palabras. Tono cálido paisa, profesional y cercano. Cero "hermano".
6. PROHIBIDO REPETIR LA MISMA RESPUESTA DOS VECES SEGUIDAS.

ÚLTIMO MENSAJE DEL CLIENTE:
"${userText}"`;
  } else {
    // Flujo B: Formulario de Registro
    contextPrompt = `HISTORIAL RECIENTE:
${history.slice(-10).map(m => `${m.role === 'user' ? 'Mecánico' : 'Mateo'}: "${m.content}"`).join('\n') || '(Inicio)'}

${memorySummary}

ESTADO DE LA FICHA COMERCIAL (${progress.progressPercentage}% COMPLETADA):
- Confirmados: ${progress.confirmed.join(', ') || 'Ninguno aún'}
- Faltan campos obligatorios (${progress.missingMandatory.length}): ${progress.missingMandatory.map(m => m.label).join('; ') || 'Ninguno'}
- Puede finalizar: ${progress.canFinalize ? 'SÍ, FICHA COMPLETA' : 'NO (FALTAN CAMPOS OBLIGATORIOS)'}

ANÁLISIS LINGÜÍSTICO (NLP):
- Mensaje normalizado: "${nlpResult.normalizedText}"
- Expresiones clave detectadas: ${JSON.stringify(nlpResult.multiWords)}
- Entidades semánticas extraídas en este mensaje: ${JSON.stringify(nlpResult.entities)}

PRÓXIMOS TEMAS A INDAGAR EN ORDEN CONVERSACIONAL NATURAL:
${pendingTopics.length > 0 ? pendingTopics.map((t, idx) => `${idx + 1}. [Sección ${t.section}] ${t.label}${t.mandatory ? ' (Obligatorio)' : ''}`).join('\n') : '(Ficha completa)'}

INSTRUCCIONES CLAVE PARA ESTE TURNO:
0. PREGUNTA CRUCIAL TRAS OBTENER EL NOMBRE:
   - Si ya conoces el nombre del usuario y aún no se sabe el nombre del taller ni la finalidad del contacto:
   - Pregúntale cordialmente por su nombre si desea afiliar su taller a la RED NITROX para recibir muestras, premios y capacitaciones, o si desea cotizar o comprar repuestos hoy.
   - Ejemplo: "¡Mucho gusto, ${session.data.nombres_apellidos ? String(session.data.nombres_apellidos).split(/\s+/)[0] : 'amigo'}! Cuéntame, ¿deseas afiliar tu taller a la RED NITROX o deseas cotizar o comprar repuestos hoy?"
1. SI EL MECÁNICO HIZO UNA PREGUNTA O CONSULTA COMERCIAL (ej. quiénes son, repuestos para NKD, precios):
   - RESPÓNDELE PRIMERO A SU DUDA con total claridad, calidez y conocimiento. NO saltes de una vez a pedirle datos.
2. SI EL MECÁNICO MENCIONA TALLER Y CIUDAD (ej. "La 50 en Medellín", "Taller El Paisa en Bello"):
   - AFIRMA Y CONFIRMA: "¿La 50 se llama tu taller y está ubicado en Medellín, sí? ¿En qué barrio y dirección están?".
   - NUNCA vuelvas a preguntar cómo se llama el taller.
3. SI EL MECÁNICO DIO RESPUESTAS GENÉRICAS ("de todas", "varias", "de todo"):
   - Para marcas de motos: dale ejemplos: "¿Me ayudas con las marcas principales como Bajaj, AKT, Suzuki? ¿De cuál recibes más en el taller?"
   - Para marcas de repuestos: "¿Manejas marcas como Casarella, NITROX u otras?"
   - Para repuestos frecuentes: "¿De lo que más rotas son kits de arrastre, pastillas de freno o motor?"
4. SI EL MECÁNICO DICE QUE NO CONOCE NITROX:
   - Preséntale la marca brevemente en una frase ("NITROX es una marca de repuestos de alta calidad con garantía total y excelente margen") y continúa con el flujo.
5. PREGUNTA DE RECOMENDACIÓN DE REPUESTOS:
   - PROHIBIDO preguntar "¿qué es lo que más pesa al escoger repuestos?". Pregunta si recomienda alguna marca ("¿Tú recomiendas alguna marca de repuestos en el taller?").
   - Luego conecta: "¿Y te gustaría recomendar NITROX y ganar muchos premios y beneficios para tu taller?"
6. ENCADENAMIENTO DE DATOS DE CONTACTO:
   - Cédula y correo SOLO se piden después de que haya manifestado interés en las muestras/beneficios.
   - Pide la autorización de Habeas Data antes de cerrar.
7. REGLA ESTRICTA DE FINALIZACIÓN:
   - SI "Puede finalizar" es NO, QUEDA TERMINANTEMENTE PROHIBIDO poner listo_para_finalizar en true ni despedirte diciendo que ya hace parte de la red. Debes continuar con el siguiente tema pendiente de forma amena.
8. MULETILLAS: PROHIBIDO decir "contame" o "y contame" repetitivamente. Máximo 22 palabras (ideal 5 a 18 palabras). Sin hermano ni repetición de nombres.`;

    if (nlpResult.entities.situacion_salud_o_personal) {
      contextPrompt += `\n\n9. ATENCIÓN PRIORITARIA: El usuario compartió malestar físico o enfermedad (ej. dolor de estómago). TERMINANTEMENTE PROHIBIDO pedir cédula, correo o datos legales en este turno. Dale un consejo humano de alivio (manzanilla, descanso) y deja la conversación tranquila sin presionar por datos de registro.`;
    }
    if (nlpResult.entities.rechazo_hostil) {
      contextPrompt += `\n\n9. ATENCIÓN CRÍTICA: El usuario rechazó con hostilidad o insultó. TERMINANTEMENTE PROHIBIDO reírse ("jaja") y TERMINANTEMENTE PROHIBIDO hacer más preguntas de registro. Pide disculpas con total humildad, respeta su decisión y haz un cierre cortés sin presiones.`;
    }

    try {
      const mlLearnings = getLiveLearningsForPrompt();
      if (mlLearnings) {
        contextPrompt += `\n\n🧠 APRENDIZAJES ACTIVOS DEL MOTOR DE MACHINE LEARNING (CLOSED-LOOP):\n${mlLearnings}`;
      }
    } catch (_) {}

    contextPrompt += `\n\nÚLTIMO MENSAJE DEL MECÁNICO:\n"${userText}"`;
  }

  try {
    // Prioridad modelos ultra-rápidos; si está saturado o sin cuota, cascada con hedging
    const response = await generateResilient({
      system: SYSTEM_PROMPT,
      prompt: contextPrompt,
      config: {
        temperature: 0.35,
        maxOutputTokens: 750,
        responseMimeType: 'application/json'
      }
    });

    const rawJson = response.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      const match = rawJson.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('No se pudo parsear el JSON de Gemini');
      }
    }

    const usage = response.usage || {};
    let inTok = usage.inputTokens || Math.round((contextPrompt.length + SYSTEM_PROMPT.length) / 4);
    let outTok = usage.outputTokens || Math.round((response.text || '').length / 4);

    let reply = cleanResponseText(parsed.respuesta_mateo || '', userText);

    // Longitud WhatsApp: recorte local instantáneo (sin una segunda llamada a la IA)
    // Detección de retoma comercial en la respuesta
    if (wantsToResumeRegistration) {
      if (session.data.commercial_state) session.data.commercial_state.status = 'resuelto';
      session.data._modo_compra = 'compra_resuelta';
    } else if (session.data.active_flow === 'commercial') {
      // Guardabarrera para Flujo Comercial:
      // Si el modelo por error formuló una pregunta de registro de taller o de afiliación
      const isAccidentalRegistrationQuestion = /\b(?:c[oó]mo\s+se\s+llama\s+tu\s+taller|qu[eé]\s+nombre\s+tiene\s+tu\s+taller|eres\s+el\s+due[ñn]o\s+o\s+mec[aá]nico|cu[aá]ntas\s+motos\s+atienden|me\s+regalas\s+tu\s+c[eé]dula|me\s+compartes\s+tu\s+correo|autorizas\s+a\s+red\s+nitrox|en\s+qu[eé]\s+ciudad.*taller|afiliar\s+tu\s+taller)\b/i.test(reply);
      if (isAccidentalRegistrationQuestion) {
        const commState = session.data.commercial_state || {};
        const rep = commState.repuesto || 'repuesto';
        const mot = commState.moto || '';
        if (!commState.repuesto || !commState.moto) {
          const firstName = session.data.nombres_apellidos ? String(session.data.nombres_apellidos).split(/\s+/)[0] : '';
          const nameGreeting = firstName ? `¡Mucho gusto, ${firstName}! ` : '¡De una! ';
          reply = `${nameGreeting}Cuéntame qué repuesto necesitas y para qué moto, y con gusto te ayudo con la cotización o compra.`;
        } else if (!commState.ciudad_o_barrio) {
          reply = `¡Listo, tenemos ${rep} NITROX para tu ${mot}! 🏍️ ¿En qué ciudad o barrio te encuentras, o compárteme tu ubicación por WhatsApp para indicarte la tienda Mundimotos más cercana o coordinar despacho directo? 📍`;
        } else {
          reply = `¡Listo! Tenemos ${rep} NITROX para tu ${mot}. ¿Deseas que te lo despachemos directo a tu taller vía WhatsApp (+57 302 427 6647)? 🏍️📦`;
        }
      }
      // Reemplazo estético si se coló algún residuo en la respuesta
      if (session.data.nombre_taller && /\b(?:cotizar|comprar|hacer\s+una\s+compra|quiero)\b/i.test(session.data.nombre_taller)) {
        delete session.data.nombre_taller;
        reply = reply.replace(/taller\s+en\s+este\s+momento\s+quiero\s+cotizar/gi, 'tu compra').replace(/taller\s+quiero\s+comprar/gi, 'tu compra');
      }
    } else if (session.data.active_flow === 'registration' && !session.data.nombre_taller) {
      // PREGUNTA CRUCIAL DETERMINÍSTICA TRAS EL NOMBRE:
      // Si el modelo pregunta cómo se llama el taller antes de indagar la finalidad
      if (/\b(?:c[oó]mo\s+se\s+llama\s+tu\s+taller|qu[eé]\s+nombre\s+tiene\s+tu\s+taller|nombre\s+de\s+tu\s+taller)\b/i.test(reply)) {
        const firstName = session.data.nombres_apellidos ? String(session.data.nombres_apellidos).split(/\s+/)[0] : '';
        const greeting = firstName ? `¡Mucho gusto, ${firstName}! 🏍️ ` : '¡Mucho gusto! 🏍️ ';
        reply = `${greeting}Cuéntame, ¿deseas afiliar tu taller a la RED NITROX o deseas cotizar o comprar repuestos hoy?`;
      }
    }

    // 3.5 LOCALIZADOR INTELIGENTE DE TIENDAS Y PUNTOS DE VENTA (Medellín, Bogotá, Cali, etc.)
    const storeReply = resolveStoreLocation({
      text: userText,
      lat: nlpResult.entities.coordenadas_gps?.lat,
      lon: nlpResult.entities.coordenadas_gps?.lon,
      lastAssistantMsg: lastAssistantMsg
    });
    if (storeReply) {
      reply = storeReply;
    }

    // 4. GUARDABARRERAS SEMÁNTICO Y ANTI-REPETICIÓN
    // Inspecciona si la respuesta generada intenta formular una pregunta sobre un dato que ya se conoce.
    if (reply.includes('?')) {
      const askedTopicKey = parsed.tema_preguntado || null;
      let isForbidden = false;

      // Evaluar contra todos los patrones semánticos
      for (const [key, def] of Object.entries(TOPIC_SEMANTIC_PATTERNS)) {
        for (const pat of def.patterns) {
          if (pat.test(reply)) {
            const check = isTopicOrQuestionForbidden(memory, key, reply);
            if (check.forbidden) {
              console.warn(`🚨 [ANTI-REPETICIÓN ACTIVADO]: Se intentó preguntar sobre "${key}" pero ya está registrado. Causa: ${check.reason}`);
              isForbidden = true;
              break;
            }
          }
        }
        if (isForbidden) break;
      }

      // Si la guardabarrera detectó que la pregunta era redundante, remover la pregunta y conservar el comentario natural
      if (isForbidden) {
        reply = reply.replace(/\?[^?]*$/g, '').trim();
        const sentences = reply.split(/[.!?]/).map(s => s.trim()).filter(Boolean);
        if (sentences.length > 0) {
          reply = sentences[0] + '.';
        } else {
          reply = '¡De una! Ya tengo esa información bien presente.';
        }
      } else {
        // Registrar la pregunta en la memoria para que no se vuelva a repetir jamás
        recordAskedQuestion(memory, askedTopicKey, reply);
      }
    }

    // 5. Integrar actualizaciones de Gemini en la memoria
    if (parsed.datos_extraidos && typeof parsed.datos_extraidos === 'object') {
      integrateFactsIntoMemory(memory, parsed.datos_extraidos, userText);
    }
    if (parsed.datos_comerciales && typeof parsed.datos_comerciales === 'object') {
      session.data.commercial_state = session.data.commercial_state || {};
      for (const [ck, cv] of Object.entries(parsed.datos_comerciales)) {
        if (cv !== null && cv !== undefined && cv !== '') {
          session.data.commercial_state[ck] = cv;
        }
      }
    }

    // Costo económico
    const totalTok = inTok + outTok;
    const costUsd = Number(((inTok * 0.000000075) + (outTok * 0.00000030)).toFixed(7));
    const costCop = Number((costUsd * 4000).toFixed(4));

    // Determinar si ya está listo para finalizar según el motor central de la ficha maestra
    const updatedProgress = getRegistrationProgress(session.data, memory);
    const isFinished = Boolean(parsed.listo_para_finalizar && updatedProgress.canFinalize);

    const isHostileRejection = /madre|mierda|hp|hpta|hijueputa|malparid|gonorrea|carechimba|no\s+me\s+jod|😡|🤬/i.test(userText) || Boolean(nlpResult.entities.rechazo_hostil);
    const isHealthSituation = Boolean(nlpResult.entities.situacion_salud_o_personal);

    if (isHostileRejection) {
      // Si el usuario rechazó con insulto u hostilidad, eliminar cualquier pregunta de registro de la respuesta
      reply = reply.replace(/\¿[^?]+\?/g, '').trim();
      reply = cleanResponseText(reply, userText);
      if (!reply.toLowerCase().includes('disculp') && !reply.toLowerCase().includes('pena')) {
        reply = '¡Qué pena contigo, tienes toda la razón! Mil disculpas si fui muy insistente. Tranquila, no guardamos ningún dato. Que tengas un excelente día.';
      } else if (!reply.toLowerCase().includes('excelente d[ií]a') && !reply.toLowerCase().includes('tranquil')) {
        reply = reply.replace(/[.!\s]+$/, '') + '. Tranquila, no guardamos ningún dato. Que tengas un excelente día.';
      }
    } else if (isHealthSituation && /c[eé]dula/i.test(reply)) {
      reply = reply.replace(/\¿(?:me\s+regalas|tienes)\s+(?:tu\s+)?c[eé]dula[^?]*\?/gi, '').trim();
      reply = reply.replace(/[.!\s]+$/, '') + '. Primero la salud, ¡que te mejores pronto!';
    }

    // 4.1 GARANTÍA DE PROGRESIÓN CONVERSACIONAL (REGLA DE UNA SOLA PREGUNTA OBLIGATORIA)
    // EXCEPCIONES: NO forzar preguntas si el usuario fue hostil, reportó malestar de salud o está en modo comercial
    if (!isFinished && !reply.includes('?') && !isHostileRejection && !isHealthSituation && session.data.active_flow !== 'commercial' && session.data._modo_compra !== 'asesoria_compra' && session.data._modo_compra !== 'preguntando_opcion') {
      const remainingPending = getConversationalPendingTopics(session.data, memory);
      let nextKeyToAsk = null;
      let nextQuestionText = null;

      for (const t of remainingPending) {
        const candQ = FALLBACK_QUESTIONS[t.key] || '¿Me cuentas un poco más de tu taller?';
        const check = isTopicOrQuestionForbidden(memory, t.key, candQ);
        if (!check.forbidden) {
          nextKeyToAsk = t.key;
          nextQuestionText = candQ;
          break;
        }
      }

      if (nextKeyToAsk && nextQuestionText) {
        if (nextKeyToAsk === 'nombres_apellidos') {
          nextQuestionText = '¿Cuál es tu nombre para tenerte bien registrado?';
        } else if (nextKeyToAsk === 'nombre_taller') {
          nextQuestionText = '¿Cómo se llama tu taller de motos?';
        }
        reply = `${reply.replace(/[.!\s]+$/, '')}. ${nextQuestionText}`;
        recordAskedQuestion(memory, nextKeyToAsk, nextQuestionText);
      }
    }

    // 4.2 GUARDABARRERAS ESTRICTO CONTRA REPETICIÓN VERBATIM
    if (isVerbatimRepetition(reply, lastAssistantMsg)) {
      console.warn(`🚨 [ANTI-REPETICIÓN ACTIVADO]: Respuesta idéntica a la anterior interceptada.`);
      const isLocQuery = /\b(?:no\s+hay\s+m[aá]s|pero\s+no\s+hay|otra\s+sede|otro\s+punto|otra\s+tienda|m[aá]s\s+puntos|queda\s+muy\s+lejos|me\s+queda\s+lejos|lejos\s+de|puntos?\s+de\s+venta|tienda|sedes?)\b/i.test(userText) || /mundimotos|sede|calle\s+59|la\s+paz|bayadera/i.test(lastAssistantMsg);
      if (isLocQuery) {
        if (/calle\s+59|la\s+paz/i.test(lastAssistantMsg)) {
          reply = '¡Claro que sí! En Medellín también contamos con la sede de **La Bayadera** en la **Calle 38 # 52-30** (al ladito de Plaza Mayor y Barrio Antioquia). ¿Te queda más cerca o prefieres despacho directo a tu taller vía WhatsApp (+57 302 427 6647)? 🏍️📦';
        } else {
          reply = '¡Totalmente! Además de las tiendas físicas, te lo despachamos directo a donde te encuentres vía WhatsApp (+57 302 427 6647) 🏍️📦. ¿En qué barrio o dirección te encuentras?';
        }
      } else if (session.data.active_flow === 'registration') {
        reply = '¡Entendido! Cuéntame, ¿en qué más te puedo colaborar hoy?';
      } else {
        reply = '¡De una! Cuéntame qué repuesto necesitas o compárteme tu barrio, dirección o ubicación para asesorarte al instante.';
      }
    }

    return {
      analysis: parsed.analisis_interno || {},
      updates: parsed.datos_extraidos || {},
      reply: reply,
      tema_preguntado: parsed.tema_preguntado || null,
      isFinished: isFinished,
      tokenUsage: {
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: totalTok,
        costUsd: costUsd,
        costCop: costCop
      }
    };

  } catch (err) {
    console.error('[GEMINI BRAIN ERROR]:', err.message || err);
    // Sincronizar hechos confirmados en session.data
    for (const [k, v] of Object.entries(memory.confirmedFacts)) {
      session.data[k] = v.value;
    }

    // Respaldo sin IA según estado comercial, despedidas o registro pendiente
    let fallbackReply;
    const isCommercial = session.data.active_flow === 'commercial' || nlpResult.entities.intencion_compra || nlpResult.entities.es_pregunta_comercial || nlpResult.entities.despedida_con_pregunta;

    // Verificar si el mensaje era una consulta de puntos de venta
    const storeFallback = resolveStoreLocation({
      text: userText,
      lat: nlpResult?.entities?.coordenadas_gps?.lat,
      lon: nlpResult?.entities?.coordenadas_gps?.lon,
      lastAssistantMsg: lastAssistantMsg
    });

    if (storeFallback) {
      fallbackReply = storeFallback;
    } else if (nlpResult.entities.es_despedida && !nlpResult.entities.despedida_con_pregunta && !isCommercial) {
      fallbackReply = '¡Con todo gusto! Que estés muy bien y que tengas un excelente día.';
    } else if (nlpResult.entities.es_pausa && !isCommercial) {
      fallbackReply = '¡Listo, perfecto! Aquí quedamos atentos para cuando desees continuar. ¡Un feliz día!';
    } else if (isCommercial) {
      session.data.active_flow = 'commercial';
      const firstName = session.data.nombres_apellidos ? session.data.nombres_apellidos.trim().split(' ')[0] : '';
      const greetingName = firstName ? `¡Mucho gusto, ${firstName}! ` : '¡De una! ';
      const commState = session.data.commercial_state || {};
      const rep = commState.repuesto || 'repuesto';
      const mot = commState.moto || '';

      if (nlpResult.entities.cotizacion_multiple) {
        fallbackReply = `${greetingName}Claro que sí, con gusto te cotizo esas referencias NITROX. ¿Para qué moto las necesitas?`;
      } else if (!commState.repuesto || !commState.moto) {
        if (commState.repuesto && !commState.moto) {
          fallbackReply = `${greetingName}¡Excelente elección el ${commState.repuesto} NITROX! ¿Para qué modelo o cilindraje de moto lo necesitas?`;
        } else {
          fallbackReply = `${greetingName}Cuéntame qué repuesto necesitas y para qué moto, y con gusto te colaboro con la cotización o compra.`;
        }
      } else if (!commState.ciudad_o_barrio) {
        fallbackReply = `¡Listo, tenemos ${rep} NITROX para tu ${mot}! 🏍️ ¿En qué ciudad o barrio te encuentras, o compárteme tu ubicación por WhatsApp para indicarte la tienda Mundimotos más cercana o coordinar despacho directo? 📍`;
      } else {
        fallbackReply = `¡Listo! Tenemos ${rep} NITROX para tu ${mot}. ¿Deseas que te lo despachemos directo a tu taller vía WhatsApp (+57 302 427 6647)? 🏍️📦`;
      }
    } else {
      const latestPending = getConversationalPendingTopics(session.data, memory);
      let chosenKey = null;
      let nextQ = null;

      for (const t of latestPending) {
        const candQ = FALLBACK_QUESTIONS[t.key] || '¿Me cuentas un poco más de tu taller?';
        const check = isTopicOrQuestionForbidden(memory, t.key, candQ);
        if (!check.forbidden) {
          chosenKey = t.key;
          nextQ = candQ;
          break;
        }
      }

      if (!chosenKey) {
        chosenKey = 'barrio_taller';
        nextQ = '¿En qué barrio o sector se encuentra ubicado tu taller?';
      }

      // Formulaciones naturales de máximo 1 sola pregunta con confirmación breve previa
      const isBadWord = (str) => !str || /\b(?:mierda|hp|hpta|hijueputa|gonorrea|marica|carechimba|malparido|no\s+sea|no\s+es)\b/i.test(str) || /^(?:y|e|o|u|si|no)$/i.test(String(str).trim());
      if (chosenKey === 'nombre_taller' && session.data.nombres_apellidos && !isBadWord(session.data.nombres_apellidos)) {
        const firstName = String(session.data.nombres_apellidos).trim().split(/\s+/)[0];
        if (firstName.length >= 2 && !isBadWord(firstName)) {
          nextQ = `¡Mucho gusto, ${firstName}! 🏍️ Cuéntame, ¿deseas afiliar tu taller a la RED NITROX para recibir beneficios y muestras, o deseas cotizar o comprar repuestos hoy?`;
        } else {
          nextQ = '¡Qué gusto saludarte! Cuéntame, ¿deseas afiliar tu taller a la RED NITROX o deseas cotizar o comprar repuestos hoy?';
        }
      } else if (chosenKey === 'ciudad_taller') {
        const cleanShop = (session.data.nombre_taller && !/\b(?:cotizar|comprar|quiero)\b/i.test(session.data.nombre_taller) && !isBadWord(session.data.nombre_taller)) ? session.data.nombre_taller : 'tu taller';
        nextQ = `¡Excelente! ¿Y en qué ciudad o municipio queda ${cleanShop}?`;
      } else if (chosenKey === 'barrio_taller' && session.data.ciudad_taller) {
        const cleanShop = (session.data.nombre_taller && !/\b(?:cotizar|comprar|quiero)\b/i.test(session.data.nombre_taller) && !isBadWord(session.data.nombre_taller)) ? session.data.nombre_taller : 'tu taller';
        nextQ = `¡Entendido! ${cleanShop} en ${session.data.ciudad_taller} 🏍️. ¿En qué barrio o sector están?`;
      }

      fallbackReply = (isAlreadyRegistered ? '¡Con gusto! Ya estás en la red. ¿En qué más te ayudo?' : nextQ);
      if (!isAlreadyRegistered && chosenKey) {
        recordAskedQuestion(memory, chosenKey, fallbackReply);
      }
    }
    return {
      analysis: { error: err.message, fallback: true },
      updates: {},
      reply: fallbackReply,
      isFinished: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costCop: 0
      }
    };
  }
}

module.exports = {
  processGeminiBrainTurn,
  generateResilient,
  trimReplyLocally,
  FALLBACK_QUESTIONS,
  getPendingTopics,
  SYSTEM_PROMPT,
  countWords,
  cleanResponseText,
  resolveStoreLocation,
  isVerbatimRepetition,
  MUNDIMOTOS_STORES
};
