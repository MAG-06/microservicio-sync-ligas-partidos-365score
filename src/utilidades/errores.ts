/** Errores de aplicacion con formato estandarizado */

import { ZodError } from "zod";

export type CodigoError =
  | "VALIDACION"
  | "NO_AUTORIZADO"
  | "LIGA_NO_MAPEADA"
  | "PARTIDO_NO_ENCONTRADO"
  | "PARTIDO_AMBIGUO"
  | "SYNC_EN_CURSO"
  | "STATS_NO_DISPONIBLE"
  | "ERROR_INTERNO";

export class ErrorApp extends Error {
  constructor(
    public readonly codigo: CodigoError,
    public readonly httpStatus: number,
    public readonly mensaje: string,
    public readonly extras?: Record<string, unknown>,
  ) {
    super(mensaje);
    this.name = "ErrorApp";
  }
}

/** Resume las primeras `max` issues de un ZodError como "path: message; ..." */
export function resumirIssuesZod(error: ZodError, max = 3): string {
  const partes = error.issues
    .slice(0, max)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(raiz)"}: ${issue.message}`);
  const resto = error.issues.length - max;
  return resto > 0 ? `${partes.join("; ")} (+${resto} mas)` : partes.join("; ");
}

/** Motivo legible de un fallo cualquiera (los ZodError se resumen) */
export function describirFallo(error: unknown): string {
  if (error instanceof ZodError) return resumirIssuesZod(error);
  if (error instanceof Error) return error.message;
  return String(error);
}
