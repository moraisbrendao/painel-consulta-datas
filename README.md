# Preventivo Logística

Site com login (e-mail e senha) onde a Logística vê os pedidos que vão vencer nos próximos dias e registra o que
está fazendo com a transportadora e o SAC. Tudo o que alguém altera fica salvo na hora e aparece para os demais.

Site: https://moraisbrendao.github.io/painel-consulta-datas/

## Como usar

1. **Enviar planilha** (botão amarelo no topo): escolha o arquivo exportado (aba *Export*, com as colunas
   *Pedido Intelipost*, *Micro Status Intelipost*, *Data Estimada da Entrega(Intelipost)* etc.).
   Ele substitui a base para todos. As tratativas já feitas continuam salvas.
2. **O que está acontecendo, por micro status**: escolha a visão
   - *Vencem em 5 dias*: data prometida ao cliente (Data Original Estimada da Entrega) entre hoje e daqui a 5 dias;
   - *Parados no rastreio*: mais de 7 dias sem atualização na Intelipost;
   - *Já vencidos* e *Todos*.
   Clique num micro status para ver só os pedidos dele.
3. **Range de vencimento por micro status**: quantos pedidos vencem hoje, em 1, 2, 5, 10, 20 e 30+ dias, por micro status.
   Clique num número para ver os pedidos.
4. **Lista de pedidos**: em cada pedido escolha a **Tratativa**, a **Nova data** e escreva a **Observação**.
   Salva sozinho e mostra quem alterou e quando. **Exportar (Excel)** baixa o que está na lista.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html`, `styles.css`, `app.js` | O site. |
| `config.js` | Endereço e chave pública (anon) do Supabase. |
| `supabase/schema.sql` | Cria as tabelas e a segurança no Supabase. |

## Instalação no Supabase

1. **SQL Editor → New query** → colar todo o `supabase/schema.sql` → **Run**.
   (Ele também apaga as tabelas do painel antigo, se ainda existirem.)
2. **Authentication → Sign In / Providers**: deixe **Allow new users to sign up** desligado.
3. **Authentication → Users → Add user → Create new user** (marque *Auto Confirm User*) para cada pessoa da Logística.

Todos os usuários com login têm o mesmo acesso. Nenhum dado de cliente (nome, telefone, endereço) é enviado:
só pedido, NF, canal, transportadora, cidade/UF, datas, micro status e link de rastreio.
