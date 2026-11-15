import { supabase } from "@/lib/supabase";
import { DIA_TORNEO, FUTBOL, FUTBOL_MINUTOS_POR_TURNO } from "@/lib/reglas";
import type { CanchaRow, Categoria } from "@/lib/db-types";

const ROUND_ORDER = ["Octavos", "Cuartos", "Semifinal", "3er puesto", "Final"];

/**
 * Fútbol femenino: juega grupos y playoffs en su propia cancha, la que sigue a
 * las del masculino (una por grupo masculino, en orden por nombre).
 * Le pone esa cancha a los cruces que no la tengan y los programa uno detrás de
 * otro, en turnos de 35', a partir del último partido ya programado en esa cancha.
 * Devuelve el nombre de la cancha usada, o null si no aplica.
 */
export async function ubicarCrucesFemenino(categoria: Categoria, categorias: Categoria[]): Promise<string | null> {
  if (!supabase || categoria.deporte !== "futbol" || categoria.rama !== "Femenino") return null;

  const { data: canchasData } = await supabase.from("canchas").select("*").order("nombre");
  const canchas = ((canchasData as CanchaRow[]) ?? []).filter(
    (c) => c.estado !== "fuera_de_servicio" && (!c.deportes_compatibles?.length || c.deportes_compatibles.includes("futbol"))
  );
  if (canchas.length === 0) return null;

  const masculino = categorias.find((c) => c.deporte === "futbol" && c.rama === "Masculino");
  let antes = 0;
  if (masculino) {
    const { count } = await supabase.from("grupos").select("id", { count: "exact", head: true }).eq("categoria_id", masculino.id);
    antes = Math.max(1, count ?? 0);
  }
  const cancha = canchas[antes % canchas.length];

  const { data: crucesData } = await supabase
    .from("partidos")
    .select("id, ronda_eliminatoria, cancha_id, fecha_hora_programada")
    .eq("categoria_id", categoria.id)
    .not("ronda_eliminatoria", "is", null)
    .in("estado", ["programado", "postergado", "suspendido"]);
  const sinUbicar = ((crucesData as { id: string; ronda_eliminatoria: string; cancha_id: string | null; fecha_hora_programada: string | null }[]) ?? [])
    .filter((p) => !p.cancha_id || !p.fecha_hora_programada)
    .sort((a, b) => ROUND_ORDER.indexOf(a.ronda_eliminatoria) - ROUND_ORDER.indexOf(b.ronda_eliminatoria));
  if (sinUbicar.length === 0) return cancha.nombre;

  // Arranca en el turno siguiente al último partido programado en esa cancha.
  const { data: ultimoData } = await supabase
    .from("partidos")
    .select("fecha_hora_programada")
    .eq("cancha_id", cancha.id)
    .not("fecha_hora_programada", "is", null)
    .order("fecha_hora_programada", { ascending: false })
    .limit(1);
  const turnoMs = FUTBOL_MINUTOS_POR_TURNO * 60 * 1000;
  const ultimo = (ultimoData as { fecha_hora_programada: string }[] | null)?.[0]?.fecha_hora_programada;
  let proximo = ultimo
    ? new Date(ultimo).getTime() + turnoMs
    : new Date(DIA_TORNEO.anio, DIA_TORNEO.mes - 1, DIA_TORNEO.dia, FUTBOL.horaInicio.horas, FUTBOL.horaInicio.minutos).getTime();

  for (const p of sinUbicar) {
    const fecha = p.fecha_hora_programada ?? new Date(proximo).toISOString();
    if (!p.fecha_hora_programada) proximo += turnoMs;
    await supabase.from("partidos").update({ cancha_id: cancha.id, fecha_hora_programada: fecha }).eq("id", p.id);
  }
  return cancha.nombre;
}
