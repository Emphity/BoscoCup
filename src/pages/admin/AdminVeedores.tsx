import { useEffect, useState, type FormEvent } from "react";
import { createProvisioningClient, supabase, veedorEmailFromPin } from "@/lib/supabase";
import type { Profile } from "@/lib/db-types";

type Veedor = Profile & { pin: string | null };

const soloDigitos = (s: string) => s.replace(/\D/g, "").slice(0, 6);

function mensajeError(err: unknown, porDefecto: string): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    if (/admin_set_veedor|admin_eliminar_veedor|veedor_pins/.test(err.message)) {
      return "Falta correr la migración 0008_gestion_veedores.sql en la base.";
    }
    if (/already registered|ya lo usa/i.test(err.message)) return "Ese PIN ya lo usa otro veedor. Elegí otro.";
    return err.message;
  }
  return porDefecto;
}

export function AdminVeedores() {
  const [veedores, setVeedores] = useState<Veedor[]>([]);
  const [nombre, setNombre] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [visibles, setVisibles] = useState<Set<string>>(new Set());
  const [editando, setEditando] = useState<string | null>(null);
  const [editNombre, setEditNombre] = useState("");
  const [editPin, setEditPin] = useState("");
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aEliminar, setAEliminar] = useState<string | null>(null);

  async function load() {
    if (!supabase) return;
    const [{ data: perfiles }, { data: pins }] = await Promise.all([
      supabase.from("profiles").select("*").eq("rol", "veedor").order("nombre"),
      supabase.from("veedor_pins").select("veedor_id, pin")
    ]);
    const pinPorId = new Map(((pins as { veedor_id: string; pin: string }[]) ?? []).map((p) => [p.veedor_id, p.pin]));
    setVeedores(((perfiles as Profile[]) ?? []).map((p) => ({ ...p, pin: pinPorId.get(p.id) ?? null })));
  }

  useEffect(() => {
    load();
  }, []);

  function limpiarMensajes() {
    setError(null);
    setSuccess(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    limpiarMensajes();
    if (!supabase) return setError("Supabase no está configurado.");
    if (pin.length !== 6) return setError("El PIN debe tener 6 dígitos.");
    setSubmitting(true);
    try {
      const provisioning = createProvisioningClient();
      const { data, error: signUpError } = await provisioning.auth.signUp({
        email: veedorEmailFromPin(pin),
        password: pin
      });
      if (signUpError) throw signUpError;
      if (!data.user) throw new Error("No se pudo crear la cuenta.");

      const { error: profileError } = await supabase
        .from("profiles")
        .insert({ id: data.user.id, nombre: nombre.trim(), rol: "veedor", activo: true });
      if (profileError) throw profileError;

      const { error: pinError } = await supabase.from("veedor_pins").upsert({ veedor_id: data.user.id, pin });
      if (pinError) throw pinError;

      setSuccess(`Veedor ${nombre.trim()} creado con PIN ${pin}.`);
      setNombre("");
      setPin("");
      load();
    } catch (err) {
      setError(mensajeError(err, "No se pudo crear el veedor."));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleVisible(id: string) {
    setVisibles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function empezarEdicion(v: Veedor) {
    limpiarMensajes();
    setEditando(v.id);
    setEditNombre(v.nombre);
    setEditPin(v.pin ?? "");
  }

  async function guardarEdicion(v: Veedor) {
    if (!supabase) return;
    limpiarMensajes();
    const nuevoNombre = editNombre.trim();
    if (!nuevoNombre) return setError("El nombre no puede quedar vacío.");
    if (editPin.length !== 6) return setError("El PIN debe tener 6 dígitos.");
    setOcupado(v.id);
    try {
      if (nuevoNombre !== v.nombre) {
        const { error: e1 } = await supabase.from("profiles").update({ nombre: nuevoNombre }).eq("id", v.id);
        if (e1) throw e1;
      }
      if (editPin !== v.pin) {
        const { error: e2 } = await supabase.rpc("admin_set_veedor_pin", { p_veedor_id: v.id, p_pin: editPin });
        if (e2) throw e2;
      }
      setSuccess(`Cambios guardados para ${nuevoNombre}.`);
      setEditando(null);
      load();
    } catch (err) {
      setError(mensajeError(err, "No se pudieron guardar los cambios."));
    } finally {
      setOcupado(null);
    }
  }

  async function onToggleActivo(v: Veedor) {
    if (!supabase) return;
    limpiarMensajes();
    setOcupado(v.id);
    const { error: err } = await supabase.rpc("admin_set_veedor_activo", { p_veedor_id: v.id, p_activo: !v.activo });
    setOcupado(null);
    if (err) return setError(mensajeError(err, "No se pudo cambiar el estado."));
    load();
  }

  async function onEliminar(v: Veedor) {
    if (!supabase) return;
    limpiarMensajes();
    setOcupado(v.id);
    const { error: err } = await supabase.rpc("admin_eliminar_veedor", { p_veedor_id: v.id });
    setOcupado(null);
    setAEliminar(null);
    if (err) return setError(mensajeError(err, "No se pudo eliminar el veedor."));
    setSuccess(`${v.nombre} eliminado.`);
    load();
  }

  return (
    <div>
      <h2 className="page-title">Veedores</h2>
      <p className="form-hint">
        Cada veedor entra con un PIN de 6 dígitos. Desde acá podés ver y cambiar su PIN, desactivarlo (no puede entrar
        hasta que lo reactives) o eliminarlo.
      </p>

      <form className="panel form-row" onSubmit={onSubmit}>
        <label className="field">
          <span>Nombre</span>
          <input className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
        </label>
        <label className="field" style={{ maxWidth: 140 }}>
          <span>PIN (6 dígitos)</span>
          <input
            className="input pin-input"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(soloDigitos(e.target.value))}
            required
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Creando…" : "Crear veedor"}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {success && <p className="form-success">{success}</p>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>PIN</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {veedores.map((v) => {
              const enEdicion = editando === v.id;
              const busy = ocupado === v.id;
              return (
                <tr key={v.id}>
                  <td>
                    {enEdicion ? (
                      <input className="input input-sm" value={editNombre} onChange={(e) => setEditNombre(e.target.value)} />
                    ) : (
                      v.nombre
                    )}
                  </td>
                  <td>
                    {enEdicion ? (
                      <input
                        className="input input-sm"
                        style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em", width: 110 }}
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={editPin}
                        onChange={(e) => setEditPin(soloDigitos(e.target.value))}
                      />
                    ) : v.pin ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <code style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em" }}>
                          {visibles.has(v.id) ? v.pin : "••••••"}
                        </code>
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => toggleVisible(v.id)}>
                          {visibles.has(v.id) ? "Ocultar" : "Ver"}
                        </button>
                      </span>
                    ) : (
                      <span className="form-hint" style={{ margin: 0 }}>
                        Sin guardar · editalo para asignar uno
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      disabled={busy || enEdicion}
                      onClick={() => onToggleActivo(v)}
                      title={v.activo ? "Tocá para desactivar" : "Tocá para activar"}
                    >
                      {v.activo ? "● Activo" : "○ Desactivado"}
                    </button>
                  </td>
                  <td className="row-actions">
                    {aEliminar === v.id ? (
                      <>
                        <span className="form-hint" style={{ margin: "0 8px 0 0", display: "inline" }}>
                          ¿Eliminar? No se puede deshacer.
                        </span>
                        <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => onEliminar(v)}>
                          {busy ? "Eliminando…" : "Sí, eliminar"}
                        </button>
                        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setAEliminar(null)}>
                          Cancelar
                        </button>
                      </>
                    ) : enEdicion ? (
                      <>
                        <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => guardarEdicion(v)}>
                          {busy ? "Guardando…" : "Guardar"}
                        </button>
                        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setEditando(null)}>
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => empezarEdicion(v)}>
                          Editar
                        </button>
                        <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => { limpiarMensajes(); setEditando(null); setAEliminar(v.id); }}>
                          Eliminar
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {veedores.length === 0 && (
              <tr>
                <td colSpan={4} className="empty-row">
                  Todavía no hay veedores cargados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
