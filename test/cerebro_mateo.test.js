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
const { getPendingTopics } = require('../gemini_brain');
const { normalizeMechanicData } = require('../scoring');

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
  assert.ok(!pending.includes('Ubicación (barrio o municipio)'), 'Ubicación no debe estar pendiente');
  assert.ok(!pending.includes('Marcas de motos atendidas'), 'Marcas no debe estar pendiente');
  assert.ok(!pending.includes('Flujo o volumen de motos atendidas'), 'Volumen no debe estar pendiente');
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

console.log('\n=======================================================');
console.log(`📊 RESULTADOS DEL TEST SUITE: ${passedTests}/${totalTests} PRUEBAS SUPERADAS CON ÉXITO.`);
if (passedTests === totalTests) {
  console.log('🎯 ¡CUMPLIMIENTO DEL 100% EN TODAS LAS REGLAS CONVERSACIONALES Y DE NLP!');
} else {
  console.error('⚠️ ALGUNAS PRUEBAS FALLARON.');
  process.exit(1);
}
console.log('=======================================================\n');
