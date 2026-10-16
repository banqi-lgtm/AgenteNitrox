// registration_engine.js - Motor Central de la Ficha Maestra RED NITROX
// Define la lista maestra de campos, validaciones de integridad, estados y progreso real de vinculación.

/**
 * Estados formales para cada campo de la ficha comercial
 */
const FIELD_STATES = {
  PENDIENTE: 'PENDIENTE',
  IDENTIFICADO: 'IDENTIFICADO',
  CONFIRMADO: 'CONFIRMADO',
  NO_APLICA: 'NO_APLICA',
  RECHAZADO: 'RECHAZADO',
  REQUIERE_ACLARACION: 'REQUIERE_ACLARACION'
};

/**
 * Lista Maestra de Campos del CRM RED NITROX
 * Define obligatoriedad, sección, validadores y dependencias lógicas.
 */
const MASTER_FIELDS = {
  // --- A. DATOS DEL MECÁNICO ---
  nombres_apellidos: {
    key: 'nombres_apellidos',
    label: 'Nombre completo del mecánico',
    section: 'A',
    mandatory: true,
    weight: 10,
    isValid: (val) => Boolean(val && typeof val === 'string' && val.trim().length >= 2 && !/^(?:no especificado|n\/a|mecanico|mecánico|tu taller|taller)$/i.test(val.trim()))
  },
  cedula: {
    key: 'cedula',
    label: 'Cédula o documento de identidad',
    section: 'A',
    mandatory: false, // Permitido rechazar respetando la negativa del mecánico
    weight: 5,
    isValid: (val) => Boolean(val && typeof val === 'string' && /^\d{6,12}(?:-\d)?$/.test(val.trim()))
  },
  celular_whatsapp: {
    key: 'celular_whatsapp',
    label: 'Celular o WhatsApp del taller',
    section: 'A',
    mandatory: true,
    weight: 5,
    isValid: (val) => Boolean(val && (typeof val === 'string' || typeof val === 'number') && val.toString().replace(/\D/g, '').length >= 10)
  },
  correo: {
    key: 'correo',
    label: 'Correo electrónico para beneficios',
    section: 'A',
    mandatory: false, // Permitido rechazar si el mecánico no usa correo
    weight: 5,
    isValid: (val) => Boolean(val && typeof val === 'string' && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(val.trim()))
  },
  ciudad_residencia: {
    key: 'ciudad_residencia',
    label: 'Ciudad de residencia',
    section: 'A',
    mandatory: false,
    weight: 3,
    isValid: (val) => Boolean(val && typeof val === 'string' && val.trim().length >= 3 && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },

  // --- B. DATOS DEL TALLER ---
  nombre_taller: {
    key: 'nombre_taller',
    label: 'Nombre del taller de motos',
    section: 'B',
    mandatory: true,
    weight: 10,
    isValid: (val) => Boolean(val && typeof val === 'string' && val.trim().length >= 2 && !/^(?:no especificado|n\/a|tu taller|el taller|taller)$/i.test(val.trim()))
  },
  ciudad_taller: {
    key: 'ciudad_taller',
    label: 'Ciudad o municipio del taller',
    section: 'B',
    mandatory: true,
    weight: 8,
    isValid: (val) => Boolean(val && typeof val === 'string' && val.trim().length >= 3 && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  barrio_taller: {
    key: 'barrio_taller',
    label: 'Barrio o sector del taller',
    section: 'B',
    mandatory: false,
    weight: 5,
    isValid: (val) => Boolean(val && typeof val === 'string' && val.trim().length >= 2 && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  direccion_taller: {
    key: 'direccion_taller',
    label: 'Dirección o referencia del taller',
    section: 'B',
    mandatory: false,
    weight: 4,
    isValid: (val) => Boolean(val && typeof val === 'string' && val.trim().length >= 3 && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  relacion_taller: {
    key: 'relacion_taller',
    label: 'Rol en el taller (dueño, mecánico, ambos o socio)',
    section: 'B',
    mandatory: true,
    weight: 8,
    isValid: (val) => Boolean(val && typeof val === 'string' && /^(?:propietario|mec[aá]nico|propietario y mec[aá]nico|due[ñn]o y mec[aá]nico|due[ñn]o|socio|administrador)$/i.test(val.trim()))
  },
  antiguedad_taller: {
    key: 'antiguedad_taller',
    label: 'Años de funcionamiento del taller',
    section: 'B',
    mandatory: false,
    weight: 4,
    isValid: (val) => Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a|no especificada)$/i.test(val.trim()))
  },
  personas_taller: {
    key: 'personas_taller',
    label: 'Cantidad de personas en el taller',
    section: 'B',
    mandatory: false,
    weight: 4,
    isValid: (val) => Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },

  // --- C. PERFIL PROFESIONAL Y ESPECIALIDAD ---
  experiencia_mecanico: {
    key: 'experiencia_mecanico',
    label: 'Años de experiencia del mecánico',
    section: 'C',
    mandatory: false,
    weight: 4,
    isValid: (val) => Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a|no especificada)$/i.test(val.trim()))
  },
  especialidad: {
    key: 'especialidad',
    label: 'Especialidades técnicas (mecánica general, motor, inyección, etc.)',
    section: 'C',
    mandatory: true,
    weight: 7,
    isValid: (val) => Array.isArray(val) ? val.length > 0 : Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  marcas_motos: {
    key: 'marcas_motos',
    label: 'Marcas de motos atendidas con frecuencia',
    section: 'C',
    mandatory: true,
    weight: 8,
    isValid: (val) => Array.isArray(val) ? val.length > 0 : Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },

  // --- D. POTENCIAL E INFLUENCIA COMERCIAL ---
  motos_por_semana: {
    key: 'motos_por_semana',
    label: 'Flujo o volumen de motos atendidas por semana',
    section: 'D',
    mandatory: true,
    weight: 8,
    isValid: (val) => Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  quien_decide_repuesto: {
    key: 'quien_decide_repuesto',
    label: 'Quién decide la marca de repuestos a comprar',
    section: 'D',
    mandatory: false,
    weight: 4,
    isValid: (val) => Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  frecuencia_recomendacion: {
    key: 'frecuencia_recomendacion',
    label: 'Frecuencia con la que recomienda repuestos al cliente',
    section: 'D',
    mandatory: false,
    weight: 3,
    isValid: (val) => Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },

  // --- E. COMPORTAMIENTO DE COMPRA Y MARCAS ---
  repuestos_frecuentes: {
    key: 'repuestos_frecuentes',
    label: 'Repuestos de mayor rotación (kits de arrastre, pastillas, etc.)',
    section: 'E',
    mandatory: true,
    weight: 8,
    isValid: (val) => Array.isArray(val) ? val.length > 0 : Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  donde_compra_repuestos: {
    key: 'donde_compra_repuestos',
    label: 'Dónde compra los repuestos (almacén, distribuidor, etc.)',
    section: 'E',
    mandatory: false,
    weight: 4,
    isValid: (val) => Array.isArray(val) ? val.length > 0 : Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  marcas_repuestos_usadas: {
    key: 'marcas_repuestos_usadas',
    label: 'Marcas de repuestos que utiliza o recomienda',
    section: 'E',
    mandatory: true,
    weight: 5,
    isValid: (val) => Array.isArray(val) ? val.length > 0 : Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },
  factores_eleccion_repuesto: {
    key: 'factores_eleccion_repuesto',
    label: 'Factores de elección de repuestos (precio, calidad, garantía)',
    section: 'E',
    mandatory: false,
    weight: 3,
    isValid: (val) => Array.isArray(val) ? val.length > 0 : Boolean(val && typeof val === 'string' && !/^(?:no especificado|n\/a)$/i.test(val.trim()))
  },

  // --- F. RELACIÓN CON NITROX ---
  conoce_nitrox: {
    key: 'conoce_nitrox',
    label: 'Si conoce la marca NITROX',
    section: 'F',
    mandatory: true,
    weight: 5,
    isValid: (val) => Boolean(val && /^(?:s[ií]|no)$/i.test(val.toString().trim()))
  },
  ha_usado_nitrox: {
    key: 'ha_usado_nitrox',
    label: 'Si ha utilizado repuestos NITROX',
    section: 'F',
    mandatory: false,
    weight: 3,
    isValid: (val) => Boolean(val && /^(?:s[ií]|no|no aplica)$/i.test(val.toString().trim()))
  },

  // --- G. INTERÉS EN RED NITROX ---
  quiere_muestras: {
    key: 'quiere_muestras',
    label: 'Interés en recibir catálogo y muestras oficiales',
    section: 'G',
    mandatory: true,
    weight: 6,
    isValid: (val) => Boolean(val && /^(?:s[ií]|no)$/i.test(val.toString().trim()))
  },

  // --- H. AUTORIZACIONES LEGALES (HABEAS DATA) ---
  autorizacion_tratamiento_datos: {
    key: 'autorizacion_tratamiento_datos',
    label: 'Autorización expresa para tratamiento de datos personales',
    section: 'H',
    mandatory: true,
    weight: 10,
    isValid: (val) => val === true || val === false
  },
  autorizacion_comunicaciones_comerciales: {
    key: 'autorizacion_comunicaciones_comerciales',
    label: 'Autorización para comunicaciones comerciales por WhatsApp',
    section: 'H',
    mandatory: false,
    weight: 3,
    isValid: (val) => val === true || val === false
  }
};

/**
 * Calcula el progreso real y exhaustivo de la vinculación contra la Lista Maestra del CRM.
 * Devuelve estado de cada campo, porcentaje real, pendientes y autorización determinística de cierre.
 */
function getRegistrationProgress(sessionData = {}, memory = {}) {
  const confirmedData = memory.confirmedFacts || {};
  const rejectedFields = memory.rejectedFields || {};
  const data = sessionData || {};

  const fieldStatus = {};
  const confirmed = [];
  const pending = [];
  const rejected = [];
  const notApplicable = [];
  const missingMandatory = [];

  let totalWeight = 0;
  let earnedWeight = 0;

  for (const [key, def] of Object.entries(MASTER_FIELDS)) {
    totalWeight += def.weight;

    // 1. Obtener valor real evitando marcadores vacíos
    let rawVal = confirmedData[key]?.value !== undefined ? confirmedData[key].value : data[key];

    // 2. Verificar si el usuario lo rechazó expresamente
    if (rejectedFields[key]) {
      fieldStatus[key] = {
        state: FIELD_STATES.RECHAZADO,
        reason: rejectedFields[key].reason || 'Rechazado por el usuario'
      };
      rejected.push({ key, label: def.label, reason: rejectedFields[key].reason });
      // Si era opcional o rechazado legítimamente, suma crédito parcial en avance
      if (!def.mandatory) {
        earnedWeight += def.weight * 0.75;
      }
      continue;
    }

    // 3. Regla F: Si nunca ha usado NITROX, calificación y experiencia NO APLICAN legítimamente
    if (key === 'ha_usado_nitrox' && (data.conoce_nitrox === 'No' || confirmedData['conoce_nitrox']?.value === 'No')) {
      fieldStatus[key] = { state: FIELD_STATES.NO_APLICA };
      notApplicable.push(key);
      earnedWeight += def.weight;
      continue;
    }

    // 3b. Regla C: Si no se especificó especialidad pero ya se conocen marcas o repuestos, asume 'Mecánica general'
    if (key === 'especialidad' && (!rawVal || (Array.isArray(rawVal) && rawVal.length === 0))) {
      if (data.marcas_motos || confirmedData['marcas_motos'] || data.repuestos_frecuentes || confirmedData['repuestos_frecuentes']) {
        rawVal = ['Mecánica general'];
      }
    }

    // 3c. Regla A: Si no se especificó ciudad de residencia, hereda la ciudad del taller
    if (key === 'ciudad_residencia' && !rawVal) {
      rawVal = data.ciudad_taller || confirmedData['ciudad_taller']?.value;
    }

    // 4. Validar valor contra validador estricto del campo
    const isValidValue = def.isValid(rawVal);

    if (isValidValue) {
      fieldStatus[key] = { state: FIELD_STATES.CONFIRMADO, value: rawVal };
      confirmed.push(key);
      earnedWeight += def.weight;
    } else {
      fieldStatus[key] = { state: FIELD_STATES.PENDIENTE };
      pending.push({
        key,
        label: def.label,
        section: def.section,
        mandatory: def.mandatory
      });

      if (def.mandatory) {
        missingMandatory.push({ key, label: def.label });
      }
    }
  }

  const progressPercentage = Math.min(100, Math.round((earnedWeight / totalWeight) * 100));

  // VALIDACIÓN DETERMINÍSTICA DE CIERRE:
  // Para poder generar credencial y carnet, NO puede faltar NINGÚN campo obligatorio
  // y la autorización de Habeas Data debe ser estrictamente afirmativa (true).
  const habeasDataConsent = fieldStatus['autorizacion_tratamiento_datos']?.value;
  const canFinalize = Boolean(
    missingMandatory.length === 0 &&
    habeasDataConsent === true &&
    progressPercentage >= 75
  );

  return {
    progressPercentage,
    fieldStatus,
    confirmed,
    pending,
    rejected,
    notApplicable,
    missingMandatory,
    canFinalize
  };
}

/**
 * Organiza los temas pendientes en una secuencia conversacional natural y cercana.
 */
function getConversationalPendingTopics(sessionData = {}, memory = {}) {
  const progress = getRegistrationProgress(sessionData, memory);

  if (progress.canFinalize || (sessionData._finished && sessionData.id_unico) || (memory.confirmedFacts?._finished?.value === true && memory.confirmedFacts?.id_unico?.value)) {
    return [];
  }

  // Filtrar de los campos pendientes ordenados por flujo comercial
  const flowOrder = [
    'nombres_apellidos',
    'nombre_taller',
    'ciudad_taller',
    'barrio_taller',
    'direccion_taller',
    'relacion_taller',
    'marcas_motos',
    'motos_por_semana',
    'repuestos_frecuentes',
    'marcas_repuestos_usadas',
    'conoce_nitrox',
    'quiere_muestras',
    'correo',
    'cedula',
    'autorizacion_tratamiento_datos'
  ];

  const orderedPending = [];
  for (const fieldKey of flowOrder) {
    const item = progress.pending.find(p => p.key === fieldKey);
    if (item) {
      orderedPending.push(item);
    }
  }

  return orderedPending;
}

module.exports = {
  FIELD_STATES,
  MASTER_FIELDS,
  getRegistrationProgress,
  getConversationalPendingTopics
};
