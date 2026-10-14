/** Mapeo de statusGroup de 365Scores a estado legible */

export function mapearEstado(statusGroup: number, statusText: string): string {
  if (statusGroup === 2) return "programado";
  if (statusGroup === 4) return "finalizado";
  return statusText.toLowerCase();
}
