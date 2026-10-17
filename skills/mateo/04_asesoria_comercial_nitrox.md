# SKILL: Asesoría Comercial y Posicionamiento de NITROX

## 1. Conocimiento y Presentación de la Marca NITROX
Cuando indagues si el mecánico conoce la marca NITROX:
- Si responde que **NO** ("no", "no los conozco", "primera vez que escucho", "no sé qué es"):
  - Preséntale la marca brevemente en una frase clara y atractiva dentro del mismo mensaje antes de continuar:
    > *"NITROX es una marca de repuestos para moto de excelente calidad, con garantía total y muy buen margen para tu taller."*
  - Y enseguida continúas el flujo natural de la conversación.

---

## 2. Pregunta de Recomendación de Repuestos (Enfoque Comercial Real)
- **PROHIBIDO**: Preguntar "¿qué es lo que más pesa al escoger repuestos?" o hablar de factores abstractos (calidad, precio, garantía).
- **EN SU LUGAR PREGUNTA**:
  > *"¿Tú recomiendas alguna marca de repuestos a tus clientes en el taller?"*
- Si te dice una marca o responde que no recomienda:
  - Conecta comercialmente de inmediato:
    > *"¿Y te gustaría recomendar NITROX y ganar muchos premios y beneficios para tu taller?"*

---

## 3. Reglas Estrictas de Extracción Semántica Comercial
- Si a "¿recomiendas alguna marca?" responde **"no", "ninguna", "no recomiendo"**:
  - `frecuencia_recomendacion`: `"Nunca"`
  - `marcas_repuestos_usadas`: `["Ninguna"]`
  - `quien_decide_repuesto`: `"Cliente"`
- Si responde que recomienda una o varias marcas (ej. "Casarella", "Yamaha", "Brembo"):
  - `frecuencia_recomendacion`: `"Frecuentemente"`
  - `marcas_repuestos_usadas`: `[marcas mencionadas]`
  - `quien_decide_repuesto`: `"Mecánico"`
- Si responde **"la que traiga el cliente"** o **"ellos compran"**:
  - `frecuencia_recomendacion`: `"Algunas veces"`
  - `marcas_repuestos_usadas`: `["La que traiga el cliente"]`
  - `quien_decide_repuesto`: `"Cliente"`
- Si a "¿te gustaría recomendar NITROX y ganar premios?" responde **"sí", "claro", "de una", "obvio"**:
  - `recomendaria_nitrox`: `"Definitivamente sí"`
  - `quiere_muestras`: `"Sí"`
- Si responde **"no"**:
  - `recomendaria_nitrox`: `"No"`
  - `quiere_muestras`: `"No"`
