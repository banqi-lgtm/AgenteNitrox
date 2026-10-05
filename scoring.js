// Calculation of Potential Score (0 to 100 pts) and RED NITROX Level (Nivel 1 to 7)

function calculateMechanicScore(data) {
  let score = 0;

  // 1. Motos atendidas por semana (Máx 35 pts)
  const motos = (data.motos_por_semana || data.motosSemana || '').toString();
  if (motos.includes('Más de 60') || motos.includes('>60') || motos.includes('60+')) {
    score += 35;
  } else if (motos.includes('41–60') || motos.includes('41-60')) {
    score += 28;
  } else if (motos.includes('21–40') || motos.includes('21-40')) {
    score += 20;
  } else if (motos.includes('11–20') || motos.includes('11-20')) {
    score += 12;
  } else if (motos.includes('1–10') || motos.includes('1-10')) {
    score += 5;
  } else {
    // Estimación numérica directa si viene texto libre
    const numMatch = motos.match(/\d+/);
    if (numMatch) {
      const val = parseInt(numMatch[0], 10);
      if (val > 60) score += 35;
      else if (val >= 40) score += 28;
      else if (val >= 20) score += 20;
      else if (val >= 10) score += 12;
      else score += 5;
    } else if (/mucha|bastante|harto|full|varias/i.test(motos)) {
      score += 25; // Buen volumen libre
    } else {
      score += 10; // Default moderado
    }
  }

  // 2. Capacidad de Prescripción (Quién decide el repuesto) (Máx 30 pts)
  const decide = (data.quien_decide_repuesto || data.decisionRepuesto || '').toLowerCase();
  if (decide.includes('mecánico') || decide.includes('mecanico') || decide.includes('ambos') || decide.includes('sujier') || decide.includes('sugier') || decide.includes('recomiend') || decide.includes('yo')) {
    score += 30;
  } else if (decide.includes('dueño') || decide.includes('propietario del taller') || decide.includes('administrador')) {
    score += 20;
  } else if (decide.includes('propietario de la moto') || decide.includes('cliente')) {
    score += 10;
  } else {
    score += 15;
  }

  // 3. Frecuencia de recomendación de marcas (Máx 20 pts)
  const reco = (data.frecuencia_recomendacion || data.frecuenciaRecomendacion || '').toLowerCase();
  if (reco.includes('siempre')) {
    score += 20;
  } else if (reco.includes('frecuentemente') || reco.includes('casi siempre')) {
    score += 15;
  } else if (reco.includes('algunas veces') || reco.includes('a veces')) {
    score += 10;
  } else if (reco.includes('rara vez') || reco.includes('nunca')) {
    score += 2;
  } else {
    score += 10;
  }

  // 4. Tamaño del Taller / Equipo (Máx 15 pts)
  const team = (data.personas_taller || data.teamSize || '').toString();
  if (team.includes('Más de 5') || team.includes('>5') || team.includes('5+')) {
    score += 15;
  } else if (team.includes('4–5') || team.includes('4-5')) {
    score += 12;
  } else if (team.includes('2–3') || team.includes('2-3')) {
    score += 8;
  } else {
    const num = team.match(/\d+/);
    if (num && parseInt(num[0], 10) >= 5) score += 15;
    else if (num && parseInt(num[0], 10) >= 3) score += 10;
    else score += 5;
  }

  return Math.min(100, Math.max(0, score));
}

function calculateNitroxLevel(data) {
  const conoce = (data.conoce_nitrox || '').toString().toLowerCase();
  const haUsado = (data.ha_usado_nitrox || '').toString().toLowerCase();
  const recomendaria = (data.recomendaria_nitrox || '').toString().toLowerCase();

  // Nivel 7: Recomienda NITROX
  if (recomendaria.includes('definitivamente') || recomendaria.includes('siempre')) {
    return { nivel: 7, nombre: 'Recomienda NITROX' };
  }

  // Nivel 4: Probó NITROX
  if (haUsado.includes('sí') || haUsado.includes('si')) {
    return { nivel: 4, nombre: 'Probó NITROX' };
  }

  // Nivel 2: Conoce NITROX
  if (conoce.includes('sí') || conoce.includes('si')) {
    return { nivel: 2, nombre: 'Conoce NITROX' };
  }

  // Nivel 1: Registrado
  return { nivel: 1, nombre: 'Registrado' };
}

function normalizeMechanicData(input, origin = 'Web') {
  const timestamp = new Date().toISOString();
  const rawId = Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 5).toUpperCase();
  const idUnico = input.id_unico || `RN-MED-${rawId}`;

  const score = calculateMechanicScore(input);
  const nivelObj = calculateNitroxLevel(input);

  return {
    // 4. Campos internos / automáticos
    id_unico: idUnico,
    fecha_registro: input.fecha_registro || timestamp,
    promotor: input.promotor || (origin === 'WhatsApp' ? 'Agente WhatsApp Mateo' : 'Formulario Virtual RED NITROX'),
    ciudad_ruta: input.ciudad_ruta || 'Medellín y Valle de Aburrá',
    zona_ruta: input.zona_ruta || input.barrio_taller || 'Zona Metropolitana',
    origen_registro: origin,
    estado_mecanico: input.estado_mecanico || 'Activo',
    score_potencial: score,
    nivel_relacion_numero: input.nivel_relacion_numero || nivelObj.nivel,
    nivel_relacion_nombre: input.nivel_relacion_nombre || nivelObj.nombre,

    // A. DATOS DEL MECÁNICO
    nombres_apellidos: input.nombres_apellidos || input.nombre || '',
    cedula: input.cedula || '',
    celular_whatsapp: input.celular_whatsapp || input.telefono || '',
    tiene_whatsapp: input.tiene_whatsapp !== undefined ? input.tiene_whatsapp : true,
    correo: input.correo || '',
    ciudad_residencia: input.ciudad_residencia || 'Medellín',
    barrio_residencia: input.barrio_residencia || '',

    // B. DATOS DEL TALLER
    nombre_taller: input.nombre_taller || input.taller || '',
    ciudad_taller: input.ciudad_taller || 'Medellín',
    barrio_taller: input.barrio_taller || '',
    direccion_taller: input.direccion_taller || input.direccion || '',
    relacion_taller: input.relacion_taller || 'Propietario',
    antiguedad_taller: input.antiguedad_taller || '1–3 años',
    personas_taller: input.personas_taller || input.personal || '1–2 personas',

    // C. PERFIL PROFESIONAL
    experiencia_mecanico: input.experiencia_mecanico || '',
    especialidad: Array.isArray(input.especialidad) ? input.especialidad : [input.especialidad || 'Mecánica general'],
    tipo_motos: Array.isArray(input.tipo_motos) ? input.tipo_motos : [input.tipo_motos || 'Varias'],
    marcas_motos: Array.isArray(input.marcas_motos) ? input.marcas_motos : [input.marcas_motos || 'Varias'],

    // D. POTENCIAL E INFLUENCIA
    motos_por_semana: input.motos_por_semana || '11–20',
    quien_decide_repuesto: input.quien_decide_repuesto || 'Mecánico',
    frecuencia_recomendacion: input.frecuencia_recomendacion || 'Frecuentemente',

    // E. COMPORTAMIENTO DE COMPRA Y MARCAS
    donde_compra_repuestos: Array.isArray(input.donde_compra_repuestos) ? input.donde_compra_repuestos : [input.donde_compra_repuestos || 'Almacenes'],
    marcas_repuestos_usadas: Array.isArray(input.marcas_repuestos_usadas) ? input.marcas_repuestos_usadas : [input.marcas_repuestos_usadas || 'NITROX'],
    factores_eleccion_repuesto: Array.isArray(input.factores_eleccion_repuesto) ? input.factores_eleccion_repuesto : ['Calidad', 'Durabilidad', 'Garantía-respaldo'],

    // F. RELACIÓN ACTUAL CON NITROX
    conoce_nitrox: input.conoce_nitrox || 'Sí',
    como_conocio_nitrox: input.como_conocio_nitrox || '',
    ha_usado_nitrox: input.ha_usado_nitrox || 'Sí',
    categorias_nitrox_usadas: Array.isArray(input.categorias_nitrox_usadas) ? input.categorias_nitrox_usadas : [],
    calificacion_experiencia_nitrox: input.calificacion_experiencia_nitrox || '',
    recomendaria_nitrox: input.recomendaria_nitrox || 'Definitivamente sí',

    // G. INTERÉS EN RED NITROX
    actividades_interes: Array.isArray(input.actividades_interes) ? input.actividades_interes : ['Capacitaciones técnicas', 'Probar productos NITROX', 'Beneficios y premios'],
    temas_capacitacion: Array.isArray(input.temas_capacitacion) ? input.temas_capacitacion : ['Motor', 'Inyección', 'Diagnóstico'],

    // H. AUTORIZACIONES
    autorizacion_tratamiento_datos: input.autorizacion_tratamiento_datos !== undefined ? input.autorizacion_tratamiento_datos : true,
    autorizacion_comunicaciones_comerciales: input.autorizacion_comunicaciones_comerciales !== undefined ? input.autorizacion_comunicaciones_comerciales : true,

    notas_seguimiento: input.notas_seguimiento || []
  };
}

module.exports = {
  calculateMechanicScore,
  calculateNitroxLevel,
  normalizeMechanicData
};
