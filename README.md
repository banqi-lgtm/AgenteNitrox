# Agente NITROX - WhatsApp Bot (Mateo) [v5.1.0]

Agente de Inteligencia Artificial para caracterización, scoring y afiliación de talleres aliados en WhatsApp para **RED NITROX**.

## Novedades en v5.1.0
- **Diferenciación y resolución de ambigüedad**: Distinción inteligente entre nombre de la persona y nombre del taller (repregunta natural en casos dudosos).
- **Seguimiento dinámico a respuestas parciales**: Validación campo a campo sin asumir respuestas ante preguntas compuestas.
- **Captura territorial fidedigna**: Barrio y dirección física obligatorios.
- **Generación de credenciales digitales con código QR**: Imagen PNG en alta resolución y carnet web interactivo 3D.
- **Captura legal previa**: Correo, Cédula/NIT y autorización explícita de Habeas Data antes de la entrega del QR.
- **CRM y Exportación**: Panel administrativo con filtros y exportación CSV con codificación UTF-8 BOM para Excel.

## Instalación

```bash
npm install
```

Crea tu archivo `.env` basándote en `.env.example`:

```bash
cp .env.example .env
```

## Ejecución local

```bash
node server.js
```
