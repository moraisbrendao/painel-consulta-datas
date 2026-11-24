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

-- =====================================================================
-- 29) Nova data automática também para os pedidos já vencidos/atrasados (não só os que vencem em até 5 dias),
--     quando o rastreio tem previsão atualizada (de hoje em diante) e depois da prometida.
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
    and coalesce(b.prev_original, b.prev_atual) <= current_date + 5
    and s.previsao >= current_date
    and s.previsao > coalesce(b.prev_original, b.prev_atual)
    and (t.pedido is null or t.nova_data is null or (t.nova_data_fonte = 'ssw' and t.nova_data <> s.previsao))
  on conflict (pedido) do update set nova_data = excluded.nova_data, nova_data_fonte = 'ssw';
  get diagnostics n = row_count;
  perform set_config('painel.ssw', '', true);
  return n;
end $$;
revoke all on function public._ssw_nova_data(text[]) from public, anon, authenticated;

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
    and c.prev_cliente <= current_date + 5
    and (c.detalhe ->> 'previsao')::date >= current_date
    and (c.detalhe ->> 'previsao')::date > c.prev_cliente
    and (t.pedido is null or t.nova_data is null or (t.nova_data_fonte = 'ssw' and t.nova_data <> (c.detalhe ->> 'previsao')::date))
  on conflict (pedido) do update set nova_data = excluded.nova_data, nova_data_fonte = 'ssw';
  get diagnostics n = row_count;
  perform set_config('painel.ssw', '', true);
  return n;
end $$;
revoke all on function public._conf_nova_data(text[]) from public, anon, authenticated;

select public._ssw_nova_data(null) as do_preventivo, public._conf_nova_data(null) as da_conferencia;

-- ============ PARTE 30: logins do painel (trocar senha sem e-mail) ============
-- As contas são criadas pela Logística no Supabase (Authentication › Users › Add user).
-- No painel a Logística vê os logins e gera uma senha provisória para quem esqueceu;
-- a pessoa troca por uma dela no primeiro acesso.
drop trigger if exists so_email_empresa on auth.users;
drop function if exists public._so_email_empresa();

-- quem administra os logins (página Logins). Os e-mails são incluídos à mão no SQL Editor:
--   insert into public.admins_painel(email) values ('fulano@empresa.com') on conflict do nothing;
create table if not exists public.admins_painel (email text primary key);
alter table public.admins_painel enable row level security;
revoke all on public.admins_painel from anon, authenticated;
create or replace function public.e_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.admins_painel where email = lower(auth.jwt() ->> 'email')) $$;
revoke all on function public.e_admin() from public, anon;
grant execute on function public.e_admin() to authenticated;

-- lista do SAC: só os administradores mexem (o e_sac() continua lendo, pois é security definer)
drop policy if exists "logistica gerencia" on public.logins_sac;
drop policy if exists "admin gerencia" on public.logins_sac;
create policy "admin gerencia" on public.logins_sac for all to authenticated
  using ((select public.e_admin())) with check ((select public.e_admin()));

create or replace function public.listar_logins()
returns table(email text, criado_em timestamptz, ultimo_acesso timestamptz, sac boolean, trocar_senha boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.e_admin() then raise exception 'sem permissão'; end if;
  return query
    select u.email::text, u.created_at, u.last_sign_in_at,
           exists (select 1 from public.logins_sac s where s.email = lower(u.email)),
           coalesce((u.raw_user_meta_data ->> 'trocar_senha')::boolean, false)
    from auth.users u order by lower(u.email);
end $$;
revoke all on function public.listar_logins() from public, anon;
grant execute on function public.listar_logins() to authenticated;

create or replace function public.senha_provisoria(p_email text)
returns text language plpgsql volatile security definer set search_path = public
as $$
declare
  alfa constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  b bytea := extensions.gen_random_bytes(8);
  nova text := '';
begin
  if auth.uid() is null or not public.e_admin() then raise exception 'sem permissão'; end if;
  for i in 0..7 loop nova := nova || substr(alfa, get_byte(b, i) % length(alfa) + 1, 1); end loop;
  update auth.users
     set encrypted_password = extensions.crypt(nova, extensions.gen_salt('bf')),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"trocar_senha": true}'::jsonb,
         updated_at = now()
   where lower(email) = lower(trim(p_email));
  if not found then raise exception 'login não encontrado'; end if;
  return nova;
end $$;
revoke all on function public.senha_provisoria(text) from public, anon;
grant execute on function public.senha_provisoria(text) to authenticated;

-- ============ PARTE 31: histórico diário da base (aba Transportadoras) ============
-- Uma foto por dia, tirada do 1º arquivo enviado no botão "Enviar base" naquele dia (os seguintes não mudam a foto).
-- dados = lista de grupos [transportadora, canal, uf, volume, em aberto, atrasados, em risco, entregues no prazo, entregues c/ atraso]
create table if not exists public.historico_base (
  dia        date primary key,
  dados      jsonb not null,
  arquivo    text,
  gravado_por text,
  gravado_em timestamptz not null default now()
);
alter table public.historico_base enable row level security;
drop policy if exists "logados leem" on public.historico_base;
create policy "logados leem" on public.historico_base for select to authenticated using ((select not public.e_sac()));
grant select on public.historico_base to authenticated;

create or replace function public.gravar_historico(p_dia date, p_dados jsonb, p_arquivo text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'sem permissão'; end if;
  if p_dia is null or p_dia > current_date + 1 or jsonb_typeof(p_dados) <> 'array' then raise exception 'dados inválidos'; end if;
  insert into public.historico_base (dia, dados, arquivo, gravado_por)
  values (p_dia, p_dados, left(p_arquivo, 200), auth.jwt() ->> 'email')
  on conflict (dia) do nothing;
  get diagnostics n = row_count;
  return n > 0;   -- false = esse dia já tinha foto
end $$;
revoke all on function public.gravar_historico(date, jsonb, text) from public, anon;
grant execute on function public.gravar_historico(date, jsonb, text) to authenticated;

-- ============ PARTE 32: Excel da Visão Gerencial no modelo de 55 colunas ============
-- (a) colunas a mais da base (ID Any, Pedido Anymarket, CEP, chave, valores, CT-e, SKU...) guardadas juntas em "extra"
alter table public.base_pedidos add column if not exists extra jsonb;
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
    dias_atraso = excluded.dias_atraso, status_prazo = excluded.status_prazo, sem_expedicao = excluded.sem_expedicao,
    extra = excluded.extra;
  return (select count(*) from public.base_pedidos);
end $$;
revoke all on function public.importar_base(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_base(jsonb, boolean, text, integer) to authenticated;

-- (b) abas Ocorrências, Reposições e Assistência Técnica do detalhamento_tickets360 (substituídas a cada "Enviar tickets")
create table if not exists public.detalhe_nf (
  nf           text primary key,
  tem_ocorr    boolean,
  ocorr_status text,
  ocorr_msg    text,
  ocorr_em     text,
  tem_repo     boolean,
  repo_nf      text,
  tem_at       boolean
);
alter table public.detalhe_nf enable row level security;
drop policy if exists "logados leem" on public.detalhe_nf;
create policy "logados leem" on public.detalhe_nf for select to authenticated using ((select not public.e_sac()));
grant select on public.detalhe_nf to authenticated;

create or replace function public.importar_detalhe_nf(linhas jsonb, limpar boolean)
returns integer language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'sem permissão'; end if;
  if limpar then delete from public.detalhe_nf where true; end if;
  insert into public.detalhe_nf (nf, tem_ocorr, ocorr_status, ocorr_msg, ocorr_em, tem_repo, repo_nf, tem_at)
  select r.nf, r.tem_ocorr, r.ocorr_status, left(r.ocorr_msg, 1000), r.ocorr_em, r.tem_repo, r.repo_nf, r.tem_at
  from jsonb_to_recordset(linhas) as r(nf text, tem_ocorr boolean, ocorr_status text, ocorr_msg text, ocorr_em text, tem_repo boolean, repo_nf text, tem_at boolean)
  where r.nf is not null and r.nf <> ''
  on conflict (nf) do update set tem_ocorr = excluded.tem_ocorr, ocorr_status = excluded.ocorr_status, ocorr_msg = excluded.ocorr_msg,
    ocorr_em = excluded.ocorr_em, tem_repo = excluded.tem_repo, repo_nf = excluded.repo_nf, tem_at = excluded.tem_at;
  return (select count(*) from public.detalhe_nf);
end $$;
revoke all on function public.importar_detalhe_nf(jsonb, boolean) from public, anon;
grant execute on function public.importar_detalhe_nf(jsonb, boolean) to authenticated;

-- =================================================================
-- 33) DESFEITA (2026-11-16): o arquivo da Intelipost NÃO acrescenta pedidos; a base (BI) manda em tudo.
-- A Intelipost só tira da base os entregues/cancelados (Preventivo e Consulta SAC) e alimenta a Conferência SSW.
-- =================================================================
create or replace view public.base_aberta with (security_invoker = true) as
  select b.* from public.base_pedidos b
  where coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
    and not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido);
drop function if exists public.importar_abertos(jsonb, boolean);
drop table if exists public.intelipost_abertos;

-- =================================================================
-- 34) Tabela de apelidos das transportadoras (página Transportadora divergente)
-- A Logística cadastra no painel: transportadora da coluna H, apelido, trecho buscado no nome do Promob e ID do método.
-- =================================================================
create table if not exists public.apelidos_transp (
  h              text primary key,
  apelido        text,
  chave          text not null,
  id_metodo      integer,
  atualizado_por text default (auth.jwt() ->> 'email'),
  atualizado_em  timestamptz default now()
);
alter table public.apelidos_transp enable row level security;
drop policy if exists "logistica le" on public.apelidos_transp;
create policy "logistica le" on public.apelidos_transp for select to authenticated using ((select not public.e_sac()));
drop policy if exists "logistica altera" on public.apelidos_transp;
create policy "logistica altera" on public.apelidos_transp for all to authenticated
  using ((select not public.e_sac())) with check ((select not public.e_sac()));
revoke all on public.apelidos_transp from anon;
grant select, insert, update, delete on public.apelidos_transp to authenticated;

-- =================================================================
-- 35) Consulta de entregas (SAC): ocorrência e reposição em andamento embaixo de cada nota
-- O detalhamento de tickets passa a guardar o ID do ticket de reposição e a fila atual dele.
-- =================================================================
alter table public.detalhe_nf add column if not exists repo_ticket text;   -- IDs dos tickets de reposição da nota, separados por vírgula
alter table public.detalhe_nf add column if not exists repo_fila text;

create or replace function public.importar_detalhe_nf(linhas jsonb, limpar boolean)
returns integer language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'sem permissão'; end if;
  if limpar then delete from public.detalhe_nf where true; end if;
  insert into public.detalhe_nf (nf, tem_ocorr, ocorr_status, ocorr_msg, ocorr_em, tem_repo, repo_nf, tem_at, repo_ticket, repo_fila)
  select r.nf, r.tem_ocorr, r.ocorr_status, left(r.ocorr_msg, 1000), r.ocorr_em, r.tem_repo, r.repo_nf, r.tem_at, left(r.repo_ticket, 200), r.repo_fila
  from jsonb_to_recordset(linhas) as r(nf text, tem_ocorr boolean, ocorr_status text, ocorr_msg text, ocorr_em text, tem_repo boolean, repo_nf text, tem_at boolean, repo_ticket text, repo_fila text)
  where r.nf is not null and r.nf <> ''
  on conflict (nf) do update set tem_ocorr = excluded.tem_ocorr, ocorr_status = excluded.ocorr_status, ocorr_msg = excluded.ocorr_msg,
    ocorr_em = excluded.ocorr_em, tem_repo = excluded.tem_repo, repo_nf = excluded.repo_nf, tem_at = excluded.tem_at,
    repo_ticket = excluded.repo_ticket, repo_fila = excluded.repo_fila;
  return (select count(*) from public.detalhe_nf);
end $$;
revoke all on function public.importar_detalhe_nf(jsonb, boolean) from public, anon;
grant execute on function public.importar_detalhe_nf(jsonb, boolean) to authenticated;

-- mesma regra do painel (chaveNF): tira zeros à esquerda e ".0" de cada parte do "número-série"
create or replace function public.chave_nf(v text) returns text language sql immutable as $$
  select string_agg(regexp_replace(regexp_replace(trim(p), '\.0+$', ''), '^0+(?=\d)', ''), '-' order by i)
  from unnest(string_to_array(trim(coalesce(v, '')), '-')) with ordinality as x(p, i)
$$;

drop function if exists public.consultar_sac();
create or replace function public.consultar_sac()
returns table (pedido text, nf text, canal text, transportadora text, micro_status text,
               prometido date, nova_data date, observacao text, atualizado_em timestamptz, link_rastreio text,
               tem_ocorr boolean, ocorr_status text, ocorr_msg text, ocorr_em text, tem_repo boolean, repo_ticket text, repo_fila text, repo_nf text)
language sql stable security definer set search_path = public
as $$
  select b.pedido, b.nf, b.canal, b.transportadora, b.micro_status,
         coalesce(b.prev_original, b.prev_atual), t.nova_data, t.observacao, t.atualizado_em, b.link_rastreio,
         d.tem_ocorr, d.ocorr_status, d.ocorr_msg, d.ocorr_em, d.tem_repo, d.repo_ticket, d.repo_fila, d.repo_nf
  from public.base_pedidos b
  left join public.tratativas t on t.pedido = b.pedido
  left join public.detalhe_nf d on d.nf = public.chave_nf(b.nf)
  where auth.uid() is not null
    and not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido)
    and (coalesce(b.prev_original, b.prev_atual) <= (now() at time zone 'America/Sao_Paulo')::date + 1
         or t.nova_data <= (now() at time zone 'America/Sao_Paulo')::date + 1)
  order by b.pedido
$$;
revoke all on function public.consultar_sac() from public, anon;
grant execute on function public.consultar_sac() to authenticated;

-- =================================================================
-- 36) BI de Reposições
-- a) Mais colunas da TABELA DE ACOMPANHAMENTO (um ticket por linha: é a contagem oficial)
-- b) Histórico acumulado da aba Reposições do detalhamento Tickets360: cada envio é guardado e nada é apagado
-- =================================================================
alter table public.reposicoes_tk add column if not exists filial         text;      -- Central de Distribuição
alter table public.reposicoes_tk add column if not exists responsavel    text;
alter table public.reposicoes_tk add column if not exists atualizado_em  timestamp; -- Data da Última Atualização
alter table public.reposicoes_tk add column if not exists finalizado_em  timestamp; -- Data de Finalização
alter table public.reposicoes_tk add column if not exists tempo_resolucao numeric;  -- Tempo de Resolução do Ticket (dia)
alter table public.reposicoes_tk add column if not exists estagnada      text;      -- Flag - Ticket Sem Atualização > 2 Dias
alter table public.reposicoes_tk add column if not exists transp_final   text;      -- coluna Q
alter table public.reposicoes_tk add column if not exists transp_redesp  text;      -- coluna R
alter table public.reposicoes_tk add column if not exists pedido         text;      -- Hub - Número do Marketplace
alter table public.reposicoes_tk add column if not exists valor_pedido   numeric;   -- Hub - Valor Total (valor do pedido, não da reposição)

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
  insert into public.reposicoes_tk (ticket, criado_em, criado_por, via, fila, tipo, motivo, status, transportadora, nf,
    filial, responsavel, atualizado_em, finalizado_em, tempo_resolucao, estagnada, transp_final, transp_redesp, pedido, valor_pedido)
  select r.ticket, r.criado_em, r.criado_por, r.via, r.fila, r.tipo, r.motivo, r.status, r.transportadora, r.nf,
    r.filial, r.responsavel, r.atualizado_em, r.finalizado_em, r.tempo_resolucao, r.estagnada, r.transp_final, r.transp_redesp, r.pedido, r.valor_pedido
  from jsonb_to_recordset(linhas) as r(ticket text, criado_em timestamp, criado_por text, via text, fila text, tipo text,
    motivo text, status text, transportadora text, nf text, filial text, responsavel text, atualizado_em timestamp,
    finalizado_em timestamp, tempo_resolucao numeric, estagnada text, transp_final text, transp_redesp text, pedido text, valor_pedido numeric)
  where r.ticket is not null and r.ticket <> ''
  on conflict (ticket) do update set criado_em = excluded.criado_em, criado_por = excluded.criado_por, via = excluded.via,
    fila = excluded.fila, tipo = excluded.tipo, motivo = excluded.motivo, status = excluded.status,
    transportadora = excluded.transportadora, nf = excluded.nf, filial = excluded.filial, responsavel = excluded.responsavel,
    atualizado_em = excluded.atualizado_em, finalizado_em = excluded.finalizado_em, tempo_resolucao = excluded.tempo_resolucao,
    estagnada = excluded.estagnada, transp_final = excluded.transp_final, transp_redesp = excluded.transp_redesp,
    pedido = excluded.pedido, valor_pedido = excluded.valor_pedido;
  return (select count(*) from public.reposicoes_tk);
end $$;
revoke all on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) to authenticated;

-- b) envios do detalhamento (um por arquivo) e histórico da aba Reposições (ticket × nova NF × envio). Só inserção.
create table if not exists public.repo_envios (
  id           bigserial primary key,
  arquivo      text,
  assinatura   text unique,                 -- impressão do conteúdo: o mesmo arquivo não entra duas vezes
  extraido_em  timestamptz not null,        -- quando o arquivo foi gerado (data do arquivo, conferida por quem envia)
  enviado_em   timestamptz not null default now(),
  enviado_por  text default (auth.jwt() ->> 'email'),
  linhas       integer,
  tickets      integer
);
create table if not exists public.repo_hist (
  envio_id              bigint not null references public.repo_envios(id),
  ticket                text not null,
  nf_nova               text not null default '',   -- '' = ainda sem nova NF
  data_criacao_ticket   timestamp,
  id_any                text,
  id_pedido             text,
  id_intelipost         text,
  nota_ticket           text,
  data_saida_nota_ticket timestamp,
  tipo_ticket           text,
  fila_atual            text,
  tipo_reposicao        text,
  transp_definida       text,
  pedido_promob         text,
  chave_nf_nova         text,
  data_emissao_nf       timestamp,
  data_saida_nf         timestamp,
  transp_promob         text,
  transp_redesp_promob  text,
  primary key (envio_id, ticket, nf_nova)
);
create index if not exists repo_hist_ticket on public.repo_hist (ticket);
alter table public.repo_envios enable row level security;
alter table public.repo_hist enable row level security;
revoke all on public.repo_envios, public.repo_hist from anon;
revoke insert, update, delete, truncate on public.repo_envios, public.repo_hist from authenticated;
grant select on public.repo_envios, public.repo_hist to authenticated;
drop policy if exists "logistica le" on public.repo_envios;
drop policy if exists "logistica le" on public.repo_hist;
create policy "logistica le" on public.repo_envios for select to authenticated using ((select not public.e_sac()));
create policy "logistica le" on public.repo_hist for select to authenticated using ((select not public.e_sac()));

-- abre um envio; devolve o número dele (ou erro se o mesmo arquivo já foi guardado)
create or replace function public.abrir_envio_repo(p_arquivo text, p_assinatura text, p_extraido_em timestamptz, p_linhas integer, p_tickets integer)
returns bigint language plpgsql security definer set search_path = public
as $$
declare n bigint;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'sem permissão'; end if;
  if exists (select 1 from public.repo_envios where assinatura = p_assinatura) then raise exception 'Esse detalhamento já está no histórico.'; end if;
  insert into public.repo_envios (arquivo, assinatura, extraido_em, enviado_por, linhas, tickets)
  values (p_arquivo, p_assinatura, p_extraido_em, auth.jwt() ->> 'email', p_linhas, p_tickets) returning id into n;
  return n;
end $$;
revoke all on function public.abrir_envio_repo(text, text, timestamptz, integer, integer) from public, anon;
grant execute on function public.abrir_envio_repo(text, text, timestamptz, integer, integer) to authenticated;

-- grava as linhas de um envio (em lotes). Só acrescenta: linha repetida do mesmo envio é ignorada, nada é alterado.
create or replace function public.gravar_hist_repo(p_envio bigint, linhas jsonb)
returns integer language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'sem permissão'; end if;
  if not exists (select 1 from public.repo_envios where id = p_envio and enviado_em > now() - interval '1 hour') then raise exception 'envio inválido'; end if;
  insert into public.repo_hist (envio_id, ticket, nf_nova, data_criacao_ticket, id_any, id_pedido, id_intelipost, nota_ticket, data_saida_nota_ticket,
    tipo_ticket, fila_atual, tipo_reposicao, transp_definida, pedido_promob, chave_nf_nova, data_emissao_nf, data_saida_nf, transp_promob, transp_redesp_promob)
  select p_envio, r.ticket, coalesce(r.nf_nova, ''), r.data_criacao_ticket, r.id_any, r.id_pedido, r.id_intelipost, r.nota_ticket, r.data_saida_nota_ticket,
    r.tipo_ticket, r.fila_atual, r.tipo_reposicao, r.transp_definida, r.pedido_promob, r.chave_nf_nova, r.data_emissao_nf, r.data_saida_nf, r.transp_promob, r.transp_redesp_promob
  from jsonb_to_recordset(linhas) as r(ticket text, nf_nova text, data_criacao_ticket timestamp, id_any text, id_pedido text, id_intelipost text, nota_ticket text,
    data_saida_nota_ticket timestamp, tipo_ticket text, fila_atual text, tipo_reposicao text, transp_definida text, pedido_promob text, chave_nf_nova text,
    data_emissao_nf timestamp, data_saida_nf timestamp, transp_promob text, transp_redesp_promob text)
  where r.ticket is not null and r.ticket <> ''
  on conflict do nothing;
  return (select count(*) from public.repo_hist where envio_id = p_envio);
end $$;
revoke all on function public.gravar_hist_repo(bigint, jsonb) from public, anon;
grant execute on function public.gravar_hist_repo(bigint, jsonb) to authenticated;

-- visão atual consolidada: 1 linha por ticket; cada campo = o valor preenchido mais recente
create or replace view public.repo_atual with (security_invoker = true) as
with h as (select x.*, e.extraido_em from public.repo_hist x join public.repo_envios e on e.id = x.envio_id),
ult as (select max(id) as envio_id from public.repo_envios),
mud as (   -- mudança de fila ou de NF entre envios
  select ticket, extraido_em, string_agg(coalesce(fila_atual, '') || '|' || nf_nova, ',' order by nf_nova) as estado from h group by ticket, envio_id, extraido_em),
mud2 as (select ticket, extraido_em, estado, lag(estado) over (partition by ticket order by extraido_em) as antes from mud)
select h.ticket,
  (array_agg(h.data_criacao_ticket order by h.extraido_em desc) filter (where h.data_criacao_ticket is not null))[1] as data_criacao_ticket,
  (array_agg(h.nota_ticket order by h.extraido_em desc) filter (where h.nota_ticket is not null))[1] as nota_ticket,
  (array_agg(h.id_intelipost order by h.extraido_em desc) filter (where h.id_intelipost is not null))[1] as id_intelipost,
  (array_agg(h.fila_atual order by h.extraido_em desc) filter (where h.fila_atual is not null))[1] as fila_atual,
  (array_agg(h.tipo_reposicao order by h.extraido_em desc) filter (where h.tipo_reposicao is not null))[1] as tipo_reposicao,
  (array_agg(h.transp_definida order by h.extraido_em desc) filter (where h.transp_definida is not null))[1] as transp_definida,
  (array_agg(h.pedido_promob order by h.extraido_em desc) filter (where h.pedido_promob is not null))[1] as pedido_promob,
  string_agg(distinct nullif(h.nf_nova, ''), ', ') as nfs_novas,
  (array_agg(h.chave_nf_nova order by h.extraido_em desc) filter (where h.chave_nf_nova is not null))[1] as chave_nf_nova,
  min(h.data_emissao_nf) as data_emissao_nf,
  min(h.data_saida_nf) as data_saida_nf,
  (array_agg(h.transp_promob order by h.extraido_em desc) filter (where h.transp_promob is not null))[1] as transp_promob,
  (array_agg(h.transp_redesp_promob order by h.extraido_em desc) filter (where h.transp_redesp_promob is not null))[1] as transp_redesp_promob,
  min(h.extraido_em) as primeiro_envio_em,
  max(h.extraido_em) as ultimo_envio_em,
  count(distinct h.envio_id) as envios,
  min(h.extraido_em) filter (where h.nf_nova <> '') as nf_vista_em,
  (select max(m.extraido_em) from mud2 m where m.ticket = h.ticket and m.antes is distinct from m.estado) as ultima_mudanca_em,
  bool_or(h.envio_id = (select envio_id from ult)) as no_ultimo_envio
from h group by h.ticket;
grant select on public.repo_atual to authenticated;
-- 37) Rastreio da Transiga por webhook: a Transiga manda os eventos para a função transiga-webhook,
--     que guarda só NF, status/ocorrência, datas e previsão (nada de nomes, documentos, endereço ou fotos)
create table if not exists public.rastreio_transiga (
  nf text primary key,              -- chave_nf("número-série")
  encomenda text,
  codigo text,
  descricao text,
  data_evento timestamp,
  previsao date,
  entregue boolean not null default false,
  data_entrega timestamp,
  eventos integer not null default 0,
  recebido_em timestamptz not null default now()
);
alter table public.rastreio_transiga enable row level security;
revoke all on public.rastreio_transiga from anon;
revoke insert, update, delete, truncate on public.rastreio_transiga from authenticated;
grant select on public.rastreio_transiga to authenticated;
drop policy if exists "logistica le" on public.rastreio_transiga;
create policy "logistica le" on public.rastreio_transiga for select to authenticated using ((select not public.e_sac()));

create or replace function public.receber_transiga(linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in select * from jsonb_to_recordset(linhas) as x(numero text, serie text, encomenda text, codigo text, descricao text, data_evento timestamp, previsao date, entregue boolean)
           where coalesce(x.numero, '') <> '' order by x.data_evento nulls first loop
    insert into public.rastreio_transiga as t (nf, encomenda, codigo, descricao, data_evento, previsao, entregue, data_entrega, eventos, recebido_em)
    values (public.chave_nf(r.numero || '-' || coalesce(r.serie, '')), nullif(r.encomenda, ''), nullif(r.codigo, ''), left(nullif(r.descricao, ''), 80),
      r.data_evento, r.previsao, coalesce(r.entregue, false), case when r.entregue then r.data_evento end, 1, now())
    on conflict (nf) do update set
      encomenda = coalesce(excluded.encomenda, t.encomenda),
      codigo = case when t.data_evento is null or excluded.data_evento >= t.data_evento then coalesce(excluded.codigo, t.codigo) else t.codigo end,
      descricao = case when t.data_evento is null or excluded.data_evento >= t.data_evento then coalesce(excluded.descricao, t.descricao) else t.descricao end,
      data_evento = greatest(t.data_evento, excluded.data_evento),
      previsao = coalesce(excluded.previsao, t.previsao),
      entregue = t.entregue or excluded.entregue,
      data_entrega = coalesce(t.data_entrega, excluded.data_entrega),
      eventos = t.eventos + 1,
      recebido_em = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.receber_transiga(jsonb) from public, anon, authenticated;
grant execute on function public.receber_transiga(jsonb) to service_role;
-- 38) Conferência SSW em lotes a cada 30 min (06:20 às 23:50, Brasília) chamada pelo próprio Supabase,
--     porque o agendamento do GitHub atrasa ou não dispara. Usa o token do cofre da parte 13 (github_robo_token).
create extension if not exists pg_cron;
create or replace function public._robo_ssw_lote()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"lote","auto":"1"}}'::jsonb);
  end if;
end $$;
revoke all on function public._robo_ssw_lote() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'robo-ssw-lote';
select cron.unschedule(jobid) from cron.job where jobname = 'robo-ssw-lote-noite';
-- horários em UTC (Brasília + 3h): 06:00–17:30 de 30 em 30 min, 18:00, depois 20h, 22h, 00h, 02h e 04h
select cron.schedule('robo-ssw-lote', '0,30 9-20 * * *', 'select public._robo_ssw_lote()');
select cron.schedule('robo-ssw-lote-noite', '0 21,23,1,3,5,7 * * *', 'select public._robo_ssw_lote()');
-- 39) Análise de canais: impactos de reputação por canal (Amazon: avaliações negativas, garantia A a Z, estornos;
--     Mercado Livre: reclamações e mediações). Cada envio substitui a lista do canal. Só a Logística lê.
create table if not exists public.canal_impactos (
  canal       text not null,
  id_pedido   text not null,     -- id do pedido no canal (ex.: 701-1234567-1234567 / 2000012345678901)
  tipo        text not null default '',
  data_pedido date,
  primary key (canal, id_pedido, tipo)
);
create table if not exists public.canal_impactos_info (
  canal       text primary key,
  arquivo     text,
  linhas      integer,
  vendas_60d  integer,           -- vendas do canal nos últimos 60 dias (se informado; senão o painel conta pela base)
  enviado_por text,
  enviado_em  timestamptz not null default now()
);
alter table public.canal_impactos enable row level security;
alter table public.canal_impactos_info enable row level security;
revoke all on public.canal_impactos, public.canal_impactos_info from anon;
revoke insert, update, delete, truncate on public.canal_impactos, public.canal_impactos_info from authenticated;
grant select on public.canal_impactos, public.canal_impactos_info to authenticated;
drop policy if exists "logistica le" on public.canal_impactos;
drop policy if exists "logistica le" on public.canal_impactos_info;
create policy "logistica le" on public.canal_impactos for select to authenticated using ((select not public.e_sac()));
create policy "logistica le" on public.canal_impactos_info for select to authenticated using ((select not public.e_sac()));

create or replace function public.importar_impactos(p_canal text, p_arquivo text, linhas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  delete from public.canal_impactos where canal = p_canal;
  insert into public.canal_impactos (canal, id_pedido, tipo, data_pedido)
  select distinct p_canal, left(r.id_pedido, 60), left(coalesce(r.tipo, ''), 60), r.data_pedido
  from jsonb_to_recordset(linhas) as r(id_pedido text, tipo text, data_pedido date)
  where coalesce(r.id_pedido, '') <> ''
  on conflict do nothing;
  get diagnostics n = row_count;
  insert into public.canal_impactos_info (canal, arquivo, linhas, enviado_por, enviado_em)
  values (p_canal, p_arquivo, n, auth.jwt() ->> 'email', now())
  on conflict (canal) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = excluded.enviado_em;
  return n;
end $$;
revoke all on function public.importar_impactos(text, text, jsonb) from public, anon;
grant execute on function public.importar_impactos(text, text, jsonb) to authenticated;

create or replace function public.salvar_vendas_canal(p_canal text, p_vendas integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  insert into public.canal_impactos_info (canal, vendas_60d, enviado_por) values (p_canal, p_vendas, auth.jwt() ->> 'email')
  on conflict (canal) do update set vendas_60d = excluded.vendas_60d;
end $$;
revoke all on function public.salvar_vendas_canal(text, integer) from public, anon;
grant execute on function public.salvar_vendas_canal(text, integer) to authenticated;

-- =================================================================
-- 40) Preventivo com os mesmos números da Visão Gerencial + histórico de retornos das transportadoras
-- base_aberta_bi: pedidos em aberto pela BASE (igual à Visão Gerencial); entregue_ip marca os que o arquivo da Intelipost já deu como entregue/cancelado.
-- retornos_hist: cada mudança de nova data / observação (tela, Enviar retornos ou robô do SSW) fica guardada, para medir promessa quebrada e retornos por pedido.
-- =================================================================
create or replace view public.base_aberta_bi with (security_invoker = true) as
  select b.*, exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido) as entregue_ip
  from public.base_pedidos b
  where coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%';
revoke all on public.base_aberta_bi from anon;
grant select on public.base_aberta_bi to authenticated;

create table if not exists public.retornos_hist (
  id              bigserial primary key,
  pedido          text not null,
  nova_data       date,
  nova_data_antes date,
  observacao      text,
  fonte           text,
  feito_por       text,
  feito_em        timestamptz not null default now()
);
create index if not exists retornos_hist_pedido on public.retornos_hist (pedido, feito_em desc);
alter table public.retornos_hist enable row level security;
revoke all on public.retornos_hist from anon;
revoke insert, update, delete, truncate on public.retornos_hist from authenticated;
grant select on public.retornos_hist to authenticated;
drop policy if exists "logistica le" on public.retornos_hist;
create policy "logistica le" on public.retornos_hist for select to authenticated using ((select not public.e_sac()));

create or replace function public._log_retorno() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.nova_data is distinct from old.nova_data or new.observacao is distinct from old.observacao then
    insert into public.retornos_hist (pedido, nova_data, nova_data_antes, observacao, fonte, feito_por)
    values (new.pedido, new.nova_data, case when tg_op = 'UPDATE' then old.nova_data end, left(new.observacao, 1000), new.nova_data_fonte, new.atualizado_por);
  end if;
  return new;
end $$;
drop trigger if exists log_retorno on public.tratativas;
create trigger log_retorno after insert or update on public.tratativas for each row execute function public._log_retorno();

-- resumo por pedido (últimos 60 dias): quantos retornos, quantas promessas quebradas (nova data trocada depois de já ter passado), primeiro e último retorno
create or replace function public.resumo_retornos() returns table (pedido text, retornos integer, quebradas integer, primeiro timestamptz, ultimo timestamptz)
language sql stable security invoker set search_path = public as $$
  select h.pedido, count(*)::int, count(*) filter (where h.nova_data_antes is not null and h.nova_data_antes < (h.feito_em at time zone 'America/Sao_Paulo')::date and h.nova_data is distinct from h.nova_data_antes)::int,
         min(h.feito_em), max(h.feito_em)
  from public.retornos_hist h where h.feito_em > now() - interval '60 days' group by h.pedido;
$$;
revoke all on function public.resumo_retornos() from public, anon;
grant execute on function public.resumo_retornos() to authenticated;


-- ============ PARTE 41: Carregar planilha sem estourar o tempo do banco ============
create or replace function public.importar_base(linhas jsonb, limpar boolean, arquivo text, total integer)
returns integer
language plpgsql security definer set search_path = public
set statement_timeout = '120s'
as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if limpar then
    truncate public.base_pedidos;   -- bem mais rápido que delete (era o que estourava o tempo)
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
    dias_atraso = excluded.dias_atraso, status_prazo = excluded.status_prazo, sem_expedicao = excluded.sem_expedicao,
    extra = excluded.extra;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.importar_base(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_base(jsonb, boolean, text, integer) to authenticated;

-- ============ PARTE 42: Carregar planilha mais rápido (só manda o que mudou, em formato de colunas) ============
alter table public.base_pedidos add column if not exists h text;   -- "impressão digital" da linha, calculada no navegador
-- lista pedido + impressão digital (para o navegador saber o que mudou)
create or replace function public.base_hashes()
returns jsonb language sql stable security invoker set search_path = public
set statement_timeout = '60s'
as $$ select coalesce(jsonb_agg(jsonb_build_array(pedido, h)), '[]'::jsonb) from public.base_pedidos $$;
revoke all on function public.base_hashes() from public, anon;
grant execute on function public.base_hashes() to authenticated;
-- grava um lote: cols = nomes das colunas (as que começam com "x:" vão para "extra"), linhas = [[valores], ...],
-- hs = impressão digital de cada linha, remover = pedidos que não estão mais na planilha, fim = último lote (atualiza base_info)
create or replace function public.importar_base_c(cols text[], linhas jsonb, hs text[], remover text[], fim boolean, arquivo text, total integer)
returns integer language plpgsql security definer set search_path = public
set statement_timeout = '120s'
as $$
declare n integer := 0;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if public.e_sac() then raise exception 'O login do SAC só consulta.'; end if;
  if remover is not null and cardinality(remover) > 0 then
    delete from public.base_pedidos where pedido = any(remover);
  end if;
  if linhas is not null and jsonb_array_length(linhas) > 0 then
    insert into public.base_pedidos
    select (jsonb_populate_record(null::public.base_pedidos,
              coalesce(a.base, '{}'::jsonb) || jsonb_build_object('extra', coalesce(a.ex, '{}'::jsonb), 'h', hs[l.i]))).*
    from jsonb_array_elements(linhas) with ordinality as l(r, i)
    cross join lateral (
      select jsonb_object_agg(c.nome, l.r -> (c.j::int - 1)) filter (where c.nome not like 'x:%') as base,
             jsonb_object_agg(substr(c.nome, 3), l.r -> (c.j::int - 1)) filter (where c.nome like 'x:%' and jsonb_typeof(l.r -> (c.j::int - 1)) not in ('null')) as ex
      from unnest(cols) with ordinality as c(nome, j)
    ) a
    where coalesce(l.r ->> 0, '') <> ''
    on conflict (pedido) do update set
      nf = excluded.nf, canal = excluded.canal, origem = excluded.origem, transportadora = excluded.transportadora,
      micro_status = excluded.micro_status, status_intelipost = excluded.status_intelipost, descricao = excluded.descricao,
      ultima_atualizacao = excluded.ultima_atualizacao, data_expedicao = excluded.data_expedicao,
      prev_original = excluded.prev_original, prev_atual = excluded.prev_atual, prev_360 = excluded.prev_360,
      comentario_360 = excluded.comentario_360, uf = excluded.uf, cidade = excluded.cidade, ocorrencia = excluded.ocorrencia,
      qtd_tickets = excluded.qtd_tickets, motivo_ticket = excluded.motivo_ticket, link_rastreio = excluded.link_rastreio,
      data_criacao = excluded.data_criacao, data_entrega = excluded.data_entrega, range_atrasos = excluded.range_atrasos,
      dias_atraso = excluded.dias_atraso, status_prazo = excluded.status_prazo, sem_expedicao = excluded.sem_expedicao,
      extra = excluded.extra, h = excluded.h;
    get diagnostics n = row_count;
  end if;
  if fim then
    insert into public.base_info (id, arquivo, total, enviado_por, enviado_em)
    values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, total = excluded.total,
      enviado_por = excluded.enviado_por, enviado_em = excluded.enviado_em;
  end if;
  return n;
end $$;
revoke all on function public.importar_base_c(text[], jsonb, text[], text[], boolean, text, integer) from public, anon;
grant execute on function public.importar_base_c(text[], jsonb, text[], text[], boolean, text, integer) to authenticated;

-- ============ PARTE 43: Cobrança do dia — retornos padronizados (palavras → categoria) com responsável ============
create table if not exists public.retorno_regras (
  categoria      text primary key,
  palavras       text[] not null default '{}',
  responsavel_id bigint references public.pessoas_responsaveis(id) on delete set null,
  ordem          integer not null default 0,
  atualizado_por text,
  atualizado_em  timestamptz not null default now()
);
alter table public.retorno_regras enable row level security;
revoke all on public.retorno_regras from anon;
grant select, insert, update, delete on public.retorno_regras to authenticated;
drop policy if exists "logistica cuida" on public.retorno_regras;
create policy "logistica cuida" on public.retorno_regras for all to authenticated
  using ((select not public.e_sac())) with check ((select not public.e_sac()));
drop trigger if exists carimbo on public.retorno_regras;
create trigger carimbo before insert or update on public.retorno_regras
  for each row execute function public._carimbo_responsavel();

-- ============ PARTE 44: abas que cada login pode usar ============
-- Sem linha (ou paginas nulo) = todas as abas. Só os administradores (admins_painel) mudam.
create table if not exists public.acessos_paginas (
  email          text primary key,
  paginas        text[],
  atualizado_por text,
  atualizado_em  timestamptz not null default now()
);
alter table public.acessos_paginas enable row level security;
revoke all on public.acessos_paginas from anon, authenticated;

-- cada pessoa lê só as abas dela
create or replace function public.meu_acesso()
returns text[] language sql stable security definer set search_path = public
as $$ select paginas from public.acessos_paginas where email = lower(auth.jwt() ->> 'email') $$;
revoke all on function public.meu_acesso() from public, anon;
grant execute on function public.meu_acesso() to authenticated;

-- administrador lê de todos
create or replace function public.listar_acessos()
returns table(email text, paginas text[]) language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.e_admin() then raise exception 'sem permissão'; end if;
  return query select a.email, a.paginas from public.acessos_paginas a;
end $$;
revoke all on function public.listar_acessos() from public, anon;
grant execute on function public.listar_acessos() to authenticated;

-- administrador grava (p_paginas nulo = todas as abas)
create or replace function public.salvar_acesso(p_email text, p_paginas text[])
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.e_admin() then raise exception 'sem permissão'; end if;
  if p_paginas is null then
    delete from public.acessos_paginas where email = lower(trim(p_email));
  else
    insert into public.acessos_paginas (email, paginas, atualizado_por, atualizado_em)
    values (lower(trim(p_email)), p_paginas, auth.jwt() ->> 'email', now())
    on conflict (email) do update set paginas = excluded.paginas, atualizado_por = excluded.atualizado_por, atualizado_em = now();
  end if;
end $$;
revoke all on function public.salvar_acesso(text, text[]) from public, anon;
grant execute on function public.salvar_acesso(text, text[]) to authenticated;

-- ============ PARTE 45: Scallia — retorno dos pedidos (webhook: faturado, coletado, entregue, cancelado) ============
-- Uma linha por pedido × marco (o Scallia manda cada marco uma vez). Só número/série/chave da NF, transportadora e data.
create table if not exists public.scallia_eventos (
  pedido         text not null default '',
  marco          text not null,
  nf             text,
  serie          text,
  chave          text,
  transportadora text,
  data_evento    timestamptz,
  recebido_em    timestamptz not null default now(),
  primary key (pedido, marco, nf)
);
alter table public.scallia_eventos alter column nf set default '';
create index if not exists scallia_eventos_nf on public.scallia_eventos (nf, serie);
alter table public.scallia_eventos enable row level security;
revoke all on public.scallia_eventos from anon;
grant select on public.scallia_eventos to authenticated;
drop policy if exists "logados leem" on public.scallia_eventos;
create policy "logados leem" on public.scallia_eventos for select to authenticated using ((select not public.e_sac()));

-- só a função do webhook (service_role) grava
create or replace function public.receber_scallia(linhas jsonb)
returns integer language plpgsql volatile security definer set search_path = public
as $$
declare n integer;
begin
  insert into public.scallia_eventos (pedido, marco, nf, serie, chave, transportadora, data_evento)
  select distinct on (1, 2, 3) * from (
    select coalesce(nullif(x->>'pedido',''), '') p, coalesce(nullif(x->>'marco',''), 'desconhecido') m, coalesce(nullif(x->>'nf',''), '') n,
           nullif(x->>'serie','') s, nullif(x->>'chave','') c, nullif(x->>'transportadora','') t, nullif(x->>'data_evento','')::timestamptz d
    from jsonb_array_elements(linhas) x) z
  on conflict (pedido, marco, nf) do update set serie = coalesce(excluded.serie, scallia_eventos.serie), chave = coalesce(excluded.chave, scallia_eventos.chave),
    transportadora = coalesce(excluded.transportadora, scallia_eventos.transportadora), data_evento = coalesce(excluded.data_evento, scallia_eventos.data_evento), recebido_em = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.receber_scallia(jsonb) from public, anon, authenticated;
grant execute on function public.receber_scallia(jsonb) to service_role;

-- ============ PARTE 46: cópia compartilhada da base (abre mais rápido para todos) ============
-- Pasta privada "copias" no Storage: o 1º login que abre o painel depois de um envio guarda um arquivo
-- compactado com a base; os outros baixam só esse arquivo. Só logins da Logística (SAC não usa).
insert into storage.buckets (id, name, public)
values ('copias', 'copias', false)
on conflict (id) do update set public = false;

drop policy if exists "copias ler" on storage.objects;
drop policy if exists "copias gravar" on storage.objects;
drop policy if exists "copias trocar" on storage.objects;
drop policy if exists "copias apagar" on storage.objects;
create policy "copias ler" on storage.objects for select to authenticated
  using (bucket_id = 'copias' and (select not public.e_sac()));
create policy "copias gravar" on storage.objects for insert to authenticated
  with check (bucket_id = 'copias' and (select not public.e_sac()));
create policy "copias trocar" on storage.objects for update to authenticated
  using (bucket_id = 'copias' and (select not public.e_sac()))
  with check (bucket_id = 'copias' and (select not public.e_sac()));
create policy "copias apagar" on storage.objects for delete to authenticated
  using (bucket_id = 'copias' and (select not public.e_sac()));

-- ============ PARTE 47: Reposição — coluna Grupo da tabela de acompanhamento (Logística, Sac, Faturamento, Projetos) ============
alter table public.reposicoes_tk add column if not exists grupo text;
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
  insert into public.reposicoes_tk (ticket, criado_em, criado_por, via, fila, tipo, motivo, status, transportadora, nf,
    filial, responsavel, atualizado_em, finalizado_em, tempo_resolucao, estagnada, transp_final, transp_redesp, pedido, valor_pedido, grupo)
  select r.ticket, r.criado_em, r.criado_por, r.via, r.fila, r.tipo, r.motivo, r.status, r.transportadora, r.nf,
    r.filial, r.responsavel, r.atualizado_em, r.finalizado_em, r.tempo_resolucao, r.estagnada, r.transp_final, r.transp_redesp, r.pedido, r.valor_pedido, r.grupo
  from jsonb_to_recordset(linhas) as r(ticket text, criado_em timestamp, criado_por text, via text, fila text, tipo text,
    motivo text, status text, transportadora text, nf text, filial text, responsavel text, atualizado_em timestamp,
    finalizado_em timestamp, tempo_resolucao numeric, estagnada text, transp_final text, transp_redesp text, pedido text, valor_pedido numeric, grupo text)
  where r.ticket is not null and r.ticket <> ''
  on conflict (ticket) do update set criado_em = excluded.criado_em, criado_por = excluded.criado_por, via = excluded.via,
    fila = excluded.fila, tipo = excluded.tipo, motivo = excluded.motivo, status = excluded.status,
    transportadora = excluded.transportadora, nf = excluded.nf, filial = excluded.filial, responsavel = excluded.responsavel,
    atualizado_em = excluded.atualizado_em, finalizado_em = excluded.finalizado_em, tempo_resolucao = excluded.tempo_resolucao,
    estagnada = excluded.estagnada, transp_final = excluded.transp_final, transp_redesp = excluded.transp_redesp,
    pedido = excluded.pedido, valor_pedido = excluded.valor_pedido, grupo = excluded.grupo;
  return (select count(*) from public.reposicoes_tk);
end $$;
revoke all on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) to authenticated;

-- ============================================================
-- PARTE 48) Reposição: itens/volumes de cada ticket (robô lê o Multi360) + cadastro de volumes (planilha "VOLUMES JADLOG")
create table if not exists public.volumes_cad (
  codigo        text primary key,          -- ex.: 76157.0001
  descricao     text,
  atualizado_em timestamptz default now()
);
create table if not exists public.repo_itens_tk (     -- um registro por ticket lido
  ticket        text primary key,
  lido_em       timestamptz not null default now(),
  fila          text,                      -- fila na hora da leitura
  eventos_ok    boolean,                   -- achou o quadro Reposição em Eventos
  volumes       integer,                   -- "N Volumes" do quadro
  parcial       text,                      -- Parcial / Total
  quando        text,                      -- Antes / Depois da entrega
  pdf_ok        boolean,                   -- leu o PDF da nota (pré-entrega)
  dest_doc      text,                      -- cpf / cnpj (nunca o número nem o nome)
  cobrado_transp text,                     -- transportadora cobrada (CNPJ de transportadora no destinatário)
  erro          text
);
create table if not exists public.repo_itens (        -- um registro por volume do ticket
  ticket  text not null,
  codigo  text not null,
  fonte   text not null default 'eventos',  -- eventos / pdf
  primary key (ticket, codigo)
);
alter table public.volumes_cad enable row level security;
alter table public.repo_itens_tk enable row level security;
alter table public.repo_itens enable row level security;
revoke all on public.volumes_cad, public.repo_itens_tk, public.repo_itens from anon;
grant select, insert, update, delete on public.volumes_cad, public.repo_itens_tk, public.repo_itens to authenticated;
drop policy if exists "logistica le" on public.volumes_cad;
drop policy if exists "logistica grava" on public.volumes_cad;
drop policy if exists "logistica le" on public.repo_itens_tk;
drop policy if exists "logistica grava" on public.repo_itens_tk;
drop policy if exists "logistica le" on public.repo_itens;
drop policy if exists "logistica grava" on public.repo_itens;
create policy "logistica le" on public.volumes_cad for select to authenticated using ((select not public.e_sac()));
create policy "logistica grava" on public.volumes_cad for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));
create policy "logistica le" on public.repo_itens_tk for select to authenticated using ((select not public.e_sac()));
create policy "logistica grava" on public.repo_itens_tk for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));
create policy "logistica le" on public.repo_itens for select to authenticated using ((select not public.e_sac()));
create policy "logistica grava" on public.repo_itens for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));

-- robô lê os tickets em Aguardando entrega 2x por dia (08:00 e 14:00 de Brasília)
create or replace function public._robo_repo_itens()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"repo-itens","auto":"1"}}'::jsonb);
  end if;
end $$;
revoke all on function public._robo_repo_itens() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'robo-repo-itens';
select cron.schedule('robo-repo-itens', '0 11,17 * * *', 'select public._robo_repo_itens()');

-- ============================================================
-- PARTE 49) Barrar entrega: planilha de tickets "Barrar entrega" + conferência do robô (rastreio e portal) + decisão da Logística
create table if not exists public.barrar_entrega (
  nf              text primary key,      -- "1070-35"
  ticket          text,
  transp_pedido   text,                  -- redespacho Promob, senão transportador Promob
  status_intelipost text,
  ticket_criado   timestamp,
  na_planilha     boolean not null default true,
  rastreio        jsonb,                 -- {situacao, fonte, evento, data_evento, transp, achou_palavra}
  portal          jsonb,                 -- {achou, transp, prazo, anotacao, anotacao_por, anotacao_em}
  mesma_transp    boolean,
  sugestao        text,                  -- barrar / nao_barrar / manual
  sugestao_opcao  text,
  sugestao_motivo text,
  conferido_em    timestamptz,
  decisao         text,                  -- barrar / nao_barrar (aprovado por alguém da Logística)
  decisao_opcao   text,
  decisao_motivo  text,
  decisao_por     text,
  decisao_em      timestamptz,
  portal_status   text,                  -- feito / erro
  portal_msg      text,
  portal_em       timestamptz,
  print_path      text                   -- print da anotação (bucket "barrar")
  ,print_rastreio  text                   -- print do rastreio (bucket "barrar")
  ,ticket_status   text                   -- prints no ticket do Multi360: feito / erro
  ,ticket_msg      text
  ,ticket_em       timestamptz
);
create table if not exists public.barrar_info (
  id integer primary key default 1 check (id = 1), arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
alter table public.barrar_entrega enable row level security;
alter table public.barrar_info enable row level security;
revoke all on public.barrar_entrega, public.barrar_info from anon;
grant select, insert, update, delete on public.barrar_entrega, public.barrar_info to authenticated;
drop policy if exists "logistica cuida" on public.barrar_entrega;
drop policy if exists "logistica cuida" on public.barrar_info;
create policy "logistica cuida" on public.barrar_entrega for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));
create policy "logistica cuida" on public.barrar_info for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));

-- planilha nova: quem saiu da planilha fica fora (na_planilha=false); o que o robô e as pessoas já fizeram fica guardado
create or replace function public.importar_barrar(linhas jsonb, arquivo text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.barrar_entrega set na_planilha = false where na_planilha is true;
  insert into public.barrar_entrega (nf, ticket, transp_pedido, status_intelipost, ticket_criado, na_planilha)
  select x->>'nf', x->>'ticket', x->>'transp_pedido', x->>'status_intelipost', nullif(x->>'ticket_criado','')::timestamp, true
  from jsonb_array_elements(linhas) x where coalesce(x->>'nf','') <> ''
  on conflict (nf) do update set ticket = excluded.ticket, transp_pedido = excluded.transp_pedido,
    status_intelipost = excluded.status_intelipost, ticket_criado = excluded.ticket_criado, na_planilha = true;
  get diagnostics n = row_count;
  insert into public.barrar_info (id, arquivo, linhas, enviado_por, enviado_em) values (1, arquivo, n, auth.jwt() ->> 'email', now())
  on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  return n;
end $$;
revoke all on function public.importar_barrar(jsonb, text) from public, anon;
grant execute on function public.importar_barrar(jsonb, text) to authenticated;

-- botões do painel: "Conferir agora" (modo barrar) e "Mandar para o portal" (modo barrar-portal)
create or replace function public.rodar_robo_barrar(modo text)
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if modo not in ('barrar', 'barrar-portal') then raise exception 'Modo inválido.'; end if;
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is null then raise exception 'Falta o token do robô no Supabase (github_robo_token).'; end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                  'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('modo', modo)));
end $$;
revoke all on function public.rodar_robo_barrar(text) from public, anon;
grant execute on function public.rodar_robo_barrar(text) to authenticated;

-- prints das anotações (privado; só a Logística)
insert into storage.buckets (id, name, public) values ('barrar', 'barrar', false) on conflict (id) do nothing;
drop policy if exists "barrar ler" on storage.objects;
drop policy if exists "barrar gravar" on storage.objects;
drop policy if exists "barrar trocar" on storage.objects;
create policy "barrar ler" on storage.objects for select to authenticated using (bucket_id = 'barrar' and (select not public.e_sac()));
create policy "barrar gravar" on storage.objects for insert to authenticated with check (bucket_id = 'barrar' and (select not public.e_sac()));
create policy "barrar trocar" on storage.objects for update to authenticated using (bucket_id = 'barrar' and (select not public.e_sac()));
-- PARTE 50) Reposições › Falta de volumes: planilha de tickets + robô que olha se a transportadora retornou
--   (no ticket do Multi360: mensagens "Externo" enviadas pelo portal do transportador; no portal: anotações em Reposições › Faltas / Inversões)
create table if not exists public.falta_volumes (
  ticket          text primary key,
  nf              text,                  -- "615-35"
  transp          text,                  -- redespacho se houver, senão a transportadora (da planilha)
  motivo          text,                  -- motivo do ticket (planilha; se vazio, o robô lê no ticket)
  fila            text,
  ticket_criado   timestamp,
  na_planilha     boolean not null default true,
  retorno_360     jsonb,                 -- [{quando, texto}] mensagens da transportadora no ticket (sem o nome de quem escreveu)
  portal          jsonb,                 -- {achou, transp, solicitado, prazo, anotacoes:[{quando, texto}]}
  motivo_ticket   text,
  tem_retorno     boolean,
  ultimo_retorno_em timestamptz,
  conferido_em    timestamptz,
  erro            text
);
create table if not exists public.falta_volumes_info (
  id integer primary key default 1 check (id = 1), arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
alter table public.falta_volumes enable row level security;
alter table public.falta_volumes_info enable row level security;
revoke all on public.falta_volumes, public.falta_volumes_info from anon;
grant select, insert, update, delete on public.falta_volumes, public.falta_volumes_info to authenticated;
drop policy if exists "logistica cuida" on public.falta_volumes;
drop policy if exists "logistica cuida" on public.falta_volumes_info;
create policy "logistica cuida" on public.falta_volumes for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));
create policy "logistica cuida" on public.falta_volumes_info for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));

create or replace function public.importar_faltas(linhas jsonb, arquivo text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.falta_volumes set na_planilha = false where na_planilha is true;
  insert into public.falta_volumes (ticket, nf, transp, motivo, fila, ticket_criado, na_planilha)
  select x->>'ticket', nullif(x->>'nf',''), nullif(x->>'transp',''), nullif(x->>'motivo',''), nullif(x->>'fila',''), nullif(x->>'ticket_criado','')::timestamp, true
  from jsonb_array_elements(linhas) x where coalesce(x->>'ticket','') <> ''
  on conflict (ticket) do update set nf = coalesce(excluded.nf, falta_volumes.nf), transp = coalesce(excluded.transp, falta_volumes.transp),
    motivo = coalesce(excluded.motivo, falta_volumes.motivo), fila = excluded.fila, ticket_criado = coalesce(excluded.ticket_criado, falta_volumes.ticket_criado), na_planilha = true;
  get diagnostics n = row_count;
  insert into public.falta_volumes_info (id, arquivo, linhas, enviado_por, enviado_em) values (1, arquivo, n, auth.jwt() ->> 'email', now())
  on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  return n;
end $$;
revoke all on function public.importar_faltas(jsonb, text) from public, anon;
grant execute on function public.importar_faltas(jsonb, text) to authenticated;

-- botão "Conferir retornos agora" (modo faltas) — mesmo token do robô
create or replace function public.rodar_robo_faltas()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is null then raise exception 'Falta o token do robô no Supabase (github_robo_token).'; end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                  'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('modo', 'faltas')));
end $$;
revoke all on function public.rodar_robo_faltas() from public, anon;
grant execute on function public.rodar_robo_faltas() to authenticated;
-- PARTE 51) Preventivo · Fase 1: memória dos pedidos (pedido_mudancas), feriados, dias úteis e tempos reais de entrega
-- Nada do que existe muda: só acrescenta tabelas, gatilhos que ANOTAM mudanças e uma função de cálculo.

-- 1) Memória: uma linha cada vez que um campo de um pedido muda (nunca apaga, nunca altera)
create table if not exists public.pedido_mudancas (
  id      bigserial primary key,
  pedido  text not null,
  campo   text not null,      -- micro_status, status_intelipost, prev_atual, transportadora, redespacho, data_expedicao, emissao_cte, data_entrega, previsao_transp (SSW), previsao_rastreio, evento_transp, situacao_transp
  antes   text,
  depois  text,
  fonte   text,               -- base | ssw | rastreio:<fonte>
  quando  timestamptz not null default now()
);
create index if not exists pedido_mudancas_pc on public.pedido_mudancas (pedido, campo, quando desc);
create index if not exists pedido_mudancas_q on public.pedido_mudancas (quando);
alter table public.pedido_mudancas enable row level security;
revoke all on public.pedido_mudancas from anon;
grant select on public.pedido_mudancas to authenticated;
drop policy if exists "logistica le" on public.pedido_mudancas;
create policy "logistica le" on public.pedido_mudancas for select to authenticated using ((select not public.e_sac()));

create or replace function public._pm_anota(p text, c text, a text, d text, f text, novo boolean)
returns void language plpgsql security definer set search_path = public as $$
declare ult text;
begin
  if p is null then return; end if;
  if novo then   -- linha nova (pedido novo ou base recarregada do zero): compara com o último valor anotado
    select m.depois into ult from public.pedido_mudancas m where m.pedido = p and m.campo = c order by m.quando desc, m.id desc limit 1;
    if found and ult is not distinct from d then return; end if;
    if not found and d is null then return; end if;
    a := ult;
  elsif a is not distinct from d then return; end if;
  insert into public.pedido_mudancas (pedido, campo, antes, depois, fonte) values (p, c, a, d, f);
end $$;
revoke all on function public._pm_anota(text, text, text, text, text, boolean) from public, anon, authenticated;

create or replace function public._pm_base() returns trigger language plpgsql security definer set search_path = public as $$
declare novo boolean := tg_op = 'INSERT';
begin
  perform public._pm_anota(new.pedido, 'micro_status',      case when novo then null else old.micro_status end, new.micro_status, 'base', novo);
  perform public._pm_anota(new.pedido, 'status_intelipost', case when novo then null else old.status_intelipost end, new.status_intelipost, 'base', novo);
  perform public._pm_anota(new.pedido, 'prev_atual',        case when novo then null else old.prev_atual::text end, new.prev_atual::text, 'base', novo);
  perform public._pm_anota(new.pedido, 'transportadora',    case when novo then null else old.transportadora end, new.transportadora, 'base', novo);
  perform public._pm_anota(new.pedido, 'redespacho',        case when novo then null else nullif(old.extra->>'redespacho', '') end, nullif(new.extra->>'redespacho', ''), 'base', novo);
  perform public._pm_anota(new.pedido, 'data_expedicao',    case when novo then null else old.data_expedicao::text end, new.data_expedicao::text, 'base', novo);
  perform public._pm_anota(new.pedido, 'emissao_cte',       case when novo then null else nullif(old.extra->>'emissao_cte', '') end, nullif(new.extra->>'emissao_cte', ''), 'base', novo);
  perform public._pm_anota(new.pedido, 'data_entrega',      case when novo then null else old.data_entrega::text end, new.data_entrega::text, 'base', novo);
  return null;
end $$;
drop trigger if exists pm_base on public.base_pedidos;
create trigger pm_base after insert or update on public.base_pedidos for each row execute function public._pm_base();

create or replace function public._pm_ssw() returns trigger language plpgsql security definer set search_path = public as $$
declare novo boolean := tg_op = 'INSERT';
begin
  if new.previsao is not null then
    perform public._pm_anota(new.pedido, 'previsao_transp', case when novo then null else old.previsao::text end, new.previsao::text, 'ssw', novo);
  end if;
  return null;
end $$;
drop trigger if exists pm_ssw on public.previsao_ssw;
create trigger pm_ssw after insert or update on public.previsao_ssw for each row execute function public._pm_ssw();

create or replace function public._pm_conf() returns trigger language plpgsql security definer set search_path = public as $$
declare novo boolean := tg_op = 'INSERT'; f text := 'rastreio:' || coalesce(new.detalhe->>'fonte', 'ssw');
begin
  perform public._pm_anota(new.pedido, 'evento_transp',
    case when novo then null else nullif(concat_ws(' @ ', old.ultimo_evento, old.data_evento::text), '') end,
    nullif(concat_ws(' @ ', new.ultimo_evento, new.data_evento::text), ''), f, novo);
  perform public._pm_anota(new.pedido, 'situacao_transp', case when novo then null else old.situacao end, new.situacao, f, novo);
  if new.detalhe->>'previsao' is not null then
    perform public._pm_anota(new.pedido, 'previsao_rastreio', case when novo then null else old.detalhe->>'previsao' end, new.detalhe->>'previsao', f, novo);
  end if;
  return null;
end $$;
drop trigger if exists pm_conf on public.conferencia_ssw;
create trigger pm_conf after insert or update on public.conferencia_ssw for each row execute function public._pm_conf();

-- ponto de partida: o micro status atual de cada pedido em aberto, com a data da última atualização na Intelipost (só uma vez)
insert into public.pedido_mudancas (pedido, campo, antes, depois, fonte, quando)
select b.pedido, 'micro_status', null, b.micro_status, 'inicial', coalesce(b.ultima_atualizacao::timestamptz, now())
from public.base_pedidos b
where b.micro_status is not null and coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
  and not exists (select 1 from public.pedido_mudancas m where m.pedido = b.pedido and m.campo = 'micro_status');

-- 2) Feriados (nacional: uf = ''; estadual: uf; municipal: uf + cidade em maiúsculas sem acento)
create table if not exists public.feriados (
  data   date not null,
  uf     text not null default '',
  cidade text not null default '',
  nome   text,
  primary key (data, uf, cidade)
);
alter table public.feriados enable row level security;
revoke all on public.feriados from anon;
grant select, insert, update, delete on public.feriados to authenticated;
drop policy if exists "todos leem" on public.feriados;
drop policy if exists "logistica cuida" on public.feriados;
create policy "todos leem" on public.feriados for select to authenticated using (true);
create policy "logistica cuida" on public.feriados for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));
insert into public.feriados (data, uf, cidade, nome) values
  ('2026-01-01','','','Confraternização Universal'), ('2026-02-16','','','Carnaval'), ('2026-02-17','','','Carnaval'), ('2026-04-03','','','Sexta-feira Santa'),
  ('2026-04-21','','','Tiradentes'), ('2026-05-01','','','Dia do Trabalho'), ('2026-06-04','','','Corpus Christi'), ('2026-09-07','','','Independência'),
  ('2026-10-12','','','Nossa Senhora Aparecida'), ('2026-11-02','','','Finados'), ('2026-11-15','','','Proclamação da República'), ('2026-11-20','','','Consciência Negra'),
  ('2026-12-25','','','Natal'),
  ('2027-01-01','','','Confraternização Universal'), ('2027-02-08','','','Carnaval'), ('2027-02-09','','','Carnaval'), ('2027-03-26','','','Sexta-feira Santa'),
  ('2027-04-21','','','Tiradentes'), ('2027-05-01','','','Dia do Trabalho'), ('2027-05-27','','','Corpus Christi'), ('2027-09-07','','','Independência'),
  ('2027-10-12','','','Nossa Senhora Aparecida'), ('2027-11-02','','','Finados'), ('2027-11-15','','','Proclamação da República'), ('2027-11-20','','','Consciência Negra'),
  ('2027-12-25','','','Natal'),
  ('2026-07-09','SP','','Revolução Constitucionalista'), ('2027-07-09','SP','','Revolução Constitucionalista'),
  ('2026-04-23','RJ','','São Jorge'), ('2027-04-23','RJ','','São Jorge'),
  ('2026-07-02','BA','','Independência da Bahia'), ('2027-07-02','BA','','Independência da Bahia'),
  ('2026-09-20','RS','','Revolução Farroupilha'), ('2027-09-20','RS','','Revolução Farroupilha'),
  ('2026-03-25','CE','','Data Magna do Ceará'), ('2027-03-25','CE','','Data Magna do Ceará'),
  ('2026-12-19','PR','','Emancipação do Paraná'), ('2027-12-19','PR','','Emancipação do Paraná'),
  ('2026-09-05','AM','','Elevação do Amazonas'), ('2027-09-05','AM','','Elevação do Amazonas'),
  ('2026-08-15','PA','','Adesão do Pará'), ('2027-08-15','PA','','Adesão do Pará'),
  ('2026-01-25','SP','SAO PAULO','Aniversário de São Paulo'), ('2027-01-25','SP','SAO PAULO','Aniversário de São Paulo'),
  ('2026-01-20','RJ','RIO DE JANEIRO','São Sebastião'), ('2027-01-20','RJ','RIO DE JANEIRO','São Sebastião')
on conflict do nothing;

create or replace function public._sem_acento(t text) returns text language sql immutable as $$
  select upper(trim(translate(coalesce(t, ''), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')))
$$;
-- dias úteis entre a (exclusive) e b (inclusive), sem sábado, domingo e feriados do destino
create or replace function public.dias_uteis(a date, b date, uf text default '', cidade text default '')
returns integer language sql stable set search_path = public as $$
  select case when a is null or b is null then null
              when b < a then -(select count(*) from generate_series(b + 1, a, interval '1 day') g(d)
                                 where extract(isodow from g.d) < 6 and not exists (select 1 from public.feriados f where f.data = g.d::date and (f.uf = '' or (f.uf = upper(coalesce($3, '')) and (f.cidade = '' or f.cidade = public._sem_acento($4))))))::int
              else (select count(*) from generate_series(a + 1, b, interval '1 day') g(d)
                     where extract(isodow from g.d) < 6 and not exists (select 1 from public.feriados f where f.data = g.d::date and (f.uf = '' or (f.uf = upper(coalesce($3, '')) and (f.cidade = '' or f.cidade = public._sem_acento($4))))))::int end
$$;
grant execute on function public.dias_uteis(date, date, text, text) to authenticated;

-- 3) Tempos reais por transportadora efetiva (redespacho, senão transportadora) × UF × cidade, das entregas dos últimos 3 meses
create table if not exists public.tempos_referencia (
  trecho       text not null,     -- expedicao_entrega | cte_entrega | criacao_expedicao | expedicao_cte
  transp       text not null,
  uf           text not null default '',
  cidade       text not null default '',
  n            integer not null,
  p50          numeric, p80 numeric, p90 numeric, media numeric,
  no_prazo     numeric,           -- % entregue até a promessa original (só no trecho expedicao_entrega)
  periodo_de   date, periodo_ate date,
  calculado_em timestamptz not null default now(),
  primary key (trecho, transp, uf, cidade)
);
alter table public.tempos_referencia enable row level security;
revoke all on public.tempos_referencia from anon;
grant select on public.tempos_referencia to authenticated;
drop policy if exists "logistica le" on public.tempos_referencia;
create policy "logistica le" on public.tempos_referencia for select to authenticated using ((select not public.e_sac()));

create or replace function public._data_ok(t text) returns date language plpgsql immutable as $$
begin return case when t ~ '^\d{4}-\d{2}-\d{2}' then left(t, 10)::date else null end; exception when others then return null; end $$;
create or replace function public._transp_efetiva(t text, redesp text) returns text language sql immutable as $$
  select case when x ~* 'tempo\s*justo|^vm\M|vm transp' then 'VM TRANSPORTES / TEMPO JUSTO' else x end
  from (select upper(trim(coalesce(nullif(trim(coalesce(redesp, '')), ''), nullif(trim(coalesce(t, '')), ''), '(SEM TRANSPORTADORA)'))) as x) s
$$;

create or replace function public.recalcular_tempos()
returns integer language plpgsql security definer set search_path = public set statement_timeout = '300s' as $$
declare n integer; ate date := current_date; de date := current_date - 92;
begin
  if auth.uid() is not null and public.e_sac() then raise exception 'Sem permissão.'; end if;
  create temp table _ent on commit drop as
    select public._transp_efetiva(b.transportadora, b.extra->>'redespacho') as transp, coalesce(nullif(upper(trim(coalesce(b.uf, ''))), ''), '?') as uf, coalesce(nullif(public._sem_acento(b.cidade), ''), '?') as cidade,
           b.data_criacao, b.data_expedicao, public._data_ok(b.extra->>'emissao_cte') as cte, b.data_entrega, b.prev_original
    from public.base_pedidos b
    where b.data_entrega between de and ate and coalesce(b.status_intelipost, '') ilike 'entregue%';
  create temp table _t on commit drop as
    select 'expedicao_entrega'::text as trecho, transp, uf, cidade, public.dias_uteis(data_expedicao, data_entrega, uf, cidade) as d, (data_entrega <= prev_original) as ok from _ent where data_expedicao is not null and data_expedicao <= data_entrega
    union all select 'cte_entrega', transp, uf, cidade, public.dias_uteis(cte, data_entrega, uf, cidade), null from _ent where cte is not null and cte <= data_entrega
    union all select 'criacao_expedicao', transp, uf, cidade, public.dias_uteis(data_criacao, data_expedicao, uf, cidade), null from _ent where data_criacao is not null and data_expedicao is not null and data_criacao <= data_expedicao
    union all select 'expedicao_cte', transp, uf, cidade, public.dias_uteis(data_expedicao, cte, uf, cidade), null from _ent where data_expedicao is not null and cte is not null and data_expedicao <= cte;
  delete from public.tempos_referencia where true;
  insert into public.tempos_referencia (trecho, transp, uf, cidade, n, p50, p80, p90, media, no_prazo, periodo_de, periodo_ate, calculado_em)
  select trecho, transp, coalesce(uf, ''), coalesce(cidade, ''), count(*),
         round(percentile_cont(0.5) within group (order by d)::numeric, 1), round(percentile_cont(0.8) within group (order by d)::numeric, 1),
         round(percentile_cont(0.9) within group (order by d)::numeric, 1), round(avg(d)::numeric, 1),
         case when count(ok) > 0 then round(100.0 * count(*) filter (where ok) / count(ok), 1) end, de, ate, now()
  from _t group by grouping sets ((trecho, transp), (trecho, transp, uf), (trecho, transp, uf, cidade));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.recalcular_tempos() from public, anon;
grant execute on function public.recalcular_tempos() to authenticated;
-- recalcula todo dia às 06:30 (Brasília)
select cron.unschedule(jobid) from cron.job where jobname = 'tempos-referencia';
select cron.schedule('tempos-referencia', '30 9 * * *', 'select public.recalcular_tempos()');
select public.recalcular_tempos();

-- PARTE 52) Reposições › Filas atualizadas e ocorrências
--   filas_tk: tickets EM ABERTO da tabela de acompanhamento (todas as filas, não só reposição). Cada envio substitui o anterior.
--   fila_responsavel: quem cuida de cada fila (a Logística edita no painel; muda de um dia para o outro).
--   ocorrencias_tk: aba Ocorrências do detalhamento de tickets (ou a planilha de ocorrências). Cada envio substitui o anterior.
--   Nome de quem escreveu a última mensagem NÃO é guardado.
create table if not exists public.filas_tk (
  ticket        text primary key,
  nf            text,
  pedido        text,
  grupo         text,
  canal         text,
  fila          text,
  tipo          text,
  motivo        text,
  status        text,
  transportadora text,          -- redespacho, se houver; senão a final
  criado_em     timestamp,
  atualizado_em timestamp       -- Data da Última Atualização
);
create table if not exists public.filas_tk_info (
  id integer primary key default 1 check (id = 1), arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
create table if not exists public.fila_responsavel (
  fila          text primary key,
  responsavel   text,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
create table if not exists public.ocorrencias_tk (
  id            bigserial primary key,
  nf            text,
  transportador text,
  criado_em     timestamp,
  motivo        text,
  status        text,
  operacao      text,
  canal         text,
  solicitante   text,           -- Último Solicitante (Multimoveis / Transportador)
  mensagem      text,           -- Última Mensagem (até 500 letras)
  mensagem_em   timestamp,
  status_macro  text,
  status_micro  text,
  dias_arquivo  integer         -- "Dias sem atualização" da planilha, quando vier
);
create index if not exists ocorrencias_tk_nf on public.ocorrencias_tk (nf);
create table if not exists public.ocorrencias_tk_info (
  id integer primary key default 1 check (id = 1), arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
alter table public.filas_tk enable row level security;
alter table public.filas_tk_info enable row level security;
alter table public.fila_responsavel enable row level security;
alter table public.ocorrencias_tk enable row level security;
alter table public.ocorrencias_tk_info enable row level security;
revoke all on public.filas_tk, public.filas_tk_info, public.fila_responsavel, public.ocorrencias_tk, public.ocorrencias_tk_info from anon;
grant select on public.filas_tk, public.filas_tk_info, public.ocorrencias_tk, public.ocorrencias_tk_info to authenticated;
grant select, insert, update, delete on public.fila_responsavel to authenticated;
drop policy if exists "logistica le" on public.filas_tk;
drop policy if exists "logistica le" on public.filas_tk_info;
drop policy if exists "logistica le" on public.ocorrencias_tk;
drop policy if exists "logistica le" on public.ocorrencias_tk_info;
drop policy if exists "logistica cuida" on public.fila_responsavel;
create policy "logistica le" on public.filas_tk for select to authenticated using ((select not public.e_sac()));
create policy "logistica le" on public.filas_tk_info for select to authenticated using ((select not public.e_sac()));
create policy "logistica le" on public.ocorrencias_tk for select to authenticated using ((select not public.e_sac()));
create policy "logistica le" on public.ocorrencias_tk_info for select to authenticated using ((select not public.e_sac()));
create policy "logistica cuida" on public.fila_responsavel for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));

create or replace function public.importar_filas_tk(linhas jsonb, limpar boolean, arquivo text, total integer)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if limpar then
    delete from public.filas_tk where true;
    insert into public.filas_tk_info (id, arquivo, linhas, enviado_por, enviado_em) values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  end if;
  insert into public.filas_tk (ticket, nf, pedido, grupo, canal, fila, tipo, motivo, status, transportadora, criado_em, atualizado_em)
  select r.ticket, r.nf, r.pedido, r.grupo, r.canal, r.fila, r.tipo, r.motivo, r.status, r.transportadora, r.criado_em, r.atualizado_em
  from jsonb_to_recordset(linhas) as r(ticket text, nf text, pedido text, grupo text, canal text, fila text, tipo text, motivo text, status text,
                                       transportadora text, criado_em timestamp, atualizado_em timestamp)
  where coalesce(r.ticket, '') <> ''
  on conflict (ticket) do update set nf = excluded.nf, pedido = excluded.pedido, grupo = excluded.grupo, canal = excluded.canal, fila = excluded.fila,
    tipo = excluded.tipo, motivo = excluded.motivo, status = excluded.status, transportadora = excluded.transportadora,
    criado_em = excluded.criado_em, atualizado_em = excluded.atualizado_em;
  return (select count(*) from public.filas_tk);
end $$;
revoke all on function public.importar_filas_tk(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_filas_tk(jsonb, boolean, text, integer) to authenticated;

create or replace function public.importar_ocorrencias_tk(linhas jsonb, limpar boolean, arquivo text, total integer)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if limpar then
    delete from public.ocorrencias_tk where true;
    insert into public.ocorrencias_tk_info (id, arquivo, linhas, enviado_por, enviado_em) values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  end if;
  insert into public.ocorrencias_tk (nf, transportador, criado_em, motivo, status, operacao, canal, solicitante, mensagem, mensagem_em, status_macro, status_micro, dias_arquivo)
  select r.nf, r.transportador, r.criado_em, r.motivo, r.status, r.operacao, r.canal, r.solicitante, left(r.mensagem, 500), r.mensagem_em, r.status_macro, r.status_micro, r.dias_arquivo
  from jsonb_to_recordset(linhas) as r(nf text, transportador text, criado_em timestamp, motivo text, status text, operacao text, canal text, solicitante text,
                                       mensagem text, mensagem_em timestamp, status_macro text, status_micro text, dias_arquivo integer)
  where coalesce(r.nf, '') <> '';
  return (select count(*) from public.ocorrencias_tk);
end $$;
revoke all on function public.importar_ocorrencias_tk(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_ocorrencias_tk(jsonb, boolean, text, integer) to authenticated;

-- PARTE 53) Falta de volumes: data prometida pela transportadora + anotações da Logística, com histórico de cada alteração
alter table public.falta_volumes add column if not exists data_prometida date;
alter table public.falta_volumes add column if not exists anotacao text;
alter table public.falta_volumes add column if not exists editado_por text;
alter table public.falta_volumes add column if not exists editado_em timestamptz;

create table if not exists public.falta_volumes_hist (
  id      bigserial primary key,
  ticket  text not null,
  campo   text not null,     -- data_prometida | anotacao
  antes   text,
  depois  text,
  por     text,
  quando  timestamptz not null default now()
);
create index if not exists falta_volumes_hist_tk on public.falta_volumes_hist (ticket, quando desc);
alter table public.falta_volumes_hist enable row level security;
revoke all on public.falta_volumes_hist from anon;
grant select on public.falta_volumes_hist to authenticated;
drop policy if exists "logistica le" on public.falta_volumes_hist;
create policy "logistica le" on public.falta_volumes_hist for select to authenticated using ((select not public.e_sac()));

create or replace function public._fv_anota()
returns trigger language plpgsql security definer set search_path = public as $$
declare quem text := nullif(coalesce(auth.jwt() ->> 'email', ''), '');
begin
  if new.data_prometida is distinct from old.data_prometida then
    insert into public.falta_volumes_hist (ticket, campo, antes, depois, por) values (new.ticket, 'data_prometida', old.data_prometida::text, new.data_prometida::text, quem);
    new.editado_por := quem; new.editado_em := now();
  end if;
  if new.anotacao is distinct from old.anotacao then
    insert into public.falta_volumes_hist (ticket, campo, antes, depois, por) values (new.ticket, 'anotacao', old.anotacao, new.anotacao, quem);
    new.editado_por := quem; new.editado_em := now();
  end if;
  return new;
end $$;
drop trigger if exists fv_anota on public.falta_volumes;
create trigger fv_anota before update on public.falta_volumes for each row execute function public._fv_anota();

-- PARTE 54) Mantém viva a sessão do robô na Intelipost (a Intelipost derruba depois de 240 min sem uso e pede o código de novo).
-- De 2 em 2 horas o Supabase chama o robô no modo "manter": ele só abre a Intelipost com a sessão guardada e guarda de novo.
-- Se a sessão já tiver caído, ele NÃO pede código fora de hora: deixa um aviso no painel e o código é pedido no próximo envio.
create or replace function public._robo_intelipost_manter()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-intelipost.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"manter"}}'::jsonb);
  end if;
end $$;
revoke all on function public._robo_intelipost_manter() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'robo-intelipost-manter';
select cron.schedule('robo-intelipost-manter', '15 */2 * * *', 'select public._robo_intelipost_manter()');

-- PARTE 55) Fila Aguardando entrega (AE e AT): o robô roda SÓ quando alguém clica em "Rodar o robô agora".
-- Antes ele também era chamado sozinho ao subir o relatório. Agora subir o relatório só guarda os tickets.
drop trigger if exists chamar_robo_aguardando on public.aguardando_info;
create or replace function public.rodar_robo_aguardando()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is null then raise exception 'Falta o token do robô no Supabase (github_robo_token).'; end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                  'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
    body := '{"ref":"main","inputs":{"modo":"aguardando"}}'::jsonb);
end $$;
revoke all on function public.rodar_robo_aguardando() from public, anon;
grant execute on function public.rodar_robo_aguardando() to authenticated;

-- ============================================================
-- PARTE 56) Consulta SAC mais rápida: a consulta antiga passava do tempo (statement timeout) e a tela ficava em "Carregando…".
--   Filtra primeiro (vencidos, hoje e amanhã), calcula a chave da nota só desses e devolve tudo numa chamada só.
create or replace function public.consultar_sac_json()
returns jsonb language sql stable security definer set search_path = public
as $$
  with lim as (select (now() at time zone 'America/Sao_Paulo')::date + 1 as d),
  x as materialized (
    select b.pedido, b.nf, b.canal, b.transportadora, b.micro_status, coalesce(b.prev_original, b.prev_atual) as prometido,
           t.nova_data, t.observacao, t.atualizado_em, b.link_rastreio
    from public.base_pedidos b
    left join public.tratativas t on t.pedido = b.pedido
    cross join lim
    where auth.uid() is not null
      and (coalesce(b.prev_original, b.prev_atual) <= lim.d or t.nova_data <= lim.d)
  ),
  y as materialized (
    select x.*, public.chave_nf(x.nf) as k from x
    where not exists (select 1 from public.intelipost_fechados f where f.pedido = x.pedido)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'pedido', y.pedido, 'nf', y.nf, 'canal', y.canal, 'transportadora', y.transportadora, 'micro_status', y.micro_status,
           'prometido', y.prometido, 'nova_data', y.nova_data, 'observacao', y.observacao, 'atualizado_em', y.atualizado_em, 'link_rastreio', y.link_rastreio,
           'tem_ocorr', d.tem_ocorr, 'ocorr_status', d.ocorr_status, 'ocorr_msg', d.ocorr_msg, 'ocorr_em', d.ocorr_em,
           'tem_repo', d.tem_repo, 'repo_ticket', d.repo_ticket, 'repo_fila', d.repo_fila, 'repo_nf', d.repo_nf) order by y.pedido), '[]'::jsonb)
  from y left join public.detalhe_nf d on d.nf = y.k
$$;
revoke all on function public.consultar_sac_json() from public, anon;
grant execute on function public.consultar_sac_json() to authenticated;

-- ============================================================
-- PARTE 57) Consulta SAC: só pedidos EM ABERTO pela base (igual ao Preventivo: tira status Entregue/Cancelado da planilha base).
--   Sem esse filtro vinham também os entregues dos últimos meses (mais de 8 mil linhas) e a consulta passava do tempo.
create or replace function public.consultar_sac_json()
returns jsonb language sql stable security definer set search_path = public
as $$
  with lim as (select (now() at time zone 'America/Sao_Paulo')::date + 1 as d),
  x as materialized (
    select b.pedido, b.nf, b.canal, b.transportadora, b.micro_status, coalesce(b.prev_original, b.prev_atual) as prometido,
           t.nova_data, t.observacao, t.atualizado_em, b.link_rastreio
    from public.base_pedidos b
    left join public.tratativas t on t.pedido = b.pedido
    cross join lim
    where auth.uid() is not null
      and coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
      and (coalesce(b.prev_original, b.prev_atual) <= lim.d or t.nova_data <= lim.d)
  ),
  y as materialized (
    select x.*, public.chave_nf(x.nf) as k from x
    where not exists (select 1 from public.intelipost_fechados f where f.pedido = x.pedido)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'pedido', y.pedido, 'nf', y.nf, 'canal', y.canal, 'transportadora', y.transportadora, 'micro_status', y.micro_status,
           'prometido', y.prometido, 'nova_data', y.nova_data, 'observacao', y.observacao, 'atualizado_em', y.atualizado_em, 'link_rastreio', y.link_rastreio,
           'tem_ocorr', d.tem_ocorr, 'ocorr_status', d.ocorr_status, 'ocorr_msg', d.ocorr_msg, 'ocorr_em', d.ocorr_em,
           'tem_repo', d.tem_repo, 'repo_ticket', d.repo_ticket, 'repo_fila', d.repo_fila, 'repo_nf', d.repo_nf) order by y.pedido), '[]'::jsonb)
  from y left join public.detalhe_nf d on d.nf = y.k
$$;
revoke all on function public.consultar_sac_json() from public, anon;
grant execute on function public.consultar_sac_json() to authenticated;

-- versão antiga (o painel usa se a nova faltar), com o mesmo filtro
drop function if exists public.consultar_sac();
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
    and coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
    and not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido)
    -- SAC vê só os vencidos, os que vencem hoje e os que vencem amanhã
    and (coalesce(b.prev_original, b.prev_atual) <= (now() at time zone 'America/Sao_Paulo')::date + 1
         or t.nova_data <= (now() at time zone 'America/Sao_Paulo')::date + 1)
  order by b.pedido
$$;
revoke all on function public.consultar_sac() from public, anon;
grant execute on function public.consultar_sac() to authenticated;

-- ============================================================
-- PARTE 58) Consulta SAC em partes de 1000 pedidos (pela ordem do número do pedido, usando o índice).
--   Cada chamada é curta e não passa do tempo limite, mesmo com o banco ocupado pelos robôs.
create or replace function public.consultar_sac_pag(p_depois text default '')
returns table (pedido text, nf text, canal text, transportadora text, micro_status text,
               prometido date, nova_data date, observacao text, atualizado_em timestamptz, link_rastreio text,
               tem_ocorr boolean, ocorr_status text, ocorr_msg text, ocorr_em text, tem_repo boolean, repo_ticket text, repo_fila text, repo_nf text)
language sql stable security definer set search_path = public
as $$
  with x as materialized (
    select b.pedido, b.nf, b.canal, b.transportadora, b.micro_status, coalesce(b.prev_original, b.prev_atual) as prometido,
           t.nova_data, t.observacao, t.atualizado_em, b.link_rastreio
    from public.base_pedidos b
    left join public.tratativas t on t.pedido = b.pedido
    where auth.uid() is not null
      and b.pedido > coalesce(p_depois, '')
      and coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
      and (coalesce(b.prev_original, b.prev_atual) <= (now() at time zone 'America/Sao_Paulo')::date + 1
           or t.nova_data <= (now() at time zone 'America/Sao_Paulo')::date + 1)
      and not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido)
    order by b.pedido
    limit 1000
  )
  select x.pedido, x.nf, x.canal, x.transportadora, x.micro_status, x.prometido, x.nova_data, x.observacao, x.atualizado_em, x.link_rastreio,
         d.tem_ocorr, d.ocorr_status, d.ocorr_msg, d.ocorr_em, d.tem_repo, d.repo_ticket, d.repo_fila, d.repo_nf
  from x left join public.detalhe_nf d on d.nf = public.chave_nf(x.nf)
  order by x.pedido
$$;
revoke all on function public.consultar_sac_pag(text) from public, anon;
grant execute on function public.consultar_sac_pag(text) to authenticated;

-- ============================================================
-- PARTE 59) Consulta SAC rápida de verdade. O diagnóstico mostrou que o banco percorria ~50 mil pedidos já entregues
--   para achar os em aberto. Agora há um índice só dos pedidos em aberto pela data prometida, e a consulta parte dele
--   (e das tratativas com nova data), sem varrer a base inteira.
create index if not exists base_pedidos_sac_abertos on public.base_pedidos ((coalesce(prev_original, prev_atual)))
  where coalesce(status_intelipost, '') not ilike 'entregue%' and coalesce(status_intelipost, '') not ilike 'cancelado%';
create index if not exists tratativas_nova_data on public.tratativas (nova_data);

create or replace function public.consultar_sac_pag(p_depois text default '')
returns table (pedido text, nf text, canal text, transportadora text, micro_status text,
               prometido date, nova_data date, observacao text, atualizado_em timestamptz, link_rastreio text,
               tem_ocorr boolean, ocorr_status text, ocorr_msg text, ocorr_em text, tem_repo boolean, repo_ticket text, repo_fila text, repo_nf text)
language sql stable security definer set search_path = public
as $$
  with lim as (select (now() at time zone 'America/Sao_Paulo')::date + 1 as d),
  cand as (
    select b.pedido from public.base_pedidos b, lim
    where coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
      and coalesce(b.prev_original, b.prev_atual) <= lim.d
    union
    select t.pedido from public.tratativas t, lim where t.nova_data <= lim.d
  ),
  x as materialized (
    select b.pedido, b.nf, b.canal, b.transportadora, b.micro_status, coalesce(b.prev_original, b.prev_atual) as prometido,
           t.nova_data, t.observacao, t.atualizado_em, b.link_rastreio
    from cand c
    join public.base_pedidos b on b.pedido = c.pedido
    left join public.tratativas t on t.pedido = b.pedido
    where auth.uid() is not null
      and c.pedido > coalesce(p_depois, '')
      and coalesce(b.status_intelipost, '') not ilike 'entregue%' and coalesce(b.status_intelipost, '') not ilike 'cancelado%'
      and not exists (select 1 from public.intelipost_fechados f where f.pedido = b.pedido)
    order by b.pedido
    limit 1000
  )
  select x.pedido, x.nf, x.canal, x.transportadora, x.micro_status, x.prometido, x.nova_data, x.observacao, x.atualizado_em, x.link_rastreio,
         d.tem_ocorr, d.ocorr_status, d.ocorr_msg, d.ocorr_em, d.tem_repo, d.repo_ticket, d.repo_fila, d.repo_nf
  from x left join public.detalhe_nf d on d.nf = public.chave_nf(x.nf)
  order by x.pedido
$$;
revoke all on function public.consultar_sac_pag(text) from public, anon;
grant execute on function public.consultar_sac_pag(text) to authenticated;

-- ============================================================
-- PARTE 60) Dropshipping › pedidos desmembrados (um pedido com 2 notas).
--   Relatório paralelo (botão "Subir pedidos desmembrados" no Dropshipping): Ordem de Compra = Pedido Anymarket da base.
--   Cada envio substitui o anterior.
create table if not exists public.drop_desmembrados (
  id            bigserial primary key,
  ordem_compra  text not null,
  chave         text not null,      -- ordem de compra só com letras e números, em maiúsculas (para ligar com o Pedido Anymarket)
  nf            text,
  transportadora text,
  status        text,
  emissao       date
);
create index if not exists drop_desmembrados_chave on public.drop_desmembrados (chave);
create table if not exists public.drop_desmembrados_info (
  id integer primary key default 1 check (id = 1), arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
alter table public.drop_desmembrados enable row level security;
alter table public.drop_desmembrados_info enable row level security;
revoke all on public.drop_desmembrados, public.drop_desmembrados_info from anon;
grant select on public.drop_desmembrados, public.drop_desmembrados_info to authenticated;
drop policy if exists "logistica le" on public.drop_desmembrados;
drop policy if exists "logistica le" on public.drop_desmembrados_info;
create policy "logistica le" on public.drop_desmembrados for select to authenticated using ((select not public.e_sac()));
create policy "logistica le" on public.drop_desmembrados_info for select to authenticated using ((select not public.e_sac()));

create or replace function public.importar_desmembrados(linhas jsonb, limpar boolean, arquivo text, total integer)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if limpar then
    delete from public.drop_desmembrados where true;
    insert into public.drop_desmembrados_info (id, arquivo, linhas, enviado_por, enviado_em) values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  end if;
  insert into public.drop_desmembrados (ordem_compra, chave, nf, transportadora, status, emissao)
  select r.ordem_compra, r.chave, r.nf, r.transportadora, r.status, r.emissao
  from jsonb_to_recordset(linhas) as r(ordem_compra text, chave text, nf text, transportadora text, status text, emissao date)
  where coalesce(r.chave, '') <> '';
  return (select count(*) from public.drop_desmembrados);
end $$;
revoke all on function public.importar_desmembrados(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_desmembrados(jsonb, boolean, text, integer) to authenticated;


-- ============ PARTE 61: Falta de volumes · dias sem retorno contam da nossa última cobrança no 360 (Externo) ============
alter table public.falta_volumes add column if not exists cobrado_em timestamptz;   -- última mensagem "Externo" da nossa equipe no ticket
notify pgrst, 'reload schema';


-- ============ PARTE 62: Alterar pedidos · o robô da Intelipost só roda quando alguém clica em "Enviar para o robô" ============
-- Colocar pedidos na fila não chama mais o robô sozinho (a troca de notas continua chamando na hora).
drop trigger if exists chamar_robo_datas on public.fila_intelipost;

create or replace function public.rodar_robo_intelipost()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is null then raise exception 'Falta o token do robô no Supabase (github_robo_token).'; end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-intelipost.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                  'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
    body := '{"ref":"main","inputs":{"modo":"real"}}'::jsonb);
end $$;
revoke all on function public.rodar_robo_intelipost() from public, anon;
grant execute on function public.rodar_robo_intelipost() to authenticated;


-- ============ PARTE 63: Dropshipping · desmembrados no formato do relatório Consulta do Promob ============
-- Colunas novas: Pedido (Promob), Item, Descrição e Qtde. A nota passa a ser opcional (vem da base pelo Pedido Promob).
alter table public.drop_desmembrados add column if not exists pedido text;
alter table public.drop_desmembrados add column if not exists item text;
alter table public.drop_desmembrados add column if not exists descricao text;
alter table public.drop_desmembrados add column if not exists qtde numeric;

create or replace function public.importar_desmembrados(linhas jsonb, limpar boolean, arquivo text, total integer)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if limpar then
    delete from public.drop_desmembrados where true;
    insert into public.drop_desmembrados_info (id, arquivo, linhas, enviado_por, enviado_em) values (1, arquivo, total, auth.jwt() ->> 'email', now())
    on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  end if;
  insert into public.drop_desmembrados (ordem_compra, chave, nf, transportadora, status, emissao, pedido, item, descricao, qtde)
  select r.ordem_compra, r.chave, r.nf, r.transportadora, r.status, r.emissao, r.pedido, r.item, r.descricao, r.qtde
  from jsonb_to_recordset(linhas) as r(ordem_compra text, chave text, nf text, transportadora text, status text, emissao date, pedido text, item text, descricao text, qtde numeric)
  where coalesce(r.chave, '') <> '';
  return (select count(*) from public.drop_desmembrados);
end $$;
revoke all on function public.importar_desmembrados(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_desmembrados(jsonb, boolean, text, integer) to authenticated;
notify pgrst, 'reload schema';


-- ============ PARTE 64: Alterar pedidos › Nota não localizada (fila "Nota não localizada (Sem Emissão)" do Multi360) ============
-- Planilha de tickets da fila → robô olha o rastreio de cada nota e executa a ação no ticket:
--   em rastreio → "voltar para o barrar"; entregue → voltar para o barrar + não barrado (Entregue);
--   fora do rastreio e passou do prazo (série 35: 30 dias; 34 e 25: 7 dias úteis desde a criação do ticket) → "seguir para cancelamento".
-- Histórico: as notas nunca são apagadas (na_planilha = false quando saem da planilha). Depois do cancelamento o robô
-- continua olhando o rastreio e avisa se aparecer CT-e.
create table if not exists public.nao_localizada (
  nf               text primary key,        -- "1070-35"
  ticket           text,
  serie            text,
  transp_pedido    text,                    -- redespacho Promob, senão transportador Promob
  transp_ticket    text,                    -- "Transportadora do Ticket" da planilha (se vier)
  status_intelipost text,
  canal            text,
  motivo           text,
  ticket_criado    timestamp,
  na_planilha      boolean not null default true,
  primeira_vez     timestamptz default now(),
  ultima_planilha  timestamptz default now(),
  rastreio         jsonb,                   -- {situacao, fonte, evento, data_evento, transp, alvo}
  conferido_em     timestamptz,
  sugestao         text,                    -- voltar_barrar / entregue / cancelar / aguardar / manual
  sugestao_motivo  text,
  prazo_ate        date,                    -- até quando espera aparecer no rastreio
  segurar          boolean default false,   -- a Logística pediu para o robô não mexer
  acao             text,                    -- ação executada no ticket: voltar_barrar / entregue / cancelar
  acao_status      text,                    -- feito / erro / teste
  acao_msg         text,
  acao_em          timestamptz,
  print_rastreio   text,                    -- print do rastreio (bucket "barrar")
  cte_depois       jsonb,                   -- rastreio que apareceu DEPOIS do cancelamento
  cte_alerta_em    timestamptz,
  cte_visto_por    text,
  cte_visto_em     timestamptz
);
create index if not exists nao_localizada_planilha on public.nao_localizada (na_planilha);
create table if not exists public.nao_localizada_info (
  id integer primary key default 1 check (id = 1), arquivo text, linhas integer, enviado_por text, enviado_em timestamptz default now()
);
alter table public.nao_localizada enable row level security;
alter table public.nao_localizada_info enable row level security;
revoke all on public.nao_localizada, public.nao_localizada_info from anon;
grant select, insert, update, delete on public.nao_localizada, public.nao_localizada_info to authenticated;
drop policy if exists "logistica cuida" on public.nao_localizada;
drop policy if exists "logistica cuida" on public.nao_localizada_info;
create policy "logistica cuida" on public.nao_localizada for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));
create policy "logistica cuida" on public.nao_localizada_info for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));

create or replace function public.importar_nao_localizada(linhas jsonb, arquivo text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  update public.nao_localizada set na_planilha = false where na_planilha is true;
  insert into public.nao_localizada (nf, ticket, serie, transp_pedido, transp_ticket, status_intelipost, canal, motivo, ticket_criado, na_planilha, ultima_planilha)
  select x->>'nf', x->>'ticket', x->>'serie', x->>'transp_pedido', nullif(x->>'transp_ticket',''), x->>'status_intelipost', x->>'canal', x->>'motivo',
         nullif(x->>'ticket_criado','')::timestamp, true, now()
  from jsonb_array_elements(linhas) x where coalesce(x->>'nf','') <> ''
  on conflict (nf) do update set ticket = excluded.ticket, serie = excluded.serie, transp_pedido = excluded.transp_pedido, transp_ticket = excluded.transp_ticket,
    status_intelipost = excluded.status_intelipost, canal = excluded.canal, motivo = excluded.motivo, ticket_criado = excluded.ticket_criado,
    na_planilha = true, ultima_planilha = now(),
    -- ticket que voltou para a fila depois de uma ação: o robô olha de novo
    acao = case when public.nao_localizada.acao_status = 'feito' and public.nao_localizada.ticket is distinct from excluded.ticket then null else public.nao_localizada.acao end,
    acao_status = case when public.nao_localizada.acao_status = 'feito' and public.nao_localizada.ticket is distinct from excluded.ticket then null else public.nao_localizada.acao_status end;
  get diagnostics n = row_count;
  insert into public.nao_localizada_info (id, arquivo, linhas, enviado_por, enviado_em) values (1, arquivo, n, auth.jwt() ->> 'email', now())
  on conflict (id) do update set arquivo = excluded.arquivo, linhas = excluded.linhas, enviado_por = excluded.enviado_por, enviado_em = now();
  return n;
end $$;
revoke all on function public.importar_nao_localizada(jsonb, text) from public, anon;
grant execute on function public.importar_nao_localizada(jsonb, text) to authenticated;

-- botão "Rodar o robô" (modo naoloc) e "Teste sem salvar" (naoloc-teste)
create or replace function public.rodar_robo_naoloc(modo text)
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  if auth.uid() is null or public.e_sac() then raise exception 'Sem permissão.'; end if;
  if modo not in ('naoloc', 'naoloc-teste') then raise exception 'Modo inválido.'; end if;
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is null then raise exception 'Falta o token do robô no Supabase (github_robo_token).'; end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                  'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('modo', modo)));
end $$;
revoke all on function public.rodar_robo_naoloc(text) from public, anon;
grant execute on function public.rodar_robo_naoloc(text) to authenticated;
notify pgrst, 'reload schema';
-- ============================================================
-- PARTE 65) Reposição: SLA de cada ticket lido no Multi360 (Detalhes do SLA) + histórico de cada leitura (pedido da Brenda, 24/11/2026)
create table if not exists public.repo_sla (
  ticket       text primary key,
  fila         text,
  situacao     text,          -- DENTRO DO PRAZO / EXPIRADO / AINDA NÃO DEFINIDO ...
  inicio       timestamptz,
  prazo_360    timestamptz,   -- prazo do 360 (horas corridas)
  horas        numeric,
  restante     text,
  lido_em      timestamptz not null default now(),
  erro         text
);
create table if not exists public.repo_sla_hist (
  id           bigserial primary key,
  ticket       text not null,
  fila         text,
  situacao     text,
  inicio       timestamptz,
  prazo_360    timestamptz,
  horas        numeric,
  lido_em      timestamptz not null default now()
);
create index if not exists repo_sla_hist_ticket on public.repo_sla_hist (ticket, lido_em);
alter table public.repo_sla enable row level security;
alter table public.repo_sla_hist enable row level security;
revoke all on public.repo_sla, public.repo_sla_hist from anon;
grant select, insert, update, delete on public.repo_sla to authenticated;
grant select, insert on public.repo_sla_hist to authenticated;
grant usage, select on sequence public.repo_sla_hist_id_seq to authenticated;
drop policy if exists "logistica le" on public.repo_sla;
drop policy if exists "logistica grava" on public.repo_sla;
drop policy if exists "logistica le" on public.repo_sla_hist;
drop policy if exists "logistica grava" on public.repo_sla_hist;
create policy "logistica le" on public.repo_sla for select to authenticated using ((select not public.e_sac()));
create policy "logistica grava" on public.repo_sla for all to authenticated using ((select not public.e_sac())) with check ((select not public.e_sac()));
create policy "logistica le" on public.repo_sla_hist for select to authenticated using ((select not public.e_sac()));
create policy "logistica grava" on public.repo_sla_hist for insert to authenticated with check ((select not public.e_sac()));

-- robô lê o SLA dos tickets em aberto 2x por dia (08:30 e 14:30 de Brasília)
create or replace function public._robo_repo_sla()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"repo-sla","auto":"1"}}'::jsonb);
  end if;
end $$;
revoke all on function public._robo_repo_sla() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'robo-repo-sla';
select cron.schedule('robo-repo-sla', '30 11,17 * * *', 'select public._robo_repo_sla()');

-- ============ PARTE 66: Reposição — coluna "Qtd Fora do SLA" da tabela de acompanhamento (Monitoramento de SLA, todos os casos) ============
alter table public.reposicoes_tk add column if not exists qtd_fora_sla numeric;
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
  insert into public.reposicoes_tk (ticket, criado_em, criado_por, via, fila, tipo, motivo, status, transportadora, nf,
    filial, responsavel, atualizado_em, finalizado_em, tempo_resolucao, estagnada, transp_final, transp_redesp, pedido, valor_pedido, grupo, qtd_fora_sla)
  select r.ticket, r.criado_em, r.criado_por, r.via, r.fila, r.tipo, r.motivo, r.status, r.transportadora, r.nf,
    r.filial, r.responsavel, r.atualizado_em, r.finalizado_em, r.tempo_resolucao, r.estagnada, r.transp_final, r.transp_redesp, r.pedido, r.valor_pedido, r.grupo, r.qtd_fora_sla
  from jsonb_to_recordset(linhas) as r(ticket text, criado_em timestamp, criado_por text, via text, fila text, tipo text,
    motivo text, status text, transportadora text, nf text, filial text, responsavel text, atualizado_em timestamp,
    finalizado_em timestamp, tempo_resolucao numeric, estagnada text, transp_final text, transp_redesp text, pedido text, valor_pedido numeric, grupo text, qtd_fora_sla numeric)
  where r.ticket is not null and r.ticket <> ''
  on conflict (ticket) do update set criado_em = excluded.criado_em, criado_por = excluded.criado_por, via = excluded.via,
    fila = excluded.fila, tipo = excluded.tipo, motivo = excluded.motivo, status = excluded.status,
    transportadora = excluded.transportadora, nf = excluded.nf, filial = excluded.filial, responsavel = excluded.responsavel,
    atualizado_em = excluded.atualizado_em, finalizado_em = excluded.finalizado_em, tempo_resolucao = excluded.tempo_resolucao,
    estagnada = excluded.estagnada, transp_final = excluded.transp_final, transp_redesp = excluded.transp_redesp,
    pedido = excluded.pedido, valor_pedido = excluded.valor_pedido, grupo = excluded.grupo, qtd_fora_sla = excluded.qtd_fora_sla;
  return (select count(*) from public.reposicoes_tk);
end $$;
revoke all on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) from public, anon;
grant execute on function public.importar_reposicoes_tk(jsonb, boolean, text, integer) to authenticated;

-- ============ PARTE 67: Troca de notas — anotação da nova NF no portal do transportador (Reposições › Pré Entrega) ============
alter table public.troca_notas add column if not exists portal_anot_status text;   -- feito | ja_tinha | nao_achou | erro (vazio = falta anotar)
alter table public.troca_notas add column if not exists portal_anot_em timestamptz;
alter table public.troca_notas add column if not exists portal_anot_msg text;
-- robô anota no portal 3x por dia (09:00, 13:00 e 17:00 de Brasília), só as trocas feitas que ainda não têm a anotação
create or replace function public._robo_anota_portal()
returns void language plpgsql security definer set search_path = public as $$
declare tk text;
begin
  begin select decrypted_secret into tk from vault.decrypted_secrets where name = 'github_robo_token' limit 1;
  exception when others then tk := null; end;
  if tk is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/moraisbrendao/painel-consulta-datas/actions/workflows/robo-ssw.yml/dispatches',
      headers := jsonb_build_object('Authorization', 'Bearer ' || tk, 'Accept', 'application/vnd.github+json',
                                    'User-Agent', 'painel-preventivo', 'Content-Type', 'application/json'),
      body := '{"ref":"main","inputs":{"modo":"anota-portal","auto":"1"}}'::jsonb);
  end if;
end $$;
revoke all on function public._robo_anota_portal() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'robo-anota-portal';
select cron.schedule('robo-anota-portal', '0 12,16,20 * * 1-5', 'select public._robo_anota_portal()');
