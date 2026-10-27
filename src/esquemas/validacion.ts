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

// --- Respuesta de /web/standings/ (solo lo que se usa) ---

export const esquemaFilaStanding365 = z.object({
  competitor: esquemaCompetidor365,
  position: z.number(),
  gamePlayed: z.number(),
  gamesWon: z.number(),
  gamesEven: z.number(),
  gamesLost: z.number(),
  for: z.number(),
  against: z.number(),
  points: z.number(),
  // Grupo/conferencia (MLS, Liga Profesional Argentina, Libertadores…): todos los grupos vienen en la misma tabla
  groupNum: z.number().nullable().optional(),
  // Partido en juego de ese equipo: la tabla total ya lo cuenta y la local/visitante no
  liveGameId: z.number().nullable().optional(),
});

export const esquemaStandings365 = z.object({
  // Una temporada sin datos (p. ej. BetPlay 128/129) llega sin la clave `standings`
  standings: z
    .array(
      z.object({
        seasonNum: z.number(),
        stageNum: z.number(),
        rows: z.array(esquemaFilaStanding365),
        // types que trae la tabla; sin el split local/visitante (Tabla Anual, Reclasificacion) 365 ignora type=2/3
        filterTypes: z.array(z.object({ type: z.number() })).optional(),
      }),
    )
    .default([]),
  competitions: z
    .array(
      z.object({
        id: z.number(),
        hasStandings: z.boolean().optional(),
        currentSeasonNum: z.number(),
        currentStageNum: z.number(),
      }),
    )
    .optional(),
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
