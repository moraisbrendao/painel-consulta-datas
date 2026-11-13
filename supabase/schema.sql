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
    qtd_tickets = excluded.qtd_tickets, motivo_ticket = excluded.motivo_ticket, link_rastreio = excluded.link_rastreio,
    data_criacao = excluded.data_criacao, data_entrega = excluded.data_entrega, range_atrasos = excluded.range_atrasos,
    dias_atraso = excluded.dias_atraso, status_prazo = excluded.status_prazo, sem_expedicao = excluded.sem_expedicao;
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
  where coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
    and not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido);
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
  using ((select not public.e_sac())) with check ((select not public.e_sac()));
grant select, insert, delete on public.logins_sac to authenticated;

do $$
declare t text;
begin
  foreach t in array array['base_pedidos','base_info','tratativas','intelipost_fechados','fechados_info',
                           'ocorrencias_cadastradas','ocorrencias_info'] loop
    execute format('drop policy if exists "logados leem" on public.%I', t);
    execute format('create policy "logados leem" on public.%I for select to authenticated using ((select not public.e_sac()))', t);
  end loop;
end $$;
drop policy if exists "logados alteram" on public.tratativas;
create policy "logados alteram" on public.tratativas for all to authenticated
  using ((select not public.e_sac())) with check ((select not public.e_sac()));

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
    -- SAC vê só os vencidos, os que vencem hoje e os que vencem amanhã
    and (coalesce(b.prev_original, b.prev_atual) <= (now() at time zone 'America/Sao_Paulo')::date + 1
         or t.nova_data <= (now() at time zone 'America/Sao_Paulo')::date + 1)
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
  using ((select not public.e_sac())) with check ((select not public.e_sac()));
create policy "logistica cuida" on public.responsavel_por_ms for all to authenticated
  using ((select not public.e_sac())) with check ((select not public.e_sac()));

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
  using ((select not public.e_sac())) with check ((select not public.e_sac()));

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

-- 12) Tickets abertos (planilha "detalhamento_tickets360", aba Tickets).
--     Guarda só nota, fila, tipo, motivo e nº do ticket. Cada envio substitui o anterior.
--     Nota que não está aqui = "Sem ticket".
create table if not exists public.tickets_abertos (
  nf         text primary key,   -- "Nota ticket" (número-série)
  fila       text,
  tipo       text,
  motivo     text,
  id_ticket  text,
  criado_em  timestamptz,
  qtd        integer not null default 1
);
create table if not exists public.tickets_info (
  id          integer primary key default 1 check (id = 1),
  arquivo     text,
  linhas      integer,
  enviado_por text,
  enviado_em  timestamptz not null default now()
);
alter table public.tickets_abertos enable row level security;
alter table public.tickets_info enable row level security;
revoke all on public.tickets_abertos, public.tickets_info from anon;
grant select on public.tickets_abertos, public.tickets_info to authenticated;
drop policy if exists "logados leem" on public.tickets_abertos;
drop policy if exists "logados leem" on public.tickets_info;
create policy "logados leem" on public.tickets_abertos for select to authenticated using ((select not public.e_sac()));
create policy "logados leem" on public.tickets_info for select to authenticated using ((select not public.e_sac()));

create or replace function public.importar_tickets(linhas jsonb, limpar boolean, arquivo text, total integer)
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if limpar then
    delete from public.tickets_abertos where true;
    insert into public.tickets_info (id, arquivo, linhas, enviado_por, enviado_em)
    values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas,
      enviado_por = excluded.enviado_por, enviado_em = excluded.enviado_em;
  end if;
  insert into public.tickets_abertos (nf, fila, tipo, motivo, id_ticket, criado_em, qtd)
  select r.nf, r.fila, r.tipo, r.motivo, r.id_ticket, r.criado_em, coalesce(r.qtd, 1)
  from jsonb_to_recordset(linhas) as r(nf text, fila text, tipo text, motivo text, id_ticket text, criado_em timestamptz, qtd integer)
  where r.nf is not null and r.nf <> ''
  on conflict (nf) do update set fila = excluded.fila, tipo = excluded.tipo, motivo = excluded.motivo,
    id_ticket = excluded.id_ticket, criado_em = excluded.criado_em, qtd = excluded.qtd;
  return (select count(*) from public.tickets_abertos);
end $$;
revoke all on function public.importar_tickets(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_tickets(jsonb, boolean, text, integer) to authenticated;

-- 13) Chamar o robô na hora: quando entra um pedido na fila do robô, o Supabase avisa o
--     GitHub para rodar o robô (sem esperar o agendamento de 10 minutos, que às vezes atrasa).
--     Só funciona depois de guardar o token do GitHub no cofre do Supabase (passo do README).
do $$ begin create extension if not exists pg_net; exception when others then null; end $$;
create or replace function public._chamar_robo()
returns trigger language plpgsql security definer set search_path = public
as $$
declare tk text;
begin
  begin
    select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null;
  end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-portal.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main"}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists chamar_robo on public.fila_portal;
create trigger chamar_robo after insert on public.fila_portal
  for each row execute function public._chamar_robo();

-- 14) Reposições (planilha "TABELA DE ACOMPANHAMENTO", aba Export, enviada na página Reposição).
--     Guarda só os tickets de reposição (e os da fila "Atribuir transportador").
--     Cada envio acrescenta/atualiza pelo número do ticket (o histórico não se perde).
--     Pré entrega = criado pelo CCP (coluna Via) e na fila "Atribuir transportador".
drop function if exists public.importar_reposicoes(jsonb, boolean);
drop table if exists public.reposicoes;
create table if not exists public.reposicoes_tk (
  ticket          text primary key,
  criado_em       timestamp,      -- hora de Brasília, como vem na planilha
  criado_por      text,
  via             text,           -- por onde foi criado (ccp, 360app)
  fila            text,
  tipo            text,
  motivo          text,
  status          text,
  transportadora  text,           -- redespacho, se houver; senão a final
  nf              text
);
alter table public.reposicoes_tk add column if not exists via text;
create table if not exists public.reposicoes_tk_info (
  id          integer primary key default 1 check (id = 1),
  arquivo     text,
  linhas      integer,
  enviado_por text,
  enviado_em  timestamptz not null default now()
);
alter table public.reposicoes_tk enable row level security;
alter table public.reposicoes_tk_info enable row level security;
revoke all on public.reposicoes_tk, public.reposicoes_tk_info from anon;
grant select on public.reposicoes_tk, public.reposicoes_tk_info to authenticated;
drop policy if exists "logados leem" on public.reposicoes_tk;
drop policy if exists "logados leem" on public.reposicoes_tk_info;
create policy "logados leem" on public.reposicoes_tk for select to authenticated using ((select not public.e_sac()));
create policy "logados leem" on public.reposicoes_tk_info for select to authenticated using ((select not public.e_sac()));

create or replace function public.importar_reposicoes_tk(linhas jsonb, primeiro boolean, arquivo text, total integer)
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if primeiro then
    insert into public.reposicoes_tk_info (id, arquivo, linhas, enviado_por, enviado_em)
    values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas,
      enviado_por = excluded.enviado_por, enviado_em = excluded.enviado_em;
  end if;
  insert into public.reposicoes_tk (ticket, criado_em, criado_por, via, fila, tipo, motivo, status, transportadora, nf)
  select r.ticket, r.criado_em, r.criado_por, r.via, r.fila, r.tipo, r.motivo, r.status, r.transportadora, r.nf
  from jsonb_to_recordset(linhas) as r(ticket text, criado_em timestamp, criado_por text, via text, fila text, tipo text,
                                       motivo text, status text, transportadora text, nf text)
  where r.ticket is not null and r.ticket <> ''
  on conflict (ticket) do update set criado_em = excluded.criado_em, criado_por = excluded.criado_por, via = excluded.via,
    fila = excluded.fila, tipo = excluded.tipo, motivo = excluded.motivo, status = excluded.status,
    transportadora = excluded.transportadora, nf = excluded.nf;
  return (select count(*) from public.reposicoes_tk);
end $$;
revoke all on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) to authenticated;

-- 15) Visão Gerencial: usa a própria base ("Enviar base"). Colunas a mais da planilha e uma leitura
--     compacta de todos os pedidos da base em uma chamada só.
drop function if exists public.intelipost_compacto();
drop function if exists public.importar_intelipost(jsonb, boolean);
drop table if exists public.intelipost_pedidos;
alter table public.base_pedidos add column if not exists data_criacao  date;
alter table public.base_pedidos add column if not exists data_entrega  date;
alter table public.base_pedidos add column if not exists range_atrasos text;
alter table public.base_pedidos add column if not exists dias_atraso   integer;
alter table public.base_pedidos add column if not exists status_prazo  text;
alter table public.base_pedidos add column if not exists sem_expedicao text;

create or replace function public.base_compacta()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when public.e_sac() then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_array(
    pedido, nf, canal, uf, transportadora, status_intelipost, micro_status, origem, data_criacao, data_expedicao, data_entrega,
    prev_original, prev_atual, ultima_atualizacao::date, range_atrasos, dias_atraso, status_prazo, sem_expedicao)), '[]'::jsonb) end
  from public.base_pedidos;
$$;
revoke all on function public.base_compacta() from public, anon;
grant execute on function public.base_compacta() to authenticated;

-- 16) Alterar pedidos: nova previsão de entrega na Intelipost.
--     A tela grava aqui (um registro por pedido, o pedido é a chave); o robô da Intelipost
--     (GitHub Actions) pega os pendentes, altera a data (hora sempre 23:59) e grava o resultado.
create table if not exists public.fila_intelipost (
  pedido      text primary key,
  nova_data   date not null,
  status      text not null default 'pendente',   -- pendente | processando | alterado | erro
  motivo      text,                               -- quando dá erro, o porquê (aparece na tela)
  pedido_por  text,
  pedido_em   timestamptz not null default now(),
  feito_em    timestamptz,
  tentativas  integer not null default 0,
  iniciado_em timestamptz
);
alter table public.fila_intelipost add column if not exists iniciado_em timestamptz;
alter table public.fila_intelipost enable row level security;
revoke all on public.fila_intelipost from anon;
grant select, delete on public.fila_intelipost to authenticated;
drop policy if exists "logistica cuida" on public.fila_intelipost;
create policy "logistica cuida" on public.fila_intelipost for all to authenticated
  using ((select not public.e_sac())) with check ((select not public.e_sac()));

-- a tela manda a lista [{pedido, nova_data}]; pedido que já estava na fila volta para pendente com a data nova
create or replace function public.enfileirar_intelipost(linhas jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  insert into public.fila_intelipost (pedido, nova_data, status, motivo, pedido_por, pedido_em, feito_em, tentativas)
  select trim(x ->> 'pedido'), (x ->> 'nova_data')::date, 'pendente', null, auth.jwt() ->> 'email', now(), null, 0
  from jsonb_array_elements(linhas) x
  where coalesce(trim(x ->> 'pedido'), '') <> '' and x ->> 'nova_data' is not null
  on conflict (pedido) do update set nova_data = excluded.nova_data, status = 'pendente', motivo = null,
    pedido_por = excluded.pedido_por, pedido_em = excluded.pedido_em, feito_em = null, tentativas = 0;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.enfileirar_intelipost(jsonb) from public, anon;
grant execute on function public.enfileirar_intelipost(jsonb) to authenticated;

-- o robô pega até N pendentes (os mais antigos primeiro)
create or replace function public.pegar_fila_intelipost(limite integer default 100)
returns setof public.fila_intelipost
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.fila_intelipost set status = 'erro', feito_em = now(),
    motivo = 'O robô parou no meio. Confira na Intelipost antes de mandar de novo.'
  where status = 'processando' and iniciado_em < now() - interval '2 hours';
  return query
  update public.fila_intelipost f set status = 'processando', tentativas = f.tentativas + 1, iniciado_em = now()
  where f.pedido in (select pedido from public.fila_intelipost where status = 'pendente'
                     order by pedido_em, pedido limit greatest(1, least(limite, 200)) for update skip locked)
  returning f.*;
end $$;
revoke all on function public.pegar_fila_intelipost(integer) from public, anon;
grant execute on function public.pegar_fila_intelipost(integer) to authenticated;

-- o robô grava o resultado de cada pedido
create or replace function public.resultado_intelipost(p text, st text, mot text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if st not in ('alterado', 'erro', 'pendente') then raise exception 'Status inválido.'; end if;
  update public.fila_intelipost set status = st, motivo = mot, feito_em = case when st = 'pendente' then null else now() end
  where pedido = p and status = 'processando';
end $$;
revoke all on function public.resultado_intelipost(text, text, text) from public, anon;
grant execute on function public.resultado_intelipost(text, text, text) to authenticated;

-- recados do robô para a tela (ex.: senha da Intelipost recusada). Nunca guarda senha:
-- só uma "impressão" (16 letras de um sha256) para saber se a senha ainda é a mesma que falhou.
create table if not exists public.robo_estado (
  nome          text primary key,
  valor         jsonb,
  atualizado_em timestamptz not null default now()
);
alter table public.robo_estado enable row level security;
revoke all on public.robo_estado from anon;
grant select, insert, update on public.robo_estado to authenticated;
drop policy if exists "logistica cuida" on public.robo_estado;
create policy "logistica cuida" on public.robo_estado for all to authenticated
  using ((select not public.e_sac())) with check ((select not public.e_sac()));

-- 17) Troca de notas (reposição TOTAL): tickets da fila "Ajuste de dados na Intelipost" (aba Reposições do
--     detalhamento_tickets). A tela calcula o método pelo DE × PARA e a série; quem pegou cada ticket e as
--     etapas marcadas ficam à vista para todos.
create table if not exists public.troca_notas (
  ticket          text primary key,
  pedido          text,
  nf_ticket       text,
  nf_nova         text,
  serie           text,
  chave           text,
  data_emissao    date,
  transp_promob   text,
  linhas          integer,
  metodo_manual   text,                           -- quando a Logística escolhe o método na mão
  etapas          jsonb not null default '{}'::jsonb,
  responsavel     text,
  pego_em         timestamptz,
  concluido_em    timestamptz,
  na_planilha     boolean not null default true,  -- false = saiu da fila na última planilha
  atualizado_em   timestamptz not null default now(),
  atualizado_por  text
);
alter table public.troca_notas add column if not exists tipo text not null default 'TOTAL';   -- TOTAL | PARCIAL (parcial não mexe nos volumes)
alter table public.troca_notas enable row level security;
revoke all on public.troca_notas from anon;
grant select, update on public.troca_notas to authenticated;
drop policy if exists "logistica cuida" on public.troca_notas;
create policy "logistica cuida" on public.troca_notas for all to authenticated
  using ((select not public.e_sac())) with check ((select not public.e_sac()));
create table if not exists public.troca_notas_info (
  id integer primary key default 1, arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
alter table public.troca_notas_info enable row level security;
revoke all on public.troca_notas_info from anon;
grant select on public.troca_notas_info to authenticated;
drop policy if exists "logistica cuida" on public.troca_notas_info;
create policy "logistica cuida" on public.troca_notas_info for select to authenticated using ((select not public.e_sac()));

create or replace function public._carimbo_troca()
returns trigger language plpgsql as $$
begin new.atualizado_em := now(); new.atualizado_por := coalesce(auth.jwt() ->> 'email', new.atualizado_por); return new; end $$;
drop trigger if exists carimbo on public.troca_notas;
create trigger carimbo before update on public.troca_notas for each row execute function public._carimbo_troca();

-- a planilha atualiza os dados do ticket e mantém quem pegou e as etapas marcadas
create or replace function public.importar_troca_notas(itens jsonb, arquivo text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  update public.troca_notas set na_planilha = false
  where ticket not in (select x ->> 'ticket' from jsonb_array_elements(itens) x);
  insert into public.troca_notas (ticket, pedido, nf_ticket, nf_nova, serie, chave, data_emissao, transp_promob, linhas, na_planilha, tipo)
  select x ->> 'ticket', x ->> 'pedido', x ->> 'nf_ticket', x ->> 'nf_nova', x ->> 'serie', x ->> 'chave',
         nullif(x ->> 'data_emissao', '')::date, x ->> 'transp_promob', coalesce((x ->> 'linhas')::integer, 1), true,
         coalesce(nullif(x ->> 'tipo', ''), 'TOTAL')
  from jsonb_array_elements(itens) x where coalesce(x ->> 'ticket', '') <> ''
  on conflict (ticket) do update set pedido = excluded.pedido, nf_ticket = excluded.nf_ticket, nf_nova = excluded.nf_nova,
    serie = excluded.serie, chave = excluded.chave, data_emissao = excluded.data_emissao, transp_promob = excluded.transp_promob,
    linhas = excluded.linhas, na_planilha = true, tipo = excluded.tipo;
  get diagnostics n = row_count;
  insert into public.troca_notas_info (id, arquivo, linhas, enviado_por, enviado_em)
  values (1, arquivo, jsonb_array_length(itens), auth.jwt() ->> 'email', now())
  on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  return n;
end $$;
revoke all on function public.importar_troca_notas(jsonb, text) from public, anon;
grant execute on function public.importar_troca_notas(jsonb, text) to authenticated;

-- 18) Robô da troca de notas: a Logística pede no painel ("Testar" sem salvar ou "Fazer" de verdade) e o robô
--     da Intelipost troca transportadora/método, faz a simulação de cotação, muda a Entrega prev., edita TODOS
--     os volumes e muda o status (Macro 12 · Micro 920 · Equipe_04 Troca de notas). As etapas 1 a 5 ficam marcadas.
alter table public.troca_notas add column if not exists robo_status text;        -- pendente | processando | testado | feito | erro
alter table public.troca_notas add column if not exists robo_modo text;          -- teste | real
alter table public.troca_notas add column if not exists robo_metodo text;
alter table public.troca_notas add column if not exists robo_transp text;
alter table public.troca_notas add column if not exists robo_msg text;
alter table public.troca_notas add column if not exists robo_passos jsonb;
alter table public.troca_notas add column if not exists robo_pedido_por text;
alter table public.troca_notas add column if not exists robo_pedido_em timestamptz;
alter table public.troca_notas add column if not exists robo_iniciado_em timestamptz;
alter table public.troca_notas add column if not exists robo_feito_em timestamptz;
alter table public.troca_notas add column if not exists prazo_dias integer;
alter table public.troca_notas add column if not exists nova_data date;

alter table public.troca_notas add column if not exists robo_prazo_manual integer;   -- prazo digitado no painel: o robô pula a simulação
drop function if exists public.pedir_robo_troca(text, text, text, text);
create or replace function public.pedir_robo_troca(tk text, metodo text, transp text, modo text, prazo integer default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if prazo is not null and (prazo < 1 or prazo > 60) then raise exception 'Prazo deve ser de 1 a 60 dias úteis.'; end if;
  if auth.uid() is null or public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if modo not in ('teste', 'real') then raise exception 'Modo inválido.'; end if;
  if coalesce(metodo, '') = '' or coalesce(transp, '') = '' then raise exception 'Sem método de entrega para este ticket.'; end if;
  update public.troca_notas set robo_status = 'pendente', robo_modo = modo, robo_metodo = metodo, robo_transp = transp,
    robo_msg = null, robo_passos = null, robo_prazo_manual = prazo, robo_pedido_por = auth.jwt() ->> 'email', robo_pedido_em = now(), robo_feito_em = null
  where ticket = tk and coalesce(robo_status, '') <> 'processando';
  if not found then raise exception 'O robô já está com este ticket (ou o ticket não existe).'; end if;
end $$;
revoke all on function public.pedir_robo_troca(text, text, text, text, integer) from public, anon;
grant execute on function public.pedir_robo_troca(text, text, text, text, integer) to authenticated;

create or replace function public.pegar_troca(limite integer default 20)
returns setof public.troca_notas language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.troca_notas set robo_status = 'erro', robo_msg = 'O robô parou no meio (mais de 2 horas). Confira na Intelipost e peça de novo.'
  where robo_status = 'processando' and robo_iniciado_em < now() - interval '2 hours';
  return query
  update public.troca_notas t set robo_status = 'processando', robo_iniciado_em = now()
  where t.ticket in (select ticket from public.troca_notas where robo_status = 'pendente' order by robo_pedido_em limit limite for update skip locked)
  returning t.*;
end $$;
revoke all on function public.pegar_troca(integer) from public, anon;
grant execute on function public.pegar_troca(integer) to authenticated;

create or replace function public.resultado_troca(tk text, st text, msg text, passos jsonb, prazo integer, nova date)
returns void language plpgsql security definer set search_path = public as $$
declare et jsonb; quem text := 'robô';
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  select etapas into et from public.troca_notas where ticket = tk;
  if st = 'feito' then   -- marca as etapas que o robô fez (1 a 5 na Intelipost, 6 e 7 no ticket do Multi360)
    for i in 1..7 loop
      if coalesce((passos ->> i::text)::boolean, false) then et := coalesce(et, '{}'::jsonb) || jsonb_build_object(i::text, jsonb_build_object('por', quem, 'em', now())); end if;
    end loop;
  end if;
  update public.troca_notas set robo_status = st, robo_msg = msg, robo_passos = passos, prazo_dias = coalesce(prazo, prazo_dias),
    nova_data = coalesce(nova, nova_data), robo_feito_em = now(), etapas = coalesce(et, etapas)
  where ticket = tk;
end $$;
revoke all on function public.resultado_troca(text, text, text, jsonb, integer, date) from public, anon;
grant execute on function public.resultado_troca(text, text, text, jsonb, integer, date) to authenticated;

-- 19) Robô da Intelipost na hora: quando alguém clica em "Fazer com o robô" / "Testar com o robô"
--     (troca de notas) ou manda datas para a fila "Alterar pedidos", o Supabase chama o GitHub
--     para rodar o robô na mesma hora. Usa o mesmo token do cofre da parte 13 (github_robo_token).
create or replace function public._chamar_robo_intelipost()
returns trigger language plpgsql security definer set search_path = public
as $$
declare tk text;
begin
  begin
    select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null;
  end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-intelipost.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"real"}}'::jsonb);   -- "real" respeita o teste/real de cada pedido
  end if;
  return null;
end $$;
drop trigger if exists chamar_robo_troca on public.troca_notas;
create trigger chamar_robo_troca after update of robo_status on public.troca_notas
  for each row when (new.robo_status = 'pendente' and old.robo_status is distinct from 'pendente')
  execute function public._chamar_robo_intelipost();
drop trigger if exists chamar_robo_datas on public.fila_intelipost;
create trigger chamar_robo_datas after insert on public.fila_intelipost
  for each statement execute function public._chamar_robo_intelipost();

-- 20) Conferência SSW: o robô lê no rastreio público do SSW (ssw.inf.br) a previsão de entrega da
--     transportadora pela NF (sem a série) + CNPJ do remetente (pela série) e grava aqui.
--     O painel mostra "SSW dd/mm" ao lado da data prometida ao cliente.
create table if not exists public.previsao_ssw (
  pedido        text primary key,
  nf            text,
  previsao      date,
  situacao      text,          -- previsao | sem previsao | entregue | fora do ssw | sem permissao
  consultado_em timestamptz not null default now()
);
alter table public.previsao_ssw enable row level security;
revoke all on public.previsao_ssw from anon;
grant select on public.previsao_ssw to authenticated;
drop policy if exists "todos leem" on public.previsao_ssw;
create policy "todos leem" on public.previsao_ssw for select to authenticated using (true);
create or replace function public.gravar_ssw(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  insert into public.previsao_ssw (pedido, nf, previsao, situacao, consultado_em)
  select r.pedido, r.nf, r.previsao, r.situacao, now()
  from jsonb_to_recordset(linhas) as r(pedido text, nf text, previsao date, situacao text)
  where coalesce(r.pedido, '') <> ''
  on conflict (pedido) do update set nf = excluded.nf, previsao = excluded.previsao, situacao = excluded.situacao, consultado_em = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.gravar_ssw(jsonb) from public, anon;
grant execute on function public.gravar_ssw(jsonb) to authenticated;

-- 21) Aba Conferência SSW: a Logística importa uma lista de pedidos (modelo Intelipost) e o robô confere
--     no rastreio do SSW se já foram entregues (para atualizar a Intelipost). Cada importação substitui a lista.
create table if not exists public.conferencia_ssw (
  pedido            text primary key,
  nf                text,
  transportadora    text,
  status_intelipost text,
  situacao          text not null default 'pendente',   -- pendente | entregue | nao entregue | fora do ssw | sem permissao | sem nf
  ultimo_evento     text,
  data_evento       date,
  data_entrega      date,
  consultado_em     timestamptz,
  importado_em      timestamptz not null default now(),
  importado_por     text
);
alter table public.conferencia_ssw add column if not exists prev_cliente date;
alter table public.conferencia_ssw enable row level security;
revoke all on public.conferencia_ssw from anon;
grant select on public.conferencia_ssw to authenticated;
drop policy if exists "logistica le" on public.conferencia_ssw;
create policy "logistica le" on public.conferencia_ssw for select to authenticated using ((select not public.e_sac()));

create or replace function public.importar_conferencia(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  delete from public.conferencia_ssw where true;
  insert into public.conferencia_ssw (pedido, nf, transportadora, status_intelipost, prev_cliente, situacao, importado_por)
  select distinct on (r.pedido) r.pedido, nullif(r.nf, ''), r.transportadora, r.status_intelipost, r.prev_cliente,
         case when coalesce(r.nf, '') = '' then 'sem nf' else 'pendente' end, auth.jwt() ->> 'email'
  from jsonb_to_recordset(linhas) as r(pedido text, nf text, transportadora text, status_intelipost text, prev_cliente date)
  where coalesce(r.pedido, '') <> '';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.importar_conferencia(jsonb) from public, anon;
grant execute on function public.importar_conferencia(jsonb) to authenticated;

create or replace function public.gravar_conferencia(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.conferencia_ssw c set situacao = r.situacao, ultimo_evento = r.ultimo_evento, data_evento = r.data_evento,
    data_entrega = r.data_entrega, consultado_em = now()
  from jsonb_to_recordset(linhas) as r(pedido text, situacao text, ultimo_evento text, data_evento date, data_entrega date)
  where c.pedido = r.pedido;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.gravar_conferencia(jsonb) from public, anon;
grant execute on function public.gravar_conferencia(jsonb) to authenticated;

-- ao importar, chama o robô do SSW na hora (mesmo token da parte 13)
create or replace function public._chamar_robo_conferencia()
returns trigger language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"conferencia"}}'::jsonb);
  end if;
  return null;
end $$;
drop trigger if exists chamar_robo_conferencia on public.conferencia_ssw;
create trigger chamar_robo_conferencia after insert on public.conferencia_ssw
  for each statement execute function public._chamar_robo_conferencia();

-- =====================================================================
-- 22) Conferência SSW: detalhe do rastreio (Jadlog, Bento Brasil, Trânsito Brasil) para a janela do painel
--     (histórico de eventos com datas, status e unidades da transportadora; nada do destinatário)
alter table public.conferencia_ssw add column if not exists detalhe jsonb;
create or replace function public.gravar_conferencia(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.conferencia_ssw c set situacao = r.situacao, ultimo_evento = r.ultimo_evento, data_evento = r.data_evento,
    data_entrega = r.data_entrega, detalhe = r.detalhe, consultado_em = now()
  from jsonb_to_recordset(linhas) as r(pedido text, situacao text, ultimo_evento text, data_evento date, data_entrega date, detalhe jsonb)
  where c.pedido = r.pedido;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.gravar_conferencia(jsonb) from public, anon;
grant execute on function public.gravar_conferencia(jsonb) to authenticated;

-- =====================================================================
-- 23) Senhas de rastreio do SSW por transportadora (campo "Senha (opcional)" do SSW), cadastradas no painel
--     Usadas pelo botão "Ver no SSW" e pelo robô. Quem está logado na Logística vê; o login do SAC não.
create table if not exists public.senhas_rastreio (
  transportadora text primary key,
  senha          text not null,
  atualizado_por text,
  atualizado_em  timestamptz not null default now()
);
alter table public.senhas_rastreio enable row level security;
drop policy if exists senhas_rastreio_ler on public.senhas_rastreio;
create policy senhas_rastreio_ler on public.senhas_rastreio for select to authenticated using (not public.e_sac());
create or replace function public.salvar_senha_rastreio(p_transportadora text, p_senha text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if coalesce(trim(p_transportadora), '') = '' then raise exception 'Informe a transportadora.'; end if;
  if coalesce(p_senha, '') = '' then delete from public.senhas_rastreio where transportadora = trim(p_transportadora); return; end if;
  insert into public.senhas_rastreio (transportadora, senha, atualizado_por, atualizado_em)
  values (trim(p_transportadora), p_senha, (select email from auth.users where id = auth.uid()), now())
  on conflict (transportadora) do update set senha = excluded.senha, atualizado_por = excluded.atualizado_por, atualizado_em = now();
end $$;
revoke all on function public.salvar_senha_rastreio(text, text) from public, anon;
grant execute on function public.salvar_senha_rastreio(text, text) to authenticated;

-- =====================================================================
-- 24) Fila Aguardando entrega (aba Alterar pedidos): a Logística sobe o relatório de tickets da fila
--     "Aguardando entrega" do Multi360; o robô lê no chat do ticket a nova NF ("NF 123-7 emitida para o pedido"),
--     confere no rastreio se foi entregue e, se foi, executa a ação "Nota entregue?" → Sim com o print do rastreio.
--     A observação de cada ticket fica guardada até a baixa (não some quando o relatório é enviado de novo).
create table if not exists public.aguardando_entrega (
  ticket          text primary key,
  tipo            text,
  tipo_reposicao  text,
  motivo          text,
  pedido          text,            -- pedido canal
  pedido_promob   text,
  nf_original     text,
  transportadora  text,            -- "Transportadora do Ticket" (todas as linhas do ticket, separadas por " / ")
  transp_promob   text,
  ticket_criado   timestamptz,
  na_planilha     boolean not null default true,
  nf_nova         text,            -- lida pelo robô no chat do ticket
  nf_emitida_em   timestamptz,
  transp_chat     text,            -- "Transportadora definida: ..." do chat
  fila_360        text,            -- fila em que o robô achou o ticket
  situacao        text not null default 'pendente',  -- pendente | sem nf nova | entregue | nao entregue | sem cte | sem rastreio | sem permissao
  fonte           text,            -- SSW | Jadlog | Bento Brasil | Trânsito Brasil
  ultimo_evento   text,
  data_evento     date,
  data_entrega    date,
  insucesso       text,            -- micro status de insucesso (vai para a aba Ocorrências)
  detalhe         jsonb,
  consultado_em   timestamptz,
  baixa_status    text,            -- feita | teste | conferir | erro
  baixa_msg       text,
  baixa_em        timestamptz,
  importado_em    timestamptz not null default now(),
  importado_por   text
);
alter table public.aguardando_entrega enable row level security;
revoke all on public.aguardando_entrega from anon;
grant select on public.aguardando_entrega to authenticated;
drop policy if exists "logistica le" on public.aguardando_entrega;
create policy "logistica le" on public.aguardando_entrega for select to authenticated using ((select not public.e_sac()));

create table if not exists public.aguardando_obs (
  ticket         text primary key,
  observacao     text not null,
  atualizado_por text,
  atualizado_em  timestamptz not null default now()
);
alter table public.aguardando_obs enable row level security;
revoke all on public.aguardando_obs from anon;
grant select on public.aguardando_obs to authenticated;
drop policy if exists "logistica le" on public.aguardando_obs;
create policy "logistica le" on public.aguardando_obs for select to authenticated using ((select not public.e_sac()));

create table if not exists public.aguardando_info (
  id integer primary key default 1, arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
alter table public.aguardando_info enable row level security;
revoke all on public.aguardando_info from anon;
grant select on public.aguardando_info to authenticated;
drop policy if exists "logistica le" on public.aguardando_info;
create policy "logistica le" on public.aguardando_info for select to authenticated using ((select not public.e_sac()));

-- o relatório atualiza os dados do ticket e mantém o que o robô já achou; ticket que saiu do relatório fica escondido
create or replace function public.importar_aguardando(itens jsonb, arquivo text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.aguardando_entrega set na_planilha = false
  where ticket not in (select x ->> 'ticket' from jsonb_array_elements(itens) x);
  insert into public.aguardando_entrega (ticket, tipo, tipo_reposicao, motivo, pedido, pedido_promob, nf_original, transportadora,
    transp_promob, ticket_criado, na_planilha, importado_por)
  select x ->> 'ticket', x ->> 'tipo', x ->> 'tipo_reposicao', x ->> 'motivo', x ->> 'pedido', x ->> 'pedido_promob', x ->> 'nf_original',
         x ->> 'transportadora', x ->> 'transp_promob', nullif(x ->> 'ticket_criado', '')::timestamptz, true, auth.jwt() ->> 'email'
  from jsonb_array_elements(itens) x where coalesce(x ->> 'ticket', '') <> ''
  on conflict (ticket) do update set tipo = excluded.tipo, tipo_reposicao = excluded.tipo_reposicao, motivo = excluded.motivo,
    pedido = excluded.pedido, pedido_promob = excluded.pedido_promob, nf_original = excluded.nf_original,
    transportadora = excluded.transportadora, transp_promob = excluded.transp_promob, ticket_criado = excluded.ticket_criado,
    na_planilha = true, importado_em = now(), importado_por = excluded.importado_por;
  get diagnostics n = row_count;
  insert into public.aguardando_info (id, arquivo, linhas, enviado_por, enviado_em)
  values (1, arquivo, jsonb_array_length(itens), auth.jwt() ->> 'email', now())
  on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  return n;
end $$;
revoke all on function public.importar_aguardando(jsonb, text) from public, anon;
grant execute on function public.importar_aguardando(jsonb, text) to authenticated;

-- o robô grava o que achou (só os campos que mandar); baixa feita = a observação sai
create or replace function public.gravar_aguardando(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.aguardando_entrega a set
    nf_nova       = case when x ? 'nf_nova'       then x ->> 'nf_nova'                            else a.nf_nova end,
    nf_emitida_em = case when x ? 'nf_emitida_em' then nullif(x ->> 'nf_emitida_em', '')::timestamptz else a.nf_emitida_em end,
    transp_chat   = case when x ? 'transp_chat'   then x ->> 'transp_chat'                        else a.transp_chat end,
    fila_360      = case when x ? 'fila_360'      then x ->> 'fila_360'                           else a.fila_360 end,
    situacao      = case when x ? 'situacao'      then x ->> 'situacao'                           else a.situacao end,
    fonte         = case when x ? 'fonte'         then x ->> 'fonte'                              else a.fonte end,
    ultimo_evento = case when x ? 'ultimo_evento' then x ->> 'ultimo_evento'                      else a.ultimo_evento end,
    data_evento   = case when x ? 'data_evento'   then nullif(x ->> 'data_evento', '')::date      else a.data_evento end,
    data_entrega  = case when x ? 'data_entrega'  then nullif(x ->> 'data_entrega', '')::date     else a.data_entrega end,
    insucesso     = case when x ? 'insucesso'     then x ->> 'insucesso'                          else a.insucesso end,
    detalhe       = case when x ? 'detalhe'       then x -> 'detalhe'                             else a.detalhe end,
    consultado_em = case when x ? 'situacao'      then now()                                      else a.consultado_em end,
    baixa_status  = case when x ? 'baixa_status'  then x ->> 'baixa_status'                       else a.baixa_status end,
    baixa_msg     = case when x ? 'baixa_status'  then x ->> 'baixa_msg'                          else a.baixa_msg end,
    baixa_em      = case when x ? 'baixa_status'  then now()                                      else a.baixa_em end
  from jsonb_array_elements(linhas) x
  where a.ticket = x ->> 'ticket';
  get diagnostics n = row_count;
  delete from public.aguardando_obs o using jsonb_array_elements(linhas) x
  where o.ticket = x ->> 'ticket' and x ->> 'baixa_status' = 'feita';
  return n;
end $$;
revoke all on function public.gravar_aguardando(jsonb) from public, anon;
grant execute on function public.gravar_aguardando(jsonb) to authenticated;

create or replace function public.salvar_obs_aguardando(p_ticket text, p_obs text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if coalesce(trim(p_obs), '') = '' then delete from public.aguardando_obs where ticket = p_ticket; return; end if;
  insert into public.aguardando_obs (ticket, observacao, atualizado_por, atualizado_em)
  values (p_ticket, trim(p_obs), auth.jwt() ->> 'email', now())
  on conflict (ticket) do update set observacao = excluded.observacao, atualizado_por = excluded.atualizado_por, atualizado_em = now();
end $$;
revoke all on function public.salvar_obs_aguardando(text, text) from public, anon;
grant execute on function public.salvar_obs_aguardando(text, text) to authenticated;

-- ao subir o relatório (ou clicar em "Rodar o robô agora"), chama o robô na hora (mesmo token da parte 13)
create or replace function public._chamar_robo_aguardando()
returns trigger language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"aguardando"}}'::jsonb);
  end if;
  return null;
end $$;
drop trigger if exists chamar_robo_aguardando on public.aguardando_info;
create trigger chamar_robo_aguardando after insert or update on public.aguardando_info
  for each statement execute function public._chamar_robo_aguardando();
create or replace function public.rodar_robo_aguardando()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.aguardando_info set enviado_em = enviado_em where id = 1;
end $$;
revoke all on function public.rodar_robo_aguardando() from public, anon;
grant execute on function public.rodar_robo_aguardando() to authenticated;

-- =====================================================================
-- 25) Conferência SSW: botão "Conferir tudo agora" — o robô confere de novo nos rastreios todos os pedidos da lista
--     que não estão entregues. Se já tem uma conferência dessas em andamento, o botão só mostra o andamento (não recomeça).
create table if not exists public.conferencia_pedido (
  id integer primary key default 1, pedido_por text, pedido_em timestamptz, feito_em timestamptz
);
insert into public.conferencia_pedido (id) values (1) on conflict (id) do nothing;
alter table public.conferencia_pedido enable row level security;
revoke all on public.conferencia_pedido from anon;
grant select on public.conferencia_pedido to authenticated;
drop policy if exists "logistica le" on public.conferencia_pedido;
create policy "logistica le" on public.conferencia_pedido for select to authenticated using ((select not public.e_sac()));

create or replace function public.conferir_tudo_agora()
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.conferencia_pedido;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  select * into c from public.conferencia_pedido where id = 1;
  if c.pedido_em is not null and (c.feito_em is null or c.feito_em < c.pedido_em) and c.pedido_em > now() - interval '24 hours' then
    return jsonb_build_object('ja', true, 'pedido_em', c.pedido_em, 'pedido_por', c.pedido_por);
  end if;
  update public.conferencia_pedido set pedido_em = now(), pedido_por = auth.jwt() ->> 'email', feito_em = null where id = 1;
  return jsonb_build_object('ja', false, 'pedido_em', now(), 'pedido_por', auth.jwt() ->> 'email');
end $$;
revoke all on function public.conferir_tudo_agora() from public, anon;
grant execute on function public.conferir_tudo_agora() to authenticated;

create or replace function public.fim_conferencia_tudo()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.conferencia_pedido set feito_em = now() where id = 1;
end $$;
revoke all on function public.fim_conferencia_tudo() from public, anon;
grant execute on function public.fim_conferencia_tudo() to authenticated;

create or replace function public._chamar_robo_conferir_tudo()
returns trigger language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  if new.pedido_em is not distinct from old.pedido_em then return null; end if;
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"conferencia-tudo"}}'::jsonb);
  end if;
  return null;
end $$;
drop trigger if exists chamar_robo_conferir_tudo on public.conferencia_pedido;
create trigger chamar_robo_conferir_tudo after update on public.conferencia_pedido
  for each row execute function public._chamar_robo_conferir_tudo();

-- =====================================================================
-- 26) Fila Aguardando entrega (AT): mesmo fluxo da parte 24 para o relatório da fila "Aguardando entrega (AT)"
--     (Assistência Técnica). Cada relatório só mexe nos tickets da própria fila.
alter table public.aguardando_entrega add column if not exists fila_rel text not null default 'AE';   -- AE | AT
drop function if exists public.importar_aguardando(jsonb, text);
create or replace function public.importar_aguardando(itens jsonb, arquivo text, p_fila text default 'AE')
returns integer language plpgsql security definer set search_path = public as $$
declare n integer; f text := case when p_fila = 'AT' then 'AT' else 'AE' end;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.aguardando_entrega set na_planilha = false
  where fila_rel = f and ticket not in (select x ->> 'ticket' from jsonb_array_elements(itens) x);
  insert into public.aguardando_entrega (ticket, tipo, tipo_reposicao, motivo, pedido, pedido_promob, nf_original, transportadora,
    transp_promob, ticket_criado, na_planilha, importado_por, fila_rel)
  select x ->> 'ticket', x ->> 'tipo', x ->> 'tipo_reposicao', x ->> 'motivo', x ->> 'pedido', x ->> 'pedido_promob', x ->> 'nf_original',
         x ->> 'transportadora', x ->> 'transp_promob', nullif(x ->> 'ticket_criado', '')::timestamptz, true, auth.jwt() ->> 'email', f
  from jsonb_array_elements(itens) x where coalesce(x ->> 'ticket', '') <> ''
  on conflict (ticket) do update set tipo = excluded.tipo, tipo_reposicao = excluded.tipo_reposicao, motivo = excluded.motivo,
    pedido = excluded.pedido, pedido_promob = excluded.pedido_promob, nf_original = excluded.nf_original,
    transportadora = excluded.transportadora, transp_promob = excluded.transp_promob, ticket_criado = excluded.ticket_criado,
    na_planilha = true, importado_em = now(), importado_por = excluded.importado_por, fila_rel = excluded.fila_rel;
  get diagnostics n = row_count;
  insert into public.aguardando_info (id, arquivo, linhas, enviado_por, enviado_em)
  values (case when f = 'AT' then 2 else 1 end, arquivo, jsonb_array_length(itens), auth.jwt() ->> 'email', now())
  on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  return n;
end $$;
revoke all on function public.importar_aguardando(jsonb, text, text) from public, anon;
grant execute on function public.importar_aguardando(jsonb, text, text) to authenticated;
create or replace function public.rodar_robo_aguardando()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.aguardando_info set enviado_em = enviado_em where true;
end $$;

-- =====================================================================
-- 27) Preventivo: quando a previsão do SSW é DEPOIS da data prometida de um pedido que vence nos próximos 5 dias
--     (hoje até +5), a nova data recebe sozinha a data do SSW. Ela fica até alguém mudar a nova data à mão
--     (aí o robô não mexe mais) ou o pedido sair como entregue/cancelado. Se o SSW mudar a previsão, a data automática acompanha.
alter table public.tratativas add column if not exists nova_data_fonte text;   -- 'ssw' = gravada pelo robô
create or replace function public._carimbo_tratativa()
returns trigger language plpgsql as $$
begin
  new.atualizado_por := coalesce(auth.jwt() ->> 'email', new.atualizado_por);
  new.atualizado_em := now();
  if coalesce(current_setting('painel.ssw', true), '') = '1' then new.atualizado_por := 'SSW (automático)';
  -- nova data mudada por uma pessoa: deixa de ser automática
  elsif tg_op = 'INSERT' then new.nova_data_fonte := null;
  elsif new.nova_data is distinct from old.nova_data then new.nova_data_fonte := null;
  end if;
  return new;
end $$;

create or replace function public._ssw_nova_data(p_pedidos text[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('painel.ssw', '1', true);
  insert into public.tratativas (pedido, nova_data, nova_data_fonte, atualizado_por)
  select b.pedido, s.previsao, 'ssw', 'SSW (automático)'
  from public.base_aberta b
  join public.previsao_ssw s on s.pedido = b.pedido
  left join public.tratativas t on t.pedido = b.pedido
  where (p_pedidos is null or b.pedido = any(p_pedidos))
    and s.previsao is not null and s.situacao <> 'entregue'
    and coalesce(b.transportadora, '') !~* '(formato|transiga)'
    and coalesce(b.prev_original, b.prev_atual) between current_date and current_date + 5
    and s.previsao > coalesce(b.prev_original, b.prev_atual)
    and (t.pedido is null or t.nova_data is null or (t.nova_data_fonte = 'ssw' and t.nova_data <> s.previsao))
  on conflict (pedido) do update set nova_data = excluded.nova_data, nova_data_fonte = 'ssw';
  get diagnostics n = row_count;
  perform set_config('painel.ssw', '', true);
  return n;
end $$;
revoke all on function public._ssw_nova_data(text[]) from public, anon, authenticated;

create or replace function public.gravar_ssw(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  insert into public.previsao_ssw (pedido, nf, previsao, situacao, consultado_em)
  select r.pedido, r.nf, r.previsao, r.situacao, now()
  from jsonb_to_recordset(linhas) as r(pedido text, nf text, previsao date, situacao text)
  where coalesce(r.pedido, '') <> ''
  on conflict (pedido) do update set nf = excluded.nf, previsao = excluded.previsao, situacao = excluded.situacao, consultado_em = now();
  get diagnostics n = row_count;
  perform public._ssw_nova_data(array(select r.pedido from jsonb_to_recordset(linhas) as r(pedido text)));
  return n;
end $$;
revoke all on function public.gravar_ssw(jsonb) from public, anon;
grant execute on function public.gravar_ssw(jsonb) to authenticated;

-- já aplica nos pedidos que hoje estão assim
select public._ssw_nova_data(null) as novas_datas_do_ssw;

-- =====================================================================
-- 28) Nova data automática também pela aba Conferência SSW: o robô guarda a previsão do rastreio (SSW, Jadlog,
--     Bento Brasil, Trânsito Brasil) dos não entregues; se vence de hoje a 5 dias e a previsão é depois da
--     prometida ao cliente, a Nova data recebe a previsão (mesmas regras da parte 27).
create or replace function public._conf_nova_data(p_pedidos text[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('painel.ssw', '1', true);
  insert into public.tratativas (pedido, nova_data, nova_data_fonte, atualizado_por)
  select c.pedido, (c.detalhe ->> 'previsao')::date, 'ssw', 'SSW (automático)'
  from public.conferencia_ssw c
  left join public.tratativas t on t.pedido = c.pedido
  where (p_pedidos is null or c.pedido = any(p_pedidos))
    and c.situacao <> 'entregue'
    and coalesce(c.detalhe ->> 'previsao', '') ~ '^\d{4}-\d{2}-\d{2}$'
    and coalesce(c.transportadora, '') !~* '(formato|transiga)'
    and c.prev_cliente between current_date and current_date + 5
    and (c.detalhe ->> 'previsao')::date > c.prev_cliente
    and (t.pedido is null or t.nova_data is null or (t.nova_data_fonte = 'ssw' and t.nova_data <> (c.detalhe ->> 'previsao')::date))
  on conflict (pedido) do update set nova_data = excluded.nova_data, nova_data_fonte = 'ssw';
  get diagnostics n = row_count;
  perform set_config('painel.ssw', '', true);
  return n;
end $$;
revoke all on function public._conf_nova_data(text[]) from public, anon, authenticated;

create or replace function public.gravar_conferencia(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.conferencia_ssw c set situacao = r.situacao, ultimo_evento = r.ultimo_evento, data_evento = r.data_evento,
    data_entrega = r.data_entrega, detalhe = r.detalhe, consultado_em = now()
  from jsonb_to_recordset(linhas) as r(pedido text, situacao text, ultimo_evento text, data_evento date, data_entrega date, detalhe jsonb)
  where c.pedido = r.pedido;
  get diagnostics n = row_count;
  perform public._conf_nova_data(array(select r.pedido from jsonb_to_recordset(linhas) as r(pedido text)));
  return n;
end $$;
revoke all on function public.gravar_conferencia(jsonb) from public, anon;
grant execute on function public.gravar_conferencia(jsonb) to authenticated;

-- já aplica no que a conferência tem hoje (Jadlog, Bento e Trânsito já trazem a previsão)
select public._conf_nova_data(null) as novas_datas_da_conferencia;
