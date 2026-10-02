# Agente NITROX - WhatsApp Bot (Mateo)

Agente de Inteligencia Artificial para atención y afiliación de talleres aliados en WhatsApp para **NITROX**.

## Características
- Integración oficial con **Meta WhatsApp Cloud API**.
- Personalidad paisa, natural, relajada y humana (**Mateo, Asesor Comercial**).
- Flujo interactivo paso a paso para afiliación de talleres:
  - Nombre del taller
  - Ciudad y dirección
  - Cantidad de personal/mecánicos
  - Maquinaria y equipos
- Simulación de ritmo humano: confirmación de lectura y pausas naturales de escritura (5-7 segundos).
- Arquitectura lista para despliegue 24/7 en la nube (Firebase Functions / Render / Railway).

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
