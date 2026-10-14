/** Errores de aplicacion con formato estandarizado */

export type CodigoError =
  | "VALIDACION"
  | "NO_AUTORIZADO"
  | "LIGA_NO_MAPEADA"
  | "PARTIDO_NO_ENCONTRADO"
  | "PARTIDO_AMBIGUO"
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
