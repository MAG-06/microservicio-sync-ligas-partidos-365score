/** Esquemas Zod para validacion de entradas y respuestas de la API */

import { z } from "zod";

// --- Respuesta de la API 365Scores ---

export const esquemaCompetidor365 = z.object({
  id: z.number(),
  name: z.string(),
});

export const esquemaJuego365 = z.object({
  id: z.number(),
  competitionId: z.number(),
  startTime: z.string(),
  statusText: z.string(),
  statusGroup: z.number(),
  roundNum: z.number().nullable().optional(),
  homeCompetitor: esquemaCompetidor365,
  awayCompetitor: esquemaCompetidor365,
});

export const esquemaRespuesta365 = z.object({
  games: z.array(esquemaJuego365),
});

// --- Query de buscar-partido ---

export const esquemaQueryBuscar = z.object({
  casa: z.string().min(1),
  liga_casa_id: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  local: z.string().min(1),
  visitante: z.string().min(1),
  inicio: z.string().datetime({ offset: true }).optional(),
});

// --- Query de equivalencias ---

export const esquemaQueryEquivalencias = z.object({
  casa: z.string().min(1),
});
