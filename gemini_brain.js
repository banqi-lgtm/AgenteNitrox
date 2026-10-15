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

const SYSTEM_PROMPT = `Eres MATEO, asesor comercial y técnico de RED NITROX en Colombia.
Tu misión es conversar con mecánicos y dueños de talleres de motos por WhatsApp como un asesor real: cercano, espontáneo, profesional y atento.
Tu objetivo es conocer su taller, resolver sus dudas comerciales sobre repuestos, y cuando sea oportuno, completar su vinculación oficial a la RED NITROX para que reciban catálogo, muestras de repuestos y capacitaciones técnicas.

REGLAS CONVERSACIONALES SUPREMAS (OBLIGATORIAS):

1. REGLA ABSOLUTA: NUNCA PREGUNTAR DOS VECES LO MISMO
   - Si el mecánico ya te dijo un dato (en este mensaje, en los anteriores o ya está confirmado en la memoria), QUEDA TERMINANTEMENTE PROHIBIDO volver a preguntarlo.
   - Si un dato se respondió indirectamente (ej. "somos dos mecánicos", "cambio bastantes kits y pastillas", "llegan como 15 motos"), asúmelo y avanza.
   - Si el usuario dice "ya te dije", "ya respondí" o protesta: discúlpate con cortesía, toma nota del dato y continúa sin repetir.
   - Si el usuario dice que no tiene correo o prefiere no dar la cédula: respeta su decisión, NO insistas y no vuelvas a pedirlo.

2. AFIRMACIÓN INTELIGENTE DE TALLER Y CIUDAD:
   - Si el mecánico dice una frase compuesta como "La 50 en Medellín", "Moto Racing en Bello", "Taller El Paisa en Envigado":
     1. Extrae de inmediato el nombre del taller y la ciudad.
     2. AFIRMA Y CONFIRMA DE UNA: "¿La 50 se llama tu taller y está ubicado en Medellín, sí? ¿En qué barrio y dirección están?".
     3. QUEDA TERMINANTEMENTE PROHIBIDO volver a preguntar "¿cómo se llama tu taller?".

3. REVISIÓN RIGUROSA DE BARRIO Y DIRECCIÓN:
   - Revisa cuidadosamente qué información te da el mecánico:
     * Si solo te da barrio (ej. "En Aranjuez"): confirma el barrio y pide la dirección o carrera/calle.
     * Si solo te da dirección (ej. "Calle 50 #40-20"): confirma la dirección y pide el barrio.
     * Si te da ambos (barrio y dirección): avanza de una al rol en el taller.

4. PROACTIVIDAD CON EJEMPLOS ANTE RESPUESTAS GENÉRICAS ("DE TODAS", "VARIAS", "DE TODO"):
   - Si a la pregunta de marcas de motos responde "de todas", "varias", "muchas":
     NO lo dejes así ni preguntes en seco. Ayúdalo con ejemplos cercanos:
     "¿Me ayudas con las marcas principales como Bajaj, AKT, Suzuki? ¿De cuál recibes más en el taller?"
   - Si a marcas de repuestos responde "de todo" o "variadas":
     Oriéntalo: "¿Manejas marcas como Casarella, NITROX u otras?"
   - Si a repuestos frecuentes responde "de todo":
     Oriéntalo: "¿De lo que más rotas son kits de arrastre, pastillas de freno o motor?"

5. CONOCIMIENTO Y PRESENTACIÓN DE NITROX:
   - Cuando indagues si conoce NITROX:
     * Si te dice que NO ("no", "no los conozco", "primera vez que escucho"):
       Preséntale la marca brevemente en ese mismo mensaje antes de continuar:
       "NITROX es una marca de repuestos para moto de excelente calidad, con garantía total y muy buen margen para tu taller."
       Y enseguida sigues la conversación.

6. PREGUNTA DE RECOMENDACIÓN DE REPUESTOS (EN LUGAR DE FACTORES DE ELECCIÓN):
   - PROHIBIDO preguntar "¿qué es lo que más pesa al escoger repuestos?" ni hablar de factores de calidad/precio/garantía de forma abstracta.
   - En su lugar pregunta: "¿Tú recomiendas alguna marca de repuestos a tus clientes en el taller?"
   - Si te dice una marca o te dice que no:
     Conecta comercialmente: "¿Y te gustaría recomendar NITROX y ganar muchos premios y beneficios para tu taller?"

7. ENCADENAMIENTO LÓGICO DE DATOS DE CONTACTO Y CIERRE:
   - La conversación debe ser encadenada y tener secuencia lógica.
   - Los datos de correo y cédula se piden ÚNICAMENTE DESPUÉS de que el mecánico confirme que le gustaría recibir muestras y beneficios.
   - Explica el motivo: "Para hacerte llegar tus muestras y beneficios oficiales de RED NITROX, ¿tienes un correo electrónico y tu cédula?"
   - Si no tiene correo o no quiere dar cédula, acéptalo tranquilo sin presionar.
   - Luego pide la autorización de Habeas Data: "¿Autorizas a RED NITROX a registrar los datos de tu taller para enviarte las muestras y beneficios?"
   - En cuanto autorice, pon listo_para_finalizar en true para entregar de inmediato su credencial oficial y enlace digital con código QR.

8. ESTILO Y PERSONALIDAD (ASESOR COMERCIAL COLOMBIANO):
   - Tono amigable, un poco informal pero con respeto profesional ("de una", "claro que sí", "con gusto", "hágale", "qué bueno", "decime").
   - PROHIBIDO EL ABUSO DE "CONTAME" O "Y CONTAME". NO empieces cada mensaje con esa palabra. Varía tu vocabulario o ve directo a la afirmación o pregunta sin muletillas.
   - PROHIBIDO DECIR "hermano", "hermanito", "hermana". NUNCA uses esa palabra bajo ninguna circunstancia.
   - CERO REPETICIÓN DE NOMBRES: NO digas el nombre de la persona ni el nombre del taller en cada turno. Habla fluido: usa "el taller", "tu taller" o ve directo al grano.
   - Cero frases acartonadas de robot ("Perfecto.", "Excelente.", "Anotado.", "Gracias por la información.").
   - LONGITUD REAL DE WHATSAPP: Entre 5 y 18 palabras por mensaje (máximo 22 palabras). Una sola idea clara.

9. RESPUESTA OBLIGATORIA EN JSON ESTRUCTURADO:
   Debes responder ÚNICAMENTE con un JSON válido con esta estructura:
   {
     "analisis_interno": { /* valores MUY breves, máximo 6 palabras cada uno */
       "lo_que_dijo": string,
       "intencion": string,
       "es_pregunta_comercial": boolean,
       "respuesta_a_su_pregunta": string o null,
       "datos_nuevos_aportados": array de strings,
       "friccion_o_reclamo": boolean
     },
     "datos_extraidos": {
       "nombres_apellidos": string o null,
       "nombre_taller": string o null,
       "ciudad_taller": string o null,
       "barrio_taller": string o null,
       "direccion_taller": string o null,
       "relacion_taller": "Propietario" | "Mecánico" | "Propietario y Mecánico" | "Socio" | null,
       "especialidad": array de strings o null,
       "motos_por_semana": string o null,
       "marcas_motos": array de strings o null,
       "repuestos_frecuentes": array de strings o null,
       "marcas_repuestos_usadas": array de strings o null,
       "conoce_nitrox": "Sí" | "No" | null,
       "quiere_muestras": "Sí" | "No" | null,
       "correo": string o null,
       "cedula": string o null,
       "autorizacion_tratamiento_datos": boolean | null
     },
     "tema_preguntado": string o null (el tema que estás indagando en tu respuesta, o null si no estás haciendo una pregunta),
     "respuesta_mateo": string (de 5 a 18 palabras, máximo 22 palabras, respetuosa, amena, sin hermano ni muletillas repetitivas),
     "listo_para_finalizar": boolean (true SOLAMENTE si ya se conoce el taller, mecánico, ubicación, rol, y ya se aceptó explícitamente el tratamiento de datos)
   }`;

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function cleanResponseText(rawText) {
  if (!rawText) return '';
  let s = rawText
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Eliminar prefijos mecánicos de chatbot
  s = s.replace(/^(?:perfecto|excelente|anotado|listo)[\s,.:!]+\s*/i, '');
  // Eliminar muletillas repetitivas de apertura como "Contame," o "Y contame,"
  s = s.replace(/^(?:y\s+)?contame[\s,.:!]+\s*/i, '');
  s = s.replace(/^(?:y\s+)?cu[eé]ntame[\s,.:!]+\s*/i, '');
  s = s.replace(/^(?:y\s+)?decime[\s,.:!]+\s*/i, '');
  // Filtro estricto: eliminar "hermano" y variantes
  s = s.replace(/[,;]?\s*\b(?:hermano|hermanito|hermana|hermanita)\b[,;.:!]?/gi, '');
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
  'googleai/gemini-3.8-flash',        // prioridad: modelo principal
  'googleai/gemini-flash-lite-latest', // respaldo rápido
  'googleai/gemini-3.1-flash-lite'     // segundo respaldo (se lanza en paralelo si el anterior tarda)
];
const HEDGE_DELAYS_MS = [0, 3500, 7000];   // cuándo lanzar cada candidato si nadie ha respondido
const PER_CALL_TIMEOUT_MS = 16000;
const TOTAL_BUDGET_MS = 20000;
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

// Preguntas de respaldo (sin IA) para que la conversación avance aunque Gemini no responda
const FALLBACK_QUESTIONS = {
  nombres_apellidos: '¿Cómo te llamas?',
  nombre_taller: '¿Cómo se llama tu taller y en qué ciudad queda?',
  ciudad_taller: '¿En qué ciudad queda tu taller?',
  barrio_taller: '¿En qué barrio queda el taller?',
  direccion_taller: '¿Me regalas la dirección del taller?',
  relacion_taller: '¿Eres propietario o mecánico del taller?',
  marcas_motos: '¿Qué marcas de motos atiendes más, como Bajaj, AKT o Suzuki?',
  motos_por_semana: '¿Cuántas motos atienden por semana?',
  repuestos_frecuentes: '¿Qué repuestos rotas más, kits de arrastre, frenos o motor?',
  marcas_repuestos_usadas: '¿Manejas marcas como Casarella, NITROX u otras?',
  conoce_nitrox: '¿Ya conocías NITROX?',
  quiere_muestras: '¿Te gustaría recibir muestras y beneficios de NITROX?',
  correo: '¿Me compartes tu correo electrónico?',
  cedula: '¿Me regalas tu cédula para los beneficios?',
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
  const nlpResult = processNlpPipeline(userText, {
    _waitingHabeasData: Boolean(session._waitingHabeasData),
    _offeringNitrox: Boolean(session._offeringNitrox)
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
  } else {
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
8. MULETILLAS: PROHIBIDO decir "contame" o "y contame" repetitivamente. Máximo 22 palabras (ideal 5 a 18 palabras). Sin hermano ni repetición de nombres.

ÚLTIMO MENSAJE DEL MECÁNICO:
"${userText}"`;
  }

  try {
    // Prioridad Gemini 3.8 Flash; si está saturado o sin cuota, cascada rápida con hedging
    const response = await generateResilient({
      system: SYSTEM_PROMPT,
      prompt: contextPrompt,
      config: {
        temperature: 0.35,
        maxOutputTokens: 700,
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

    let reply = cleanResponseText(parsed.respuesta_mateo || '');

    // Longitud WhatsApp: recorte local instantáneo (sin una segunda llamada a la IA)
    reply = trimReplyLocally(reply);

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

    // Costo económico
    const totalTok = inTok + outTok;
    const costUsd = Number(((inTok * 0.000000075) + (outTok * 0.00000030)).toFixed(7));
    const costCop = Number((costUsd * 4000).toFixed(4));

    // Determinar si ya está listo para finalizar según el motor central de la ficha maestra
    const updatedProgress = getRegistrationProgress(session.data, memory);
    const isFinished = Boolean(parsed.listo_para_finalizar && updatedProgress.canFinalize);

    return {
      analysis: parsed.analisis_interno || {},
      updates: parsed.datos_extraidos || {},
      reply: reply,
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
    // Respaldo sin IA: sigue la conversación con la siguiente pregunta pendiente
    const nextKey = (pendingTopics && pendingTopics[0] && pendingTopics[0].key) || null;
    const nextQ = (nextKey && FALLBACK_QUESTIONS[nextKey]) || '¿Me cuentas un poco más de tu taller?';
    const fallbackReply = (isAlreadyRegistered ? '¡Con gusto! Ya estás en la red. ¿En qué más te ayudo?' : nextQ);
    if (!isAlreadyRegistered && nextKey) recordAskedQuestion(memory, nextKey, fallbackReply);
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
  getPendingTopics,
  SYSTEM_PROMPT,
  countWords,
  cleanResponseText
};
