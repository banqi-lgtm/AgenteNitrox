// nlp_pipeline.js - Procesamiento de Lenguaje Natural en Español para MATEO (RED NITROX Colombia)
// Etapas:
// A. Normalización (expansión de modismos y abreviaciones WhatsApp sin alterar significado original)
// B. Tokenización (unidades léxicas y expresiones multipalabra)
// C. Lematización contextual (diferenciación sustantivo vs. verbo, mapeo a lemas estándar)
// D. Extracción Semántica (ciudades, marcas, repuestos, volumen, roles, consultas comerciales, negaciones)

/**
 * Normaliza el texto de WhatsApp tolerando informalidad y abreviaciones colombianas
 * Mantiene intacto el mensaje original para referencias posteriores.
 */
function normalizeText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { original: '', normalized: '' };
  }

  const original = rawText.trim();
  let text = original;

  // 1. Limpieza de caracteres de control y normalización de espacios
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  // 2. Diccionario de abreviaturas y modismos frecuentes en WhatsApp Colombia
  const abbreviations = [
    // Saludos con typos o jerga
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:hols|holi|holis|ola|oola)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'hola' },
    // Preposiciones y conjunciones (con límites Unicode para no afectar palabras con tildes)
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:q|ke)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'que' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:xq|pq|xk)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'por qué' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:d)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'de' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:tb|tbn|tmb)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'también' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:pa)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'para' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:ala)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'a la' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:dnd|x dnd)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'dónde' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:porfa|xfa|xfav)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'por favor' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:uds|ustes)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'ustedes' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:ps)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'pues' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:bn)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'bien' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:pto)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'punto' },
    // Términos mecánicos y repuestos abreviados
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:kt\s+d\s+arrastre|kit\s+d\s+arrastre|kit\s+arrastre)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'kit de arrastre' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:taller\s+d\s+motos)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'taller de motos' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:rep|repuests)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'repuestos' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:ptas|pastillitas)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'pastillas' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:inyecc)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'inyección' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:electr)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'electricidad' }
  ];

  for (const item of abbreviations) {
    text = text.replace(item.pattern, item.replacement);
  }

  // 3. Normalizar puntuación excesiva (ej. "???" -> "?", "!!!" -> "!")
  text = text.replace(/([?!.,;:]){2,}/g, '$1');
  text = text.replace(/\s+([,.:!?])/g, '$1');

  return {
    original: original,
    normalized: text
  };
}

/**
 * Tokeniza el texto reconociendo palabras individuales y frases compuestas de alto valor semántico.
 */
function tokenize(text) {
  if (!text) return [];

  // Expresiones multipalabra prioritarias del dominio motero / comercial
  const multiWordExpressions = [
    'kit de arrastre',
    'pastillas de freno',
    'inyección electrónica',
    'mecánica general',
    'alto cilindraje',
    'bajo cilindraje',
    'por semana',
    'al día',
    'a la semana',
    'al mes',
    'red nitrox',
    'muestras gratis',
    'tratamiento de datos',
    'propietario y mecánico',
    'dueño y mecánico'
  ];

  let workingText = text.toLowerCase();
  const detectedMultiWords = [];

  for (const mwe of multiWordExpressions) {
    if (workingText.includes(mwe)) {
      detectedMultiWords.push(mwe);
    }
  }

  // Separar tokens individuales
  const cleanForTokens = text.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'¡¿]/g, ' ');
  const rawTokens = cleanForTokens.split(/\s+/).filter(Boolean);

  return {
    rawTokens,
    multiWords: detectedMultiWords
  };
}

/**
 * Lematizador contextual en español.
 * Distingue explícitamente entre sustantivos y verbos según su contexto gramatical
 * (ej. "el trabajo" [sustantivo] vs. "trabajo con yamaha" [verbo]).
 */
function lemmatize(tokenInfo, fullText) {
  const { rawTokens } = tokenInfo;
  const lowerFull = (fullText || '').toLowerCase();

  // Diccionario morfológico de formas verbales
  const verbMap = {
    // trabajar
    'trabajo': 'trabajar',
    'trabajas': 'trabajar',
    'trabaja': 'trabajar',
    'trabajamos': 'trabajar',
    'trabajan': 'trabajar',
    'trabajando': 'trabajar',
    'trabajé': 'trabajar',
    // cambiar
    'cambio': 'cambiar',
    'cambias': 'cambiar',
    'cambia': 'cambiar',
    'cambiamos': 'cambiar',
    'cambian': 'cambiar',
    'cambiando': 'cambiar',
    'cambié': 'cambiar',
    // atender
    'atiendo': 'atender',
    'atiendes': 'atender',
    'atiende': 'atender',
    'atendemos': 'atender',
    'atienden': 'atender',
    'atendiendo': 'atender',
    'atendí': 'atender',
    // reparar / arreglar
    'reparo': 'reparar',
    'repara': 'reparar',
    'reparamos': 'reparar',
    'reparan': 'reparar',
    'reparando': 'reparar',
    'arreglo': 'arreglar',
    'arreglas': 'arreglar',
    'arregla': 'arreglar',
    'arreglamos': 'arreglar',
    'arreglan': 'arreglar',
    'arreglando': 'arreglar',
    // comprar
    'compro': 'comprar',
    'compras': 'comprar',
    'compra': 'comprar',
    'compramos': 'comprar',
    'compran': 'comprar',
    'comprando': 'comprar',
    // recomendar
    'recomiendo': 'recomendar',
    'recomiendas': 'recomendar',
    'recomienda': 'recomendar',
    'recomendamos': 'recomendar',
    'recomiendan': 'recomendar',
    'recomendando': 'recomendar',
    // llegar
    'llego': 'llegar',
    'llega': 'llegar',
    'llegan': 'llegar',
    'llegamos': 'llegar',
    'llegando': 'llegar'
  };

  // Diccionario de formas plurales a singulares
  const nounPluralMap = {
    'repuestos': 'repuesto',
    'motos': 'moto',
    'motocicletas': 'motocicleta',
    'talleres': 'taller',
    'pastillas': 'pastilla',
    'bandas': 'banda',
    'discos': 'disco',
    'cadenas': 'cadena',
    'motores': 'motor',
    'cilindros': 'cilindro',
    'pistones': 'pistón',
    'válvulas': 'válvula',
    'valvulas': 'válvula',
    'rodamientos': 'rodamiento',
    'balineras': 'balinera',
    'llantas': 'llanta',
    'mecánicos': 'mecánico',
    'mecanicos': 'mecánico',
    'marcas': 'marca',
    'clientes': 'cliente',
    'muestras': 'muestra'
  };

  const lemmatizedTokens = rawTokens.map((token, idx) => {
    const lower = token.toLowerCase();

    // 1. Desambiguación contextual de "trabajo": ¿Sustantivo o Verbo?
    if (lower === 'trabajo') {
      const prevWord = idx > 0 ? rawTokens[idx - 1].toLowerCase() : '';
      if (['el', 'mi', 'su', 'nuestro', 'mucho', 'bastante', 'buen', 'un', 'este'].includes(prevWord) ||
          lowerFull.includes('bastante trabajo') || lowerFull.includes('mucho trabajo')) {
        return { token, lemma: 'trabajo', pos: 'sustantivo' };
      }
      return { token, lemma: 'trabajar', pos: 'verbo' };
    }

    // 2. Desambiguación contextual de "cambio": ¿Sustantivo o Verbo?
    if (lower === 'cambio') {
      const prevWord = idx > 0 ? rawTokens[idx - 1].toLowerCase() : '';
      if (['el', 'un', 'este', 'primer', 'segundo'].includes(prevWord) || lowerFull.includes('cambio de aceite')) {
        return { token, lemma: 'cambio', pos: 'sustantivo' };
      }
      return { token, lemma: 'cambiar', pos: 'verbo' };
    }

    // 3. Verbos conocidos
    if (verbMap[lower]) {
      return { token, lemma: verbMap[lower], pos: 'verbo' };
    }

    // 4. Plurales de sustantivos
    if (nounPluralMap[lower]) {
      return { token, lemma: nounPluralMap[lower], pos: 'sustantivo' };
    }

    return { token, lemma: lower, pos: 'desconocido' };
  });

  return lemmatizedTokens;
}

/**
 * Extracción Semántica de Entidades y Hechos desde el mensaje.
 * Extrae simultáneamente múltiples hechos independientes en el mismo turno.
 */
function extractSemanticEntities(text, sessionContext = {}) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase().replace(/[.,!¡?¿]+/g, ' ');
  const unaccented = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const extracted = {
    // Entidades clave
    ciudad_taller: null,
    barrio_taller: null,
    direccion_taller: null,
    nombres_apellidos: null,
    nombre_taller: null,
    relacion_taller: null,
    equipo_taller: null,
    especialidad: null,
    motos_por_semana: null,
    marcas_motos: null,
    repuestos_frecuentes: null,
    marcas_repuestos_usadas: null,
    criterio_compra: null,
    canal_compra: null,

    // Relación comercial e intereses
    frecuencia_recomendacion: null,
    quien_decide_repuesto: null,
    recomendaria_nitrox: null,
    conoce_nitrox: null,
    quiere_muestras: null,
    interes_comercial_detalles: null,

    // Datos de contacto y formalización
    celular_whatsapp: null,
    telefono_alterno: null,
    correo: null,
    cedula: null,

    // Señales conversacionales y de control
    intenciones_detectadas: [],
    es_saludo: false,
    es_despedida: false,
    es_pausa: false,
    despedida_con_pregunta: false,
    no_tiene_taller: false,
    es_pregunta_comercial: false,
    pregunta_comercial_tema: null,
    intencion_compra: false,
    intencion_cotizacion: false,
    cotizacion_multiple: false,
    consulta_catalogo: false,
    consulta_compatibilidad: false,
    consulta_ubicacion: false,
    eleccion_flujo_compra: null, // 'solo_comprar' | 'seguir_formulario'
    repuesto_solicitado: null,
    repuestos_solicitados: [],
    moto_solicitada: null,
    ciudad_solicitada: null,
    barrio_solicitado: null,
    intencion_retomar_formulario: false,
    rechazo_registro: false,
    protesta_repeticion: false,
    rechazo_dato: {},
    situacion_salud_o_personal: false,
    rechazo_hostil: false,
    friccion_o_reclamo: false,
    autorizacion_habeas_data: null
  };

  // 1. PROTESTA POR REPETICIÓN (Regla: "Ya te dije", "Ya respondí", etc.)
  if (/(?:ya\s+(?:me\s+)?hab[ií]as|ya\s+te\s+(?:dije|respond[ií])|eso\s+ya|ya\s+lo\s+dije|ya\s+respond[ií]|pregunta\s+ya)/i.test(lower)) {
    extracted.protesta_repeticion = true;
  }

  // 2. RECHAZOS Y NEGATIVAS EXPLÍCITAS DE DATOS (Regla: "Prefiero no dar cédula", "no tengo correo")
  if (/no\s*(?:quiero|prefiero\s*no|doy|voy\s*a\s*dar)\s*(?:la\s*)?(?:c[eé]dula|cc|nit)/i.test(lower) ||
      /(?:prefiero\s*no\s*dar\s*la\s*c[eé]dula|sin\s*c[eé]dula)/i.test(lower)) {
    extracted.rechazo_dato.cedula = 'Rechazado expresamente por el usuario';
    extracted.cedula = 'No proporcionada (rechazada por el usuario)';
  }

  const isAskingEmail = sessionContext._lastQuestion === 'CORREO' || /correo/i.test(sessionContext.lastAssistantMessage || '');
  if (isAskingEmail && /^(?:no\s+tengo|no\s+uso|no\s+manejo|no\b)/i.test(lower)) {
    extracted.rechazo_dato.correo = 'No dispone o no usa correo';
    extracted.correo = 'No disponible / No usa';
  } else if (/(?:no\s*tengo\s*correo|no\s*uso\s*correo|no\s*manejo\s*correo|sin\s*correo)/i.test(lower)) {
    extracted.rechazo_dato.correo = 'No dispone o no usa correo';
    extracted.correo = 'No disponible / No usa';
  }

  // Detección de situaciones de salud, dolor o malestar físico personal
  if (/\b(?:duele\s+el\s+est[oó]mago|dolor\s+de\s+cabeza|enferm[oa]|dolor|hospital|m[eé]dico|maluca|maluco|me\s+siento\s+mal)\b/i.test(lower) || /:\(|😢|🤒/.test(raw)) {
    extracted.situacion_salud_o_personal = true;
  }

  // Detección de rechazo hostil o insultos en autorización / registro
  const isHostileHabeas = /\b(?:lo\s+autorizar[aá]\s+tu\s+madre|su\s+madre|tu\s+madre|no\s+autorizo\s+(?:un\s+carajo|nada|ni\s+mierda)|no\s+me\s+jod[a-z]*|v[aá]yase\s+a\s+la\s+mierda|coma\s+mierda)\b/i.test(lower) || /😡|🤬/.test(raw);
  if (isHostileHabeas) {
    extracted.autorizacion_tratamiento_datos = false;
    extracted.rechazo_dato.autorizacion_tratamiento_datos = 'Rechazo hostil';
    extracted.rechazo_hostil = true;
    extracted.friccion_o_reclamo = true;
  }

  // 3. CONSULTAS COMERCIALES Y/O INTENCIÓN DE COMPRA DEL USUARIO (FLUJO A)
  // Detección de respuesta a la bifurcación: ¿Seguimos con el formulario o quieres solo comprar?
  const wasForkAsked = sessionContext._modo_compra === 'preguntando_opcion' ||
                       sessionContext._lastQuestion === 'OPCION_COMPRA_O_FORMULARIO' ||
                       /\b(?:formulario\s+o\s+quieres\s+solo\s+comprar|seguimos\s+con\s+el\s+formulario|o\s+solo\s+comprar)\b/i.test(sessionContext.lastAssistantMessage || '');

  if (wasForkAsked) {
    if (/\b(?:solo\s+comprar|comprar|repuestos?|primero\s+comprar|la\s+compra|compro|quiero\s+comprar|cotizar|necesito\s+repuestos?|solo\s+los\s+repuestos)\b/i.test(lower)) {
      extracted.eleccion_flujo_compra = 'solo_comprar';
    } else if (/\b(?:formulario|registro|vincular|sigamos|seguir|continuar|afiliar|ambos|las\s+dos|inscribir|terminar)\b/i.test(lower)) {
      extracted.eleccion_flujo_compra = 'seguir_formulario';
    }
  }

  // Detección de reanudar formulario (transición de Flujo Comercial a Registro)
  if (/\b(?:sigamos\s+con\s+el\s+formulario|retomemos\s+el\s+formulario|volver\s+al\s+formulario|seguir\s+con\s+el\s+registro|retomar\s+el\s+registro|continuar\s+el\s+registro|inscribir\s+el\s+taller|vincular\s+el\s+taller|terminar\s+el\s+formulario|ahora\s+s[ií]\s+el\s+formulario|sigamos\s+con\s+el\s+registro)\b/i.test(lower)) {
    extracted.intencion_retomar_formulario = true;
  }

  // Detección de rechazo explícito de registro
  if (/\b(?:no\s+quiero\s+(?:registrarme|formulario|registro|vincularme)|solo\s+quiero\s+comprar|no\s+me\s+interesa\s+el\s+registro|nada\s+de\s+formularios?)\b/i.test(lower)) {
    extracted.rechazo_registro = true;
  }

  // Detección de Intención de Compra y Cotización explícita (Flujo A)
  const isQuotePhrase = /\b(?:cotizar|cotizaci[oó]n|cot[ií]zame|m[aá]ndame\s+(?:una\s+)?cotizaci[oó]n|cu[aá]nto\s+me\s+cuesta|cu[aá]nto\s+me\s+vale|cu[aá]nto\s+vale\s+todo|precios\s+al\s+por\s+mayor|comparar\s+precios|presupuesto)\b/i.test(lower);
  const isPurchaseIntent = isQuotePhrase ||
    /\b(?:quiero\s+comprar|comprar\s+repuestos|c[oó]mo\s+compro|d[oó]nde\s+compro|d[oó]nde\s+puedo\s+comprar|venden\s+repuestos|necesito\s+comprar|a\s+c[oó]mo\s+los\s+repuestos|precio\s+de|comprar|hacer\s+una\s+compra|para\s+una\s+compra|adquirir\s+repuestos|voy\s+a\s+llevar|me\s+llevo|llevar\s+el\s+kit|llevar\s+los|llevar\s+las)\b/i.test(lower) ||
    /^(?:hola\s+)?(?:quiero\s+comprar|comprar|compro|compras|cotizar|necesito\s+repuestos?)[\s.,!]*$/i.test(lower) ||
    /\b(?:quiero|necesito|deseo|voy\s+a)\s+(?:comprar|hacer\s+una\s+compra|adquirir|cotizar|llevar)\b/i.test(lower) ||
    /\b(?:no\s*,?\s*(?:hoy\s+)?quiero\s+comprar|solo\s+quiero\s+comprar|solo\s+comprar|hoy\s+necesito\s+comprar)\b/i.test(lower) ||
    /\b(?:a\s+c[oó]mo\s+(?:tienen|est[aá]n?)|cu[aá]nto\s+vale|cu[aá]nto\s+cuesta|qu[eé]\s+precio\s+tiene)\b.*?\b(?:repuesto|kit|cadena|pastillas?|frenos?|bandas?|zapatas?|clutch|embrague|bater[ií]a|llanta|buj[ií]a)\b/i.test(lower) ||
    /\b(?:a\s+c[oó]mo\s+sale|a\s+c[oó]mo\s+(?:lo\s+)?tienen|cu[aá]nto\s+vale\s+esa\s+vaina|tienen\s+de\s+eso|m[aá]ndame\s+precio|qu[eé]\s+vale\s+el\s+kit|qu[eé]\s+vale\s+esa\s+vaina)\b/i.test(lower) ||
    /\b(?:tienen|manejan|venden|consiguen)\s+repuestos\s+(?:para|pa)\b/i.test(lower);

  if (isQuotePhrase) {
    extracted.intencion_cotizacion = true;
    extracted.intencion_compra = true;
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'cotizacion';
  } else if (isPurchaseIntent) {
    extracted.intencion_compra = true;
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'intencion_compra';
  } else if (/\b(?:qui[eé]nes\s+son|qu[eé]\s+hacen|de\s+qu[eé]\s+es\s+nitrox|qu[eé]\s+es\s+red\s+nitrox)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'identidad_empresa';
  } else if (/\b(?:tienen|manejan|venden|hay|consiguen)\b.*?\b(?:pastillas?|frenos?|kit|arrastre|repuesto|bater[ií]a|llanta|cadena|aceite|cilindro|buj[ií]a)\b/i.test(lower) ||
             /\b(?:pastillas?|kit\s+(?:de\s+)?arrastre|kit\s+(?:para|pa)\s+|repuestos?|zapatas?|bandas?|buj[ií]as?)\b.*?\b(?:para|pa)\b.*?\b(?:nkd|boxer|pulsar|yamaha|akt|honda|nmax|fz|gixxer|discover|apache)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'consulta_repuesto_referencia';
  } else if (/\b(?:d[oó]nde\s+quedan|d[oó]nde\s+est[aá]n|ubicaci[oó]n\s+de\s+ustedes|tienen\s+sede|d[oó]nde\s+puedo\s+conseguir|tienda\s+m[aá]s\s+cercana|punto\s+de\s+venta)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.consulta_ubicacion = true;
    extracted.pregunta_comercial_tema = 'ubicacion_empresa';
  } else if (/\b(?:cu[aá]nto\s+cuesta|qu[eé]\s+precio|precios|cat[aá]logo|m[aá]ndame\s+el\s+cat[aá]logo|qu[eé]\s+referencias\s+manejan)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'precios_catalogo';
  }

  // Consultas de catálogo y compatibilidad
  if (/\b(?:cat[aá]logo|portafolio|folleto|m[aá]ndame\s+el\s+cat[aá]logo)\b/i.test(lower)) {
    extracted.consulta_catalogo = true;
    extracted.es_pregunta_comercial = true;
  }
  if (/\b(?:le\s+sirve|es\s+compatible|tienen\s+para\s+(?:una|la)\b|sirve\s+para|aplica\s+para)\b/i.test(lower)) {
    extracted.consulta_compatibilidad = true;
    extracted.es_pregunta_comercial = true;
  }

  // Detección de repuestos solicitados (soporte multi-referencia)
  const commercialRequestedParts = [];
  if (/\b(?:kit\s+(?:de\s+)?arrastre|kit\s+(?:para|pa)\s+|relaci[oó]n|pi[ñn][oó]n\s+y\s+corona|arrastre)\b/i.test(lower)) {
    commercialRequestedParts.push('Kit de arrastre');
  }
  if (/\b(?:pastillas?(?:\s+de\s+freno)?|frenos?|bandas?(?:\s+traseras?)?|zapatas?|discos?(?:\s+de\s+freno)?)\b/i.test(lower)) {
    commercialRequestedParts.push('Frenos (pastillas / bandas)');
  }
  if (/\b(?:cadenas?(?:\s+reforzada|\s+gold|\s+o-ring)?)\b/i.test(lower)) {
    commercialRequestedParts.push('Cadena de transmisión');
  }
  if (/\b(?:clutch|embrague|discos?\s+de\s+clutch|prensa)\b/i.test(lower)) {
    commercialRequestedParts.push('Embrague / Clutch');
  }
  if (/\b(?:bater[ií]as?)\b/i.test(lower)) {
    commercialRequestedParts.push('Batería');
  }
  if (/\b(?:llantas?)\b/i.test(lower)) {
    commercialRequestedParts.push('Llanta');
  }
  if (/\b(?:buj[ií]as?)\b/i.test(lower)) {
    commercialRequestedParts.push('Bujía');
  }
  if (/\b(?:aceite|lubricante)\b/i.test(lower)) {
    commercialRequestedParts.push('Aceite');
  }
  extracted.repuestos_solicitados = commercialRequestedParts;
  if (commercialRequestedParts.length > 0) {
    extracted.repuesto_solicitado = commercialRequestedParts[0];
    if (/\b(?:necesito|busco|quiero|tienen|manejan|consiguen|cotizar|comprar|venden|hay|precio|cu[aá]nto|para\s+mi\s+moto|a\s+c[oó]mo)\b/i.test(lower)) {
      extracted.intencion_compra = true;
      extracted.es_pregunta_comercial = true;
      if (!extracted.pregunta_comercial_tema) extracted.pregunta_comercial_tema = 'intencion_compra';
    }
  }
  if (commercialRequestedParts.length > 1 || /\b(?:varias?\s+referencias|todos?\s+(?:estos|los)\s+repuestos|pedido\s+completo|combo)\b/i.test(lower)) {
    extracted.cotizacion_multiple = true;
  }

  // Detección de saludos, despedidas y pausas
  const isGreetingWord = /\b(?:hola|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|quiubo|quihubo|qu[eé]\s+m[aá]s|buen\s+d[ií]a|ey\s+hola)\b/i.test(lower);
  extracted.es_saludo = isGreetingWord;

  const isFarewellWord = /\b(?:chao|adi[oó]s|hasta\s+luego|nos\s+vemos)\b/i.test(lower);
  const isPausePhrase = /\b(?:despu[eé]s\s+(?:te\s+confirmo|seguimos|le\s+escribo|te\s+escribo|reviso|miro|hablamos)|hablamos\s+luego|luego\s+te\s+escribo|por\s+ahora\s+no\s+necesito\s+nada|d[eé]jame\s+pensarlo|voy\s+a\s+revisar|m[aá]s\s+tarde\s+te\s+aviso|despu[eé]s\s+te\s+aviso)\b/i.test(lower);
  const hasFollowUpQuestion = /(?:\bah\b|\buna\s+cosa\b|\bpregunta\b|\bcu[aá]nto\b|\bqu[eé]\s+vale\b|\btienen\b).*?(?:\?|[a-z0-9])/i.test(lower) && (lower.includes('?') || /\b(?:cu[aá]nto|qu[eé]\s+vale|precio|repuesto|kit|tienen|venden)\b/i.test(lower));

  if (isFarewellWord && hasFollowUpQuestion) {
    extracted.despedida_con_pregunta = true;
    extracted.es_pregunta_comercial = true;
    extracted.es_despedida = false;
  } else if (isPausePhrase) {
    extracted.es_pausa = true;
  } else if (isFarewellWord) {
    extracted.es_despedida = true;
  }

  // Detección de no poseer taller (Mecánico independiente / sin taller)
  if (/\b(?:no\s+tengo\s+taller|todav[ií]a\s+no\s+tengo\s+taller|no\s+cuento\s+con\s+taller|trabajo\s+independiente|mec[aá]nico\s+independiente|sin\s+taller|no\s+poseo\s+taller)\b/i.test(lower)) {
    extracted.no_tiene_taller = true;
    if (!extracted.relacion_taller) extracted.relacion_taller = 'Mecánico Independiente / A domicilio';
    if (!extracted.nombre_taller) extracted.nombre_taller = 'Mecánico Independiente / A domicilio';
  }

  // Detección de motocicleta solicitada en la consulta comercial
  let bikeSearchText = lower;
  const correctionMatch = lower.match(/\b(?:no\s+(?:es|era))\s+[a-z0-9]+\s+(?:es\s+(?:para|pa)?\s+|para\s+)(.*)/i);
  if (correctionMatch) {
    bikeSearchText = correctionMatch[1];
  }
  const bikeMatch = bikeSearchText.match(/\b(kawasaki(?:\s*(?:klx|ninja|versys|z\s*\d+|150|250|300|400|650))?|pulsar(?:\s+(?:ns\s*200|200\s*ns|180|150|135|220|ug))?|boxer(?:\s+(?:ct\s*100|ct100|bm\s*100|100))?|nkd(?:\s*125)?|gixxer(?:\s*(?:150|250))?|fz(?:\s*(?:16|2\.0|25))?|nmax(?:\s*155)?|apache(?:\s*(?:160|180|200))?|discover(?:\s*(?:125|135|150))?|akt(?:\s*(?:125|special|cr4|tt))?|yamaha(?:\s*(?:crypton|xtz|libero|bws|mt))?|honda(?:\s*(?:cb|cbf|wave|xr|dio|navi))?|suzuki(?:\s*(?:gn|gixxer|vivax|dr|ax))?|ktm(?:\s*(?:duke|rc|adventure))?|kymco(?:\s*(?:agility|twist))?|victory(?:\s*(?:mrx|one|nitro))?)\b/i);
  if (bikeMatch) {
    const rawBike = bikeMatch[1].trim();
    extracted.moto_solicitada = rawBike.charAt(0).toUpperCase() + rawBike.slice(1);
  } else if ((sessionContext.active_flow === 'commercial' || sessionContext._modo_compra === 'asesoria_compra') && /^(?:es\s+(?:una\s+)?)?(\d{2,4}|[a-z]{1,4}\s*\d{2,4}|ns\s*200|klx\s*\d+|cr4|special|ct\s*100)$/i.test(raw.trim())) {
    // Si estamos en flujo comercial y el usuario responde solo el modelo o cilindraje (ej: "150", "200", "klx 150")
    const modelOrCc = raw.replace(/^(?:es\s+(?:una\s+)?)/i, '').trim();
    const prevMoto = sessionContext.commercial_state?.moto || sessionContext.moto || '';
    extracted.moto_solicitada = prevMoto ? `${prevMoto} ${modelOrCc}` : modelOrCc;
    extracted.intencion_compra = true;
  }

  // 4. CIUDADES, MUNICIPIOS Y TALLERES COMPUESTOS ("Pj en Bogotá", "La 50 en Medellín", "Taller El Paisa en Cali")
  const municipalities = [
    { name: 'Bogotá', regex: /\b(?:bogot[aá]|dc|bogota\s*dc)\b/i },
    { name: 'Medellín', regex: /\b(?:medell[ií]n|medallo)\b/i },
    { name: 'Cali', regex: /\b(?:cali)\b/i },
    { name: 'Barranquilla', regex: /\b(?:barranquilla|quilla)\b/i },
    { name: 'Cartagena', regex: /\b(?:cartagena)\b/i },
    { name: 'Bucaramanga', regex: /\b(?:bucaramanga|bucara)\b/i },
    { name: 'Pereira', regex: /\b(?:pereira)\b/i },
    { name: 'Manizales', regex: /\b(?:manizales)\b/i },
    { name: 'Cúcuta', regex: /\b(?:c[uú]cuta)\b/i },
    { name: 'Ibagué', regex: /\b(?:ibagu[eé])\b/i },
    { name: 'Santa Marta', regex: /\b(?:santa\s+marta)\b/i },
    { name: 'Villavicencio', regex: /\b(?:villavicencio|villavo)\b/i },
    { name: 'Pasto', regex: /\b(?:pasto)\b/i },
    { name: 'Montería', regex: /\b(?:monter[ií]a)\b/i },
    { name: 'Valledupar', regex: /\b(?:valledupar)\b/i },
    { name: 'Armenia', regex: /\b(?:armenia)\b/i },
    { name: 'Popayán', regex: /\b(?:popay[aá]n)\b/i },
    { name: 'Neiva', regex: /\b(?:neiva)\b/i },
    { name: 'Sincelejo', regex: /\b(?:sincelejo)\b/i },
    { name: 'Tunja', regex: /\b(?:tunja)\b/i },
    { name: 'Riohacha', regex: /\b(?:riohacha)\b/i },
    { name: 'Florencia', regex: /\b(?:florencia)\b/i },
    { name: 'Yopal', regex: /\b(?:yopal)\b/i },
    { name: 'Quibdó', regex: /\b(?:quibd[oó])\b/i },
    { name: 'Soacha', regex: /\b(?:soacha)\b/i },
    { name: 'Bello', regex: /\b(?:bello)\b/i },
    { name: 'Itagüí', regex: /\b(?:itag[uü][ií]|itagui)\b/i },
    { name: 'Envigado', regex: /\b(?:envigado)\b/i },
    { name: 'Sabaneta', regex: /\b(?:sabaneta)\b/i },
    { name: 'La Estrella', regex: /\b(?:la\s+estrella|estrella)\b/i },
    { name: 'Caldas', regex: /\b(?:caldas)\b/i },
    { name: 'Copacabana', regex: /\b(?:copacabana)\b/i },
    { name: 'Girardota', regex: /\b(?:girardota)\b/i },
    { name: 'Barbosa', regex: /\b(?:barbosa)\b/i },
    { name: 'Rionegro', regex: /\b(?:rionegro)\b/i },
    { name: 'Palmira', regex: /\b(?:palmira)\b/i },
    { name: 'Dosquebradas', regex: /\b(?:dosquebradas)\b/i },
    { name: 'Floridablanca', regex: /\b(?:floridablanca)\b/i },
    { name: 'Girón', regex: /\b(?:gir[oó]n)\b/i },
    { name: 'Piedecuesta', regex: /\b(?:piedecuesta)\b/i },
    { name: 'Barrancabermeja', regex: /\b(?:barrancabermeja)\b/i },
    { name: 'Tuluá', regex: /\b(?:tulu[aá])\b/i },
    { name: 'Facatativá', regex: /\b(?:facatativ[aá]|faca)\b/i },
    { name: 'Fusagasugá', regex: /\b(?:fusagasug[aá]|fusa)\b/i },
    { name: 'Chía', regex: /\b(?:ch[ií]a)\b/i },
    { name: 'Zipaquirá', regex: /\b(?:zipaquir[aá]|zipa)\b/i },
    { name: 'Apartadó', regex: /\b(?:apartad[oó])\b/i },
    { name: 'Turbo', regex: /\b(?:turbo)\b/i },
    { name: 'Cartago', regex: /\b(?:cartago)\b/i },
    { name: 'Pitalito', regex: /\b(?:pitalito)\b/i },
    { name: 'Ipiales', regex: /\b(?:ipiales)\b/i },
    { name: 'Sogamoso', regex: /\b(?:sogamoso)\b/i },
    { name: 'Duitama', regex: /\b(?:duitama)\b/i },
    { name: 'Girardot', regex: /\b(?:girardot)\b/i }
  ];

  // 4a. Detección de taller y ciudad expresados juntos (ej: "Pj en Bogotá", "La 50 en Medellín", "Taller Central en Cali")
  const isSparePartPhrase = /\b(?:pastillas?|frenos?|kit|arrastre|bandas?|disco|discos|aceite|buj[ií]as?|bater[ií]as?|repuestos?|filtros?|cadena|cadenas|llantas?|neum[aá]ticos?|guayas?|suspensi[oó]n|amortiguador(?:es)?|rodamientos?|balineras?|pi[ñn][oó]n(?:es)?|corona)\b/i.test(raw);
  const workshopCityMatch = !isSparePartPhrase && raw.match(/^(?:(?:el\s+taller\s+es|se\s+llama|mi\s+taller\s+es|taller)\s+)?([A-Za-z0-9\s#\-\.]{1,35}?)\s+(?:en|de|ubicado\s+en)\s+([A-Za-z0-9\s#\-\.áéíóúÁÉÍÓÚñÑ]{2,30})$/i);
  if (workshopCityMatch) {
    const rawShop = workshopCityMatch[1].trim();
    const rawCity = workshopCityMatch[2].trim();
    const isBadShop = /\b(?:mierda|hp|hpta|hijueputa|gonorrea|marica|carechimba|malparido|no\s+sea|no\s+es|mentira)\b/i.test(rawShop) || /^(?:hola|buenas|soy|yo|si|sí|ok|estoy|vivo|queda|estamos|ubicado|ubicados)$/i.test(rawShop);
    if (rawShop.length >= 1 && !isBadShop) {
      if (!sessionContext.nombre_taller) {
        const formattedShop = rawShop.toLowerCase().startsWith('taller') || /motos|racing|motor/i.test(rawShop) ? rawShop : `Taller ${rawShop}`;
        extracted.nombre_taller = formattedShop.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
      const matchedCity = municipalities.find(m => m.regex.test(rawCity));
      if (matchedCity && !sessionContext.ciudad_taller) {
        extracted.ciudad_taller = matchedCity.name;
      }
    }
  }

  // 4b. Detección de taller explícito ("se llama La 50", "el taller es Moto Sol")
  const explicitShopMatch = raw.match(/^(?:el\s+taller\s+es|se\s+llama|mi\s+taller\s+es|nombre\s+del\s+taller\s+es)\s+([A-Za-z0-9\s#\-\.]{1,35})$/i);
  if (explicitShopMatch && !extracted.nombre_taller) {
    let s = explicitShopMatch[1].trim();
    const isBadShop = /\b(?:mierda|hp|hpta|hijueputa|gonorrea|marica|carechimba|malparido|no\s+sea|no\s+es|mentira)\b/i.test(s) || /^(?:hola|buenas|soy|yo|si|sí|ok)$/i.test(s);
    if (!isBadShop) {
      s = s.replace(/\s+(?:en|de|ubicado\s+en)\s+.*$/i, '').trim();
      const formattedShop = s.toLowerCase().startsWith('taller') || /motos|racing|motor/i.test(s) ? s : `Taller ${s}`;
      extracted.nombre_taller = formattedShop.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
  }

  // 4c. Detección de corrección de ciudad o afirmación explícita ("Vivo en Medellín", "¿Cómo sabes que vivo en Bogotá? Vivo en Medellín")
  const cityCorrectionMatch = lower.match(/(?:c[oó]mo\s+sabes\s+que\s+(?:vivo|estoy)\s+en\s+([a-zñáéíóú\s]+?)[?,\s]+(?:vivo|estoy)\s+en\s+([a-zñáéíóú\s]+)|no\s+(?:vivo|estoy|quedo|queda|es)\s+(?:en\s+)?([a-zñáéíóú\s]+?)[,;.\s]+(?:vivo|estoy|queda|es)\s+(?:en\s+)?([a-zñáéíóú\s]+)|(?:vivo|estoy)\s+en\s+([a-zñáéíóú\s]+?)[,;.\s]+no\s+(?:en\s+)?([a-zñáéíóú\s]+))/i);
  const explicitLivingMatch = lower.match(/\b(?:vivo|estoy|me\s+encuentro|ubicado)\s+en\s+([a-zñáéíóú\s]+)/i);

  if (cityCorrectionMatch) {
    const assertedCandidate = (cityCorrectionMatch[2] || cityCorrectionMatch[4] || cityCorrectionMatch[5] || '').trim();
    for (const m of municipalities) {
      if (m.regex.test(assertedCandidate)) {
        extracted.ciudad_taller = m.name;
        extracted.ciudad_solicitada = m.name;
        extracted.friccion_o_reclamo = true;
        extracted.correccion_ciudad = true;
        break;
      }
    }
  } else if (explicitLivingMatch) {
    const livingCandidate = explicitLivingMatch[1].trim();
    for (const m of municipalities) {
      if (m.regex.test(livingCandidate)) {
        extracted.ciudad_taller = m.name;
        extracted.ciudad_solicitada = m.name;
        break;
      }
    }
  }

  if (!extracted.ciudad_taller) {
    for (const m of municipalities) {
      if (m.regex.test(lower) || m.regex.test(unaccented)) {
        extracted.ciudad_taller = m.name;
        extracted.ciudad_solicitada = m.name;
        break;
      }
    }
  }

  // Si responde con una sola palabra o frase corta que es ciudad (Ejemplo: "Bogotá", "En Bogotá")
  if (!extracted.ciudad_taller && raw.split(/\s+/).length <= 3) {
    const cleanCityCandidate = raw.replace(/^(?:en|de|en la ciudad de|ciudad)\s+/i, '').trim();
    for (const m of municipalities) {
      if (m.regex.test(cleanCityCandidate)) {
        extracted.ciudad_taller = m.name;
        extracted.ciudad_solicitada = m.name;
        break;
      }
    }
  }

  // 5. BARRIOS Y ZONAS (Medellín, Bogotá, Cali, Bucaramanga, Barranquilla, Pereira)
  const barriosConCiudad = [
    // Medellín y Valle de Aburrá
    { name: 'Barrio Antioquia', city: 'Medellín', regex: /\b(?:barrio\s+antioquia|antioquia)\b/i },
    { name: 'La Bayadera', city: 'Medellín', regex: /\b(?:la\s+bayadera|bayadera)\b/i },
    { name: 'Plaza Mayor', city: 'Medellín', regex: /\b(?:plaza\s+mayor)\b/i },
    { name: 'Estadio', city: 'Medellín', regex: /\b(?:estadio|la\s+70)\b/i },
    { name: 'Guayabal', city: 'Medellín', regex: /\bguayabal\b/i },
    { name: 'El Poblado', city: 'Medellín', regex: /\b(?:el\s+poblado|poblado)\b/i },
    { name: 'Belén', city: 'Medellín', regex: /\b(?:bel[eé]n)\b/i },
    { name: 'Laureles', city: 'Medellín', regex: /\blaureles\b/i },
    { name: 'Centro', city: 'Medellín', regex: /\b(?:centro|la\s+candelaria|la\s+paz)\b/i },
    { name: 'Aranjuez', city: 'Medellín', regex: /\baranjuez\b/i },
    { name: 'Manrique', city: 'Medellín', regex: /\bmanrique\b/i },
    { name: 'Robledo', city: 'Medellín', regex: /\brobledo\b/i },
    { name: 'Castilla', city: 'Medellín', regex: /\bcastilla\b/i },
    { name: 'Prado', city: 'Medellín', regex: /\bprado\b/i },
    { name: 'San Javier', city: 'Medellín', regex: /\bsan\s+javier\b/i },
    { name: 'Buenos Aires', city: 'Medellín', regex: /\bbuenos\s+aires\b/i },
    { name: 'La América', city: 'Medellín', regex: /\bla\s+am[eé]rica\b/i },
    { name: 'Floresta', city: 'Medellín', regex: /\bfloresta\b/i },
    { name: 'Calasanz', city: 'Medellín', regex: /\bcalasanz\b/i },
    { name: 'Santa Cruz', city: 'Medellín', regex: /\bsanta\s+cruz\b/i },
    { name: 'Popular', city: 'Medellín', regex: /\bpopular\b/i },
    { name: 'Villa Hermosa', city: 'Medellín', regex: /\bvilla\s+hermosa\b/i },
    { name: 'San Antonio de Prado', city: 'Medellín', regex: /\bsan\s+antonio\s+de\s+prado\b/i },
    { name: 'Niquía', city: 'Bello', regex: /\bniqu[ií]a\b/i },
    { name: 'Cabañas', city: 'Bello', regex: /\bcaba[ñn]as\b/i },
    { name: 'Ditaires', city: 'Itagüí', regex: /\bditaires\b/i },
    { name: 'Santa María', city: 'Itagüí', regex: /\bsanta\s+mar[ií]a\b/i },
    // Bogotá
    { name: 'Venecia', city: 'Bogotá', regex: /\bvenecia\b/i },
    { name: 'Primera de Mayo', city: 'Bogotá', regex: /\b(?:primera\s+de\s+mayo|1\s+de\s+mayo|restrepo)\b/i },
    { name: 'Avenida Boyacá', city: 'Bogotá', regex: /\b(?:boyac[aá]|normand[ií]a|engativ[aá]|fontib[oó]n|calle\s+80)\b/i },
    { name: 'Suba', city: 'Bogotá', regex: /\b(?:suba|la\s+campi[ñn]a|colina|rinc[oó]n|calle\s+130)\b/i },
    { name: 'Kennedy', city: 'Bogotá', regex: /\bkennedy\b/i },
    { name: 'Bosa', city: 'Bogotá', regex: /\bbosa\b/i },
    { name: 'Tunjuelito', city: 'Bogotá', regex: /\btunjuelito\b/i },
    { name: 'Ciudad Bolívar', city: 'Bogotá', regex: /\bciudad\s+bol[ií]var\b/i },
    // Cali
    { name: 'San Bosco', city: 'Cali', regex: /\b(?:san\s+bosco|breta[ñn]a)\b/i },
    // Bucaramanga
    { name: 'La Concordia', city: 'Bucaramanga', regex: /\b(?:la\s+concordia|concordia)\b/i },
    // Barranquilla
    { name: 'La Cordialidad', city: 'Barranquilla', regex: /\b(?:la\s+cordialidad|cordialidad)\b/i }
  ];

  for (const b of barriosConCiudad) {
    if (b.regex.test(lower)) {
      extracted.barrio_taller = b.name;
      if (!extracted.ciudad_taller && !sessionContext.ciudad_taller) {
        extracted.ciudad_taller = b.city;
      }
      break;
    }
  }

  // 5b. COORDENADAS GPS DE WHATSAPP (ej. "Ubicación GPS: 6.2404, -75.5746")
  const gpsMatch = raw.match(/Ubicaci[oó]n\s+GPS:\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)/i)
                || raw.match(/([+-]?\d{1,2}\.\d{3,})\s*,\s*([+-]?\d{1,3}\.\d{3,})/);
  if (gpsMatch) {
    const lat = parseFloat(gpsMatch[1]);
    const lon = parseFloat(gpsMatch[2]);
    extracted.coordenadas_gps = { lat, lon };
  }

  // 6. DIRECCIÓN DEL TALLER
  const addrMatch = raw.match(/\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida|cra\.|cll\.)\b\s+[0-9a-zA-Z#\s\-\.\°]+/i)
    || raw.match(/\b\d+\s*#\s*\d+[\s\-0-9a-zA-Z]*/i);
  if (addrMatch) {
    extracted.direccion_taller = addrMatch[0].trim();
  }

  // 7. MARCAS DE MOTOS ATENDIDAS
  const brandsList = [
    { name: 'Yamaha', regex: /\byamaha\b/i },
    { name: 'Bajaj', regex: /\b(?:bajaj|pulsar|boxer|discover|platino)\b/i },
    { name: 'AKT', regex: /\b(?:akt|nkd|tt|special)\b/i },
    { name: 'Honda', regex: /\b(?:honda|cb|cbr|xr|wave)\b/i },
    { name: 'Suzuki', regex: /\b(?:suzuki|gixxer|gn|vivax)\b/i },
    { name: 'TVS', regex: /\b(?:tvs|apache|stryker)\b/i },
    { name: 'Hero', regex: /\b(?:hero|eco|hunk)\b/i },
    { name: 'KTM', regex: /\b(?:ktm|duke)\b/i },
    { name: 'Kymco', regex: /\bkymco\b/i },
    { name: 'Victory', regex: /\bvictory\b/i }
  ];

  const detectedBrands = [];
  for (const b of brandsList) {
    if (b.regex.test(lower)) {
      detectedBrands.push(b.name);
    }
  }
  const isGenericBrandsOnly = /^(?:de\s+)?todas$|^(?:de\s+)?todo(?:\s+tipo)?$|^variadas?$|^muchas$/i.test(lower) ||
    (/(?:todas|de todas|variadas|de todo tipo|muchas)/i.test(lower) && detectedBrands.length === 0);

  const isTransitEvading = /\b(?:sitp|transmilenio|metro|buses?|alimentador|pagando\s+pasaje|chiva)\b/i.test(lower);

  if (isTransitEvading) {
    extracted.marcas_motos = null;
    extracted.marcas_genericas = false;
    extracted.es_respuesta_evasiva = true;
  } else if (isGenericBrandsOnly) {
    extracted.marcas_genericas = true;
    if (extracted.protesta_repeticion) {
      extracted.marcas_motos = ['Variadas / Todas'];
    }
  } else if (detectedBrands.length > 0) {
    extracted.marcas_motos = detectedBrands;
  }

  // 8. VOLUMEN DE MOTOS POR SEMANA O DÍA
  // Detecta números directos ("20"), rangos ("entre 15 y 20", "20 a 30"), palabras numéricas ("veinte"), y cualitativos
  const spanishWordNumbers = {
    'un': 1, 'una': 1, 'uno': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5,
    'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10, 'once': 11,
    'doce': 12, 'trece': 13, 'catorce': 14, 'quince': 15, 'dieciseis': 16,
    'diecisiete': 17, 'dieciocho': 18, 'diecinueve': 19, 'veinte': 20,
    'veinticinco': 25, 'treinta': 30, 'cuarenta': 40, 'cincuenta': 50,
    'sesenta': 60, 'setenta': 70, 'ochenta': 80, 'noventa': 90, 'cien': 100
  };

  const isDaily = /\b(?:al\s*d[ií]a|diarias?|por\s*d[ií]a)\b/i.test(raw);
  const isVolumeContext = sessionContext._lastQuestion === 'VOLUMEN' || 
                          sessionContext._lastQuestion === 'VOLUMEN_Y_MARCAS' ||
                          /(?:cu[aá]ntas?|qu[eé]\s+(?:tanto|tantas|cantidad|promedio|flujo|volumen))\s+(?:de\s+)?(?:motos?|m[aá]quinas?)|(?:motos?|m[aá]quinas?)\s+(?:atienden|reciben|llegan|entran)/i.test(sessionContext.lastAssistantMessage || '');

  const rangeMatch = raw.match(/\b(?:entre\s+)?(\d+)\s*(?:a|-|o|y)\s*(\d+)\s*(?:motos?|m[aá]quinas?)?/i);
  const volumeExplicitMatch = raw.match(/(?:como|unas|unos|alrededor\s+de|por\s+ah[ií])?\s*(\d+)\s*(?:motos?|veh[ií]culos?|m[aá]quinas?)?\s*(?:por\s+semana|ala\s+semana|a\s+la\s+semana|semanales|al\s+d[ií]a|diarias)/i)
    || raw.match(/(?:atiendo|recibo|arreglo|llegan|hago|veo|entran)\s*(?:como|unas|unos)?\s*(\d+)\s*(?:motos?)?(?:\s*(?:por|a\s*la)\s*semana|\s*al\s*d[ií]a)?/i)
    || raw.match(/\b(\d+)\s*(?:motos?|m[aá]quinas?)\b/i);

  const standaloneNumMatch = raw.match(/\b(?:unas?|unos?|como|por\s+ah[ií]|alrededor\s+de|m[aá]s\s+o\s+menos)?\s*(\d{1,3})\s*(?:motos?)?\b/i);

  let wordNum = null;
  for (const [w, n] of Object.entries(spanishWordNumbers)) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(raw)) {
      wordNum = n;
      break;
    }
  }

  if (isTransitEvading) {
    // Si menciona transporte público o evasivas, no asignar volumen espurio
    extracted.motos_por_semana = null;
  } else if (rangeMatch && (isVolumeContext || /\bmotos?\b/i.test(raw) || isDaily || /semana/i.test(raw))) {
    const min = rangeMatch[1];
    const max = rangeMatch[2];
    extracted.motos_por_semana = isDaily ? `${min} a ${max} motos al día` : `${min} a ${max} motos/semana`;
  } else if (volumeExplicitMatch && volumeExplicitMatch[1]) {
    const num = volumeExplicitMatch[1];
    extracted.motos_por_semana = isDaily ? `Aproximadamente ${num} motos al día` : `${num} motos/semana`;
  } else if (isVolumeContext && standaloneNumMatch && standaloneNumMatch[1]) {
    const num = standaloneNumMatch[1];
    extracted.motos_por_semana = isDaily ? `Aproximadamente ${num} motos al día` : `${num} motos/semana`;
  } else if (isVolumeContext && wordNum) {
    extracted.motos_por_semana = isDaily ? `Aproximadamente ${wordNum} motos al día` : `${wordNum} motos/semana`;
  } else if (/bastantes|muchas|harto|full|bastante movimiento|buen flujo/i.test(lower) && (isVolumeContext || /motos?/i.test(lower))) {
    extracted.motos_por_semana = 'Alta afluencia (+30 motos/semana)';
  } else if (/pocas|poquitas|bajo|suave|despacio/i.test(lower) && isVolumeContext) {
    extracted.motos_por_semana = 'Baja afluencia (menos de 10 motos/semana)';
  }

  // 9. TIPOS DE REPUESTOS Y REPUESTOS FRECUENTES
  const partsList = [
    { name: 'Kits de arrastre', regex: /\b(?:kit\s+d[e]?\s+arrastre|arrastre|cadenas?|pi[ñn][oó]n|corona)\b/i },
    { name: 'Pastillas de freno', regex: /\b(?:pastillas?(?:\s+de\s+freno)?|frenos?|bandas?|discos?)\b/i },
    { name: 'Partes de motor', regex: /\b(?:motor|motores|cilindros?|pist[oó]n|pistones|anillos|v[aá]lvulas?|empaques?)\b/i },
    { name: 'Lubricación / Filtros', regex: /\b(?:aceites?|filtros?|lubricantes?)\b/i },
    { name: 'Suspensión', regex: /\b(?:suspensi[oó]n|amortiguadores?|retenes|retenedores)\b/i },
    { name: 'Electricidad / Baterías', regex: /\b(?:bater[ií]as?|buj[ií]as?|bobinas?|bombillos?|luces|el[eé]ctrico|electricidad)\b/i },
    { name: 'Llantas / Neumáticos', regex: /\b(?:llantas?|neum[aá]ticos?|rines)\b/i },
    { name: 'Guayas y mandos', regex: /\b(?:guayas?|cables?|mandos?|manecillas?)\b/i },
    { name: 'Rodamientos', regex: /\b(?:rodamientos?|balineras?|cunas?)\b/i }
  ];

  const detectedParts = [];
  for (const p of partsList) {
    if (p.regex.test(lower)) {
      detectedParts.push(p.name);
    }
  }
  const isGenericPartsOnly = /^(?:de\s+)?todo$|^variados?$|^lo que llegue$/i.test(lower) ||
    (/(?:de todo|variados|lo que llegue)/i.test(lower) && detectedParts.length === 0);

  // Distinción semántica de polisemia de "rotar": "roto por las estaciones" = desplazamiento, NO repuestos
  const isLocationRotation = /\broto\s+(?:por|en|entre|turnos?)\b/i.test(lower) && !/\b(?:repuestos?|piezas?|frenos?|arrastre|aceite|bater[ií]a)\b/i.test(lower);

  if (isLocationRotation || isTransitEvading) {
    extracted.repuestos_frecuentes = null;
    extracted.repuestos_genericos = false;
  } else if (isGenericPartsOnly) {
    extracted.repuestos_genericos = true;
    if (extracted.protesta_repeticion) {
      extracted.repuestos_frecuentes = ['Variados / De todo'];
    }
  } else if (detectedParts.length > 0) {
    extracted.repuestos_frecuentes = detectedParts;
  }

  // 10. ROLES EN EL TALLER
  // Detecta dueño, mecánico, o rol dual con soporte para jerga colombiana ("la que lo comanda", "el patrón", etc.)
  const isOwner = /\b(?:due[ñn]o|due[ñn]a|propietari[oa]|patr[oó]n|patrona|jefe|jefa|socio|socia|creador|fundador|el\s+taller\s+es\s+m[ií]o|es\s+m[ií]o|la\s+que\s+(?:lo\s+)?comanda|el\s+que\s+(?:lo\s+)?comanda|yo\s+(?:lo\s+)?comando|yo\s+mando|la\s+que\s+manda|el\s+que\s+manda|el\s+mero\s+mero|la\s+mera\s+mera|el\s+duro|la\s+dura)\b/i.test(lower);
  const isMechanic = /\b(?:mec[aá]nico|empleado|trabajador|t[eé]cnico|yo\s+arreglo|arreglo\s+las\s+motos|las\s+arreglo\s+yo)\b/i.test(lower);
  const isBoth = /\b(?:ambas|las\s+dos|ambos|ambas\s+cosas|due[ñn]o\s+y\s+mec[aá]nico|propietario\s+y\s+mec[aá]nico)\b/i.test(lower) ||
                 (isOwner && isMechanic);

  if (isBoth) {
    extracted.relacion_taller = 'Propietario y Mecánico';
  } else if (isOwner) {
    extracted.relacion_taller = 'Propietario';
  } else if (isMechanic) {
    extracted.relacion_taller = 'Mecánico';
  }

  // 11. EQUIPO / PERSONAL EN EL TALLER
  const teamMatch = raw.match(/somos\s*(\d+|dos|tres|cuatro|cinco)\s*mec[aá]nicos?/i)
    || raw.match(/(?:somos|trabajamos)\s*(\d+)\s*(?:personas|en\s+el\s+taller)?/i);
  if (teamMatch) {
    extracted.equipo_taller = teamMatch[0];
  } else if (/trabajo\s+solo|estoy\s+solo/i.test(lower)) {
    extracted.equipo_taller = 'Trabaja solo';
  }

  // 12. ESPECIALIDAD TÉCNICA
  const specs = [];
  if (/de todo|mec[aá]nica general|reparaci[oó]n general|todo/i.test(lower)) specs.push('Mecánica general');
  if (/motor|motores|ajuste|anillado/i.test(lower)) specs.push('Motor / 4T');
  if (/inyecci[oó]n|electr[oó]nica|inyeccion electr[oó]nica/i.test(lower)) specs.push('Inyección electrónica');
  if (/frenos|suspensi[oó]n/i.test(lower)) specs.push('Frenos / Suspensión');
  if (/electricidad|el[eé]ctrico/i.test(lower)) specs.push('Electricidad');
  if (specs.length > 0) {
    extracted.especialidad = specs;
  }

  // 13. MARCAS DE REPUESTOS RECOMENDADAS O USADAS (Casarella, Nitrox, originales, etc.)
  const repBrandsList = ['Casarella', 'NITROX', 'Yamaha', 'Honda', 'AKT', 'Bajaj', 'DID', 'Choho', 'Ichiban', 'Repsol', 'Motul', 'Castrol', 'NGK'];
  const detectedRepBrands = [];
  for (const rb of repBrandsList) {
    if (new RegExp(`\\b${rb}\\b`, 'i').test(lower)) {
      detectedRepBrands.push(rb);
    }
  }
  if (detectedRepBrands.length > 0) {
    extracted.marcas_repuestos_usadas = detectedRepBrands;
    extracted.frecuencia_recomendacion = 'Frecuentemente';
    if (!extracted.quien_decide_repuesto) extracted.quien_decide_repuesto = 'Mecánico';
  }

  const isAskingRec = sessionContext._askingRecommendBrands || sessionContext._lastQuestion === 'MARCA_RECOMENDADA' || sessionContext._lastQuestion === 'REPUESTOS_Y_MARCA';
  if (isAskingRec) {
    if (/^(?:no|ninguna|para\s+nada|no\s+recomiendo|no\s+manejo)$/i.test(lower) || /\b(?:no\s+recomiendo|ninguna\s+marca|no\s+tengo\s+preferencia)\b/i.test(lower)) {
      extracted.frecuencia_recomendacion = 'Nunca';
      extracted.marcas_repuestos_usadas = ['Ninguna'];
      extracted.quien_decide_repuesto = 'Cliente';
    } else if (/(?:cliente|ellos\s+traen|los\s+trae\s+el\s+cliente|el\s+due[ñn]o)/i.test(lower)) {
      extracted.frecuencia_recomendacion = 'Algunas veces';
      extracted.quien_decide_repuesto = 'Cliente';
      if (!extracted.marcas_repuestos_usadas) extracted.marcas_repuestos_usadas = ['La que traiga el cliente'];
    }
  }

  // Criterio de compra
  if (/m[aá]s\s+econ[oó]mico|donde\s+me\s+salga\s+m[aá]s\s+barato|precio|econom[ií]a/i.test(lower)) {
    extracted.criterio_compra = 'Precio / Economía';
  } else if (/calidad|original|garant[ií]a|durabilidad/i.test(lower)) {
    extracted.criterio_compra = 'Calidad y Garantía';
  }

  // 14. CONOCIMIENTO DE LA MARCA NITROX (Sí / No)
  if (/(?:no\s+(?:lo\s+|la\s+|los\s+)?conozco|primera\s+vez|no\s+he\s+escuchado|ni\s+idea|^no\b|para\s+nada|nunca\s+los\s+he\s+visto)/i.test(lower)) {
    if (sessionContext._askingNitrox || sessionContext._lastQuestion === 'NITROX_EXP_INTERES' || /\bnitrox\b/i.test(lower) || lower.split(/\s+/).length <= 4) {
      extracted.conoce_nitrox = 'No';
      extracted.ha_usado_nitrox = 'No';
    }
  } else if (/\bnitrox\b/i.test(lower) || ((sessionContext._askingNitrox || sessionContext._lastQuestion === 'NITROX_EXP_INTERES') && /^(?:s[ií]|claro|de\s+una|obvio)/i.test(lower))) {
    extracted.conoce_nitrox = 'Sí';
  }

  // 15. INTERÉS EN BENEFICIOS Y RECOMENDAR NITROX (Recomendar, Premios, Muestras, Catálogo)
  const isAskingRecNitrox = sessionContext._askingRecommendNitrox || sessionContext._lastQuestion === 'RECOMENDAR_NITROX' || sessionContext._lastQuestion === 'OFERTA_MUESTRAS' || sessionContext._lastQuestion === 'NITROX_EXP_INTERES';
  if (isAskingRecNitrox && /^(?:s[ií]|claro|de\s+una|h[aá]gale|obvio|por\s+supuesto|me\s+gustar[ií]a|s[ií]\s+claro)$/i.test(lower)) {
    extracted.recomendaria_nitrox = 'Definitivamente sí';
    extracted.quiere_muestras = 'Sí';
    extracted.interes_comercial_detalles = 'Interés en recomendar NITROX y recibir muestras/premios';
  } else if (isAskingRecNitrox && /^(?:no|paso|no\s+gracias|no\s+me\s+interesa)$/i.test(lower)) {
    extracted.recomendaria_nitrox = 'No';
    extracted.quiere_muestras = 'No';
  } else if (/\b(?:muestras|cat[aá]logo|capacitaci[oó]n|capacitaciones|conocer\s+el\s+cat[aá]logo|recibir\s+muestras|premios|beneficios)\b/i.test(lower) ||
      (/\b(?:me\s+interesa|me\s+gustar[ií]a|claro|de\s+una|h[aá]gale|obvio|por\s+supuesto|s[ií])\b/i.test(lower) && (sessionContext._offeringNitrox || sessionContext._askingRecommendNitrox))) {
    extracted.quiere_muestras = 'Sí';
    extracted.interes_comercial_detalles = 'Interés manifestado en muestras de repuestos y catálogo oficial';
  }

  // 16. CONTACTO: TELÉFONOS CELULARES (WhatsApp y alterno)
  const mobMatches = [...raw.replace(/[\s.\-()]/g, ' ').matchAll(/(?:\+?57\s*)?(3\d{9})(?!\d)/g)];
  if (mobMatches.length > 0) {
    extracted.celular_whatsapp = '57' + mobMatches[0][1];
    if (mobMatches.length > 1) {
      extracted.telefono_alterno = '57' + mobMatches[1][1];
    }
  }

  // 17. CONTACTO: CORREO ELECTRÓNICO
  const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    extracted.correo = emailMatch[0].toLowerCase();
  }

  // 18. DOCUMENTO DE IDENTIDAD: CÉDULA / NIT (Extracción estricta sin contaminar con celulares)
  const explicitId = raw.match(/\b(?:c[eé]dula|cc|c\.c\.|nit|documento)\b[:\s#]*(\b\d{7,10}(?:-\d)?\b)/i);
  if (explicitId) {
    extracted.cedula = explicitId[1];
  } else if ((sessionContext._askingCedula || sessionContext._lastQuestion === 'CEDULA') && !extracted.correo) {
    const candidateMatch = raw.match(/\b\d{7,10}\b/);
    if (candidateMatch) {
      const num = candidateMatch[0];
      // Solo asignar si NO coincide con un celular extraído en este mensaje
      if (!extracted.celular_whatsapp || !extracted.celular_whatsapp.includes(num)) {
        extracted.cedula = num;
      }
    }
  }

  // 19. HABEAS DATA - AUTORIZACIÓN LEGAL DE TRATAMIENTO DE DATOS
  if (sessionContext._waitingHabeasData || sessionContext._lastQuestion === 'HABEAS_DATA') {
    if (/(?:no\s*gracias|no\s*acepto|no\s*autorizo|^no\b|para\s*nada|negativo)/i.test(lower)) {
      extracted.autorizacion_habeas_data = false;
    } else if (/(?:s[ií]|acepto|autorizo|claro|de\s+una|h[aá]gale|con\s+gusto|de\s+acuerdo|ok|listo)/i.test(lower)) {
      extracted.autorizacion_habeas_data = true;
    }
  }

  // 20. EXTRACCIÓN MULTIINTENCIÓN DE NOMBRE Y TALLER
  if (!extracted.nombres_apellidos) {
    const explicitPersonMatch = raw.match(/\b(?:yo\s+soy|soy|me\s+llamo|mi\s+nombre\s+es|mi\s+nombre\s+completo\s+es|puedes\s+decirme)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúñÑ]+){0,3})\b/i);
    if (explicitPersonMatch) {
      let cand = explicitPersonMatch[1].trim();
      cand = cand.replace(/\s+(?:y|e|pero|para|que|de|del|con)\b.*$/i, '').trim();
      cand = cand.replace(/\s+(?:gerente|propietario|mecanico|mecánico|dueño).*$/i, '').trim();
      cand = cand.replace(/\s+(?:pero\s+dime|dime).*$/i, '').trim();
      if (cand && !/\b(?:propietario|mecanico|mecánico|dueño|cliente|independiente|taller|motos)\b/i.test(cand)) {
        extracted.nombres_apellidos = cand.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
    }
  }

  if (!extracted.nombre_taller && !extracted.no_tiene_taller) {
    const explicitShopIntro = raw.match(/\b(?:el\s+taller\s+se\s+llama|mi\s+taller\s+se\s+llama|el\s+negocio\s+se\s+llama)\s+([A-Za-z0-9ÁÉÍÓÚáéíóúñÑ\s#\-\.]{2,35}?)(?:\s+(?:y|en|pero|para|que|con)|\s*$)/i);
    if (explicitShopIntro) {
      const sCand = explicitShopIntro[1].trim();
      if (!/\b(?:hola|buenas|soy|yo|si|no)\b/i.test(sCand)) {
        extracted.nombre_taller = sCand.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
    }
  }

  // 21. CATÁLOGO DE INTENCIONES DETECTADAS (MULTIINTENCIÓN)
  const intList = [];
  if (extracted.es_saludo) intList.push('saludo');
  if (extracted.es_despedida) intList.push('despedida');
  if (extracted.es_pausa) intList.push('pausa');
  if (extracted.despedida_con_pregunta) intList.push('despedida_con_pregunta');
  if (extracted.nombres_apellidos) intList.push('nombre_personal');
  if (extracted.nombre_taller && !extracted.no_tiene_taller) intList.push('nombre_taller');
  if (extracted.no_tiene_taller) intList.push('no_tiene_taller');
  if (extracted.intencion_compra) intList.push('compra');
  if (extracted.intencion_cotizacion) intList.push('cotizacion');
  if (extracted.cotizacion_multiple) intList.push('cotizacion_multiple');
  if (extracted.consulta_catalogo) intList.push('consulta_catalogo');
  if (extracted.consulta_compatibilidad) intList.push('consulta_compatibilidad');
  if (extracted.consulta_ubicacion) intList.push('consulta_ubicacion');
  if (extracted.rechazo_registro) intList.push('rechazo_registro');
  if (extracted.intencion_retomar_formulario) intList.push('retomar_formulario');
  if (extracted.protesta_repeticion) intList.push('protesta_repeticion');
  if (extracted.autorizacion_habeas_data !== null) intList.push('habeas_data');
  extracted.intenciones_detectadas = intList;

  return extracted;
}

/**
 * Pipeline integral de NLP en Español para MATEO.
 * Ejecuta: Normalización -> Tokenización -> Lematización -> Extracción Semántica.
 */
function processNlpPipeline(rawText, sessionContext = {}) {
  const norm = normalizeText(rawText);
  const tokenInfo = tokenize(norm.normalized);
  const lemmas = lemmatize(tokenInfo, norm.normalized);
  const entities = extractSemanticEntities(norm.normalized, sessionContext);

  return {
    originalText: norm.original,
    normalizedText: norm.normalized,
    tokens: tokenInfo.rawTokens,
    multiWords: tokenInfo.multiWords,
    lemmas: lemmas,
    entities: entities
  };
}

module.exports = {
  normalizeText,
  tokenize,
  lemmatize,
  extractSemanticEntities,
  processNlpPipeline
};
