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
