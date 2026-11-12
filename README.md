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
   - *Já vencidos*, *Vencem hoje*, *Vencem amanhã* e *Vencem em 5 dias*: pela **nova data** informada pela Logística, ou,
     se não houver, pela data prometida ao cliente (Data Original Estimada da Entrega). Assim, um pedido com nova data
     volta como "Vencem amanhã" um dia antes dela;
   - *Parados no rastreio*: mais de 7 dias sem atualização na Intelipost;
   - *Todos*.
   Clique num micro status para ver só os pedidos dele.
4. **Range de vencimento por micro status**: quantos pedidos vencem hoje, em 1, 2, 5, 10, 20 e 30+ dias, por micro status.
   Clique no nome de uma coluna para ver todos os pedidos daquele range, ou num número para ver só os daquele micro status.
5. **Lista de pedidos**: em cada pedido preencha a **Nova data** e a **Observação**. Salva sozinho, mostra quem alterou e
   fica guardado até o pedido aparecer como entregue ou cancelado na Intelipost. Clique na linha para abrir o detalhe do pedido. **Exportar (Excel)** baixa o que está na lista.

6. **Ocorrências** (menu da esquerda): mostra as notas com micro status *Destinatário ausente*, *Endereço não localizado*,
   *Aguardando instrução*, *Destinatário mudou-se*, *Carga recusada* e *Estabelecimento fechado*.
   - Todo dia clique em **Enviar ocorrências cadastradas** e escolha a planilha de ocorrências (precisa ter a coluna
     *Nota* ou *NF*; *Série* e *Motivo* são opcionais). As notas que estão nela ganham a marca "✓ ocorrência cadastrada"
     na lista de pedidos; as outras ficam como "ocorrência a cadastrar".
   - Para as que faltam, a página separa por micro status e por transportadora do portal (conforme a planilha
     *Transportadora a considerar*). Clique em **Baixar template**, e no portal https://ccp.360multi.com/occurrences use
     *Importar Ocorrências*, escolha o arquivo, selecione o motivo em massa e a transportadora e clique em *Enviar Notas*.

7. **Consulta SAC** (menu da esquerda): busca por NF ou pedido, filtros de canal, transportadora e nova data, e
   **Baixar (Excel)**. Mostra a data prometida ao cliente, a nova data e a observação da Logística (só leitura).
   - Para um login do SAC ver **só** essa tela: crie o login no Supabase (*Authentication › Users › Add user*) e
     adicione o e-mail no quadro **Logins do SAC**, no fim da página Consulta SAC. Esse login não envia arquivos,
     não altera nada e não vê as outras páginas.

8. **Responsáveis** (menu da esquerda): cadastre as pessoas (nome e área) e escolha o dono de cada micro status.
   Micro status sem dono aparecem como **Pendente de responsável** (o número no menu mostra quantos faltam). O
   responsável aparece na tabela por micro status, na lista de pedidos, no detalhe, no Excel e no filtro **Responsável**.

9. **Robô do portal** (aba Ocorrências): **Mandar pendentes para o robô** grava o pedido numa fila; a cada 10 minutos o
   robô (GitHub Actions, arquivo `.github/workflows/robo-portal.yml`) entra no portal, importa um arquivo por micro status e
   transportadora, escolhe motivo e transportadora e clica em *Enviar Notas*. **Testar sem enviar** faz tudo menos o envio.
   Precisa de 4 segredos no GitHub (*Settings › Secrets and variables › Actions*): `PORTAL_EMAIL`, `PORTAL_SENHA`,
   `ROBO_EMAIL` e `ROBO_SENHA` (login do robô no painel, criado no Supabase).
   **Para o robô começar na hora** (o agendamento do GitHub às vezes atrasa horas): crie um token em
   https://github.com/settings/personal-access-tokens/new (só este repositório, permissão *Actions: Read and write*) e,
   no SQL Editor do Supabase, rode `select vault.create_secret('COLE_O_TOKEN', 'github_robo_token');`. Depois disso,
   cada pedido ao robô chama o GitHub na hora. Sem o token, dá para rodar à mão em *Actions › Robô do portal › Run workflow*.

10. **Enviar tickets** (botão no topo): escolha a planilha `detalhamento_tickets360` (aba *Tickets*). Para cada pedido o
    painel mostra, embaixo do número, a **fila** do ticket aberto (pela coluna *Nota ticket*) ou **Sem ticket**. Tem também
    o filtro **Ticket (fila)** no topo, a fila no detalhe e no Excel. Cada envio substitui o anterior.

11. **Enviar retornos** (botão amarelo na lista de pedidos, ao lado de Modelo de retornos): sobe em massa o modelo
    (*Pedido Intelipost*, *NF*, *Transportadora*, *Nova Data*, *Observação*). A coluna **Nova Data** aceita só data e vira a
    nova data do pedido; a coluna **Observação** é texto e vira a observação. **Modelo de retornos** baixa o modelo já com
    os pedidos filtrados. Fica salvo até o pedido aparecer como entregue ou cancelado.

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

## 12. Reposição

Na página **Reposição**, clique em **Enviar tabela de acompanhamento** e escolha a planilha *TABELA DE ACOMPANHAMENTO* (aba Export).

- **Pré entrega**: ticket criado pelo **CCP** (coluna Via) que foi para a fila **Atribuir transportador**.
- **Pós entrega**: tickets com Tipo **Reposição Pós Entrega**.
- A transportadora é a de **redespacho** quando houver; senão, a transportadora final.
- Quadro de casos por transportadora × motivo, com filtros de data (de/até), mês e transportadora, e exportação em Excel.
- Cada envio acrescenta os tickets novos e atualiza os que já existiam (o histórico fica guardado).
- Precisa ter rodado o `schema.sql` atualizado (seção 14).

## 13. Visão Gerencial

Primeira página do menu. Usa o arquivo de **Transações da Intelipost** (botão **Enviar Intelipost**): além de tirar do Preventivo os entregues e cancelados, o painel guarda uma versão enxuta de **todos** os pedidos (canal, UF, transportadora, série, status, micro status, datas e situação), sem nome, endereço, e-mail, telefone ou CEP do cliente.

- Filtros com várias opções, meta de performance editável, cards clicáveis.
- "De quem é o atraso", produtividade por dia, atrasos por transportadora e faixa, distribuição por situação, pedidos por canal, performance por transportadora e pedidos por transportadora (por situação ou por mês).
- Data prometida = Previsão Entrega Cliente Original (senão a atual).
- Precisa ter rodado o `schema.sql` atualizado (seção 15) e enviado o arquivo da Intelipost de novo.
