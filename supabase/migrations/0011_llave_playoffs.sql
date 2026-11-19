-- Cuadro de playoffs para cualquier cantidad de equipos (par o impar).
-- Correr DESPUÉS de 0010: node scripts/run-sql.mjs supabase/migrations/0011_llave_playoffs.sql
--
-- 1. llave_pos: lugar del partido dentro de su ronda (0, 1, 2…). Con eso se
--    sabe qué partidos alimentan a cuál (los de lugar 2i y 2i+1 van al lugar i
--    de la ronda siguiente) y el cuadro se puede dibujar espejado.
-- 2. Por defecto entran todos los equipos a playoffs: la fase de grupos solo
--    ordena el cuadro. (99 = "todos"; se puede cambiar desde Cruces.)

begin;

alter table partidos add column if not exists llave_pos int;
alter table partidos drop constraint if exists partidos_llave_pos_rango;
alter table partidos add constraint partidos_llave_pos_rango check (llave_pos between 0 and 15) not valid;

create unique index if not exists partidos_llave_unica
  on partidos (categoria_id, ronda_eliminatoria, llave_pos)
  where ronda_eliminatoria is not null and llave_pos is not null;

update categorias set cantidad_clasifican_por_grupo = 99;

commit;
