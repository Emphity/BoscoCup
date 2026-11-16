-- Gestión completa de veedores desde el panel del organizador.
-- Correr con: node scripts/run-sql.mjs supabase/migrations/0008_gestion_veedores.sql
--
-- 1. Tabla veedor_pins: guarda el PIN de cada veedor para que el admin lo
--    pueda volver a ver. Solo la lee/escribe un admin (RLS).
-- 2. admin_set_veedor_pin: cambia el PIN (email + contraseña de la cuenta).
-- 3. admin_set_veedor_activo: activa/desactiva. Desactivado = la cuenta queda
--    bloqueada en Auth (no puede ni iniciar sesión) y pierde sus partidos.
-- 4. admin_eliminar_veedor: borra la cuenta, el perfil y sus asignaciones.
--    Los goles/tarjetas que cargó se conservan (creado_por queda en null).
--
-- Nota: los veedores creados antes de esta migración no tienen PIN guardado.
-- Para verlo desde el panel hay que asignarles uno nuevo con "Editar".

begin;

-- ---- 1. PINs visibles para el admin ----
create table if not exists veedor_pins (
  veedor_id uuid primary key references profiles(id) on delete cascade,
  pin text not null unique check (pin ~ '^\d{6}$'),
  updated_at timestamptz not null default now()
);

alter table veedor_pins enable row level security;
drop policy if exists admin_todo_veedor_pins on veedor_pins;
create policy admin_todo_veedor_pins on veedor_pins for all using (is_admin()) with check (is_admin());

-- Que borrar un perfil no quede trabado por lo que esa persona cargó.
alter table eventos_partido drop constraint if exists eventos_partido_creado_por_fkey;
alter table eventos_partido add constraint eventos_partido_creado_por_fkey
  foreign key (creado_por) references profiles(id) on delete set null;
alter table sanciones drop constraint if exists sanciones_creado_por_fkey;
alter table sanciones add constraint sanciones_creado_por_fkey
  foreign key (creado_por) references profiles(id) on delete set null;
alter table avisos drop constraint if exists avisos_creado_por_fkey;
alter table avisos add constraint avisos_creado_por_fkey
  foreign key (creado_por) references profiles(id) on delete set null;
alter table auditoria drop constraint if exists auditoria_usuario_id_fkey;
alter table auditoria add constraint auditoria_usuario_id_fkey
  foreign key (usuario_id) references profiles(id) on delete set null;

-- Chequeo común: quien llama es admin y el destino es un veedor.
create or replace function _exigir_admin_sobre_veedor(p_veedor_id uuid)
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Solo el organizador puede gestionar veedores' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_veedor_id and rol = 'veedor') then
    raise exception 'Veedor inexistente' using errcode = 'P0002';
  end if;
end;
$$;

-- ---- 2. cambiar PIN ----
create or replace function admin_set_veedor_pin(p_veedor_id uuid, p_pin text)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_email text := 'veedor-' || p_pin || '@boscocup.local';
begin
  perform _exigir_admin_sobre_veedor(p_veedor_id);
  if p_pin !~ '^\d{6}$' then
    raise exception 'El PIN debe tener 6 dígitos' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email and id <> p_veedor_id) then
    raise exception 'Ese PIN ya lo usa otra cuenta' using errcode = '23505';
  end if;

  update auth.users
     set email = v_email,
         encrypted_password = crypt(p_pin, gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = p_veedor_id;

  update auth.identities
     set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', v_email),
         updated_at = now()
   where user_id = p_veedor_id and provider = 'email';

  -- Cierra las sesiones abiertas con el PIN viejo.
  delete from auth.sessions where user_id = p_veedor_id;

  insert into veedor_pins (veedor_id, pin, updated_at)
  values (p_veedor_id, p_pin, now())
  on conflict (veedor_id) do update set pin = excluded.pin, updated_at = now();
end;
$$;

-- ---- 3. activar / desactivar ----
create or replace function admin_set_veedor_activo(p_veedor_id uuid, p_activo boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform _exigir_admin_sobre_veedor(p_veedor_id);
  update profiles set activo = p_activo where id = p_veedor_id;
  update auth.users
     set banned_until = case when p_activo then null else 'infinity'::timestamptz end,
         updated_at = now()
   where id = p_veedor_id;
  if not p_activo then
    delete from auth.sessions where user_id = p_veedor_id;
  end if;
end;
$$;

-- ---- 4. eliminar ----
create or replace function admin_eliminar_veedor(p_veedor_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform _exigir_admin_sobre_veedor(p_veedor_id);
  delete from asignaciones_veedor where veedor_id = p_veedor_id;
  delete from profiles where id = p_veedor_id;
  delete from auth.users where id = p_veedor_id;
end;
$$;

revoke all on function _exigir_admin_sobre_veedor(uuid) from public, anon, authenticated;
revoke all on function admin_set_veedor_pin(uuid, text) from public, anon;
revoke all on function admin_set_veedor_activo(uuid, boolean) from public, anon;
revoke all on function admin_eliminar_veedor(uuid) from public, anon;
grant execute on function admin_set_veedor_pin(uuid, text) to authenticated;
grant execute on function admin_set_veedor_activo(uuid, boolean) to authenticated;
grant execute on function admin_eliminar_veedor(uuid) to authenticated;

commit;
