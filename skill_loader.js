// skill_loader.js - Cargador y Ensamblador Modular de Skills en Memoria para MATEO
// RED NITROX Colombia

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills', 'mateo');
let cachedPrompt = null;
const skillsMap = new Map();

/**
 * Carga e indexa todos los archivos de habilidad (.md) en memoria RAM.
 * Se ejecuta una sola vez al arrancar para garantizar cero latencia de I/O de disco.
 */
function loadSkills(dir = SKILLS_DIR) {
  skillsMap.clear();
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️ [SKILL_LOADER] Directorio de skills no encontrado: ${dir}`);
    cachedPrompt = '';
    return '';
  }

  const files = fs.readdirSync(dir)
    .filter(file => file.endsWith('.md'))
    .sort();

  const sections = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const skillKey = file.replace(/\.md$/, '');
    skillsMap.set(skillKey, content);
    sections.push(content);
  }

  cachedPrompt = sections.join('\n\n---\n\n');
  console.log(`🧩 [SKILL_LOADER] ${skillsMap.size} skills cargadas en memoria RAM desde ${dir}`);
  return cachedPrompt;
}

// Carga inicial síncrona en memoria RAM
loadSkills();

/**
 * Retorna el SYSTEM_PROMPT completo ensamblado a partir de los archivos .md.
 */
function getMateoSystemPrompt() {
  if (!cachedPrompt) {
    return loadSkills();
  }
  return cachedPrompt;
}

/**
 * Obtiene el contenido específico de una habilidad por su clave (ej: '00_identidad_pnl').
 */
function getSkill(skillKey) {
  return skillsMap.get(skillKey) || null;
}

/**
 * Recarga las habilidades en caliente (útil para pruebas y desarrollo).
 */
function reloadSkills() {
  return loadSkills();
}

module.exports = {
  loadSkills,
  getMateoSystemPrompt,
  getSkill,
  reloadSkills,
  get SYSTEM_PROMPT() {
    return getMateoSystemPrompt();
  }
};
