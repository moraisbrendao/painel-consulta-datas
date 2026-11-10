-- =====================================================================
-- Painel de Consulta de Datas de Entrega - estrutura do banco (Supabase)
-- Versão 2: lista de cobrança + histórico de retornos + padronização.
--
-- Como usar: no Supabase, abra "SQL Editor" > "New query", cole TODO
-- este arquivo e clique em "Run". Pode rodar de novo sem problema:
-- os retornos e as regras já salvos são mantidos.
-- =====================================================================

-- 0) Limpa a versão 1 (que dependia da planilha)
drop function if exists public.substituir_entregas(jsonb);
drop table if exists public.entregas;
drop table if exists public.atualizacao;

-- 1) Quem é da Logística (pode enviar arquivos e mudar regras).
--    Todo o resto dos usuários só consulta.
create table if not exists public.admins (
  email text primary key
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- 2) Pedidos que a Logística está cobrando (arquivo "atrasados em aberto")
create table if not exists public.pedidos (
  pedido          text primary key,   -- Pedido Intelipost
  pedido_canal    text,               -- Pedido Anymarket
  nota            text,               -- Nota-Série
  nova_nf         text,               -- Nova NF reposição
  canal           text,
  transportadora  text,
  status          text,
  micro_status    text,
  dias_atraso     int,
  prev_original   date,
  prev_atual      date,
  data_entrega    date,
  uf              text,
  cidade          text,
  link_rastreio   text,
  em_cobranca     boolean not null default true,  -- está na lista atual?
  atualizado_em   timestamptz not null default now()
);
create index if not exists pedidos_nota_idx on public.pedidos (lower(nota));

-- 3) Histórico de tudo que as transportadoras responderam
create table if not exists public.retornos (
  id              bigint generated always as identity primary key,
  pedido          text not null,
  nota            text,
  transportadora  text,
  texto           text not null,      -- exatamente o que a transportadora escreveu
  nova_data       date,               -- data encontrada no texto (se houver)
  data_retorno    date not null default current_date,
  lote            uuid not null,      -- cada envio de arquivo é um lote
  arquivo         text,
  enviado_por     text,
  criado_em       timestamptz not null default now()
);
create index if not exists retornos_pedido_idx on public.retornos (pedido, data_retorno desc, id desc);
create index if not exists retornos_lote_idx on public.retornos (lote);

-- Último retorno de cada pedido (+ quantos retornos ele já teve)
create or replace view public.ultimo_retorno with (security_invoker = true) as
select distinct on (pedido)
  pedido, texto, nova_data, data_retorno, transportadora,
  count(*) over (partition by pedido) as qtd_retornos
from public.retornos
order by pedido, data_retorno desc, id desc;

-- Envios feitos (para conferir e desfazer)
create or replace view public.envios with (security_invoker = true) as
select lote, min(arquivo) as arquivo, min(enviado_por) as enviado_por,
       min(data_retorno) as data_retorno, min(criado_em) as criado_em, count(*) as qtd
from public.retornos
group by lote;

-- 4) Regras de padronização: "quando o retorno tiver <termo>, considerar como <categoria>"
create table if not exists public.regras (
  id         bigint generated always as identity primary key,
  categoria  text not null,
  termo      text not null,
  criado_em  timestamptz not null default now(),
  unique (categoria, termo)
);

-- 5) Segurança: sem login ninguém vê nada; só a Logística altera.
alter table public.admins   enable row level security;
alter table public.pedidos  enable row level security;
alter table public.retornos enable row level security;
alter table public.regras   enable row level security;

drop policy if exists "cada um ve se e admin" on public.admins;
create policy "cada um ve se e admin" on public.admins
  for select to authenticated using (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "logados consultam" on public.pedidos;
drop policy if exists "admin altera"      on public.pedidos;
create policy "logados consultam" on public.pedidos for select to authenticated using (true);
create policy "admin altera" on public.pedidos for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "logados consultam" on public.retornos;
drop policy if exists "admin altera"      on public.retornos;
create policy "logados consultam" on public.retornos for select to authenticated using (true);
create policy "admin altera" on public.retornos for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "logados consultam" on public.regras;
drop policy if exists "admin altera"      on public.regras;
create policy "logados consultam" on public.regras for select to authenticated using (true);
create policy "admin altera" on public.regras for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 6) Importa a lista de pedidos em cobrança.
--    Quem está no arquivo fica "em cobrança"; quem saiu da lista some da
--    consulta, mas o histórico de retornos dele é mantido.
create or replace function public.importar_pedidos(linhas jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not public.is_admin() then
    raise exception 'Somente a Logística pode enviar a lista de cobrança.';
  end if;

  update public.pedidos set em_cobranca = false where em_cobranca;

  insert into public.pedidos (pedido, pedido_canal, nota, nova_nf, canal, transportadora, status,
    micro_status, dias_atraso, prev_original, prev_atual, data_entrega, uf, cidade, link_rastreio,
    em_cobranca, atualizado_em)
  select pedido, pedido_canal, nota, nova_nf, canal, transportadora, status,
    micro_status, dias_atraso, prev_original, prev_atual, data_entrega, uf, cidade, link_rastreio,
    true, now()
  from jsonb_populate_recordset(null::public.pedidos, linhas)
  where coalesce(pedido, '') <> ''
  on conflict (pedido) do update set
    pedido_canal = excluded.pedido_canal, nota = excluded.nota, nova_nf = excluded.nova_nf,
    canal = excluded.canal, transportadora = excluded.transportadora, status = excluded.status,
    micro_status = excluded.micro_status, dias_atraso = excluded.dias_atraso,
    prev_original = excluded.prev_original, prev_atual = excluded.prev_atual,
    data_entrega = excluded.data_entrega, uf = excluded.uf, cidade = excluded.cidade,
    link_rastreio = excluded.link_rastreio, em_cobranca = true, atualizado_em = now();

  select count(*) into n from public.pedidos where em_cobranca;
  return n;
end;
$$;

-- 7) Salva os retornos de um arquivo da transportadora (um lote)
create or replace function public.enviar_retornos(linhas jsonb, arquivo text, data_retorno date)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare novo_lote uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    raise exception 'Somente a Logística pode enviar retornos.';
  end if;

  insert into public.retornos (pedido, nota, transportadora, texto, nova_data, data_retorno,
                               lote, arquivo, enviado_por)
  select r.pedido, r.nota, r.transportadora, r.texto, r.nova_data,
         coalesce(enviar_retornos.data_retorno, current_date),
         novo_lote, enviar_retornos.arquivo, auth.jwt() ->> 'email'
  from jsonb_to_recordset(linhas)
       as r(pedido text, nota text, transportadora text, texto text, nova_data date)
  where coalesce(r.pedido, '') <> '' and coalesce(r.texto, '') <> '';

  return novo_lote;
end;
$$;

-- 8) Desfaz um envio de retornos (apaga só aquele lote)
create or replace function public.apagar_lote(lote_id uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not public.is_admin() then
    raise exception 'Somente a Logística pode apagar envios.';
  end if;
  delete from public.retornos where lote = lote_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 9) Regras de fábrica (o botão "voltar para as regras de fábrica" usa isto)
create or replace function public._carregar_regras_padrao()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.regras where true;
  insert into public.regras (categoria, termo)
  select c.categoria, t.termo
  from (values
    (1, 'Entrega agendada', array['AGENDAD','AGENDAMENTO']),
    (2, 'Em processo de devolução', array['DEVOLU','RETORNANDO PARA O REMETENTE','Barrada','CANCELADA','Aguardando NFD']),
    (3, 'Em processo de reposição', array['REPOSI','FALTA DE VOL','FALTA VOLUME','EXTRAVIO','AVARIA','Mercadoria sinistrada',
        'Possivel resposição CRI - confirmando com a unidade','CTRC BAIXADO/CANCELADO - Produto não recebido']),
    (4, 'EM BUSCAS', array['BUSCAS','EM BUSCA']),
    (5, 'NÃO CHEGOU PARA A TRANSPORTADORA', array['NAO COLETAD','NAO FOI COLETAD','NAO TEMOS EM SISTEMA','NAO DEU ENTRADA',
        'NAO EMBARCAD','SEM ENTRADA','NAO RECEBEMOS','Mercadoria não coleta','Sem Emissão','Não tenho esta NF em sistema',
        'Não consta em nossa base']),
    (6, 'Ocorrência - pendência SAC', array['AUSENTE','RECUSA','NAO LOCALIZAD','ENDERECO INCORRETO','MUDOU-SE','FECHADO',
        'AGUARDANDO INSTRU','CONTATO','AGUARDANDO RETORNO','aguardo retorno no chat','Conforme a unidade',
        'o cliente recusou. Pois fez o cancelamento no site da compra','MUDOU DE ENDERECO/ DESCONHECIDO NO LOCAL',
        'Solicitei confirmação de dados na plataforma']),
    (7, 'MERCADORIA RETIDA', array['RETIDA','RETENCAO','FISCALIZACAO']),
    (8, 'Roubo / área de risco', array['ROUBO','FURTO','AREA DE RISCO','SINISTRO']),
    (9, 'Pendência transportadora - cobrar', array['SEM PREVISAO','AGUARDANDO POSICAO','VERIFICANDO','TRATANDO','EM ANALISE',
        'Em tratativa com cliente','Melhor horário para entrega é no período tarde. A partir das 13:00hs','Seguir cancelamento',
        'aguardando atualização da matriz','SOBRA CONSTATADA NO ATO DO CARREG/DESCARREG','ENTREGA PREJUDICADA PELO HORARIO',
        'volume trocado com outra unidade','a unidade de TUB esta aguardando o recebimento para seguir com a entrega',
        'já informei na planilha anterior que esta mercadorina não veio para Aceville','Aguardando liberação Sefaz']),
    (10, 'Em rota de entrega', array['EM ROTA DE ENTREGA','EM ENTREGA','SAIDA PARA ENTREGA','Em rota para ser entregue',
        'em rota','emrota','Rota de entrega','Saida para entrega na cidade de BLUMENAU.',
        'Saida para entrega na cidade de GAROPABA.','Saida para entrega na cidade de ITAPOA.']),
    (11, 'Entregue', array['Entregue','Entregue 26/10','ENTREGA FINALIZADA','Finalizado','ENTREGA REALIZADA','ENTREGA REALZIADA'])
  ) as c(ordem, categoria, termos)
  cross join lateral unnest(c.termos) with ordinality as t(termo, pos)
  order by c.ordem, t.pos;
end;
$$;

create or replace function public.restaurar_regras_padrao()
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not public.is_admin() then
    raise exception 'Somente a Logística pode mudar as regras.';
  end if;
  perform public._carregar_regras_padrao();
  select count(*) into n from public.regras;
  return n;
end;
$$;

revoke all on function public.importar_pedidos(jsonb) from public, anon;
revoke all on function public.enviar_retornos(jsonb, text, date) from public, anon;
revoke all on function public.apagar_lote(uuid) from public, anon;
revoke all on function public.restaurar_regras_padrao() from public, anon;
grant execute on function public.importar_pedidos(jsonb) to authenticated;
grant execute on function public.enviar_retornos(jsonb, text, date) to authenticated;
grant execute on function public.apagar_lote(uuid) to authenticated;
grant execute on function public.restaurar_regras_padrao() to authenticated;

-- 10) Na primeira vez, já começa com as regras de fábrica
revoke all on function public._carregar_regras_padrao() from public, anon, authenticated;
do $$
begin
  if not exists (select 1 from public.regras) then
    perform public._carregar_regras_padrao();
  end if;
end $$;

-- =====================================================================
-- PREVENTIVO (Intelipost): base de pedidos em aberto, responsáveis e
-- micro status. Pode rodar de novo sem perder nada.
-- =====================================================================

-- Chave do micro status: maiúsculo, sem acento e sem espaços sobrando
create or replace function public.chave_ms(t text)
returns text language sql immutable as $$
  select upper(regexp_replace(trim(translate(coalesce(t, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')), '\s+', ' ', 'g'));
$$;

-- Pessoas/áreas responsáveis
create table if not exists public.responsaveis (
  id     bigint generated always as identity primary key,
  nome   text not null,
  area   text,
  unique (nome)
);

-- Cada micro status tem (ou não) um responsável. Sem responsável = "Pendente de responsável"
create table if not exists public.micro_status (
  chave           text primary key,
  nome            text not null,
  responsavel_id  bigint references public.responsaveis(id) on delete set null,
  criado_em       timestamptz not null default now()
);

-- Pedidos em aberto da última base da Intelipost (entregues e cancelados não entram)
create table if not exists public.intelipost (
  pedido                 text primary key,   -- coluna "Pedido" (= Pedido Intelipost)
  nf                     text,               -- Nota Fiscal-Série
  pedido_venda           text,
  canal                  text,
  transportadora         text,
  status_transp          text,               -- Status Transportador
  micro_status           text,
  descricao              text,               -- Descrição Transportador (último evento)
  data_ultimo_status     date,
  data_despacho          date,
  prev_cliente           date,               -- Previsão Entrega Cliente (atual)
  prev_cliente_original  date,               -- Previsão Entrega Cliente Original
  prev_transp            date,               -- Previsão Entrega Transp.
  uf                     text,
  cidade                 text,
  link_rastreio          text
);
create index if not exists intelipost_nf_idx on public.intelipost (nf);

-- Resumo da última base enviada (uma linha só)
create table if not exists public.intelipost_info (
  id            int primary key default 1 check (id = 1),
  arquivo       text,
  enviado_por   text,
  enviado_em    timestamptz not null default now(),
  resumo        jsonb
);

alter table public.responsaveis    enable row level security;
alter table public.micro_status    enable row level security;
alter table public.intelipost      enable row level security;
alter table public.intelipost_info enable row level security;

do $$
declare t text;
begin
  foreach t in array array['responsaveis','micro_status','intelipost','intelipost_info'] loop
    execute format('drop policy if exists "logados consultam" on public.%I', t);
    execute format('drop policy if exists "admin altera" on public.%I', t);
    execute format('create policy "logados consultam" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "admin altera" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Recebe a base da Intelipost em partes. Na primeira parte (limpar = true) apaga a base anterior.
-- Micro status que ainda não existem entram sem responsável.
create or replace function public.importar_intelipost(linhas jsonb, limpar boolean, arquivo text, resumo jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not public.is_admin() then
    raise exception 'Somente a Logística pode enviar a base da Intelipost.';
  end if;
  if limpar then
    delete from public.intelipost where true;
    insert into public.intelipost_info (id, arquivo, enviado_por, enviado_em, resumo)
    values (1, importar_intelipost.arquivo, auth.jwt() ->> 'email', now(), importar_intelipost.resumo)
    on conflict (id) do update set arquivo = excluded.arquivo, enviado_por = excluded.enviado_por,
      enviado_em = excluded.enviado_em, resumo = excluded.resumo;
  end if;

  insert into public.intelipost
  select * from jsonb_populate_recordset(null::public.intelipost, linhas)
  where coalesce(pedido, '') <> ''
  on conflict (pedido) do update set
    nf = excluded.nf, pedido_venda = excluded.pedido_venda, canal = excluded.canal,
    transportadora = excluded.transportadora, status_transp = excluded.status_transp,
    micro_status = excluded.micro_status, descricao = excluded.descricao,
    data_ultimo_status = excluded.data_ultimo_status, data_despacho = excluded.data_despacho,
    prev_cliente = excluded.prev_cliente, prev_cliente_original = excluded.prev_cliente_original,
    prev_transp = excluded.prev_transp, uf = excluded.uf, cidade = excluded.cidade,
    link_rastreio = excluded.link_rastreio;

  insert into public.micro_status (chave, nome)
  select distinct on (public.chave_ms(x->>'micro_status')) public.chave_ms(x->>'micro_status'), trim(x->>'micro_status')
  from jsonb_array_elements(linhas) x
  where coalesce(trim(x->>'micro_status'), '') <> ''
  on conflict (chave) do nothing;

  select count(*) into n from public.intelipost;
  return n;
end;
$$;
revoke all on function public.importar_intelipost(jsonb, boolean, text, jsonb) from public, anon;
grant execute on function public.importar_intelipost(jsonb, boolean, text, jsonb) to authenticated;

-- Lista inicial de micro status (todos começam como "Pendente de responsável")
insert into public.micro_status (chave, nome)
select public.chave_ms(n), n from unnest(array[
  'CANCELADO','ENTREGUE NO DESTINO','SAIDA FILIAL','ENTRADA FILIAL','ENTREGUE','CLIENTE ALEGA FALTA DE MERCADORIA',
  'SAIU PARA ENTREGA','AGUARDANDO AUTORIZACAO PARA REENTREGA','TROCA DE NOTAS','REENTREGA SOLICITADA',
  'AGUARDANDO INSTRUÇÃO','EM TRÂNSITO','EMISSAO do CT-e / NFS-e','ENTRADA FILIAL DESTINO','DESTINATÁRIO AUSENTE',
  'EM TRANSFERENCIA','EXTRAVIO CONFIRMADO','NÃO VISITADO','ENDEREÇO NÃO LOCALIZADO','BUSCA',
  'CARGA RECUSADA PELO DESTINATARIO','EM ROTA DE ENTREGA','DEVOLUCAO - ENTRADA FILIAL','INDENIZACAO RECUSADA',
  'DEVOLUCAO - ENTRADA FILIAL DESTINO','DESPACHADO','DIFICIL ACESSO','AVERIGUAR FALHA NA ENTREGA','CARGA ERRADA',
  'Falha ao criar pedido com a transportadora','AUSÊNCIA DE ATUALIZAÇÃO','Pedido criado na transportadora com sucesso',
  'ESTABELECIMENTO FECHADO','CARGA INCOMPLETA','CRIADO','PREVISAO DE ENTREGA ALTERADA','CARGA REDESPACHADA',
  'ENTREGA AGENDADA','EM DEVOLUÇÃO','AVARIA CONFIRMADA','PROBLEMA OPERACIONAL','PARADO NA FISCALIZACAO','DEVOLVIDO',
  'MERCADORIA EM DEVOLUCAO EM OUTRA OPERACAO','PRONTO PARA RETIRADA','FALHA NA ENTREGA','DEVOLUCAO - SAIDA FILIAL'
]) as n
on conflict (chave) do nothing;
