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

  // Si el usuario expresó molestia, insulto, hostilidad o emojis de rabia, erradicar cualquier risa
  const isAngryOrHostile = /madre|mierda|hp|hpta|hijueputa|malparid|gonorrea|carechimba|no\s+me\s+jod|😡|🤬/i.test(userText);
  if (isAngryOrHostile) {
    s = s.replace(/^[¡!]?\s*(?:jaj+a*|jej+e*|jij+i*)[\s,!.]*/gi, '');
  }

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
const HEDGE_DELAYS_MS = [0, 600, 1400, 2200];   // respuesta ultra-rápida en <800ms
const PER_CALL_TIMEOUT_MS = 2500;
const TOTAL_BUDGET_MS = 4500;
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
      setTimeout(launchNext, HEDGE_DELAYS_MS[i] || (3500 * i));
    }
  });
}

/** Recorta localmente (sin llamar a la IA) una respuesta demasiado larga para WhatsApp. */
function trimReplyLocally(reply, maxWords = 22) {
  if (countWords(reply) <= maxWords) return reply;
  const sentences = (reply.match(/[^.!?¡¿]*[.!?]+|[^.!?]+$/g) || [reply]).map(x => x.trim()).filter(Boolean);
  const question = [...sentences].reverse().find(x => x.includes('?'));
  const first = sentences[0];
  if (question && first && first !== question && countWords(first + ' ' + question) <= maxWords + 3) return first + ' ' + question;
  if (question && countWords(question) <= maxWords + 3) return question;
  if (first && countWords(first) <= maxWords + 3) return first;
  return reply.split(/\s+/).slice(0, maxWords).join(' ').replace(/[,;:]$/, '') + '…';
}

// Preguntas de respaldo (sin IA) para que la conversación avance con MÁXIMO UNA SOLA PREGUNTA
const FALLBACK_QUESTIONS = {
  nombres_apellidos: '¡Hola! Mi nombre es Mateo de RED NITROX. Bienvenido a la *Ruta NITROX*, un programa creado para apoyar a tu taller de motos con capacitaciones técnicas, muestras y premios. 🏍️ Para comenzar a conversar, ¿cuál es tu nombre?',
  nombre_taller: '¡Qué gusto! Cuéntame, ¿cómo se llama tu taller de motos?',
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
    if (loc) session.data.commercial_state.ciudad_o_barrio = loc;
  }

  const isCommercialIntent = Boolean(
    nlpResult.entities.intencion_compra ||
    nlpResult.entities.es_pregunta_comercial ||
    session.data._modo_compra === 'asesoria_compra'
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
    const repuesto = session.data.commercial_state.repuesto || '';
    const moto = session.data.commercial_state.moto || '';
    const location = session.data.commercial_state.ciudad_o_barrio || session.data.ciudad_taller || session.data.barrio_taller || '';
    const commStatus = session.data.commercial_state.status || 'indagando';

    contextPrompt = `HISTORIAL RECIENTE:
${history.slice(-8).map(m => `${m.role === 'user' ? 'Cliente' : 'Mateo'}: "${m.content}"`).join('\n') || '(Inicio)'}

🚨 ESTADO ACTIVO: FLUJO A — ATENCIÓN COMERCIAL Y ASESORÍA DE COMPRAS NITROX (INDIVIDUAL Y SEPARADO DEL FORMULARIO)
DATOS COMERCIALES YA CONOCIDOS:
- Nombre del cliente: ${name || 'Aún no proporcionado'}
- Taller (si lo mencionó): ${workshop || 'No mencionado'}
- Repuesto buscado: ${repuesto || 'Pendiente por identificar'}
- Motocicleta / Modelo: ${moto || 'Pendiente por identificar'}
- Ubicación / Ciudad o Barrio: ${location || 'Pendiente por identificar'}
- Estado comercial: ${commStatus}

REGLAS ABSOLUTAS DEL FLUJO COMERCIAL:
1. PRIORIDAD TOTAL A LA COMPRA/COTIZACIÓN: El cliente quiere comprar o cotizar repuestos. Atiéndelo de inmediato con total calidez y conocimiento experto.
2. TERMINANTEMENTE PROHIBIDO hacer preguntas del formulario de registro del taller (PROHIBIDO preguntar cómo se llama su taller si no lo dijo, rol de dueño o mecánico, cuántas motos atiende por semana, cédula, correo o Habeas Data).
3. PROHIBIDO OBLIGAR AL CLIENTE A ELEGIR: Si el cliente ya manifestó que quiere comprar (ej. "Walter González pero hoy quiero hacer una compra" o "No hoy quiero comprar"), PROHIBIDO preguntar "¿Seguimos con el formulario o quieres solo comprar?". Salúdalo con calidez por su nombre y atiende su compra de inmediato:
   "¡Mucho gusto, ${name ? name.split(/\s+/)[0] : 'amigo'}! De una, cuéntame qué repuesto necesitas y te ayudo con la compra."
4. EXCLUSIVIDAD 100% NITROX: Solo repuestos oficiales NITROX (kits de arrastre reforzados 420H, 428H, 520H; cadenas Gold/O-Ring; pastillas y bandas de freno; kits de clutch). CERO marcas competidoras.
5. NO INVENTAR PRECIOS FIJOS O INVENTARIOS EXACTOS: Si pide precios o stock exacto, dale el rango o explícale que en el punto oficial Mundimotos / WhatsApp de pedidos (+57 302 427 6647) se lo confirman al instante con despacho a su taller.
6. SI FALTA LA MOTO: Pregunta marca, modelo o cilindraje para identificar la referencia correcta (ej. "¿Qué modelo de Pulsar tienes? Así identificamos la referencia adecuada.").
7. SI YA TIENES REPUESTO Y MOTO PERO FALTA UBICACIÓN: Pide su ciudad y barrio o ubicación por WhatsApp para recomendarle la sede Mundimotos más cercana.
8. SI LA SOLICITUD COMERCIAL YA ESTÁ RESUELTA:
   Puedes ofrecer de forma natural, breve y opcional (sin presionar):
   "Listo${name ? ' ' + name.split(/\s+/)[0] : ''}. Si quieres, después retomamos el registro de tu taller para que también puedas aprovechar los beneficios de la Ruta NITROX 🏍️"
9. Longitud: 5 a 22 palabras. Tono cálido paisa, profesional y cercano. Cero "hermano".
10. MULTIINTENCIÓN EN UN SOLO MENSAJE: Si el cliente saludó, dio su nombre/taller y pidió cotizar/comprar (ej. "Hola, soy Walter González, mi taller es Moto Sport y quiero cotizar un kit de arrastre"), salúdalo por su nombre, agradece y entra DIRECTO a cotizar: "¡Mucho gusto Walter! Claro que sí, te ayudo con la cotización del kit de arrastre. ¿Para qué moto lo buscas?". CERO preguntas de registro de taller.
11. DESPEDIDAS CON PREGUNTAS: Si el cliente dijo "Gracias, chao. Ah, una cosa, ¿cuánto vale el kit?", atiende y responde con prioridad a su pregunta sobre el repuesto. NO cierres la interacción.
12. PAUSAS COMERCIALES: Si el cliente dice "después te confirmo", "hablamos luego", "déjame pensarlo", responde cordialmente ("¡De una, con mucho gusto! Aquí quedo atento cuando decidas confirmar.") sin forzar venta ni darla por perdida.
13. COTIZACIÓN MÚLTIPLE: Si el cliente ya mencionó varios repuestos (ej. kit de arrastre y zapatas), NO vuelvas a pedir los repuestos. Confirma que NITROX maneja ambas referencias y pregúntale por el modelo de moto o ciudad.
14. CLIENTE SIN TALLER / INDEPENDIENTE: Si el cliente dice que no tiene taller o trabaja independiente, acéptalo con naturalidad ("¡De una!") y continúa la asesoría comercial con total normalidad sin exigirle nombre de taller.

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
    reply = trimReplyLocally(reply);

    // Detección de retoma comercial en la respuesta
    if (/ahora\s+s[ií]\s+seguimos\s+con\s+el\s+formulario|despu[eé]s\s+retomamos\s+(?:el\s+registro|tu\s+registro|el\s+formulario)/i.test(reply)) {
      if (session.data.commercial_state) session.data.commercial_state.status = 'resuelto';
      session.data._modo_compra = 'compra_resuelta';
    } else if (session.data.active_flow === 'commercial') {
      // Guardabarrera para Flujo Comercial:
      // Si el modelo por error formuló una pregunta de registro de taller
      const isAccidentalRegistrationQuestion = /\b(?:c[oó]mo\s+se\s+llama\s+tu\s+taller|qu[eé]\s+nombre\s+tiene\s+tu\s+taller|eres\s+el\s+due[ñn]o\s+o\s+mec[aá]nico|cu[aá]ntas\s+motos\s+atienden|me\s+regalas\s+tu\s+c[eé]dula|me\s+compartes\s+tu\s+correo|autorizas\s+a\s+red\s+nitrox)\b/i.test(reply);
      if (isAccidentalRegistrationQuestion) {
        const firstName = session.data.nombres_apellidos ? String(session.data.nombres_apellidos).split(/\s+/)[0] : '';
        const nameGreeting = firstName ? `¡Mucho gusto, ${firstName}! ` : '¡De una! ';
        reply = `${nameGreeting}Cuéntame qué repuesto necesitas y para qué moto, y con gusto te ayudo con la compra.`;
      }
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

    if (nlpResult.entities.es_despedida && !nlpResult.entities.despedida_con_pregunta && !isCommercial) {
      fallbackReply = '¡Con todo gusto! Que estés muy bien y que tengas un excelente día.';
    } else if (nlpResult.entities.es_pausa && !isCommercial) {
      fallbackReply = '¡Listo, perfecto! Aquí quedamos atentos para cuando desees continuar. ¡Un feliz día!';
    } else if (isCommercial) {
      session.data.active_flow = 'commercial';
      const firstName = session.data.nombres_apellidos ? session.data.nombres_apellidos.trim().split(' ')[0] : '';
      const greetingName = firstName ? `¡Mucho gusto, ${firstName}! ` : '¡De una! ';
      const commState = session.data.commercial_state || {};

      if (nlpResult.entities.cotizacion_multiple) {
        fallbackReply = `${greetingName}Claro que sí, con gusto te cotizo esas referencias NITROX. ¿Para qué moto las necesitas?`;
      } else if (!commState.repuesto || !commState.moto) {
        if (commState.repuesto && !commState.moto) {
          fallbackReply = `${greetingName}¡Excelente elección el ${commState.repuesto} NITROX! ¿Para qué modelo de moto lo necesitas?`;
        } else {
          fallbackReply = `${greetingName}Cuéntame qué repuesto necesitas y para qué moto, y con gusto te colaboro con la cotización o compra.`;
        }
      } else if (!commState.ciudad_o_barrio) {
        fallbackReply = '¡Excelente! ¿En qué ciudad o barrio estás para indicarte el punto de venta más cercano?';
      } else {
        fallbackReply = '¡Listo! Ya te confirmo disponibilidad y punto de venta NITROX más cercano.';
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
          nextQ = `¡Mucho gusto, ${firstName}! 🏍️ ¿Cómo se llama tu taller de motos?`;
        } else {
          nextQ = '¡Qué gusto saludarte! Cuéntame, ¿cómo se llama tu taller de motos?';
        }
      } else if (chosenKey === 'ciudad_taller' && session.data.nombre_taller && !isBadWord(session.data.nombre_taller)) {
        nextQ = `¡Excelente! ¿Y en qué ciudad o municipio queda ${session.data.nombre_taller}?`;
      } else if (chosenKey === 'barrio_taller' && session.data.nombre_taller && session.data.ciudad_taller && !isBadWord(session.data.nombre_taller)) {
        nextQ = `¡Entendido! ${session.data.nombre_taller} en ${session.data.ciudad_taller} 🏍️. ¿En qué barrio o sector están?`;
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
  cleanResponseText
};
