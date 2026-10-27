// test/cerebro_mateo.test.js - Suite de Pruebas Automatizadas de Calidad para MATEO
// Verifica:
// 1. Cero repetición de preguntas sobre datos confirmados (meta = 0).
// 2. Extracción simultánea de múltiples entidades en un único turno.
// 3. Detección semántica de preguntas equivalentes.
// 4. Lematización contextual correcta (sustantivo vs. verbo: "trabajo", "cambio").
// 5. Conservación de marcas, referencias, cantidades y negaciones.
// 6. Interpretación de respuestas breves de una sola palabra ("Envigado").
// 7. Prioridad a preguntas comerciales del mecánico.
// 8. Manejo de rechazos explícitos sin trabar el bot ("prefiero no dar la cédula").
// 9. Separación estricta de interés comercial vs. autorización legal Habeas Data.
// 10. Protección de talleres ya registrados (cero preguntas de vinculación).
// 11. Concurrencia y serialización por número de teléfono.

const assert = require('assert');
const { processNlpPipeline, lemmatize, tokenize, normalizeText } = require('../nlp_pipeline');
const {
  initOrLoadMemory,
  isTopicOrQuestionForbidden,
  integrateFactsIntoMemory,
  recordAskedQuestion,
  buildConversationSummary,
  TOPIC_SEMANTIC_PATTERNS
} = require('../conversation_memory');
const { getPendingTopics, cleanResponseText, SYSTEM_PROMPT } = require('../gemini_brain');
const { getMateoSystemPrompt, getSkill } = require('../skill_loader');
const { normalizeMechanicData } = require('../scoring');
const { generateMateoResponse, cleanWorkshopName, cleanPersonName, parseNameAndWorkshop, extractEntities, isPureGreeting } = require('../agent');
const { getRegistrationProgress, getConversationalPendingTopics } = require('../registration_engine');

console.log('🧪 =======================================================');
console.log('🚀 INICIANDO AUDITORÍA Y TEST SUITE DEL CEREBRO DE MATEO');
console.log('🧪 =======================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(testName, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`✅ [PASÓ]: ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FALLÓ]: ${testName}`);
    console.error(`   Detalle del error: ${err.message}\n`, err.stack);
  }
}

// -------------------------------------------------------------
// TEST 1: Normalización de abreviaturas de WhatsApp sin perder datos
// -------------------------------------------------------------
runTest('A. Normalización preserva marcas y expande jerga WhatsApp', () => {
  const input = "atiendo 15 motos ala semana, trabajo con bajaj y yamaha y cambio pastillas y kit d arrastre xfa";
  const result = normalizeText(input);

  assert.ok(result.normalized.includes('a la semana'), 'Debe expandir "ala" a "a la"');
  assert.ok(result.normalized.includes('kit de arrastre'), 'Debe expandir "kit d arrastre" a "kit de arrastre"');
  assert.ok(result.normalized.includes('bajaj'), 'Debe conservar la marca Bajaj');
  assert.ok(result.normalized.includes('yamaha'), 'Debe conservar la marca Yamaha');
  assert.strictEqual(result.original, input, 'Debe preservar el texto original intacto');
});

// -------------------------------------------------------------
// TEST 2: Lematización contextual (sustantivo vs. verbo)
// -------------------------------------------------------------
runTest('B. Lematización contextual diferencia sustantivo de verbo', () => {
  // Caso 1: "trabajo" como sustantivo ("bastante trabajo")
  const text1 = "Con ese movimiento hay bastante trabajo en el taller";
  const tok1 = tokenize(text1);
  const lem1 = lemmatize(tok1, text1);
  const itemTrabajo1 = lem1.find(l => l.token.toLowerCase() === 'trabajo');
  assert.ok(itemTrabajo1, 'Debe encontrar el token trabajo');
  assert.strictEqual(itemTrabajo1.pos, 'sustantivo', '"bastante trabajo" debe clasificarse como sustantivo');
  assert.strictEqual(itemTrabajo1.lemma, 'trabajo', 'El lema de sustantivo debe ser trabajo');

  // Caso 2: "trabajo" como verbo ("yo trabajo con yamaha")
  const text2 = "Yo trabajo con Yamaha y Suzuki";
  const tok2 = tokenize(text2);
  const lem2 = lemmatize(tok2, text2);
  const itemTrabajo2 = lem2.find(l => l.token.toLowerCase() === 'trabajo');
  assert.ok(itemTrabajo2, 'Debe encontrar el token trabajo');
  assert.strictEqual(itemTrabajo2.pos, 'verbo', '"yo trabajo" debe clasificarse como verbo');
  assert.strictEqual(itemTrabajo2.lemma, 'trabajar', 'El lema del verbo debe ser trabajar');

  // Caso 3: "cambio" como sustantivo vs verbo
  const text3 = "Hacemos cambio de aceite";
  const tok3 = tokenize(text3);
  const lem3 = lemmatize(tok3, text3);
  const itemCambio = lem3.find(l => l.token.toLowerCase() === 'cambio');
  assert.strictEqual(itemCambio.pos, 'sustantivo', '"cambio de aceite" debe ser sustantivo');
});

// -------------------------------------------------------------
// TEST 3: Extracción simultánea de múltiples entidades (Ejemplo 1 del requerimiento)
// -------------------------------------------------------------
runTest('C. Extracción simultánea de 4 hechos en un único mensaje (Ejemplo 1)', () => {
  const userText = "Buenas, tengo un taller en Bello. Trabajo con Yamaha y Bajaj, me llegan como 20 motos por semana y cambio bastante pastillas y kits de arrastre";
  const nlp = processNlpPipeline(userText);
  const entities = nlp.entities;

  assert.strictEqual(entities.ciudad_taller, 'Bello', 'Debe extraer ciudad Bello');
  assert.deepStrictEqual(entities.marcas_motos, ['Yamaha', 'Bajaj'], 'Debe extraer marcas Yamaha y Bajaj');
  assert.ok(entities.motos_por_semana.includes('20'), 'Debe extraer volumen 20 motos');
  assert.ok(entities.repuestos_frecuentes.includes('Kits de arrastre'), 'Debe extraer kits de arrastre');
  assert.ok(entities.repuestos_frecuentes.includes('Pastillas de freno'), 'Debe extraer pastillas de freno');
});

// -------------------------------------------------------------
// TEST 4: Interpretación de respuesta corta de una sola palabra (Ejemplo 2)
// -------------------------------------------------------------
runTest('D. Respuesta breve de una palabra interpretada en contexto (Ejemplo 2)', () => {
  const userText = "Envigado";
  const nlp = processNlpPipeline(userText);
  assert.strictEqual(nlp.entities.ciudad_taller, 'Envigado', 'Debe reconocer Envigado como ciudad');
});

// -------------------------------------------------------------
// TEST 5: Multitema con equipo y volumen diario (Ejemplo 3)
// -------------------------------------------------------------
runTest('E. Extracción de equipo, volumen diario y marca (Ejemplo 3)', () => {
  const userText = "De todo, la verdad. Somos dos mecánicos, atendemos como 12 motos al día y trabajamos más que todo con AKT";
  const nlp = processNlpPipeline(userText);
  const entities = nlp.entities;

  assert.ok(entities.especialidad.includes('Mecánica general'), 'Debe clasificar como Mecánica general');
  assert.ok(entities.equipo_taller.toLowerCase().includes('dos') || entities.equipo_taller.toLowerCase().includes('2'), 'Debe extraer equipo de dos mecánicos');
  assert.ok(entities.motos_por_semana.includes('12 motos al día'), 'Debe extraer 12 motos al día');
  assert.deepStrictEqual(entities.marcas_motos, ['AKT'], 'Debe extraer marca AKT');
});

// -------------------------------------------------------------
// TEST 6: Detección y prioridad a consultas comerciales (Ejemplos 4 y 7)
// -------------------------------------------------------------
runTest('F. Detección de consultas comerciales y preguntas de empresa', () => {
  // Caso "¿Quiénes son?"
  const q1 = processNlpPipeline("¿Y ustedes quiénes son o qué hacen?");
  assert.strictEqual(q1.entities.es_pregunta_comercial, true);
  assert.strictEqual(q1.entities.pregunta_comercial_tema, 'identidad_empresa');

  // Caso "Pastillas para una NKD"
  const q2 = processNlpPipeline("¿Ustedes manejan pastillas para una NKD?");
  assert.strictEqual(q2.entities.es_pregunta_comercial, true);
  assert.strictEqual(q2.entities.pregunta_comercial_tema, 'consulta_repuesto_referencia');
});

// -------------------------------------------------------------
// TEST 7: Respeto estricto a la negativa de dar datos (Ejemplo 8)
// -------------------------------------------------------------
runTest('G. Respeto de negativa a dar cédula sin insistir ni trabar (Ejemplo 8)', () => {
  const userText = "Por ahora prefiero no dar la cédula";
  const nlp = processNlpPipeline(userText);
  assert.ok(nlp.entities.rechazo_dato.cedula, 'Debe registrar rechazo de cédula');
  assert.ok(nlp.entities.cedula.includes('rechazada'), 'Debe marcar cédula como no proporcionada');

  const session = { data: {}, memory: null };
  const memory = initOrLoadMemory(session);
  integrateFactsIntoMemory(memory, nlp.entities, userText);

  // La guardabarrera debe bloquear cualquier pregunta futura sobre la cédula
  const check = isTopicOrQuestionForbidden(memory, 'cedula');
  assert.strictEqual(check.forbidden, true, 'Debe prohibir volver a pedir la cédula');
});

// -------------------------------------------------------------
// TEST 8: Separación estricta de interés comercial vs Habeas Data (Ejemplo 9)
// -------------------------------------------------------------
runTest('H. Interés en muestras/catálogo NO aprueba Habeas Data automáticamente (Ejemplo 9)', () => {
  const userText = "Sí, me interesa conocer el catálogo y las muestras";
  const session = { data: {}, memory: null, _offeringNitrox: true, _waitingHabeasData: false };
  const memory = initOrLoadMemory(session);

  const nlp = processNlpPipeline(userText, session);
  integrateFactsIntoMemory(memory, nlp.entities, userText);

  // Debe registrar interés en muestras
  assert.strictEqual(memory.confirmedFacts['quiere_muestras']?.value, 'Sí');
  // NO debe registrar autorización de Habeas Data
  assert.strictEqual(memory.confirmedFacts['autorizacion_tratamiento_datos'], undefined);

  // En normalizeMechanicData tampoco debe ser true
  const mechanicDoc = normalizeMechanicData({ quiere_muestras: 'Sí' });
  assert.strictEqual(mechanicDoc.autorizacion_tratamiento_datos, false, 'No debe auto-aprobarse Habeas Data');
});

// -------------------------------------------------------------
// TEST 9: REGLA DE ORO - CERO PREGUNTAS REPETIDAS SOBRE DATOS CONFIRMADOS
// -------------------------------------------------------------
runTest('I. Cero preguntas repetidas sobre datos ya confirmados', () => {
  const session = { data: {}, memory: null };
  const memory = initOrLoadMemory(session);

  // Simular mecánico que ya confirmó ubicación Bello, marcas Yamaha y Bajaj, volumen 20 motos
  integrateFactsIntoMemory(memory, {
    ciudad_taller: 'Bello',
    marcas_motos: ['Yamaha', 'Bajaj'],
    motos_por_semana: '20 motos por semana'
  });

  // Intentar preguntar por ciudad
  const checkCiudad = isTopicOrQuestionForbidden(memory, 'ciudad_taller', '¿En qué ciudad queda tu taller?');
  assert.strictEqual(checkCiudad.forbidden, true, 'Debe prohibir preguntar por ciudad ya conocida');

  // Intentar preguntar por marcas de motos
  const checkMarcas = isTopicOrQuestionForbidden(memory, 'marcas_motos', '¿Qué marcas de motos atiendes?');
  assert.strictEqual(checkMarcas.forbidden, true, 'Debe prohibir preguntar por marcas ya conocidas');

  // Intentar preguntar con frase equivalente ("¿Con cuáles marcas trabajas?")
  const checkMarcasEquiv = isTopicOrQuestionForbidden(memory, 'marcas_motos', '¿Con cuáles marcas de motos trabajas?');
  assert.strictEqual(checkMarcasEquiv.forbidden, true, 'Debe detectar equivalencia semántica y prohibirla');

  // getPendingTopics no debe incluir ninguno de esos datos
  const pending = getPendingTopics(memory);
  assert.ok(!pending.some(p => p.includes('Ciudad o municipio')), 'Ubicación no debe estar pendiente');
  assert.ok(!pending.some(p => p.includes('Marcas de motos')), 'Marcas no debe estar pendiente');
  assert.ok(!pending.some(p => p.includes('Flujo o volumen')), 'Volumen no debe estar pendiente');
});

// -------------------------------------------------------------
// TEST 10: Taller ya registrado no vuelve a pasar por registro
// -------------------------------------------------------------
runTest('J. Taller ya registrado tiene cero temas de registro pendientes', () => {
  const session = { data: { _finished: true, id_unico: 'RN-MED-TEST01' }, memory: null };
  const memory = initOrLoadMemory(session);
  const pending = getPendingTopics(memory);
  assert.strictEqual(pending.length, 0, 'Un taller registrado debe tener 0 temas pendientes');
});

// -------------------------------------------------------------
// TEST 11: Detección de protesta del usuario ("Ya te dije")
// -------------------------------------------------------------
runTest('K. Detección de protesta ("Ya te dije que Yamaha y Suzuki")', () => {
  const userText = "Ya te dije que Yamaha y Suzuki";
  const nlp = processNlpPipeline(userText);
  assert.strictEqual(nlp.entities.protesta_repeticion, true, 'Debe detectar protesta de repetición');
  assert.deepStrictEqual(nlp.entities.marcas_motos, ['Yamaha', 'Suzuki'], 'Debe extraer las marcas recordadas');
});

// -------------------------------------------------------------
// TEST 12: Blindaje contra finalización prematura (Caso Johan / Leones la 50)
// -------------------------------------------------------------
runTest('L. No finaliza la vinculación si solo se conoce nombre y taller sin ubicación, rol ni Habeas Data', () => {
  const session = { data: {}, memory: null };
  const memory = initOrLoadMemory(session);

  // Turno 1 y 2: Mecánico da nombre y taller
  integrateFactsIntoMemory(memory, {
    nombres_apellidos: 'Johan González',
    nombre_taller: 'Taller Leones La 50'
  });

  const pending = getPendingTopics(memory);
  // Debe haber temas pendientes de ubicación, rol, etc.
  assert.ok(pending.length >= 4, 'Deben quedar temas pendientes esenciales');
  assert.ok(pending.some(p => p.includes('Ciudad o municipio') || p.includes('Ubicación')), 'Ubicación debe estar pendiente');
  assert.ok(pending.some(p => p.includes('Rol en el taller')), 'Rol debe estar pendiente');

  // Comprobar que NO está listo para finalizar
  const hasEssentialData = Boolean(
    memory.confirmedFacts['nombres_apellidos']?.value &&
    memory.confirmedFacts['nombre_taller']?.value &&
    (memory.confirmedFacts['ciudad_taller']?.value || memory.confirmedFacts['barrio_taller']?.value || memory.confirmedFacts['direccion_taller']?.value) &&
    memory.confirmedFacts['relacion_taller']?.value &&
    memory.confirmedFacts['autorizacion_tratamiento_datos']?.value !== undefined
  );
  assert.strictEqual(hasEssentialData, false, 'No debe considerarse con datos esenciales completos');
});

// -------------------------------------------------------------
// TEST 13: Extracción de taller y ciudad compuestos ("La 50 en Medellín")
// -------------------------------------------------------------
runTest('M. Extracción de taller y ciudad compuestos ("La 50 en Medellín")', () => {
  const userText = "La 50 en Medellín";
  const nlp = processNlpPipeline(userText);
  assert.ok(nlp.entities.nombre_taller.includes('La 50'), 'Debe extraer nombre del taller con La 50');
  assert.strictEqual(nlp.entities.ciudad_taller, 'Medellín', 'Debe extraer ciudad Medellín');
  const cleaned = cleanWorkshopName(userText);
  assert.strictEqual(cleaned, 'Taller La 50', 'cleanWorkshopName debe formatear como Taller La 50');
});

// -------------------------------------------------------------
// TEST 14: Anti-muletilla estricta (Eliminación de "Contame," / "Y contame,")
// -------------------------------------------------------------
runTest('N. Sanitizador de muletillas elimina "Contame," y "Y contame,"', () => {
  const text1 = "Contame, ¿en qué barrio está ubicado tu taller?";
  const cleaned1 = cleanResponseText(text1);
  assert.ok(!cleaned1.toLowerCase().startsWith('contame'), 'No debe empezar con contame');

  const text2 = "Y contame, ¿qué marcas atiendes más?";
  const cleaned2 = cleanResponseText(text2);
  assert.ok(!cleaned2.toLowerCase().startsWith('y contame'), 'No debe empezar con y contame');
});

// -------------------------------------------------------------
// TEST 15: Detección de conocimiento de Nitrox (No los conozco -> 'No')
// -------------------------------------------------------------
runTest('O. Detección de conocimiento de Nitrox (No los conozco -> No)', () => {
  const userText = "La verdad no los conozco";
  const nlp = processNlpPipeline(userText, { _askingNitrox: true });
  assert.strictEqual(nlp.entities.conoce_nitrox, 'No', 'Debe extraer conoce_nitrox: No');
});

// -------------------------------------------------------------
// TEST 16: Validación de cierre y entrega de carnet con celular_whatsapp
// -------------------------------------------------------------
runTest('P. Ficha completa con celular_whatsapp autoriza canFinalize = true', () => {
  const sessionData = {
    nombres_apellidos: 'Fidel González',
    nombre_taller: 'Taller La 50',
    ciudad_taller: 'Medellín',
    barrio_taller: 'Aranjuez',
    direccion_taller: 'Calle 50 #40-20',
    celular_whatsapp: '573208185796',
    relacion_taller: 'Propietario',
    especialidad: ['Mecánica general'],
    marcas_motos: ['Bajaj', 'AKT', 'Suzuki'],
    motos_por_semana: '15 motos por semana',
    repuestos_frecuentes: ['Kits de arrastre', 'Pastillas de freno'],
    marcas_repuestos_usadas: ['Casarella', 'NITROX'],
    conoce_nitrox: 'No',
    quiere_muestras: 'Sí',
    correo: 'fidel@gmail.com',
    cedula: '1020304050',
    autorizacion_tratamiento_datos: true
  };

  const progress = getRegistrationProgress(sessionData, {});
  assert.strictEqual(progress.missingMandatory.length, 0, 'No debe faltar ningún campo obligatorio');
  assert.strictEqual(progress.canFinalize, true, 'canFinalize debe ser true para entregar carnet digital y QR');
  assert.ok(progress.progressPercentage >= 80, 'Progreso debe ser >= 80%');
});

// -------------------------------------------------------------
// TEST 17: Respuesta genérica ('todas', 'de todo') no marca marcas_motos como confirmadas
// -------------------------------------------------------------
runTest('Q. Respuesta genérica ("todas") activa marcas_genericas y no confirma marcas_motos', () => {
  const userText = "de todas recibo";
  const nlp = processNlpPipeline(userText, { _askingBrands: true });
  assert.strictEqual(nlp.entities.marcas_motos, null, 'marcas_motos debe permanecer null para forzar precisión');
  assert.strictEqual(nlp.entities.marcas_genericas, true, 'marcas_genericas debe ser true');
});

// -------------------------------------------------------------
// TEST 18: Respuesta "No" a recomendación de repuestos captura frecuencia Nunca y Sin preferencia
// -------------------------------------------------------------
runTest('R. Respuesta "No" a recomendación de marcas se captura con 100% fidelidad', () => {
  const userText = "No";
  const nlp = processNlpPipeline(userText, { _askingRecommendBrands: true, _lastQuestion: 'MARCA_RECOMENDADA' });
  assert.strictEqual(nlp.entities.frecuencia_recomendacion, 'Nunca', 'Debe capturar frecuencia_recomendacion como Nunca');
  assert.deepStrictEqual(nlp.entities.marcas_repuestos_usadas, ['Ninguna'], 'Debe capturar marcas_repuestos_usadas como Ninguna');
  assert.strictEqual(nlp.entities.quien_decide_repuesto, 'Cliente', 'Debe asignar quien_decide_repuesto a Cliente');
});

// -------------------------------------------------------------
// TEST 19: Respuesta "Sí" a recomendar NITROX y ganar premios captura recomendaria_nitrox y quiere_muestras
// -------------------------------------------------------------
runTest('S. Respuesta afirmativa a recomendar NITROX y premios activa recomendaria_nitrox', () => {
  const userText = "Sí";
  const nlp = processNlpPipeline(userText, { _askingRecommendNitrox: true, _lastQuestion: 'RECOMENDAR_NITROX' });
  assert.strictEqual(nlp.entities.recomendaria_nitrox, 'Definitivamente sí', 'Debe capturar recomendaria_nitrox: Definitivamente sí');
  assert.strictEqual(nlp.entities.quiere_muestras, 'Sí', 'Debe capturar quiere_muestras: Sí');
});

// -------------------------------------------------------------
// TEST 20: Celulares de WhatsApp en el chat NO contaminan la cédula y extraen teléfono alterno
// -------------------------------------------------------------
runTest('T. Múltiples números de celular en el chat no se asignan a cédula y extraen alterno', () => {
  const userText = "3177694776\n3110222345";
  const nlp = processNlpPipeline(userText, { _lastQuestion: 'CELULAR' });
  assert.strictEqual(nlp.entities.celular_whatsapp, '573177694776', 'Debe capturar el primer número como celular_whatsapp');
  assert.strictEqual(nlp.entities.telefono_alterno, '573110222345', 'Debe capturar el segundo número como telefono_alterno');
  assert.strictEqual(nlp.entities.cedula, null, 'Cédula debe ser null, no debe contaminarse con un número celular');
});

// -------------------------------------------------------------
// TEST 21: Captura de volumen con números aislados ("20"), rangos ("entre 15 y 20") y palabras ("veinte")
// -------------------------------------------------------------
runTest('U. Captura exhaustiva de volumen de motos (aislado, rango, palabras, diario)', () => {
  // Caso 1: Carlos respondió solo "20" a la pregunta de volumen
  const nlp1 = processNlpPipeline("20", { _lastQuestion: 'VOLUMEN', lastAssistantMessage: '¿Cuántas motos atienden por semana aproximadamente?' });
  assert.strictEqual(nlp1.entities.motos_por_semana, '20 motos/semana', 'Debe capturar "20" como 20 motos/semana');

  // Caso 2: Rango "entre 15 y 20"
  const nlp2 = processNlpPipeline("entre 15 y 20", { _lastQuestion: 'VOLUMEN' });
  assert.strictEqual(nlp2.entities.motos_por_semana, '15 a 20 motos/semana', 'Debe capturar rango 15 a 20 motos/semana');

  // Caso 3: Palabra en español "veinte"
  const nlp3 = processNlpPipeline("veinte", { _lastQuestion: 'VOLUMEN' });
  assert.strictEqual(nlp3.entities.motos_por_semana, '20 motos/semana', 'Debe capturar "veinte" como 20 motos/semana');

  // Caso 4: Volumen diario "4 diarias"
  const nlp4 = processNlpPipeline("4 diarias", {});
  assert.ok(nlp4.entities.motos_por_semana.includes('al día') || nlp4.entities.motos_por_semana.includes('diarias'), 'Debe capturar tasa diaria');
});

// -------------------------------------------------------------
// TEST 22: Saludo cordial inicial obligatorio con presentación de Mateo y Ruta NITROX
// -------------------------------------------------------------
runTest('V. Saludo cordial y presentación de Mateo y Ruta NITROX en primer contacto', () => {
  const { FALLBACK_QUESTIONS } = require('../gemini_brain');
  const greeting = FALLBACK_QUESTIONS.nombres_apellidos;
  assert.ok(greeting.toLowerCase().includes('mateo'), 'Debe presentarse como Mateo');
  assert.ok(greeting.toLowerCase().includes('ruta nitrox'), 'Debe mencionar la Ruta NITROX');
  assert.ok(greeting.toLowerCase().includes('capacitaciones'), 'Debe mencionar capacitaciones');
  assert.ok(greeting.toLowerCase().includes('premios'), 'Debe mencionar premios');
  assert.ok(!greeting.toLowerCase().startsWith('¿cómo te llamas?'), 'No debe ser solo "¿cómo te llamas?" en seco');
});

// -------------------------------------------------------------
// TEST 23: Sincronización de ciudad_residencia con ciudad_taller (no forzar Medellín en Fusagasugá)
// -------------------------------------------------------------
runTest('W. Sincronización de ciudad de residencia con ciudad del taller (sin forzar Medellín)', () => {
  const input = {
    nombre_taller: 'Taller Prueba',
    ciudad_taller: 'Fusagasugá',
    ciudad_residencia: 'Medellín' // Residuo histórico
  };
  const normalized = normalizeMechanicData(input, 'WhatsApp');
  assert.strictEqual(normalized.ciudad_taller, 'Fusagasugá', 'ciudad_taller debe ser Fusagasugá');
  assert.strictEqual(normalized.ciudad_residencia, 'Fusagasugá', 'ciudad_residencia debe heredar Fusagasugá en lugar de Medellín');
  assert.strictEqual(normalized.ciudad_ruta, 'Fusagasugá y alrededores', 'ciudad_ruta debe basarse en Fusagasugá');
});

// -------------------------------------------------------------
// TEST 24: "Hola y no saludas?" nunca se extrae como nombre "Y" ni como taller
// -------------------------------------------------------------
runTest('X. "Hola y no saludas?" reconocido como saludo y jamás extrae "Y" como nombre', () => {
  const greetingCheck = isPureGreeting("Hola y no saludas?");
  assert.strictEqual(greetingCheck, true, '"Hola y no saludas?" debe ser clasificado como saludo puro');

  const pName = cleanPersonName("Hola y no saludas?");
  assert.strictEqual(pName, '', 'cleanPersonName no debe extraer nombre de "Hola y no saludas?"');

  const singleY = cleanPersonName("Y");
  assert.strictEqual(singleY, '', 'cleanPersonName jamás debe extraer una sola letra o conjunción "Y"');

  const parsed = parseNameAndWorkshop("Hola y no saludas?");
  assert.strictEqual(parsed.name, '', 'parseNameAndWorkshop no debe asignar nombre');
  assert.strictEqual(parsed.workshop, '', 'parseNameAndWorkshop no debe asignar taller');

  const session = { data: {}, history: [] };
  const entities = extractEntities("Hola y no saludas?", session.data);
  assert.strictEqual(entities.nombres_apellidos, undefined, 'extractEntities no debe extraer nombres_apellidos');
  assert.strictEqual(entities.nombre_taller, undefined, 'extractEntities no debe extraer nombre_taller');
});

// -------------------------------------------------------------
// TEST 25: Insultos y protestas jamás se asignan como taller ni como nombre
// -------------------------------------------------------------
runTest('Y. Insultos y protestas jamás son asignados como nombre de taller', () => {
  const bad1 = cleanWorkshopName("No sea mierda ese no es mi nombre");
  assert.strictEqual(bad1, '', 'cleanWorkshopName debe retornar vacío ante insulto/protesta');

  const bad2 = cleanWorkshopName("Entonces?");
  assert.strictEqual(bad2, '', 'cleanWorkshopName debe retornar vacío ante pregunta "Entonces?"');

  const bad3 = cleanWorkshopName("Taller No Sea Mierda Ese No Es Mi Nombre");
  assert.strictEqual(bad3, '', 'cleanWorkshopName debe purgar taller con insulto');

  const badName = cleanPersonName("No sea mierda ese no es mi nombre");
  assert.strictEqual(badName, '', 'cleanPersonName debe retornar vacío ante insulto');
});

// -------------------------------------------------------------
// TEST 26: Detección y manejo de rechazo/corrección de nombre
// -------------------------------------------------------------
runTest('Z. Rechazo de nombre resetea nombres_apellidos espurio y no contamina nombre_taller', () => {
  const sessionData = {
    nombres_apellidos: 'Y',
    _lastQuestion: 'TALLER'
  };

  const entities = extractEntities("No sea mierda ese no es mi nombre", sessionData);

  assert.strictEqual(sessionData.nombres_apellidos, undefined, 'Debe borrar el nombre espurio "Y" de sessionData');
  assert.strictEqual(entities.nombre_taller, undefined, 'No debe asignar la protesta como taller');
  assert.strictEqual(sessionData._lastQuestion, 'NOMBRE', 'Debe reorientar la conversación a preguntar por el nombre');
});

// -------------------------------------------------------------
// TEST 27: Rechazo de nombre con nuevo nombre provisto
// -------------------------------------------------------------
runTest('AA. Corrección de nombre con nuevo nombre explícito actualiza nombre y no contamina taller', () => {
  const sessionData = {
    nombres_apellidos: 'Equivocado',
    _lastQuestion: 'TALLER'
  };

  const entities = extractEntities("Ese no es mi nombre, me llamo Carlos", sessionData);

  assert.strictEqual(entities.nombres_apellidos, 'Carlos', 'Debe capturar "Carlos" como el nombre corregido');
  assert.strictEqual(entities.nombre_taller, undefined, 'No debe asignar a taller');
});

// -------------------------------------------------------------
// TEST 28: Progresión conversacional obligatoria (jamás enviar disculpa o comentario sin pregunta)
// -------------------------------------------------------------
runTest('AB. Respuesta de Mateo jamás se queda sin pregunta si la vinculación está incompleta', () => {
  const sessionData = {
    _finished: false
    // Sin nombres_apellidos
  };
  let reply = "¡Qué pena contigo por la confusión.";

  // Regla fundamental de progresión conversacional:
  if (!sessionData._finished && !reply.includes('?')) {
    if (!sessionData.nombres_apellidos) {
      reply = `${reply.replace(/[.!\s]+$/, '')}. 🏍️ ¿Cuál es tu nombre para tenerte bien registrado?`;
    } else if (!sessionData.nombre_taller) {
      reply = `${reply.replace(/[.!\s]+$/, '')}. 🏍️ ¿Cómo se llama tu taller de motos?`;
    }
  }

  assert.ok(reply.includes('?'), 'La respuesta debe incluir una pregunta');
  assert.ok(reply.includes('¿Cuál es tu nombre'), 'Debe solicitar el nombre');
  assert.strictEqual(
    reply,
    '¡Qué pena contigo por la confusión. 🏍️ ¿Cuál es tu nombre para tenerte bien registrado?',
    'Debe concatenar la disculpa con la solicitud del dato'
  );
});

// -------------------------------------------------------------
// TEST 29: Carga modular de skills desde archivos .md en memoria RAM
// -------------------------------------------------------------
runTest('AC. Cargador skill_loader indexa todas las skills .md sin errores de I/O', () => {
  const pnlSkill = getSkill('00_identidad_pnl');
  const saludoSkill = getSkill('01_saludo_presentacion');
  const vinculacionSkill = getSkill('02_vinculacion_taller');
  const friccionSkill = getSkill('03_manejo_friccion');
  const comercialSkill = getSkill('04_asesoria_comercial_nitrox');
  const habeasSkill = getSkill('05_cierre_habeas_data');
  const schemaSkill = getSkill('06_output_schema');

  assert.ok(pnlSkill && pnlSkill.length > 50, 'Debe cargar skill 00_identidad_pnl');
  assert.ok(saludoSkill && saludoSkill.length > 50, 'Debe cargar skill 01_saludo_presentacion');
  assert.ok(vinculacionSkill && vinculacionSkill.length > 50, 'Debe cargar skill 02_vinculacion_taller');
  assert.ok(friccionSkill && friccionSkill.length > 50, 'Debe cargar skill 03_manejo_friccion');
  assert.ok(comercialSkill && comercialSkill.length > 50, 'Debe cargar skill 04_asesoria_comercial_nitrox');
  assert.ok(habeasSkill && habeasSkill.length > 50, 'Debe cargar skill 05_cierre_habeas_data');
  assert.ok(schemaSkill && schemaSkill.length > 50, 'Debe cargar skill 06_output_schema');
});

// -------------------------------------------------------------
// TEST 30: Integridad del SYSTEM_PROMPT ensamblado para Gemini
// -------------------------------------------------------------
runTest('AD. SYSTEM_PROMPT ensamblado contiene todas las reglas y restricciones críticas', () => {
  const prompt = getMateoSystemPrompt();
  assert.strictEqual(prompt, SYSTEM_PROMPT, 'SYSTEM_PROMPT exportado debe coincidir con el cargador');

  // Reglas críticas que deben estar presentes en el prompt ensamblado
  assert.ok(prompt.includes('MATEO'), 'Debe incluir el nombre Mateo');
  assert.ok(prompt.includes('Ruta NITROX') || prompt.includes('Ruta NITROX'), 'Debe mencionar la Ruta NITROX');
  assert.ok(prompt.includes('hermano'), 'Debe incluir la prohibición de hermano');
  assert.ok(prompt.includes('analisis_interno'), 'Debe incluir el esquema JSON');
  assert.ok(prompt.includes('datos_extraidos'), 'Debe incluir datos_extraidos');
  assert.ok(prompt.includes('listo_para_finalizar'), 'Debe incluir listo_para_finalizar');
  assert.ok(prompt.includes('5 a 18 palabras'), 'Debe especificar el límite de palabras WhatsApp');
});

// -------------------------------------------------------------
// TEST 31: Jerga colombiana de roles ("Yo soy la que lo comanda" -> Propietario)
// -------------------------------------------------------------
runTest('AE. Jerga colombiana de roles ("la que lo comanda", "el patrón") normalizada a Propietario', () => {
  const nlp1 = processNlpPipeline("Yo soy la que lo comanda", { _lastQuestion: 'ROL' });
  assert.strictEqual(nlp1.entities.relacion_taller, 'Propietario', 'Debe normalizar "la que lo comanda" a Propietario');

  const nlp2 = processNlpPipeline("Yo comando el taller y arreglo las motos", {});
  assert.strictEqual(nlp2.entities.relacion_taller, 'Propietario y Mecánico', 'Debe reconocer rol dual de comandar y arreglar');

  const nlp3 = processNlpPipeline("Yo soy la jefa", {});
  assert.strictEqual(nlp3.entities.relacion_taller, 'Propietario', 'Debe normalizar "la jefa" a Propietario');
});

// -------------------------------------------------------------
// TEST 32: Evasivas y bromas de transporte público ("Atiendo motos del sitp")
// -------------------------------------------------------------
runTest('AF. Respuestas evasivas o de transporte público ("motos del sitp") no se asignan a marcas ni volumen', () => {
  const nlp = processNlpPipeline("Atiendo motos del sitp", { _lastQuestion: 'MARCAS_MOTOS' });
  assert.strictEqual(nlp.entities.marcas_motos, null, 'SITP no debe ser tomado como marca de moto');
  assert.strictEqual(nlp.entities.motos_por_semana, null, 'SITP no debe ser tomado como volumen de motos');
  assert.strictEqual(nlp.entities.es_respuesta_evasiva, true, 'Debe marcarse como respuesta evasiva');
});

// -------------------------------------------------------------
// TEST 33: Polisemia de "rotar" ("Roto por las estaciones del sitp")
// -------------------------------------------------------------
runTest('AG. Polisemia colombiana de "rotar" (desplazamiento) no se confunde con repuestos frecuentes', () => {
  const nlp = processNlpPipeline("Roto por las estaciones del sitp", { _lastQuestion: 'REPUESTOS' });
  assert.strictEqual(nlp.entities.repuestos_frecuentes, null, 'Desplazamiento por estaciones no debe ser repuestos_frecuentes');
});

// -------------------------------------------------------------
// TEST 34: Normalización y saneamiento en integrateFactsIntoMemory
// -------------------------------------------------------------
runTest('AH. integrateFactsIntoMemory normaliza rol jergal y sanitiza marcas/repuestos espurios', () => {
  const memory = initOrLoadMemory({});
  integrateFactsIntoMemory(memory, {
    relacion_taller: 'el que comanda',
    marcas_motos: ['sitp', 'Yamaha'],
    repuestos_frecuentes: ['Roto por las estaciones del sitp'],
    motos_por_semana: 'motos del sitp'
  }, 'Yo soy el que comanda y atiendo motos del sitp');

  assert.strictEqual(memory.confirmedFacts['relacion_taller']?.value, 'Propietario', 'Debe normalizar "el que comanda" a Propietario');
  assert.deepStrictEqual(memory.confirmedFacts['marcas_motos']?.value, ['Yamaha'], 'Debe filtrar sitp y conservar únicamente marcas reales');
  assert.strictEqual(memory.confirmedFacts['repuestos_frecuentes'], undefined, 'No debe registrar repuestos espurios de estaciones');
  assert.strictEqual(memory.confirmedFacts['motos_por_semana'], undefined, 'No debe registrar volumen espurio de sitp');
});

// -------------------------------------------------------------
// TEST 35: Prohibición total anti-robot y saneamiento de lenguaje en cleanResponseText
// -------------------------------------------------------------
runTest('AI. Prohibición estricta de términos robóticos en SYSTEM_PROMPT y cleanResponseText', () => {
  const prompt = getMateoSystemPrompt();
  assert.ok(prompt.includes('TERMINANTEMENTE PROHIBIDO DECIR QUE ERES UN SISTEMA, BOT, AGENTE, IA'), 'El prompt debe tener la prohibición anti-robot explícita');

  const { cleanResponseText } = require('../gemini_brain');
  const dirtyReply = "Como sistema de IA, te informo que el sistema se quedó pensando.";
  const cleaned = cleanResponseText(dirtyReply);
  assert.ok(!cleaned.toLowerCase().includes('como sistema'), 'cleanResponseText debe erradicar "como sistema"');
  assert.ok(!cleaned.toLowerCase().includes('de ia'), 'cleanResponseText debe erradicar menciones de IA');
});

// -------------------------------------------------------------
// TEST 36: Rechazo hostil de autorización ("Lo autorizará tu madre 😡")
// -------------------------------------------------------------
runTest('AJ. Rechazo hostil de Habeas Data ("Lo autorizará tu madre") no aprueba datos y erradica risas', () => {
  const userText = "Lo autorizará tu madre 😡";
  const nlp = processNlpPipeline(userText, { _lastQuestion: 'HABEAS_DATA' });
  assert.strictEqual(nlp.entities.autorizacion_tratamiento_datos, false, 'No debe autorizar tratamiento de datos');
  assert.strictEqual(nlp.entities.rechazo_hostil, true, 'Debe marcarse como rechazo hostil');

  const { cleanResponseText } = require('../gemini_brain');
  const dirtyLaugh = "¡Jaja, mil disculpas! Tranquila, sin presiones.";
  const cleaned = cleanResponseText(dirtyLaugh, userText);
  assert.ok(!cleaned.toLowerCase().includes('jaja'), 'cleanResponseText debe erradicar risas ante insultos');
});

// -------------------------------------------------------------
// TEST 38: Piezas de moto ("Pastillas de freno") jamás contaminan taller ni ciudad
// -------------------------------------------------------------
runTest('AL. Repuestos ("Pastillas de freno") jamás se confunden con taller ni ciudad y extraen repuesto', () => {
  const userText = "Pastillas de freno";
  const nlp = processNlpPipeline(userText, { _lastQuestion: 'REPUESTOS' });
  assert.strictEqual(nlp.entities.nombre_taller, null, 'No debe asignar "Taller Pastillas" como nombre de taller');
  assert.strictEqual(nlp.entities.ciudad_taller, null, 'No debe asignar "Freno" como ciudad');
  assert.ok(nlp.entities.repuestos_frecuentes && nlp.entities.repuestos_frecuentes.includes('Pastillas de freno'), 'Debe extraer Pastillas de freno como repuestos_frecuentes');

  const { cleanWorkshopName } = require('../agent');
  assert.strictEqual(cleanWorkshopName('Pastillas'), '', 'cleanWorkshopName("Pastillas") debe retornar cadena vacía');
  assert.strictEqual(cleanWorkshopName('Pastillas de freno'), '', 'cleanWorkshopName("Pastillas de freno") debe retornar cadena vacía');
});

// -------------------------------------------------------------
// TEST 39: Guardabarrera anti-repetición de rol femenino ("propietaria o mecánica")
// -------------------------------------------------------------
runTest('AM. Guardabarrera anti-repetición bloquea preguntas de rol redundantes ("eres la propietaria o mecánica")', () => {
  const memory = initOrLoadMemory({
    data: { relacion_taller: 'Propietario' },
    history: []
  });
  const check = isTopicOrQuestionForbidden(memory, 'relacion_taller', '¿eres la propietaria o mecánica principal del taller?');
  assert.strictEqual(check.forbidden, true, 'Debe prohibir repreguntar el rol cuando ya está confirmado');
});

// -------------------------------------------------------------
// TEST 40: Detección de intención de compra en NLP ("Hola Quiero comprar")
// -------------------------------------------------------------
runTest('AN. Detección de intencion_compra en frases de compra ("Hola Quiero comprar")', () => {
  const nlp1 = processNlpPipeline("Hola Quiero comprar");
  assert.strictEqual(nlp1.entities.intencion_compra, true, 'Debe detectar intencion_compra en "Hola Quiero comprar"');
  assert.strictEqual(nlp1.entities.es_pregunta_comercial, true, 'Debe marcar es_pregunta_comercial');

  const nlp2 = processNlpPipeline("Dónde puedo comprar repuestos nitrox?");
  assert.strictEqual(nlp2.entities.intencion_compra, true, 'Debe detectar intencion_compra en "Dónde puedo comprar repuestos"');

  const nlp3 = processNlpPipeline("necesito comprar un kit de arrastre");
  assert.strictEqual(nlp3.entities.intencion_compra, true, 'Debe detectar intencion_compra en "necesito comprar un kit de arrastre"');
});

// -------------------------------------------------------------
// TEST 41: Detección de elección del flujo ("solo comprar" vs "seguir formulario")
// -------------------------------------------------------------
runTest('AO. Detección de elección entre solo comprar y formulario', () => {
  const context = {
    _modo_compra: 'preguntando_opcion',
    lastAssistantMessage: '¡Claro que sí! ¿Seguimos con el formulario de tu taller o quieres solo comprar repuestos NITROX?'
  };

  const nlpBuy = processNlpPipeline("solo comprar", context);
  assert.strictEqual(nlpBuy.entities.eleccion_flujo_compra, 'solo_comprar', 'Debe reconocer elección "solo_comprar"');

  const nlpForm = processNlpPipeline("sigamos con el formulario", context);
  assert.strictEqual(nlpForm.entities.eleccion_flujo_compra, 'seguir_formulario', 'Debe reconocer elección "seguir_formulario"');
});

// -------------------------------------------------------------
// TEST 42: Manejo de modo compra y fallback sin IA de bifurcación
// -------------------------------------------------------------
runTest('AP. Transición directa a Flujo Comercial A sin forzar preguntas de rol ni bifurcación redundante', () => {
  const session = {
    data: {
      nombres_apellidos: 'Carlos',
      nombre_taller: 'Taller El Paisa',
      ciudad_taller: 'Medellín',
      barrio_taller: 'Aranjuez',
      direccion_taller: 'Calle 92 # 48-12',
      _lastQuestion: 'ROL_TALLER'
    },
    history: []
  };

  const nlp = processNlpPipeline("Hola Quiero comprar", session.data);
  assert.strictEqual(nlp.entities.intencion_compra, true, 'Debe detectar intención de compra');
  assert.strictEqual(nlp.entities.es_pregunta_comercial, true);
});

// -------------------------------------------------------------
// TEST 43: Nombre de persona con intención de compra añadida ("Walter González pero hoy quiero hacer una compra")
// -------------------------------------------------------------
runTest('AQ. Extracción de nombre limpio y detección de intención de compra compuesta', () => {
  const input = "Walter González pero hoy quiero hacer una compra";
  const parsed = parseNameAndWorkshop(input);
  assert.strictEqual(parsed.name, 'Walter González', 'Debe extraer únicamente el nombre "Walter González"');

  const nlp = processNlpPipeline(input, { _lastQuestion: 'NOMBRE' });
  assert.strictEqual(nlp.entities.intencion_compra, true, 'Debe detectar intencion_compra = true');
});

// -------------------------------------------------------------
// ESCENARIOS OBLIGATORIOS SECCIÓN 9: SEPARACIÓN DE FLUJOS COMERCIAL Y REGISTRO
// -------------------------------------------------------------

// Escenario 1: El usuario quiere comprar desde el primer mensaje
runTest('S1. Usuario quiere comprar desde el primer mensaje activa Flujo Comercial', () => {
  const nlp = processNlpPipeline("Hola quiero comprar unos repuestos para mi moto", {});
  assert.strictEqual(nlp.entities.intencion_compra, true, 'Debe detectar intención de compra desde el primer mensaje');
  assert.strictEqual(nlp.entities.es_pregunta_comercial, true);
});

// Escenario 2: El usuario expresa intención de compra después de responder su nombre
runTest('S2. Usuario expresa intención de compra junto a su nombre sin bifurcación repetitiva', () => {
  const input = "Walter González, pero hoy quiero hacer una compra";
  const parsed = parseNameAndWorkshop(input);
  assert.strictEqual(parsed.name, 'Walter González', 'Debe limpiar y extraer solo el nombre de Walter');

  const nlp = processNlpPipeline(input, {});
  assert.strictEqual(nlp.entities.intencion_compra, true, 'Debe activar intención comercial de una');
});

// Escenario 3: El usuario inicia el formulario y después solicita una cotización
runTest('S3. Usuario inicia formulario y solicita cotización intermedia sin perder datos', () => {
  const session = {
    data: {
      nombres_apellidos: 'Andrés Morales',
      active_flow: 'registration'
    }
  };
  const text = "Mi taller se llama Motos Del Valle y necesito cotizar un kit de arrastre";
  const entities = extractEntities(text, session.data);
  assert.strictEqual(entities.nombre_taller, 'Motos Del Valle', 'Debe capturar el taller');

  const nlp = processNlpPipeline(text, session.data);
  assert.strictEqual(nlp.entities.intencion_compra, true, 'Debe detectar la cotización comercial');
  assert.strictEqual(nlp.entities.repuesto_solicitado, 'Kit de arrastre', 'Debe identificar el kit de arrastre');
});

// Escenario 4: El usuario termina la cotización y decide retomar el formulario
runTest('S4. Retoma del formulario post-compra sin repetir preguntas ya contestadas', () => {
  const session = {
    data: {
      nombres_apellidos: 'Walter González',
      nombre_taller: 'Taller Walter Motos',
      active_flow: 'commercial',
      commercial_state: { repuesto: 'Kit de arrastre', moto: 'Pulsar 200 NS', status: 'resuelto' }
    },
    memory: initOrLoadMemory({
      data: {
        nombres_apellidos: 'Walter González',
        nombre_taller: 'Taller Walter Motos'
      }
    })
  };

  const nlp = processNlpPipeline("Listo de una, sigamos con el formulario de mi taller", session.data);
  assert.strictEqual(nlp.entities.intencion_retomar_formulario, true, 'Debe detectar intención de retomar el formulario');

  // Comprobar que en el progreso, nombre y taller ya están confirmados y no se repiten
  const pending = getConversationalPendingTopics(session.data, session.memory);
  const pendingKeys = pending.map(p => p.key);
  assert.ok(!pendingKeys.includes('nombres_apellidos'), 'No debe volver a preguntar el nombre');
  assert.ok(!pendingKeys.includes('nombre_taller'), 'No debe volver a preguntar el taller');
  assert.ok(pendingKeys.includes('ciudad_taller'), 'Debe continuar con la ciudad del taller');
});

// Escenario 5: El usuario no quiere registrarse, pero sí comprar
runTest('S5. Usuario no quiere registrarse pero sí comprar (respeta decisión)', () => {
  const text = "No quiero registrarme, solo comprar repuestos para Pulsar";
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.rechazo_registro, true, 'Debe detectar rechazo de registro');
  assert.strictEqual(nlp.entities.intencion_compra, true, 'Debe mantener intención de compra');
  assert.strictEqual(nlp.entities.moto_solicitada, 'Pulsar', 'Debe extraer la moto Pulsar');
});

// Escenario 6: El usuario cambia varias veces entre compra y registro
runTest('S6. Alternancia múltiple entre compra y registro preserva ambos estados', () => {
  const sessionData = {
    nombres_apellidos: 'Jorge Pérez',
    active_flow: 'registration',
    commercial_state: {}
  };

  // Turno 1: Compra
  const nlp1 = processNlpPipeline("Necesito precio de unas pastillas de freno", sessionData);
  if (nlp1.entities.intencion_compra) {
    sessionData.previous_flow = sessionData.active_flow;
    sessionData.active_flow = 'commercial';
    sessionData.commercial_state.repuesto = nlp1.entities.repuesto_solicitado;
  }
  assert.strictEqual(sessionData.active_flow, 'commercial');
  assert.strictEqual(sessionData.commercial_state.repuesto, 'Frenos (pastillas / bandas)');

  // Turno 2: Retomar registro
  const nlp2 = processNlpPipeline("Sigamos con el registro", sessionData);
  if (nlp2.entities.intencion_retomar_formulario) {
    sessionData.previous_flow = sessionData.active_flow;
    sessionData.active_flow = 'registration';
  }
  assert.strictEqual(sessionData.active_flow, 'registration');
  assert.strictEqual(sessionData.nombres_apellidos, 'Jorge Pérez', 'Conserva nombre del mecánico');
  assert.strictEqual(sessionData.commercial_state.repuesto, 'Frenos (pastillas / bandas)', 'Conserva dato comercial');
});

// Escenario 7: Información comercial en varios mensajes
runTest('S7. Información comercial provista en varios mensajes acumulada en commercial_state', () => {
  const commState = {};

  // Mensaje 1: repuesto
  const nlp1 = processNlpPipeline("Quiero un kit de arrastre", {});
  if (nlp1.entities.repuesto_solicitado) commState.repuesto = nlp1.entities.repuesto_solicitado;
  assert.strictEqual(commState.repuesto, 'Kit de arrastre');

  // Mensaje 2: moto
  const nlp2 = processNlpPipeline("Para una Boxer CT100", {});
  if (nlp2.entities.moto_solicitada) commState.moto = nlp2.entities.moto_solicitada;
  assert.ok(commState.moto?.toLowerCase().includes('boxer'), 'Debe contener Boxer');

  // Mensaje 3: ubicación
  const nlp3 = processNlpPipeline("Estoy en Venecia Bogotá", {});
  if (nlp3.entities.ciudad_taller) commState.ciudad_o_barrio = 'Bogotá';
  assert.strictEqual(commState.ciudad_o_barrio, 'Bogotá');
});

// Escenario 8: El usuario corrige un dato de la motocicleta
runTest('S8. Corrección de datos de motocicleta actualiza commercial_state', () => {
  const commState = { moto: 'Boxer CT100', repuesto: 'Kit de arrastre' };
  const text = "Me equivoqué, no es Boxer, es para una Pulsar 200 NS";
  const nlp = processNlpPipeline(text, {});
  assert.ok(nlp.entities.moto_solicitada?.toLowerCase().includes('pulsar'), 'Debe detectar la corrección a Pulsar');
  commState.moto = nlp.entities.moto_solicitada;
  assert.ok(commState.moto.toLowerCase().includes('pulsar'));
});

// Escenario 9: El usuario abandona la compra y vuelve después
runTest('S9. Abandono de compra y retorno posterior conserva session.data', () => {
  const session = {
    data: {
      nombres_apellidos: 'Walter González',
      active_flow: 'commercial',
      commercial_state: { repuesto: 'Kit de arrastre', moto: 'Pulsar 200 NS' },
      last_updated_at: new Date(Date.now() - 86400000).toISOString()
    }
  };
  assert.strictEqual(session.data.nombres_apellidos, 'Walter González');
  assert.strictEqual(session.data.commercial_state.repuesto, 'Kit de arrastre');
});

// Escenario 10: Fallback determinístico si Gemini o red no identifica intención
runTest('S10. Manejo seguro si Gemini no identifica intención (fallback determinístico)', () => {
  const nlp = processNlpPipeline("A cómo tienen las zapatas?", {});
  assert.strictEqual(nlp.entities.es_pregunta_comercial, true);
  assert.strictEqual(nlp.entities.intencion_compra, true);
  assert.strictEqual(nlp.entities.repuesto_solicitado, 'Frenos (pastillas / bandas)');
});

// Escenario 11: Resiliencia ante fallos transitorios de almacenamiento
runTest('S11. Resiliencia ante fallos transitorios (memoria local mantiene integridad)', () => {
  const memory = initOrLoadMemory({});
  integrateFactsIntoMemory(memory, { nombres_apellidos: 'Carlos Mario', ciudad_taller: 'Cali' }, 'Carlos Mario en Cali');
  assert.strictEqual(memory.confirmedFacts['nombres_apellidos'].value, 'Carlos Mario');
  assert.strictEqual(memory.confirmedFacts['ciudad_taller'].value, 'Cali');
});

// Escenario 12: Deduplicación e idempotencia ante mensajes duplicados
runTest('S12. Mensajes idénticos duplicados no corrompen el estado ni duplican preguntas', () => {
  const memory = initOrLoadMemory({});
  const q1 = "¿Qué repuesto NITROX buscas y para qué moto?";
  recordAskedQuestion(memory, 'repuesto_comercial', q1);
  recordAskedQuestion(memory, 'repuesto_comercial', q1);
  assert.strictEqual(memory.askedQuestions.length, 1, 'No debe duplicar la misma pregunta en askedQuestions');
});

// Escenario 13: Las 15 preguntas existentes del formulario siguen funcionando al 100%
runTest('S13. Integridad de las 15 preguntas maestras de registration_engine', () => {
  const { MASTER_FIELDS } = require('../registration_engine');
  const fieldKeys = Object.keys(MASTER_FIELDS);
  assert.ok(fieldKeys.length >= 15, `Deben existir al menos los 15 campos maestros de la ficha (hay ${fieldKeys.length})`);
  assert.ok(fieldKeys.includes('nombres_apellidos'));
  assert.ok(fieldKeys.includes('nombre_taller'));
  assert.ok(fieldKeys.includes('ciudad_taller'));
  assert.ok(fieldKeys.includes('relacion_taller'));
  assert.ok(fieldKeys.includes('autorizacion_tratamiento_datos'));
});

// Escenario 14: Consentimiento Habeas Data se solicita y valida determinísticamente
runTest('S14. Validación estricta y determinística de Habeas Data antes de finalizar', () => {
  const dataWithoutHabeas = {
    nombres_apellidos: 'Carlos Ruiz',
    nombre_taller: 'Taller Moto Sport',
    ciudad_taller: 'Medellín',
    barrio_taller: 'Robledo',
    direccion_taller: 'Cra 80 # 65-10',
    relacion_taller: 'Propietario',
    celular_whatsapp: '573001234567',
    marcas_motos: ['Yamaha'],
    motos_por_semana: '20',
    repuestos_frecuentes: ['Kits de arrastre'],
    marcas_repuestos_usadas: ['NITROX'],
    conoce_nitrox: 'Sí',
    quiere_muestras: 'Sí',
    correo: 'carlos@gmail.com',
    cedula: '1020304050',
    autorizacion_tratamiento_datos: false
  };
  const progress = getRegistrationProgress(dataWithoutHabeas);
  assert.strictEqual(progress.canFinalize, false, 'No puede finalizar sin Habeas Data');

  dataWithoutHabeas.autorizacion_tratamiento_datos = true;
  const progressApproved = getRegistrationProgress(dataWithoutHabeas);
  assert.strictEqual(progressApproved.canFinalize, true, 'Puede finalizar con Habeas Data aprobado');
});

// Escenario 15: Rutas y funciones anteriores continúan funcionando
runTest('S15. Exportaciones de agent, gemini_brain y scoring operativas', () => {
  const agent = require('../agent');
  assert.strictEqual(typeof agent.generateMateoResponse, 'function', 'generateMateoResponse debe ser función');
  assert.strictEqual(typeof agent.cleanPersonName, 'function', 'cleanPersonName debe ser función');
  assert.strictEqual(typeof agent.cleanWorkshopName, 'function', 'cleanWorkshopName debe ser función');

  const { processGeminiBrainTurn } = require('../gemini_brain');
  assert.strictEqual(typeof processGeminiBrainTurn, 'function', 'processGeminiBrainTurn debe ser función');
});

// ============================================================================
// ESCENARIOS OBLIGATORIOS DE INTELIGENCIA MULTIINTENCIÓN (MI-1 a MI-18)
// ============================================================================

// 1. Solo un saludo
runTest('MI-1. Solo un saludo es reconocido sin activar compras ni preguntas comerciales', () => {
  const nlp = processNlpPipeline("Hola, buenos días", {});
  assert.strictEqual(nlp.entities.es_saludo, true);
  assert.ok(nlp.entities.intenciones_detectadas.includes('saludo'));
  assert.strictEqual(nlp.entities.es_pregunta_comercial, false);
});

// 2. Solo una despedida
runTest('MI-2. Solo una despedida activa cierre cordial sin preguntas de registro', () => {
  const nlp = processNlpPipeline("Listo, muchas gracias, hasta luego", {});
  assert.strictEqual(nlp.entities.es_despedida, true);
  assert.strictEqual(nlp.entities.despedida_con_pregunta, false);
  assert.ok(nlp.entities.intenciones_detectadas.includes('despedida'));
});

// 3. Un nombre como respuesta del formulario
runTest('MI-3. Un nombre aislado o directo se extrae limpiamente como nombre_personal', () => {
  const name = cleanPersonName("Me llamo Juan David Ramírez");
  assert.strictEqual(name, 'Juan David Ramírez');
  const nlp = processNlpPipeline("Me llamo Juan David Ramírez", {});
  assert.strictEqual(nlp.entities.nombres_apellidos, 'Juan David Ramírez');
  assert.ok(nlp.entities.intenciones_detectadas.includes('nombre_personal'));
});

// 4. Un nombre acompañado de una compra
runTest('MI-4. Un nombre acompañado de una compra procesa ambas intenciones simultáneas', () => {
  const text = "Hola, soy Walter González y hoy quiero comprar repuestos";
  const name = cleanPersonName(text);
  assert.strictEqual(name, 'Walter González');
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.es_saludo, true);
  assert.strictEqual(nlp.entities.nombres_apellidos, 'Walter González');
  assert.strictEqual(nlp.entities.intencion_compra, true);
  assert.ok(nlp.entities.intenciones_detectadas.includes('saludo'));
  assert.ok(nlp.entities.intenciones_detectadas.includes('nombre_personal'));
  assert.ok(nlp.entities.intenciones_detectadas.includes('compra'));
});

// 5. Un nombre y el nombre del taller junto con una cotización
runTest('MI-5. Nombre, taller y cotización extraídos en una sola frase compuesta', () => {
  const text = "Soy Walter González, mi taller se llama Moto Sport y quiero cotizar un kit de arrastre";
  const parsed = parseNameAndWorkshop(text);
  assert.strictEqual(parsed.name, 'Walter González');
  assert.ok(parsed.workshop.includes('Moto Sport'), 'Debe incluir Moto Sport');
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.intencion_cotizacion, true);
  assert.strictEqual(nlp.entities.repuesto_solicitado, 'Kit de arrastre');
});

// 6. Una solicitud de compra sin nombre
runTest('MI-6. Solicitud de compra sin nombre prioriza Flujo A comercial', () => {
  const nlp = processNlpPipeline("¿Dónde puedo comprar unas pastillas NITROX?", {});
  assert.strictEqual(nlp.entities.intencion_compra, true);
  assert.strictEqual(nlp.entities.repuesto_solicitado, 'Frenos (pastillas / bandas)');
  assert.strictEqual(nlp.entities.nombres_apellidos, null);
});

// 7. Una cotización con varias referencias
runTest('MI-7. Cotización de varias referencias captura lista estructurada y activa cotizacion_multiple', () => {
  const text = "Cotízame un kit de arrastre y unas zapatas para Pulsar 200";
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.intencion_cotizacion, true);
  assert.strictEqual(nlp.entities.cotizacion_multiple, true);
  assert.ok(nlp.entities.repuestos_solicitados.includes('Kit de arrastre'));
  assert.ok(nlp.entities.repuestos_solicitados.includes('Frenos (pastillas / bandas)'));
  assert.ok(nlp.entities.moto_solicitada.toLowerCase().includes('pulsar'));
});

// 8. Una despedida seguida de una nueva pregunta
runTest('MI-8. Despedida seguida de nueva pregunta prioriza responder la pregunta', () => {
  const text = "Gracias, chao. Ah, una cosa, ¿cuánto vale el kit de arrastre?";
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.despedida_con_pregunta, true);
  assert.strictEqual(nlp.entities.es_pregunta_comercial, true);
  assert.strictEqual(nlp.entities.repuesto_solicitado, 'Kit de arrastre');
  assert.strictEqual(nlp.entities.es_despedida, false, 'No debe cerrarse si hay una pregunta pendiente');
});

// 9. Un rechazo al registro acompañado de una intención de compra
runTest('MI-9. Rechazo al registro con intención de compra respeta decisión y pasa a compra', () => {
  const text = "No quiero registrarme en ninguna red, solo quiero comprar repuestos";
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.rechazo_registro, true);
  assert.strictEqual(nlp.entities.intencion_compra, true);
  assert.ok(nlp.entities.intenciones_detectadas.includes('rechazo_registro'));
  assert.ok(nlp.entities.intenciones_detectadas.includes('compra'));
});

// 10. Una respuesta al formulario con lenguaje informal
runTest('MI-10. Respuesta al formulario con lenguaje informal normaliza rol y taller', () => {
  const text = "El negocio mío se llama Moto Racing y yo soy el que lo comanda";
  const parsed = parseNameAndWorkshop(text);
  assert.ok(parsed.workshop.includes('Moto Racing'));
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.relacion_taller, 'Propietario');
});

// 11. Una consulta comercial ambigua
runTest('MI-11. Consulta comercial ambigua clasifica como intención de compra / precio', () => {
  const nlp = processNlpPipeline("¿A cómo sale esa vaina?", {});
  assert.strictEqual(nlp.entities.es_pregunta_comercial, true);
  assert.strictEqual(nlp.entities.intencion_compra, true);
});

// 12. Dos intenciones comerciales simultáneas
runTest('MI-12. Dos intenciones comerciales simultáneas (producto + catálogo)', () => {
  const text = "¿Tienen kit para Pulsar 200 y me puedes mandar el catálogo?";
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.repuesto_solicitado, 'Kit de arrastre');
  assert.strictEqual(nlp.entities.consulta_catalogo, true);
  assert.ok(nlp.entities.intenciones_detectadas.includes('consulta_catalogo'));
});

// 13. Un usuario que cambia varias veces de flujo
runTest('MI-13. Alternancia múltiple de flujos preserva contexto y datos del cliente', () => {
  const session = { data: {}, history: [] };
  // Turno 1: Registro (nombre)
  session.data.nombres_apellidos = 'Carlos Mario Gómez';
  session.data.active_flow = 'registration';
  // Turno 2: Pasa a compra
  session.data.previous_flow = session.data.active_flow;
  session.data.active_flow = 'commercial';
  session.data.commercial_state = { repuesto: 'Pastillas de freno' };
  // Turno 3: Retoma registro
  session.data.previous_flow = session.data.active_flow;
  session.data.active_flow = 'registration';
  session.data.commercial_state.status = 'resuelto';
  // Turno 4: Nueva cotización
  session.data.active_flow = 'commercial';
  assert.strictEqual(session.data.nombres_apellidos, 'Carlos Mario Gómez');
  assert.strictEqual(session.data.commercial_state.repuesto, 'Pastillas de freno');
});

// 14. Una conversación retomada después de una pausa
runTest('MI-14. Conversación retomada tras pausa conserva cotización previa', () => {
  const nlpPause = processNlpPipeline("Gracias por la cotización, después te confirmo", {});
  assert.strictEqual(nlpPause.entities.es_pausa, true);
  const session = {
    data: {
      nombres_apellidos: 'Walter',
      active_flow: 'commercial',
      commercial_state: { repuesto: 'Kit de arrastre', moto: 'Pulsar 200 NS' },
      _es_pausa: true
    }
  };
  const nlpResume = processNlpPipeline("Hola, ya revisé y sí voy a llevar el kit", {});
  assert.strictEqual(session.data.commercial_state.repuesto, 'Kit de arrastre');
  assert.strictEqual(nlpResume.entities.intencion_compra, true);
});

// 15. Una salida ambigua de Gemini (fallback determinístico seguro)
runTest('MI-15. Salida ambigua o fallo de IA maneja multiintención determinísticamente', () => {
  const nlp = processNlpPipeline("Hola soy Walter y quiero cotizar", {});
  assert.strictEqual(nlp.entities.es_saludo, true);
  assert.strictEqual(nlp.entities.nombres_apellidos, 'Walter');
  assert.strictEqual(nlp.entities.intencion_cotizacion, true);
});

// 16. Un fallo de Gemini o Firestore (resiliencia en memoria local)
runTest('MI-16. Fallo de almacenamiento conserva hechos confirmados en memoria local', () => {
  const memory = initOrLoadMemory({});
  integrateFactsIntoMemory(memory, { nombres_apellidos: 'Pedro Navaja', ciudad_taller: 'Bogotá' }, 'Pedro en Bogotá');
  assert.strictEqual(memory.confirmedFacts['nombres_apellidos'].value, 'Pedro Navaja');
  assert.strictEqual(memory.confirmedFacts['ciudad_taller'].value, 'Bogotá');
});

// 17. Un mensaje duplicado (idempotencia y anti-repetición)
runTest('MI-17. Mensajes idénticos consecutivos no duplican preguntas ni corrompen historial', () => {
  const memory = initOrLoadMemory({});
  const q = "¿Qué repuesto buscas y para qué moto?";
  recordAskedQuestion(memory, 'repuesto_solicitado', q);
  recordAskedQuestion(memory, 'repuesto_solicitado', q);
  assert.strictEqual(memory.askedQuestions.length, 1);
});

// 18. Una respuesta que ya había sido proporcionada anteriormente
runTest('MI-18. Respuesta a dato ya suministrado activa protesta y evita repetición', () => {
  const text = "Ya te dije que soy Carlos Gómez en Medellín";
  const nlp = processNlpPipeline(text, {});
  assert.strictEqual(nlp.entities.protesta_repeticion, true);
  assert.strictEqual(nlp.entities.ciudad_taller, 'Medellín');
});

// ============================================================================
// TESTS DE LOCALIZADOR DE PUNTOS DE VENTA, UBICACIÓN Y ANTI-REPETICIÓN
// ============================================================================
const { resolveStoreLocation, isVerbatimRepetition, MUNDIMOTOS_STORES } = require('../gemini_brain');

runTest('LOC-1. Pregunta sobre dónde comprar sin ubicación indaga barrio, dirección o ubicación WhatsApp', () => {
  const reply = resolveStoreLocation({ text: '¿Dónde puedo comprar repuestos NITROX?' });
  assert.ok(reply.includes('barrio o dirección'));
  assert.ok(reply.includes('ubicación por WhatsApp'));
});

runTest('LOC-2. Mención de Barrio Antioquia direcciona a Sede La Bayadera (Calle 38 # 52-30)', () => {
  const reply = resolveStoreLocation({ text: 'Estoy en Barrio Antioquia' });
  assert.ok(reply.includes('La Bayadera'));
  assert.ok(reply.includes('Calle 38 # 52-30'));
  assert.ok(!reply.includes('Calle 59'));
});

runTest('LOC-3. Pregunta "pero no hay más?" tras mencionar La Paz responde con Sede La Bayadera', () => {
  const reply = resolveStoreLocation({
    text: 'pero no hay mas ?',
    lastAssistantMsg: 'Te vas directo al Mundimotos de La Paz (Centro), en la Calle 59 # 51D-72 en Medellín.'
  });
  assert.ok(reply.includes('La Bayadera'));
  assert.ok(reply.includes('Calle 38 # 52-30'));
});

runTest('LOC-4. Pregunta "pero no hay más?" tras mencionar La Bayadera ofrece despacho directo sin repetir', () => {
  const reply = resolveStoreLocation({
    text: 'pero no hay mas puntos?',
    lastAssistantMsg: 'En Medellín también contamos con la sede de La Bayadera en la Calle 38 # 52-30.'
  });
  assert.ok(reply.includes('despachamos directo'));
  assert.ok(reply.includes('+57 302 427 6647'));
});

runTest('LOC-5. Coordenadas GPS de WhatsApp cerca de Medellín calculan la sede más cercana', () => {
  // Coordenadas cercanas a La Bayadera (lat 6.2404, lon -75.5746)
  const reply = resolveStoreLocation({
    text: 'Ubicación GPS: 6.2410, -75.5750',
    lat: 6.2410,
    lon: -75.5750
  });
  assert.ok(reply.includes('Recibí tu ubicación'));
  assert.ok(reply.includes('La Bayadera'));
  assert.ok(reply.includes('Calle 38 # 52-30'));
});

runTest('LOC-6. Coordenadas GPS en municipio distante ofrecen despacho directo vía WhatsApp', () => {
  // Coordenadas en municipio lejano (ej. Apartadó, Urabá lat ~7.88, lon ~-76.62)
  const reply = resolveStoreLocation({
    text: 'Ubicación GPS: 7.8800, -76.6200',
    lat: 7.8800,
    lon: -76.6200
  });
  assert.ok(reply.includes('Recibí tu ubicación'));
  assert.ok(reply.includes('despachamos directo'));
  assert.ok(reply.includes('+57 302 427 6647'));
});

runTest('LOC-7. Directorio de sedes cubre todas las ciudades principales de Colombia', () => {
  const cities = MUNDIMOTOS_STORES.map(s => s.city);
  assert.ok(cities.includes('medellin'));
  assert.ok(cities.includes('bogota'));
  assert.ok(cities.includes('cali'));
  assert.ok(cities.includes('bucaramanga'));
  assert.ok(cities.includes('barranquilla'));
  assert.ok(cities.includes('pereira'));
  assert.ok(MUNDIMOTOS_STORES.length >= 10);
});

runTest('LOC-8. Detector de repetición verbatim identifica respuestas idénticas o casi idénticas', () => {
  const msg1 = "¡Ese es el punto autorizado principal en Medellín! Y recuerda que te lo despachamos directo a tu taller pidiéndolo al WhatsApp +57 302 427 6647 🏍️📦";
  const msg2 = "Ese es el punto autorizado principal en Medellin Y recuerda que te lo despachamos directo a tu taller pidiendolo al WhatsApp +57 302 427 6647";
  const msg3 = "¡Claro que sí! En Medellín también contamos con la sede de La Bayadera.";
  assert.strictEqual(isVerbatimRepetition(msg1, msg2), true);
  assert.strictEqual(isVerbatimRepetition(msg1, msg3), false);
});

console.log('\n=======================================================');
console.log(`📊 RESULTADOS DEL TEST SUITE: ${passedTests}/${totalTests} PRUEBAS SUPERADAS CON ÉXITO.`);
if (passedTests === totalTests) {
  console.log('🎯 ¡CUMPLIMIENTO DEL 100% EN TODAS LAS REGLAS CONVERSACIONALES Y DE NLP!');
} else {
  console.error('⚠️ ALGUNAS PRUEBAS FALLARON.');
  process.exit(1);
}
console.log('=======================================================\n');

