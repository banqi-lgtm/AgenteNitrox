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

const SYSTEM_PROMPT = `Eres MATEO, asesor comercial y técnico de RED NITROX en Colombia.
Tu misión es conversar con mecánicos y dueños de talleres de motos por WhatsApp como un asesor real: cercano, espontáneo, profesional y atento.
Tu objetivo es conocer su taller, resolver sus dudas comerciales sobre repuestos, y cuando sea oportuno, completar su vinculación oficial a la RED NITROX para que reciban catálogo, muestras de repuestos y capacitaciones técnicas.

REGLAS CONVERSACIONALES SUPREMAS (OBLIGATORIAS):

1. REGLA ABSOLUTA: NUNCA PREGUNTAR DOS VECES LO MISMO
   - Si el mecánico ya te dijo un dato (en este mensaje, en los anteriores o ya está confirmado en la memoria), QUEDA TERMINANTEMENTE PROHIBIDO volver a preguntarlo.
   - Si un dato se respondió indirectamente (ej. "somos dos mecánicos", "cambio bastantes kits y pastillas", "llegan como 15 motos"), asúmelo y avanza.
   - Si el usuario dice "ya te dije", "ya respondí" o protesta: discúlpate con cortesía paisa, toma nota del dato y continúa sin repetir.
   - Si el usuario dice que no tiene correo o prefiere no dar la cédula: respeta su decisión, NO insistas y no vuelvas a pedirlo.

2. CONVERSAR, NO ENTREVISTAR:
   - Conversar NO significa rematar cada mensaje con una pregunta.
   - Alterna con naturalidad: reconoce lo que te cuenta, aporta información de valor sobre repuestos y talleres, y deja espacio libre.
   - Si el usuario te hace una pregunta comercial o técnica (ej. "¿quiénes son?", "¿tienen pastillas para una NKD?", "¿cuánto cuesta?"):
     RESPONDE PRIMERO A SU PREGUNTA con claridad y amabilidad antes de cualquier trámite.

3. ESTILO Y PERSONALIDAD (ASESOR COMERCIAL COLOMBIANO):
   - Tono amigable, un poco informal pero con respeto profesional ("de una", "claro que sí", "con gusto", "contame", "hágale", "qué bueno").
   - PROHIBIDO DECIR "hermano", "hermanito", "hermana". NUNCA uses esa palabra bajo ninguna circunstancia.
   - CERO REPETICIÓN DE NOMBRES: NO digas el nombre de la persona ni el nombre del taller en cada turno. Habla fluido: usa "el taller", "tu taller" o ve directo al grano.
   - Cero frases acartonadas de robot ("Perfecto.", "Excelente.", "Anotado.", "Gracias por la información.").
   - LONGITUD REAL DE WHATSAPP: Entre 5 y 18 palabras por mensaje (máximo 22 palabras). Una sola idea clara.

4. SEPARACIÓN ESTRICTA DE INTERÉS VS. AUTORIZACIÓN LEGAL DE DATOS:
   - Si el mecánico dice "me interesan las muestras" o "quiero conocer el catálogo", registra su interés comercial, pero NO asumas que ya autorizó el tratamiento legal de datos.
   - La autorización de Habeas Data debe preguntarse explícitamente antes de cerrar la vinculación.

5. RESPUESTA OBLIGATORIA EN JSON ESTRUCTURADO:
   Debes responder ÚNICAMENTE con un JSON válido con esta estructura:
   {
     "analisis_interno": {
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
     "respuesta_mateo": string (de 5 a 18 palabras, máximo 22 palabras, respetuosa, amena, sin hermano ni nombres repetitivos),
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
  // Filtro estricto: eliminar "hermano" y variantes
  s = s.replace(/[,;]?\s*\b(?:hermano|hermanito|hermana|hermanita)\b[,;.:!]?/gi, '');
  // Corregir espacios y signos dobles
  s = s.replace(/\s+([,.:!?])/g, '$1');
  s = s.replace(/([,.:!?]){2,}/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';
}

/**
 * Calcula los temas de vinculación aún pendientes consultando la memoria semántica.
 * Si un dato ya está confirmado o fue rechazado, NUNCA aparece como pendiente.
 */
function getPendingTopics(memory) {
  const confirmed = memory.confirmedFacts || {};
  const rejected = memory.rejectedFields || {};

  // Si ya está finalizado oficialmente con carnet y registro completado, cero temas pendientes
  if (confirmed._finished?.value === true && confirmed.id_unico?.value) {
    return [];
  }

  const pending = [];

  if (!confirmed.nombres_apellidos?.value) {
    pending.push('Nombre del mecánico');
  }

  if (!confirmed.nombre_taller?.value) {
    pending.push('Nombre del taller de motos');
  }

  const hasLocation = Boolean(
    confirmed.ciudad_taller?.value ||
    confirmed.barrio_taller?.value ||
    confirmed.direccion_taller?.value
  );
  if (!hasLocation) {
    pending.push('Ubicación (barrio o municipio)');
  }

  if (!confirmed.relacion_taller?.value) {
    pending.push('Rol en el taller (dueño, mecánico o ambos)');
  }

  if (!confirmed.especialidad?.value || (Array.isArray(confirmed.especialidad.value) && confirmed.especialidad.value.length === 0)) {
    pending.push('Especialidad técnica del taller');
  }

  if (!confirmed.motos_por_semana?.value) {
    pending.push('Flujo o volumen de motos atendidas');
  }

  if (!confirmed.marcas_motos?.value || (Array.isArray(confirmed.marcas_motos.value) && confirmed.marcas_motos.value.length === 0)) {
    pending.push('Marcas de motos atendidas');
  }

  if (!confirmed.repuestos_frecuentes?.value || (Array.isArray(confirmed.repuestos_frecuentes.value) && confirmed.repuestos_frecuentes.value.length === 0)) {
    pending.push('Repuestos que cambian con mayor frecuencia');
  }

  if (!confirmed.marcas_repuestos_usadas?.value && !confirmed.criterio_compra?.value) {
    pending.push('Marcas de repuestos que recomiendan o criterio de compra');
  }

  if (!confirmed.conoce_nitrox?.value && !confirmed.quiere_muestras?.value) {
    pending.push('Interés en conocer repuestos NITROX, muestras gratis y catálogo');
  }

  // Datos de contacto (respetando si fueron rechazados)
  const contactResolved = Boolean(
    confirmed.correo?.value ||
    confirmed.cedula?.value ||
    (rejected.correo && rejected.cedula)
  );
  if (!contactResolved) {
    pending.push('Datos para envío de catálogo y muestras (correo y cédula o NIT)');
  }

  if (confirmed.autorizacion_tratamiento_datos?.value === undefined) {
    pending.push('Autorización explícita de tratamiento de datos (Habeas Data)');
  }

  return pending;
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

  const isAlreadyRegistered = Boolean(session.data._finished === true && session.data.id_unico);
  const pendingTopics = getPendingTopics(memory);
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

ANÁLISIS LINGÜÍSTICO (NLP):
- Mensaje normalizado: "${nlpResult.normalizedText}"
- Expresiones clave detectadas: ${JSON.stringify(nlpResult.multiWords)}
- Entidades semánticas extraídas en este mensaje: ${JSON.stringify(nlpResult.entities)}

TEMAS AÚN PENDIENTES POR CONOCER (EN ORDEN):
${pendingTopics.length > 0 ? pendingTopics.map((t, idx) => `${idx + 1}. ${t}`).join('\n') : '(Todos los temas esenciales están resueltos)'}

INSTRUCCIONES CLAVE PARA ESTE TURNO:
1. SI EL MECÁNICO HIZO UNA PREGUNTA O CONSULTA COMERCIAL (ej. quiénes son, repuestos para NKD, precios):
   - RESPÓNDELE PRIMERO A SU DUDA con total claridad, calidez y conocimiento. NO saltes de una vez a pedirle datos.
2. SI EL MECÁNICO ACABA DE COMPARTIR VARIOS DATOS (ej. marcas, volumen, repuestos):
   - Reconoce amablemente lo que te contó ("¡Qué bueno!", "Ah, de una").
   - NUNCA vuelvas a preguntar sobre ninguno de esos datos.
3. SI EL MECÁNICO MANIFESTÓ RECHAZO A DAR UN DATO (ej. cédula o correo):
   - Tranquilízalo con cortesía, dile que no hay lío y continúa sin presionar.
4. SI EL MECÁNICO EXPRESÓ INTERÉS EN MUESTRAS O CATÁLOGO:
   - Registra su interés comercial ("quiere_muestras": "Sí"), pero RECUERDA: esto NO es autorización de Habeas Data todavía.
5. NO ES OBLIGATORIO PREGUNTAR EN CADA MENSAJE. Si acabas de responder una duda o comentar, puedes cerrar amablemente sin pregunta si no es necesario.
6. MÁXIMO 22 PALABRAS (ideal 5 a 18 palabras). Sin hermano ni repetición de nombres.

ÚLTIMO MENSAJE DEL MECÁNICO:
"${userText}"`;
  }

  try {
    const response = await ai.generate({
      system: SYSTEM_PROMPT,
      prompt: contextPrompt,
      config: {
        temperature: 0.35,
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

    // Refinamiento de longitud estricta si excede el rango WhatsApp
    const wc = countWords(reply);
    if (wc > 25 || wc < 3) {
      const refinePrompt = `Acorta y pule esta respuesta de Mateo para que suene 100% natural, amena, paisa y tenga entre 5 y 18 palabras estrictas. Responde únicamente con el texto final pulido:\n"${reply}"`;
      const refined = await ai.generate({
        prompt: refinePrompt,
        config: { temperature: 0.2 }
      });
      const refinedUsage = refined.usage || {};
      inTok += refinedUsage.inputTokens || Math.round(refinePrompt.length / 4);
      outTok += refinedUsage.outputTokens || Math.round((refined.text || '').length / 4);
      const refinedText = cleanResponseText(refined.text);
      if (refinedText && countWords(refinedText) <= 25) {
        reply = refinedText;
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

    // Costo económico
    const totalTok = inTok + outTok;
    const costUsd = Number(((inTok * 0.000000075) + (outTok * 0.00000030)).toFixed(7));
    const costCop = Number((costUsd * 4000).toFixed(4));

    // Determinar si ya está listo para finalizar (requiere taller, nombre, ubicación, rol y autorización de datos respondida)
    const hasRequired = Boolean(
      memory.confirmedFacts['nombres_apellidos']?.value &&
      memory.confirmedFacts['nombre_taller']?.value &&
      (memory.confirmedFacts['ciudad_taller']?.value || memory.confirmedFacts['barrio_taller']?.value || memory.confirmedFacts['direccion_taller']?.value) &&
      memory.confirmedFacts['relacion_taller']?.value &&
      memory.confirmedFacts['autorizacion_tratamiento_datos']?.value !== undefined &&
      pendingTopics.length <= 1
    );
    const isFinished = Boolean(parsed.listo_para_finalizar && hasRequired);

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
    console.error('[GEMINI BRAIN ERROR]:', err);
    return {
      analysis: { error: err.message },
      updates: {},
      reply: '¡Qué pena que se me cayó un segundo la señal! Contame, ¿en qué íbamos?',
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
  getPendingTopics,
  SYSTEM_PROMPT,
  countWords,
  cleanResponseText
};
