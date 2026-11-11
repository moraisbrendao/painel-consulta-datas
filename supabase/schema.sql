-- =====================================================================
-- PAINEL PREVENTIVO - LOGÍSTICA
-- Cole tudo no Supabase > SQL Editor > New query > Run.
-- Pode rodar de novo sempre que este arquivo mudar: as tratativas salvas
-- e a base enviada são mantidas.
-- =====================================================================

-- 1) Limpa o que sobrou do painel antigo (se ainda existir)
drop view if exists public.ultimo_retorno, public.envios cascade;
drop table if exists public.urgencias, public.usuarios_sac, public.notas, public.intelipost, public.intelipost_info,
  public.micro_status, public.responsaveis, public.retornos, public.pedidos, public.regras,
  public.entregas, public.atualizacao, public.admins cascade;
drop function if exists public.consulta_sac, public.meu_perfil, public.is_sac, public.importar_intelipost,
  public.chave_ms, public.restaurar_regras_padrao, public._carregar_regras_padrao, public.apagar_lote,
  public.enviar_retornos, public.importar_pedidos, public.substituir_entregas, public.is_admin cascade;

-- 2) Base de pedidos (vem da planilha da Intelipost; cada envio substitui a anterior)
create table if not exists public.base_pedidos (
  pedido              text primary key,
  nf                  text,
  canal               text,
  origem              text,
  transportadora      text,
  micro_status        text,
  status_intelipost   text,
  descricao           text,
  ultima_atualizacao  timestamp,
  data_expedicao      date,
  prev_original       date,
  prev_atual          date,
  prev_360            date,
  comentario_360      text,
  uf                  text,
  cidade              text,
  ocorrencia          text,
  qtd_tickets         integer,
  motivo_ticket       text,
  link_rastreio       text
);

create table if not exists public.base_info (
  id          integer primary key default 1 check (id = 1),
  arquivo     text,
  total       integer,
  enviado_por text,
  enviado_em  timestamptz not null default now()
);

-- 3) Tratativas da Logística (ficam salvas mesmo quando a base é trocada)
create table if not exists public.tratativas (
  pedido          text primary key,
  situacao        text,
  nova_data       date,
  observacao      text,
  atualizado_por  text not null default (auth.jwt() ->> 'email'),
  atualizado_em   timestamptz not null default now()
);

create or replace function public._carimbo_tratativa()
returns trigger language plpgsql as $$
begin
  new.atualizado_por := coalesce(auth.jwt() ->> 'email', new.atualizado_por);
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists carimbo on public.tratativas;
create trigger carimbo before insert or update on public.tratativas
  for each row execute function public._carimbo_tratativa();

-- 4) Segurança: só quem tem login vê e altera. Ninguém se cadastra sozinho
--    (desligue "Allow new users to sign up" em Authentication).
alter table public.base_pedidos enable row level security;
alter table public.base_info    enable row level security;
alter table public.tratativas   enable row level security;

drop policy if exists "logados leem" on public.base_pedidos;
drop policy if exists "logados leem" on public.base_info;
drop policy if exists "logados leem" on public.tratativas;
drop policy if exists "logados alteram" on public.tratativas;
create policy "logados leem" on public.base_pedidos for select to authenticated using (true);
create policy "logados leem" on public.base_info    for select to authenticated using (true);
create policy "logados leem" on public.tratativas   for select to authenticated using (true);
create policy "logados alteram" on public.tratativas for all to authenticated using (true) with check (true);

revoke all on public.base_pedidos, public.base_info, public.tratativas from anon;
grant select on public.base_pedidos, public.base_info to authenticated;
grant select, insert, update, delete on public.tratativas to authenticated;

-- 5) Envio da planilha (em partes de até 2.000 linhas)
create or replace function public.importar_base(linhas jsonb, limpar boolean, arquivo text, total integer)
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if limpar then
    delete from public.base_pedidos where true;
    insert into public.base_info (id, arquivo, total, enviado_por, enviado_em)
    values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, total = excluded.total,
      enviado_por = excluded.enviado_por, enviado_em = excluded.enviado_em;
  end if;
  insert into public.base_pedidos
  select * from jsonb_populate_recordset(null::public.base_pedidos, linhas) r
  where r.pedido is not null and r.pedido <> ''
  on conflict (pedido) do update set
    nf = excluded.nf, canal = excluded.canal, origem = excluded.origem, transportadora = excluded.transportadora,
    micro_status = excluded.micro_status, status_intelipost = excluded.status_intelipost, descricao = excluded.descricao,
    ultima_atualizacao = excluded.ultima_atualizacao, data_expedicao = excluded.data_expedicao,
    prev_original = excluded.prev_original, prev_atual = excluded.prev_atual, prev_360 = excluded.prev_360,
    comentario_360 = excluded.comentario_360, uf = excluded.uf, cidade = excluded.cidade, ocorrencia = excluded.ocorrencia,
    qtd_tickets = excluded.qtd_tickets, motivo_ticket = excluded.motivo_ticket, link_rastreio = excluded.link_rastreio;
  return (select count(*) from public.base_pedidos);
end $$;
revoke all on function public.importar_base(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_base(jsonb, boolean, text, integer) to authenticated;

-- 6) Atualização em tempo real das tratativas para todos os usuários
do $$ begin
  alter publication supabase_realtime add table public.tratativas;
exception when others then null;   -- já adicionada (ou rodando fora do Supabase)
end $$;

-- 7) Arquivo da Intelipost (transactions): guarda só o número do pedido
--    dos ENTREGUES e CANCELADOS (status do transportador). Esses pedidos
--    somem do painel. Nenhum dado de cliente é enviado.
create table if not exists public.intelipost_fechados (
  pedido text primary key,
  status text
);
create table if not exists public.fechados_info (
  id           integer primary key default 1 check (id = 1),
  arquivo      text,
  total_linhas integer,
  fechados     integer,
  enviado_por  text,
  enviado_em   timestamptz not null default now()
);
alter table public.intelipost_fechados enable row level security;
alter table public.fechados_info enable row level security;
drop policy if exists "logados leem" on public.intelipost_fechados;
drop policy if exists "logados leem" on public.fechados_info;
create policy "logados leem" on public.intelipost_fechados for select to authenticated using (true);
create policy "logados leem" on public.fechados_info for select to authenticated using (true);
revoke all on public.intelipost_fechados, public.fechados_info from anon;
grant select on public.intelipost_fechados, public.fechados_info to authenticated;

-- pedidos da base que ainda estão em aberto (o painel lê daqui)
create or replace view public.base_aberta with (security_invoker = true) as
  select b.* from public.base_pedidos b
  where not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido);
revoke all on public.base_aberta from anon;
grant select on public.base_aberta to authenticated;

create or replace function public.importar_fechados(linhas jsonb, limpar boolean, arquivo text, total_linhas integer, fechados integer)
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if limpar then
    delete from public.intelipost_fechados where true;
    insert into public.fechados_info (id, arquivo, total_linhas, fechados, enviado_por, enviado_em)
    values (1, arquivo, total_linhas, fechados, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, total_linhas = excluded.total_linhas,
      fechados = excluded.fechados, enviado_por = excluded.enviado_por, enviado_em = excluded.enviado_em;
  end if;
  insert into public.intelipost_fechados (pedido, status)
  select r.pedido, r.status from jsonb_to_recordset(linhas) as r(pedido text, status text)
  where r.pedido is not null and r.pedido <> ''
  on conflict (pedido) do update set status = excluded.status;
  return (select count(*) from public.intelipost_fechados);
end $$;
revoke all on function public.importar_fechados(jsonb, boolean, text, integer, integer) from public, anon;
grant execute on function public.importar_fechados(jsonb, boolean, text, integer, integer) to authenticated;

-- 8) Ocorrências já cadastradas no portal (planilha enviada pela Logística todo dia).
--    Cada envio SOMA à lista (não apaga as dos dias anteriores).
create table if not exists public.ocorrencias_cadastradas (
  nf        text not null,
  serie     text not null default '',
  motivo    text,
  primeiro_envio timestamptz not null default now(),
  primary key (nf, serie)
);
create table if not exists public.ocorrencias_info (
  id          integer primary key default 1 check (id = 1),
  arquivo     text,
  linhas      integer,
  enviado_por text,
  enviado_em  timestamptz not null default now()
);
alter table public.ocorrencias_cadastradas enable row level security;
alter table public.ocorrencias_info enable row level security;
drop policy if exists "logados leem" on public.ocorrencias_cadastradas;
drop policy if exists "logados leem" on public.ocorrencias_info;
create policy "logados leem" on public.ocorrencias_cadastradas for select to authenticated using (true);
create policy "logados leem" on public.ocorrencias_info for select to authenticated using (true);
revoke all on public.ocorrencias_cadastradas, public.ocorrencias_info from anon;
grant select on public.ocorrencias_cadastradas, public.ocorrencias_info to authenticated;

create or replace function public.importar_ocorrencias(linhas jsonb, arquivo text, primeiro boolean, total integer)
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if primeiro then
    insert into public.ocorrencias_info (id, arquivo, linhas, enviado_por, enviado_em)
    values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas,
      enviado_por = excluded.enviado_por, enviado_em = excluded.enviado_em;
  end if;
  insert into public.ocorrencias_cadastradas (nf, serie, motivo)
  select r.nf, coalesce(r.serie, ''), r.motivo from jsonb_to_recordset(linhas) as r(nf text, serie text, motivo text)
  where r.nf is not null and r.nf <> ''
  on conflict (nf, serie) do update set motivo = coalesce(excluded.motivo, public.ocorrencias_cadastradas.motivo);
  return (select count(*) from public.ocorrencias_cadastradas);
end $$;
revoke all on function public.importar_ocorrencias(jsonb, text, boolean, integer) from public, anon;
grant execute on function public.importar_ocorrencias(jsonb, text, boolean, integer) to authenticated;

-- 9) SAC: quem estiver na lista abaixo entra no painel vendo SÓ a "Consulta SAC"
--    (NF, pedido, canal, transportadora, micro status, data prometida, nova data,
--    observação da Logística e rastreio). A lista é preenchida pelo próprio painel,
--    na página Consulta SAC (quadro "Logins do SAC").
create table if not exists public.logins_sac (
  email        text primary key,
  incluido_por text,
  incluido_em  timestamptz not null default now()
);
alter table public.logins_sac enable row level security;
revoke all on public.logins_sac from anon;

create or replace function public.e_sac()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.logins_sac where email = lower(auth.jwt() ->> 'email')) $$;
revoke all on function public.e_sac() from public, anon;
grant execute on function public.e_sac() to authenticated;

create or replace function public.meu_perfil_painel()
returns text language sql stable security definer set search_path = public
as $$ select case when public.e_sac() then 'sac' else 'logistica' end $$;
revoke all on function public.meu_perfil_painel() from public, anon;
grant execute on function public.meu_perfil_painel() to authenticated;

-- a Logística (quem não é SAC) cuida da lista; o SAC não lê nada direto das tabelas
drop policy if exists "logistica gerencia" on public.logins_sac;
create policy "logistica gerencia" on public.logins_sac for all to authenticated
  using (not public.e_sac()) with check (not public.e_sac());
grant select, insert, delete on public.logins_sac to authenticated;

do $$
declare t text;
begin
  foreach t in array array['base_pedidos','base_info','tratativas','intelipost_fechados','fechados_info',
                           'ocorrencias_cadastradas','ocorrencias_info'] loop
    execute format('drop policy if exists "logados leem" on public.%I', t);
    execute format('create policy "logados leem" on public.%I for select to authenticated using (not public.e_sac())', t);
  end loop;
end $$;
drop policy if exists "logados alteram" on public.tratativas;
create policy "logados alteram" on public.tratativas for all to authenticated
  using (not public.e_sac()) with check (not public.e_sac());

-- o que o SAC vê: só pedidos em aberto e só estas colunas
create or replace function public.consultar_sac()
returns table (pedido text, nf text, canal text, transportadora text, micro_status text,
               prometido date, nova_data date, observacao text, atualizado_em timestamptz, link_rastreio text)
language sql stable security definer set search_path = public
as $$
  select b.pedido, b.nf, b.canal, b.transportadora, b.micro_status,
         coalesce(b.prev_original, b.prev_atual), t.nova_data, t.observacao, t.atualizado_em, b.link_rastreio
  from public.base_pedidos b
  left join public.tratativas t on t.pedido = b.pedido
  where auth.uid() is not null
    and not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido)
  order by b.pedido
$$;
revoke all on function public.consultar_sac() from public, anon;
grant execute on function public.consultar_sac() to authenticated;

-- 10) Responsáveis: cada micro status tem um dono. Micro status sem dono aparece
--     como "Pendente de responsável". A Logística cuida disso na página Responsáveis.
create table if not exists public.pessoas_responsaveis (
  id    bigint generated always as identity primary key,
  nome  text not null unique,
  area  text
);
create table if not exists public.responsavel_por_ms (
  micro_status   text primary key,   -- nome do micro status em maiúsculas, sem acento
  responsavel_id bigint references public.pessoas_responsaveis(id) on delete cascade,
  atualizado_por text,
  atualizado_em  timestamptz not null default now()
);
alter table public.pessoas_responsaveis enable row level security;
alter table public.responsavel_por_ms enable row level security;
revoke all on public.pessoas_responsaveis, public.responsavel_por_ms from anon;
grant select, insert, update, delete on public.pessoas_responsaveis, public.responsavel_por_ms to authenticated;
drop policy if exists "logistica cuida" on public.pessoas_responsaveis;
drop policy if exists "logistica cuida" on public.responsavel_por_ms;
create policy "logistica cuida" on public.pessoas_responsaveis for all to authenticated
  using (not public.e_sac()) with check (not public.e_sac());
create policy "logistica cuida" on public.responsavel_por_ms for all to authenticated
  using (not public.e_sac()) with check (not public.e_sac());

create or replace function public._carimbo_responsavel()
returns trigger language plpgsql as $$
begin
  new.atualizado_por := coalesce(auth.jwt() ->> 'email', new.atualizado_por);
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists carimbo on public.responsavel_por_ms;
create trigger carimbo before insert or update on public.responsavel_por_ms
  for each row execute function public._carimbo_responsavel();

-- 11) Fila do robô do portal de ocorrências (ccp.360multi.com).
--     O painel grava aqui os grupos pendentes; o robô (GitHub Actions) pega o pedido,
--     importa no portal e grava o resultado. Só a Logística (e o login do robô) mexe.
create table if not exists public.fila_portal (
  id            bigint generated always as identity primary key,
  criado_em     timestamptz not null default now(),
  criado_por    text,
  teste         boolean not null default false,   -- true = faz tudo menos "Enviar Notas"
  status        text not null default 'pendente', -- pendente | processando | feito | erro
  grupos        jsonb not null,                   -- [{ms, motivo, transportadora, posicao, notas:[{nf,serie}]}]
  resultado     jsonb,
  iniciado_em   timestamptz,
  terminado_em  timestamptz
);
alter table public.fila_portal enable row level security;
revoke all on public.fila_portal from anon;
grant select, insert, update on public.fila_portal to authenticated;
drop policy if exists "logistica cuida" on public.fila_portal;
create policy "logistica cuida" on public.fila_portal for all to authenticated
  using (not public.e_sac()) with check (not public.e_sac());

create or replace function public._carimbo_fila()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.criado_por := coalesce(auth.jwt() ->> 'email', new.criado_por); end if;
  return new;
end $$;
drop trigger if exists carimbo on public.fila_portal;
create trigger carimbo before insert on public.fila_portal
  for each row execute function public._carimbo_fila();

-- o robô pega o pedido mais antigo da fila (um de cada vez)
create or replace function public.pegar_fila_portal()
returns setof public.fila_portal
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  -- pedido travado há mais de 1 hora volta como erro (o robô caiu no meio)
  update public.fila_portal set status = 'erro', terminado_em = now(),
    resultado = coalesce(resultado, '[]'::jsonb) || '[{"status":"erro","msg":"O robô parou no meio. Confira no portal antes de mandar de novo."}]'::jsonb
  where status = 'processando' and iniciado_em < now() - interval '1 hour';
  return query
  update public.fila_portal f set status = 'processando', iniciado_em = now()
  where f.id = (select id from public.fila_portal where status = 'pendente' order by id limit 1 for update skip locked)
  returning f.*;
end $$;
revoke all on function public.pegar_fila_portal() from public, anon;
grant execute on function public.pegar_fila_portal() to authenticated;
