# sync-365

Mantiene en Supabase los **partidos programados de 365Scores** de las ligas mapeadas y **resuelve el `game_id`** de 365Scores a partir de casa + liga de la casa + fecha + equipos. No descarga estadísticas ni usa IA. Es común a todas las casas: la traducción liga de la casa → competición de 365 sale de la tabla `equivalencias_liga` (la llena el servicio equivalencias-365).

**Lugar en el flujo:** casa → **sync-365** → stats-365 → IA → gateway. El gateway le pide el `game_id` de cada partido de la casa y usa `/equivalencias` para marcar qué ligas tienen estadísticas (`mapeada`).

**Puerto:** 8003

## Cómo correrlo

```bash
npm install
cp .env.example .env   # y llenar los valores
npm run dev            # desarrollo con recarga (tsx watch)
npm test               # tests (node:test + tsx; mockean fetch, sin llamadas reales)
npm run build          # compila a dist/
npm start              # producción (node dist/index.js)
```

## Variables de entorno

| Variable | Para qué | Obligatoria |
|---|---|---|
| `SUPABASE_URL` | URL de Supabase (`equivalencias_liga`, `partidos_programados_365`, `equipos_365`) | **Sí** |
| `SUPABASE_KEY` | Clave de Supabase | **Sí** |
| `PUERTO` | Puerto del servidor (default `8003`) | No |
| `HOST` | Host del servidor (default `127.0.0.1`) | No |
| `CORS_ORIGEN` | Origen permitido (default `*`) | No |
| `SYNC_TOKEN` | Token Bearer de `POST /api/sync`. Si no está definido, `/api/sync` siempre responde 401. | Sí, para sincronizar |
| `API_TOKEN` | Si se define, `/buscar-partido` y `/equivalencias` exigen `Authorization: Bearer <API_TOKEN>`; si no, son públicos | No |

## Endpoints

### `GET /salud`

```json
{ "estado": "ok" }
```

### `GET /buscar-partido`

```
GET /buscar-partido?casa=betplay&liga_casa_id=1000094985&fecha=2026-10-10&local=Millonarios&visitante=Nacional&inicio=2026-10-10T20:00:00-05:00
```

- `casa`, `liga_casa_id` (siempre string), `fecha` (`YYYY-MM-DD`, Bogotá), `local`, `visitante`: obligatorios.
- `inicio` (ISO con zona, opcional): hora de inicio según la casa. Activa el auto-alias y desempata.

```json
{ "game_id": 4512345, "competition_id": 620, "fecha_hora": "2026-10-10T20:00:00-05:00", "local": "Millonarios", "visitante": "Atlético Nacional", "fecha_difiere": false }
```

Cómo busca:

1. Traduce la liga con `equivalencias_liga` (`casa` + `liga_casa_id`, `activa = true`); si no hay → `LIGA_NO_MAPEADA`.
2. Si la liga no se sincronizó en las últimas 3 h, la sincroniza primero.
3. Busca en el día exacto (Bogotá). Los nombres se comparan normalizados (sin tildes, signos ni sufijos FC/CF/Club…) y contra los alias de `equipos_365`.
4. **Tolerancia de fecha:** si el día exacto no da nada, busca en ±3 días (`DIAS_TOLERANCIA_FECHA`) solo coincidencias completas; gana la más cercana a `inicio` (o al mediodía de `fecha`), empate → `PARTIDO_AMBIGUO`. La respuesta agrega `fecha_difiere: true` y `diferencia_minutos` (365Scores menos la hora de referencia).
5. **Auto-alias seguro:** con un único match parcial (un equipo coincide), devuelve el partido y aprende el alias del otro equipo solo si vino `inicio`, la hora difiere ≤ 30 min y el nombre no coincide con otro equipo de la competición. Si no, lo deja en el log `[auto-alias]` sin guardar. En la búsqueda con tolerancia nunca aprende.

### `GET /equivalencias?casa=betplay`

Ligas de la casa con equivalencia activa (la misma regla que usa `/buscar-partido` para `LIGA_NO_MAPEADA`). Pagina contra Supabase y ordena por `liga_casa_id` como texto. Casa sin equivalencias → 200 con `total: 0`.

```json
{ "casa": "betplay", "total": 1, "equivalencias": [{ "liga_casa_id": "1000094985", "competition_id_365": 620 }] }
```

### `POST /api/sync`

Header `Authorization: Bearer <SYNC_TOKEN>`. Toma las `competition_id_365` distintas de `equivalencias_liga` con `activa = true`, pide a 365Scores sus partidos actuales (máx. 2 ligas a la vez, pausa 1–2 s), hace upsert de partidos y equipos y actualiza `ultima_sincronizacion`.

```json
{ "ligas": 12, "partidos": 340 }
```

Se dispara a diario a las 6:30 a. m. (Bogotá) con el workflow `.github/workflows/sync-365.yml` (secrets `SYNC365_URL` y `SYNC_TOKEN`).

## Errores

Formato: `{ "error": { "codigo": "…", "mensaje": "…" } }`

| Código | HTTP | Cuándo |
|---|---|---|
| `VALIDACION` | 400 | Query inválida (trae `detalles` con los issues de Zod) o JSON mal formado y cualquier otro 4xx de Fastify (Content-Type no soportado, cuerpo muy grande…) |
| `NO_AUTORIZADO` | 401 | Token faltante o inválido |
| `LIGA_NO_MAPEADA` | 404 | La liga de la casa no tiene equivalencia activa en 365 |
| `PARTIDO_NO_ENCONTRADO` | 404 | No hay partido para esa fecha y equipos |
| `RUTA_NO_ENCONTRADA` | 404 | Ruta inexistente |
| `PARTIDO_AMBIGUO` | 409 | Varios candidatos; trae `candidatos` |
| `STATS_NO_DISPONIBLE` | 502 | Falló 365Scores o Supabase |
| `ERROR_INTERNO` | 500 | Error no previsto (el detalle solo va al log) |

---

El detalle del contrato (§5.6 `liga_casa_id`, §12 `/buscar-partido`, §12.1 `/equivalencias`) está en `DOCS/CONTRATO-ARQUITECTURA.md`, que es la fuente de verdad.
