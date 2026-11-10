-- =====================================================================
-- Painel de Consulta de Datas de Entrega - estrutura do banco (Supabase)
-- Como usar: no Supabase, abra "SQL Editor" > "New query", cole TODO
-- este arquivo e clique em "Run". Só precisa fazer isso uma vez.
-- =====================================================================

-- 1) Tabela com os pedidos que aparecem no painel
create table if not exists public.entregas (
  pedido          text primary key,   -- Pedido Intelipost
  pedido_canal    text,               -- Pedido Anymarket / marketplace
  nota            text,               -- Nota-Série
  canal           text,
  transportadora  text,
  status          text,               -- Status Intelipost
  prev_original   date,
  prev_atual      date,
  data_entrega    date,
  nova_data       date,               -- nova data informada pela transportadora
  retorno         text,               -- categoria do retorno (quando não é data)
  retorno_texto   text,               -- texto que a transportadora mandou
  data_retorno    date,               -- dia em que a logística recebeu o retorno
  uf              text,
  cidade          text,
  link_rastreio   text
);

-- 2) Informação da última atualização (uma linha só)
create table if not exists public.atualizacao (
  id              int primary key default 1 check (id = 1),
  atualizado_em   timestamptz not null default now(),
  atualizado_por  text,
  qtd_pedidos     int
);

-- 3) Lista de quem pode ENVIAR a planilha (a logística).
--    Todo o resto dos usuários só consulta.
create table if not exists public.admins (
  email text primary key
);

-- Função que responde "o usuário logado é da logística?"
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- 4) Segurança: ninguém sem login vê nada.
alter table public.entregas    enable row level security;
alter table public.atualizacao enable row level security;
alter table public.admins      enable row level security;

drop policy if exists "logados consultam"       on public.entregas;
drop policy if exists "admin altera"            on public.entregas;
drop policy if exists "logados veem atualizacao" on public.atualizacao;
drop policy if exists "admin altera atualizacao" on public.atualizacao;
drop policy if exists "cada um ve se e admin"   on public.admins;

create policy "logados consultam" on public.entregas
  for select to authenticated using (true);
create policy "admin altera" on public.entregas
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "logados veem atualizacao" on public.atualizacao
  for select to authenticated using (true);
create policy "admin altera atualizacao" on public.atualizacao
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "cada um ve se e admin" on public.admins
  for select to authenticated using (lower(email) = lower(auth.jwt() ->> 'email'));

-- 5) Troca todos os pedidos de uma vez (usado pelo botão "Enviar planilha").
--    Se der erro no meio, nada é apagado.
create or replace function public.substituir_entregas(linhas jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not public.is_admin() then
    raise exception 'Somente a logística pode enviar a planilha.';
  end if;

  delete from public.entregas where true;

  insert into public.entregas
  select * from jsonb_populate_recordset(null::public.entregas, linhas)
  on conflict (pedido) do update set
    pedido_canal = excluded.pedido_canal, nota = excluded.nota,
    canal = excluded.canal, transportadora = excluded.transportadora,
    status = excluded.status, prev_original = excluded.prev_original,
    prev_atual = excluded.prev_atual, data_entrega = excluded.data_entrega,
    nova_data = excluded.nova_data, retorno = excluded.retorno,
    retorno_texto = excluded.retorno_texto, data_retorno = excluded.data_retorno,
    uf = excluded.uf, cidade = excluded.cidade, link_rastreio = excluded.link_rastreio;

  select count(*) into n from public.entregas;

  insert into public.atualizacao (id, atualizado_em, atualizado_por, qtd_pedidos)
  values (1, now(), auth.jwt() ->> 'email', n)
  on conflict (id) do update set
    atualizado_em = excluded.atualizado_em,
    atualizado_por = excluded.atualizado_por,
    qtd_pedidos = excluded.qtd_pedidos;

  return n;
end;
$$;

revoke all on function public.substituir_entregas(jsonb) from public, anon;
grant execute on function public.substituir_entregas(jsonb) to authenticated;

-- 6) Quem é da logística? Troque pelo seu e-mail (e de quem mais for enviar).
-- insert into public.admins (email) values ('seu.email@empresa.com.br');
