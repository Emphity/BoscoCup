-- La vista pública guarda en memoria las tablas que casi no cambian
-- (categorías, equipos, grupos, asignación de equipos a grupos y canchas)
-- para no volver a pedirlas con cada gol. Para enterarse cuando el admin
-- edita alguna, necesita recibir sus cambios por Realtime.

alter publication supabase_realtime add table categorias;
alter publication supabase_realtime add table equipos;
alter publication supabase_realtime add table grupos;
alter publication supabase_realtime add table grupo_equipos;
alter publication supabase_realtime add table canchas;
