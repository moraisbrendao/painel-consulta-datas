# Preventivo Logística

Site com login (e-mail e senha) onde a Logística vê os pedidos que vão vencer nos próximos dias e registra o que
está fazendo com a transportadora e o SAC. Tudo o que alguém altera fica salvo na hora e aparece para os demais.

Site: https://moraisbrendao.github.io/painel-consulta-datas/

## Como usar

**Filtros no topo** (Buscar, Transportadora, Canal, Micro status, Observação) ficam fixos ao rolar e valem para todas as
tabelas e para a lista. Em cada filtro dá para marcar vários itens. **Limpar filtros** volta tudo.

1. **Enviar planilha** (botão amarelo no topo): escolha o arquivo exportado (aba *Export*, com as colunas
   *Pedido Intelipost*, *Micro Status Intelipost*, *Data Estimada da Entrega(Intelipost)* etc.).
   Ele substitui a base para todos. As tratativas já feitas continuam salvas.
2. **Enviar Intelipost**: escolha o `transactions_....xlsx` da Intelipost. O site lê o arquivo (uns 20 segundos), guarda só o
   número dos pedidos **entregues** e **cancelados** (Status Transportador) e tira esses pedidos do painel. Nome e endereço
   do cliente não são enviados.
3. **O que está acontecendo, por micro status**: escolha a visão
   - *Vencem em 5 dias*: data prometida ao cliente (Data Original Estimada da Entrega) entre hoje e daqui a 5 dias;
   - *Parados no rastreio*: mais de 7 dias sem atualização na Intelipost;
   - *Já vencidos* e *Todos*.
   Clique num micro status para ver só os pedidos dele.
4. **Range de vencimento por micro status**: quantos pedidos vencem hoje, em 1, 2, 5, 10, 20 e 30+ dias, por micro status.
   Clique no nome de uma coluna para ver todos os pedidos daquele range, ou num número para ver só os daquele micro status.
5. **Lista de pedidos**: em cada pedido preencha a **Nova data** e a **Observação**. Salva sozinho, mostra quem alterou e
   fica guardado até o pedido aparecer como entregue ou cancelado na Intelipost. Clique na linha para abrir o detalhe do pedido. **Exportar (Excel)** baixa o que está na lista.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html`, `styles.css`, `app.js` | O site. |
| `leitor-intelipost.js` | Lê o arquivo da Intelipost em segundo plano. |
| `config.js` | Endereço e chave pública (anon) do Supabase. |
| `supabase/schema.sql` | Cria as tabelas e a segurança no Supabase. |

## Instalação no Supabase

1. **SQL Editor → New query** → colar todo o `supabase/schema.sql` → **Run**.
   (Ele também apaga as tabelas do painel antigo, se ainda existirem.)
2. **Authentication → Sign In / Providers**: deixe **Allow new users to sign up** desligado.
3. **Authentication → Users → Add user → Create new user** (marque *Auto Confirm User*) para cada pessoa da Logística.

Todos os usuários com login têm o mesmo acesso. Nenhum dado de cliente (nome, telefone, endereço) é enviado:
só pedido, NF, canal, transportadora, cidade/UF, datas, micro status e link de rastreio.
