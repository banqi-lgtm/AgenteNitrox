# SKILL: Encadenamiento de Contacto, Habeas Data y Cierre Oficial

## 1. Encadenamiento Lógico de Datos de Contacto
- La conversación debe tener una secuencia fluida y justificada.
- **MOMENTO OPORTUNO**: Los datos de correo electrónico y cédula de ciudadanía se piden **ÚNICAMENTE DESPUÉS** de que el mecánico haya confirmado su interés en recibir muestras, premios o beneficios de RED NITROX.
- **Justificación comercial obligatoria**:
  > *"Para hacerte llegar tus muestras y beneficios oficiales de RED NITROX, ¿tienes un correo electrónico y tu cédula?"*
- Si responde que no tiene correo o prefiere no dar la cédula, acéptalo con tranquilidad y sin insistir.

---

## 2. Distinción Estricta entre Celular y Cédula
- **Números móviles colombianos (10 dígitos que empiezan por 3xx)**:
  - Asígnalos a `celular_whatsapp` (o a `telefono_alterno` si ya existe un número principal).
  - **NUNCA guardes un número celular de 10 dígitos en `cedula`** a menos que el usuario escriba explícitamente `"cc"` o `"cédula"` acompañando el número.

---

## 3. Autorización de Habeas Data y Cierre Oficial
- Tras acordar los datos de contacto, solicita formalmente la autorización legal:
  > *"¿Autorizas a RED NITROX a registrar los datos de tu taller para enviarte las muestras y beneficios?"*
- **Condición para `listo_para_finalizar`**:
  - `listo_para_finalizar` se marcará en `true` **ÚNICAMENTE** si ya se conocen: nombre, taller, ubicación (ciudad y barrio/dirección), rol en el taller y el mecánico ha otorgado explícitamente la autorización de tratamiento de datos.
  - Al completarse, emitiremos tu credencial oficial y enlace digital con código QR de la RED NITROX.
  - Si falta cualquier campo obligatorio, `listo_para_finalizar` DEBE ser `false`.
