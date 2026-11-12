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

Primeira página do menu. Usa a **base** (botão **Enviar base**, aba Export), com todos os pedidos que vierem nela.

- Atrasado = coluna **Range de Atrasos** começando com "Vencido" (as faixas da tabela também vêm dela).
- Data prometida = Data Original Estimada da Entrega (senão a atual). Entregue no prazo/com atraso pelo Status Prazo Intelipost.
- Filtros com várias opções, meta de performance editável, cards clicáveis, "de quem é o atraso", produtividade por dia, atrasos por transportadora e faixa, distribuição por situação, pedidos por canal, performance por transportadora e pedidos por transportadora (por situação ou por mês).
- Precisa ter rodado o `schema.sql` atualizado (seção 15) e enviado a base de novo.

## 14. Entregas e SLA

Página no menu logo abaixo da Visão Gerencial. Usa a mesma base ("Enviar base") e os mesmos filtros da Visão Gerencial, mas só os pedidos com status **Entregue**.
- **No prazo / com atraso:** pela coluna "Status Prazo Intelipost" (Fora do Prazo = atraso); se ela estiver vazia, data de entrega depois da data prometida = atraso.
- Cards: SLA de entrega, Entregues, No prazo, Com atraso. Aviso de quantas entregas no prazo faltaram para a meta (a mesma meta da Visão Gerencial).
- SLA por transportadora (clique na linha para ver as entregas com atraso dela) e lista com Baixar Excel.
- Se a base enviada só tiver pedidos em aberto, a página avisa que não há entregues.

## 15. Atrasos por UF

Página no menu abaixo de Entregas e SLA. Mesma base e mesmos filtros da Visão Gerencial.
- Mapa do Brasil (ou quadrados) com cada estado colorido pelo % de atraso sobre os pedidos em aberto: sem atraso, até 4%, 4 a 8%, 8 a 15%, acima de 15%. O número é a quantidade de atrasados.
- Clique num estado: transportadoras que atendem, com as séries de cada uma, e as cidades, com em aberto / atrasados / %. Botão para baixar os atrasados do estado.
- "Ranking e tabela": estados do que tem mais atrasos para o que tem menos, com a transportadora que mais atrasa em cada um, e Baixar Excel.
- O desenho do mapa vem de @svg-maps/brazil (licença CC BY 4.0), salvo em `mapa-brasil.js`.

## 16. Alterar pedidos (nova previsão de entrega na Intelipost)

Você diz o pedido e a nova data; o robô altera na Intelipost e o resultado aparece na tela.
1. Cole na caixa uma linha por pedido: `PEDIDO 27/11/2026` (dia/mês/ano; a hora fica 23:59). Ou suba a planilha (modelo: Pedido, Nova data).
2. A tela confere antes: fica de fora (com o motivo) pedido sem data, data que não dá para ler, data que já passou, data a mais de 6 meses e o mesmo pedido com duas datas.
3. "Alterar na Intelipost" grava na fila (`fila_intelipost`). O robô (`.github/workflows/robo-intelipost.yml`) passa de 30 em 30 minutos, em dia útil, das 6h às 20h.

Para o robô funcionar:
- Rode de novo o `supabase/schema.sql` (seção 16).
- No GitHub: Settings > Secrets and variables > Actions > **New repository secret**: `INTELIPOST_EMAIL` e `INTELIPOST_SENHA` (login da Intelipost usado pelo robô).
- Primeiro roda em modo **diag** (só olha as telas, sem mexer em nada) para conferir os campos; depois **dryrun** (preenche sem salvar). Só então a variável `INTELIPOST_ATIVO = sim` liga o agendamento real.
- Se o login falhar, o robô para de tentar com aquela senha (para não bloquear a conta) e a tela mostra um aviso vermelho. Trocou a senha no GitHub, ele volta sozinho.
