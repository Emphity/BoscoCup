import { supabase } from "@/lib/supabase";
import { AMARILLAS_PARA_SUSPENSION } from "@/lib/reglas";
import type { EventoPartidoRow, PartidoRow } from "@/lib/db-types";

/**
 * Tarjetas acumulativas: quién de un equipo no puede jugar su próximo partido.
 *
 * Se recorren los partidos ya jugados del equipo en orden:
 * - Roja directa o doble amarilla → suspendido para el partido siguiente.
 * - Amarillas sueltas (en el partido en que vio doble amarilla no cuentan):
 *   al llegar a AMARILLAS_PARA_SUSPENSION, suspendido para el siguiente y el
 *   contador vuelve a cero.
 * La suspensión se da por cumplida con el siguiente partido jugado por el equipo.
 */
export interface Suspension {
  motivo: string;
}

export interface EstadoTarjetas {
  /** Jugadores que no pueden jugar el próximo partido del equipo. */
  suspendidos: Map<string, Suspension>;
  /** Amarillas acumuladas que todavía no llegaron a suspensión. */
  amarillas: Map<string, number>;
}

const JUGADOS = ["finalizado", "walkover"];

function orden(p: Pick<PartidoRow, "fecha_hora_programada" | "created_at">): string {
  return p.fecha_hora_programada ?? p.created_at ?? "";
}

export function calcularTarjetas(
  partidos: Pick<PartidoRow, "id" | "fecha_hora_programada" | "created_at">[],
  eventos: Pick<EventoPartidoRow, "partido_id" | "jugador_id" | "tipo">[]
): EstadoTarjetas {
  const suspendidos = new Map<string, Suspension>();
  const amarillas = new Map<string, number>();
  const ordenados = [...partidos].sort((a, b) => orden(a).localeCompare(orden(b)));

  for (const p of ordenados) {
    // Jugar este partido cumple las suspensiones que venían del anterior.
    suspendidos.clear();

    const delPartido = eventos.filter((e) => e.partido_id === p.id && e.jugador_id);
    const expulsadoPorDoble = new Set(delPartido.filter((e) => e.tipo === "doble_amarilla").map((e) => e.jugador_id as string));
    const amarillasPartido = new Map<string, number>();

    for (const e of delPartido) {
      const j = e.jugador_id as string;
      if (e.tipo === "tarjeta_roja") suspendidos.set(j, { motivo: "Roja" });
      else if (e.tipo === "doble_amarilla") suspendidos.set(j, { motivo: "Doble amarilla" });
      else if (e.tipo === "tarjeta_amarilla" && !expulsadoPorDoble.has(j)) {
        amarillasPartido.set(j, (amarillasPartido.get(j) ?? 0) + 1);
      }
    }

    for (const [j, n] of amarillasPartido) {
      const total = (amarillas.get(j) ?? 0) + n;
      if (total >= AMARILLAS_PARA_SUSPENSION) {
        amarillas.set(j, 0);
        if (!suspendidos.has(j)) suspendidos.set(j, { motivo: `${AMARILLAS_PARA_SUSPENSION} amarillas acumuladas` });
      } else {
        amarillas.set(j, total);
      }
    }
  }

  return { suspendidos, amarillas };
}

/**
 * Estado de tarjetas de un equipo antes de su próximo partido.
 * `excluirPartidoId`: el partido que se está jugando ahora (no cuenta todavía).
 */
export async function fetchTarjetasEquipo(equipoId: string, excluirPartidoId?: string): Promise<EstadoTarjetas> {
  const vacio: EstadoTarjetas = { suspendidos: new Map(), amarillas: new Map() };
  if (!supabase) return vacio;

  const { data: partidosData } = await supabase
    .from("partidos")
    .select("id, fecha_hora_programada, created_at")
    .or(`equipo_local_id.eq.${equipoId},equipo_visitante_id.eq.${equipoId}`)
    .in("estado", JUGADOS);
  const partidos = ((partidosData as Pick<PartidoRow, "id" | "fecha_hora_programada" | "created_at">[]) ?? []).filter(
    (p) => p.id !== excluirPartidoId
  );
  if (partidos.length === 0) return vacio;

  const { data: eventosData } = await supabase
    .from("eventos_partido")
    .select("partido_id, jugador_id, tipo")
    .in(
      "partido_id",
      partidos.map((p) => p.id)
    )
    .eq("equipo_id", equipoId)
    .eq("anulado", false)
    .in("tipo", ["tarjeta_amarilla", "tarjeta_roja", "doble_amarilla"]);

  return calcularTarjetas(partidos, (eventosData as Pick<EventoPartidoRow, "partido_id" | "jugador_id" | "tipo">[]) ?? []);
}
