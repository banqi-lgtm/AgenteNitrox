// conversation_memory.js - Memoria Conversacional Persistente y Control Anti-Repetición
// MATEO — RED NITROX Colombia

/**
 * Mapa de temas conversacionales y patrones de preguntas semánticamente equivalentes.
 */
const TOPIC_SEMANTIC_PATTERNS = {
  nombres_apellidos: {
    topic: 'Nombre del mecánico',
    patterns: [
      /c[oó]mo\s+te\s+llamas/i,
      /cu[aá]l\s+es\s+tu\s+nombre/i,
      /con\s+qui[eé]n\s+tengo\s+el\s+gusto/i,
      /c[oó]mo\s+es\s+tu\s+nombre/i,
      /tu\s+nombre/i
    ]
  },
  nombre_taller: {
    topic: 'Nombre del taller',
    patterns: [
      /c[oó]mo\s+se\s+llama\s+el\s+taller/i,
      /nombre\s+del\s+taller/i,
      /cu[aá]l\s+es\s+el\s+nombre\s+de\s+tu\s+taller/i,
      /tu\s+taller\s+c[oó]mo\s+se\s+llama/i
    ]
  },
  ciudad_taller: {
    topic: 'Ciudad o municipio del taller',
    patterns: [
      /en\s+qu[eé]\s+ciudad/i,
      /en\s+qu[eé]\s+municipio/i,
      /d[oó]nde\s+queda\s+el\s+taller/i,
      /d[oó]nde\s+est[aá]n\s+ubicados/i,
      /d[oó]nde\s+tienen\s+el\s+taller/i
    ]
  },
  barrio_taller: {
    topic: 'Barrio o ubicación detallada',
    patterns: [
      /en\s+qu[eé]\s+barrio/i,
      /por\s+qu[eé]\s+sector/i,
      /direcci[oó]n\s+del\s+taller/i,
      /por\s+d[oó]nde\s+est[aá]n/i
    ]
  },
  relacion_taller: {
    topic: 'Rol en el taller (dueño / mecánico)',
    patterns: [
      /el\s+taller\s+es\s+tuyo/i,
      /trabajas\s+con\s+alguien\s+m[aá]s/i,
      /eres\s+el\s+due[ñn]o/i,
      /eres\s+propietario/i,
      /tu\s+rol\s+en\s+el\s+taller/i,
      /due[ñn]o\s+o\s+mec[aá]nico/i
    ]
  },
  marcas_motos: {
    topic: 'Marcas de motocicletas atendidas',
    patterns: [
      /qu[eé]\s+marcas\s+de\s+motos/i,
      /con\s+cu[aá]les\s+marcas/i,
      /con\s+qu[eé]\s+marcas\s+trabajas/i,
      /qu[eé]\s+marcas\s+atiendes/i,
      /qu[eé]\s+motos\s+te\s+llegan\s+m[aá]s/i,
      /marcas\s+que\s+m[aá]s\s+reciben/i
    ]
  },
  motos_por_semana: {
    topic: 'Volumen y flujo de motos',
    patterns: [
      /cu[aá]ntas\s+motos/i,
      /qu[eé]\s+volumen\s+de\s+motos/i,
      /motos\s+por\s+semana/i,
      /motos\s+al\s+d[ií]a/i,
      /cu[aá]ntas\s+motos\s+atiendes/i,
      /cu[aá]ntas\s+motos\s+te\s+llegan/i
    ]
  },
  repuestos_frecuentes: {
    topic: 'Repuestos de mayor rotación',
    patterns: [
      /qu[eé]\s+repuestos\s+cambias/i,
      /qu[eé]\s+repuestos\s+compras/i,
      /qu[eé]\s+repuestos\s+te\s+piden\s+m[aá]s/i,
      /repuestos\s+que\s+m[aá]s\s+mueves/i,
      /qu[eé]\s+repuestos\s+se\s+cambian\s+m[aá]s/i
    ]
  },
  especialidad: {
    topic: 'Especialidad técnica del taller',
    patterns: [
      /qu[eé]\s+tipo\s+de\s+trabajo\s+hacen/i,
      /en\s+qu[eé]\s+se\s+especializan/i,
      /cu[aá]l\s+es\s+la\s+especialidad/i,
      /hacen\s+motor\s+o\s+de\s+todo/i
    ]
  },
  direccion_taller: {
    topic: 'Dirección o referencia del taller',
    patterns: [
      /direcci[oó]n/i,
      /carrera|calle|cra|cll|transversal|diagonal/i,
      /en\s+qu[eé]\s+direcci[oó]n/i,
      /por\s+cu[aá]l\s+calle/i
    ]
  },
  marcas_repuestos_usadas: {
    topic: 'Marcas de repuestos que recomienda o utiliza',
    patterns: [
      /recomiendas\s+alguna\s+marca/i,
      /qu[eé]\s+marcas?\s+de\s+repuestos/i,
      /como\s+casarella/i,
      /marcas\s+como\s+casarella/i,
      /repuestos\s+recomiendas/i
    ]
  },
  conoce_nitrox: {
    topic: 'Conocimiento de la marca NITROX',
    patterns: [
      /conoces\s+(?:la\s+marca\s+)?nitrox/i,
      /has\s+escuchado\s+(?:hablar\s+)?de\s+nitrox/i,
      /conoces\s+a\s+nitrox/i
    ]
  },
  quiere_muestras: {
    topic: 'Interés en recomendar NITROX y recibir muestras',
    patterns: [
      /recomendar\s+nitrox/i,
      /ganar\s+(?:muchos\s+)?premios/i,
      /recibir\s+(?:las\s+)?muestras/i,
      /muestras\s+oficiales/i,
      /premios\s+y\s+beneficios/i
    ]
  },
  correo_y_cedula: {
    topic: 'Datos para envío de beneficios (correo y cédula)',
    patterns: [
      /correo\s+electr[oó]nico/i,
      /c[eé]dula\s+o\s+nit/i,
      /un\s+correo\s+y/i,
      /para\s+enviarte\s+los\s+beneficios/i
    ]
  },
  habeas_data: {
    topic: 'Autorización legal de tratamiento de datos',
    patterns: [
      /tratamiento\s+de\s+datos/i,
      /autorizas/i,
      /habeas\s+data/i,
      /pol[ií]tica\s+de\s+privacidad/i,
      /autorizas\s+el\s+registro/i
    ]
  }
};

/**
 * Inicializa o carga la estructura de memoria en la sesión.
 */
function initOrLoadMemory(session) {
  session.memory = session.memory || {
    // 1. Datos confirmados y validados (con origen, timestamp y confianza)
    confirmedFacts: {},
    // 2. Datos ambiguos que requieran clarificación
    ambiguousData: {},
    // 3. Contradicciones detectadas (cuando el usuario cambia un dato ya confirmado)
    contradictoryData: {},
    // 4. Preguntas formuladas por Mateo en la conversación
    askedQuestions: [],
    // 5. Preguntas del usuario o del bot ya respondidas
    answeredQuestions: [],
    // 6. Temas comerciales y de registro ya abordados
    topicsCovered: [],
    // 7. Intereses comerciales manifestados por el mecánico
    commercialInterests: [],
    // 8. Información de la empresa compartida con el usuario
    commercialInfoShared: [],
    // 9. Compromisos pendientes (ej. "revisar referencia para NKD")
    pendingCommitments: [],
    // 10. Campos rechazados explícitamente por el usuario (NUNCA VOLVER A PREGUNTAR)
    rejectedFields: {},
    // Resumen dinámico y cronológico de la conversación
    conversationSummary: ''
  };

  // Sincronizar datos planos previos si existen en session.data
  const currentData = session.data || {};
  for (const [key, val] of Object.entries(currentData)) {
    if (val !== null && val !== undefined && val !== '' && !session.memory.confirmedFacts[key]) {
      if (Array.isArray(val) && val.length === 0) continue;
      session.memory.confirmedFacts[key] = {
        value: val,
        timestamp: Date.now(),
        source: 'preexistente',
        confidence: 'ALTA'
      };
      if (!session.memory.topicsCovered.includes(key)) {
        session.memory.topicsCovered.push(key);
      }
    }
  }

  return session.memory;
}

/**
 * Comprueba si un tema o una pregunta ya ha sido preguntada o si el dato ya está confirmado.
 * Regla de Oro: ¡NUNCA PREGUNTAR DOS VECES LO MISMO!
 */
function isTopicOrQuestionForbidden(memory, topicKey, proposedQuestionText = '') {
  if (!memory) return false;

  // 1. ¿El dato ya está confirmado en la memoria?
  if (memory.confirmedFacts[topicKey]) {
    const val = memory.confirmedFacts[topicKey].value;
    if (val !== null && val !== undefined && val !== '') {
      if (!Array.isArray(val) || val.length > 0) {
        return {
          forbidden: true,
          reason: `El dato "${topicKey}" ya está confirmado con el valor: ${JSON.stringify(val)}`
        };
      }
    }
  }

  // 2. ¿El usuario ya rechazó explícitamente dar ese dato?
  if (memory.rejectedFields[topicKey]) {
    return {
      forbidden: true,
      reason: `El usuario ya rechazó dar "${topicKey}": ${memory.rejectedFields[topicKey].reason}`
    };
  }

  // 3. ¿El tema ya fue cubierto y cerrado en la conversación?
  if (memory.topicsCovered.includes(topicKey)) {
    return {
      forbidden: true,
      reason: `El tema "${topicKey}" ya fue abordado en la conversación.`
    };
  }

  // 4. ¿La pregunta propuesta es semánticamente equivalente a una ya realizada?
  if (proposedQuestionText) {
    const cleanProposed = proposedQuestionText.trim().toLowerCase();

    // Verificación contra la tabla semántica
    const semanticDef = TOPIC_SEMANTIC_PATTERNS[topicKey];
    if (semanticDef) {
      for (const pattern of semanticDef.patterns) {
        if (pattern.test(cleanProposed)) {
          // Si ya se hizo alguna pregunta sobre este topicKey en askedQuestions
          const alreadyAsked = memory.askedQuestions.some(q => q.topicKey === topicKey);
          if (alreadyAsked) {
            return {
              forbidden: true,
              reason: `Pregunta semánticamente equivalente sobre "${topicKey}" ya fue formulada previamente.`
            };
          }
        }
      }
    }

    // Verificación literal y de similitud básica contra askedQuestions
    for (const q of memory.askedQuestions) {
      if (q.questionText && cleanProposed.includes(q.questionText.toLowerCase().slice(0, 20))) {
        return {
          forbidden: true,
          reason: `Pregunta similar ya registrada: "${q.questionText}"`
        };
      }
    }
  }

  return { forbidden: false };
}

/**
 * Fusiona los hechos extraídos por NLP en la memoria persistente.
 * Detecta contradicciones en lugar de sobreescribir silenciosamente.
 */
function integrateFactsIntoMemory(memory, extractedEntities, userText = '') {
  if (!memory || !extractedEntities) return;

  const now = Date.now();

  // 1. Integrar rechazos explícitos de datos
  if (extractedEntities.rechazo_dato && typeof extractedEntities.rechazo_dato === 'object') {
    for (const [field, reason] of Object.entries(extractedEntities.rechazo_dato)) {
      memory.rejectedFields[field] = {
        reason: reason,
        timestamp: now
      };
      if (!memory.topicsCovered.includes(field)) {
        memory.topicsCovered.push(field);
      }
    }
  }

  // 2. Integrar consultas comerciales y compromisos
  if (extractedEntities.es_pregunta_comercial && extractedEntities.pregunta_comercial_tema) {
    memory.pendingCommitments.push({
      tema: extractedEntities.pregunta_comercial_tema,
      consulta: userText,
      timestamp: now,
      atendida: false
    });
  }

  // 3. Mapeo de entidades extraídas a hechos confirmados
  const fieldMapping = [
    'ciudad_taller',
    'barrio_taller',
    'direccion_taller',
    'nombres_apellidos',
    'nombre_taller',
    'relacion_taller',
    'equipo_taller',
    'especialidad',
    'motos_por_semana',
    'marcas_motos',
    'repuestos_frecuentes',
    'marcas_repuestos_usadas',
    'criterio_compra',
    'conoce_nitrox',
    'quiere_muestras',
    'correo',
    'cedula'
  ];

  for (const field of fieldMapping) {
    const newVal = extractedEntities[field];
    if (newVal !== null && newVal !== undefined && newVal !== '') {
      if (Array.isArray(newVal) && newVal.length === 0) continue;

      // Comprobar si ya existía un valor confirmado
      const existing = memory.confirmedFacts[field];
      if (existing && existing.value) {
        // Detectar si hay contradicción real (ej. cambio de ciudad de "Medellín" a "Bello")
        const isDifferent = JSON.stringify(existing.value) !== JSON.stringify(newVal);
        if (isDifferent) {
          memory.contradictoryData[field] = {
            previousValue: existing.value,
            newValue: newVal,
            detectedAt: now
          };
          // Se actualiza con el nuevo valor pero dejando registro de la corrección
          memory.confirmedFacts[field] = {
            value: newVal,
            timestamp: now,
            source: 'correccion_usuario',
            confidence: 'ALTA'
          };
        }
      } else {
        // Nuevo hecho confirmado
        memory.confirmedFacts[field] = {
          value: newVal,
          timestamp: now,
          source: 'mensaje_usuario',
          confidence: 'ALTA'
        };
      }

      if (!memory.topicsCovered.includes(field)) {
        memory.topicsCovered.push(field);
      }
    }
  }

  // 4. Si hubo aceptación de Habeas Data
  if (extractedEntities.autorizacion_habeas_data !== null && extractedEntities.autorizacion_habeas_data !== undefined) {
    memory.confirmedFacts['autorizacion_tratamiento_datos'] = {
      value: extractedEntities.autorizacion_habeas_data,
      timestamp: now,
      source: 'respuesta_habeas_data',
      confidence: 'ALTA'
    };
    if (!memory.topicsCovered.includes('habeas_data')) {
      memory.topicsCovered.push('habeas_data');
    }
  }

  // 5. Interés comercial
  if (extractedEntities.quiere_muestras === 'Sí' || extractedEntities.interes_comercial_detalles) {
    memory.commercialInterests.push({
      detalle: extractedEntities.interes_comercial_detalles || 'Interés en muestras/catálogo',
      timestamp: now
    });
  }
}

/**
 * Registra una pregunta realizada por Mateo para evitar repetición futura.
 */
function recordAskedQuestion(memory, topicKey, questionText) {
  if (!memory || !questionText) return;

  const entry = {
    topicKey: topicKey || 'general',
    questionText: questionText.trim(),
    timestamp: Date.now()
  };

  memory.askedQuestions.push(entry);
}

/**
 * Genera un resumen conversacional conciso para incluir en el prompt de Gemini.
 */
function buildConversationSummary(memory) {
  if (!memory) return 'Sin resumen previo.';

  const facts = [];
  for (const [k, v] of Object.entries(memory.confirmedFacts)) {
    facts.push(`${k}: ${JSON.stringify(v.value)}`);
  }

  const rejected = [];
  for (const [k, v] of Object.entries(memory.rejectedFields)) {
    rejected.push(`${k} (${v.reason})`);
  }

  let summary = `HECHOS YA CONFIRMADOS:\n${facts.length > 0 ? facts.join('\n') : 'Ninguno todavía.'}\n\n`;

  if (rejected.length > 0) {
    summary += `CAMPOS NO DISPONIBLES O RECHAZADOS (PROHIBIDO PREGUNTAR):\n${rejected.join('\n')}\n\n`;
  }

  if (memory.askedQuestions.length > 0) {
    summary += `PREGUNTAS YA FORMULADAS (PROHIBIDO REPETIR):\n${memory.askedQuestions.map(q => `- [${q.topicKey}] ${q.questionText}`).join('\n')}\n\n`;
  }

  if (memory.pendingCommitments.length > 0) {
    const unhandled = memory.pendingCommitments.filter(c => !c.atendida);
    if (unhandled.length > 0) {
      summary += `CONSULTAS O DUDAS PENDIENTES DEL USUARIO:\n${unhandled.map(c => `- ${c.consulta}`).join('\n')}\n\n`;
    }
  }

  return summary;
}

module.exports = {
  TOPIC_SEMANTIC_PATTERNS,
  initOrLoadMemory,
  isTopicOrQuestionForbidden,
  integrateFactsIntoMemory,
  recordAskedQuestion,
  buildConversationSummary
};
