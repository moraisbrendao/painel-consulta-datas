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

## 17. Troca de notas (reposição total)

Aba Alterar pedidos > **Troca de notas**. Segue o passo a passo da Logística ("ajuste intelipost").
1. **Subir detalhamento_tickets**: lê a aba **Reposições**, só os tickets da fila "Ajuste de dados na Intelipost" com Tipo de reposição **Total**.
2. Para cada ticket a tela mostra o que digitar na Intelipost: pedido, **método de entrega** (DE × PARA em `troca-notas.js` pela transportadora do Promob — a de redespacho primeiro — e pela **série** da nova NF), código de rastreamento/nota (nova NF), série, chave e data da NF. Quando o DE × PARA não casa, ela avisa e deixa escolher o método na mão.
3. Prazo da simulação de cotação (dias úteis) → nova Entrega prev. (pula sábado e domingo; feriado não) e botão para mandar a data ao robô.
4. As 7 etapas com marcação e quem pegou cada ticket ficam à vista para todos.
Precisa rodar de novo o `supabase/schema.sql` (seção 17).

## 18. Robô da troca de notas

Na aba **Alterar pedidos › Troca de notas**, abra um ticket e use:

- **Testar com o robô (não salva)**: o robô abre o pedido na Intelipost, faz a simulação de cotação e preenche tudo (transportadora, método, Entrega prev., todos os volumes, status), mas fecha sem salvar. Serve para conferir.
- **Fazer com o robô**: faz de verdade as etapas 1 a 5 e marca essas etapas no painel. As etapas 6 e 7 (ticket no Multi360) continuam na mão.

Para funcionar, rode de novo o `supabase/schema.sql` (parte 18). O robô passa de 30 em 30 minutos quando a variável `INTELIPOST_ATIVO = sim` existe no GitHub.

**Reposição parcial:** a Troca de notas também traz os tickets "Parcial" da mesma fila (coluna Tipo e filtro Tipo). O passo a passo é o mesmo, só que **sem a etapa 4 (volumes)**: na tela ela aparece como "não se aplica" e o robô pula os volumes. Rode o `supabase/schema.sql` de novo (coluna `tipo`) e suba o detalhamento_tickets outra vez.

## 19. Robô da Intelipost começa na hora

Rode a parte 19 do `supabase/schema.sql`. Depois disso, cada clique em "Fazer com o robô" / "Testar com o robô"
(Troca de notas) e cada envio de datas em "Alterar pedidos" chama o GitHub na mesma hora, sem esperar o agendamento.
Usa o mesmo token do cofre da parte 13 (`github_robo_token`); sem ele, o robô só roda no agendamento.

## 20. Conferência SSW

Rode a parte 20 do `supabase/schema.sql`. O robô do SSW (`.github/workflows/robo-ssw.yml`) roda de 2 em 2 horas (6h às 20h) nos dias úteis, ~1.000 pedidos por rodada (o SSW bloqueia consultas rápidas), os que vencem antes primeiro
(ou à mão em *Actions › Robô do SSW › Run workflow*): para cada pedido em aberto, consulta o rastreio público do SSW pela NF
(sem a série) + CNPJ do remetente escolhido pela série, e grava a "Previsão de entrega" da transportadora. No Preventivo aparece
"SSW dd/mm" embaixo da data prometida (vermelho se for depois) e o filtro "Conferência SSW".

## 21. Aba Conferência SSW

Rode a parte 21 do `supabase/schema.sql`. Na aba *Conferência SSW*, "Importar pedidos" lê uma planilha com Pedido Intelipost e NF
(ou Nota-Série; sem NF, usa a da base) e substitui a lista. O robô do SSW começa na hora (modo `conferencia`) e confere, um por vez,
se o SSW mostra MERCADORIA ENTREGUE. Card "Falta atualizar a Intelipost" = entregue no SSW e status da Intelipost diferente de Entregue.
As rodadas agendadas também conferem os pendentes antes das previsões.

## 22. Histórico do rastreio na Conferência SSW

Rode a parte 22 do `supabase/schema.sql`. O robô passa a guardar o histórico da Jadlog, da Bento Brasil e da Trânsito Brasil,
e o botão "Ver na <transportadora>" abre uma janela no painel com status, previsão e todos os eventos.

## 23. Senhas de rastreio do SSW

Rode a parte 23 do `supabase/schema.sql`. Na aba *Conferência SSW*, o botão "Senhas do SSW" guarda a senha de rastreio de cada
transportadora (Trans Sua, VM, Aceville…). O botão "Ver no SSW" já abre com a senha, e o robô também usa (os segredos do GitHub continuam valendo).

## 24. Fila Aguardando entrega

Rode a parte 24 do `supabase/schema.sql`. Em *Alterar pedidos* → "Fila Aguardando entrega", suba o relatório de tickets da fila
Aguardando entrega do Multi360 (Excel). O robô (modo `aguardando` do Robô do SSW) abre cada ticket, lê no chat a nova NF
("NF 123-7 emitida para o pedido"), confere no rastreio (SSW, Jadlog, Bento Brasil ou Trânsito Brasil) e, se estiver entregue,
executa a ação "Nota entregue?" → Sim com o print do rastreio. Os não entregues ficam na lista com observação (guardada até a baixa);
os de insucesso na entrega vão para a aba *Ocorrências*. Usa os segredos MULTI360_EMAIL/MULTI360_SENHA (ou PORTAL_EMAIL/PORTAL_SENHA).

## 25. Conferir tudo agora (Conferência SSW)

Rode a parte 25 do `supabase/schema.sql`. O botão "Conferir tudo agora" chama o robô na hora (modo `conferencia-tudo`) para conferir
de novo todos os pedidos da lista que não estão entregues. Enquanto essa conferência estiver em andamento, as outras rodadas do SSW
param para não passar do limite do SSW, e o botão mostra o andamento em vez de recomeçar.

## 26. Fila Aguardando entrega (AT)

Rode a parte 26 do `supabase/schema.sql`. Em *Alterar pedidos*, o botão "Aguardando entrega AT" faz o mesmo da Fila Aguardando
entrega com o relatório da fila "Aguardando entrega (AT)" (Assistência Técnica). Cada relatório só mexe nos tickets da própria fila.

## 27. Nova data automática pelo SSW (Preventivo)

Rode a parte 27 do `supabase/schema.sql`. Pedido que vence de hoje até 5 dias com previsão do SSW depois da prometida recebe
a data do SSW na Nova data (marcada como automática). Se alguém mudar a nova data à mão, o robô não mexe mais nela.

## 28. Nova data automática pela Conferência SSW

Rode a parte 28 do `supabase/schema.sql`. A conferência passa a guardar a previsão do rastreio dos não entregues que vencem de hoje
a 5 dias; se for depois da data prometida ao cliente, vai sozinha para a Nova data (card "Data do SSW" no Preventivo).

## 29. Nova data automática para vencidos

Rode a parte 29 do `supabase/schema.sql`. A nova data automática (partes 27 e 28) passa a valer também para pedidos já vencidos,
quando o rastreio tem previsão de hoje em diante e depois da prometida.

## 30. Logins do painel e senha esquecida
- As contas continuam sendo criadas no Supabase: Authentication › Users › Add user › Create new user (marque "Auto Confirm User"). "Allow new users to sign up" fica desligado.
- Na página Consulta SAC, o cartão "Logins do painel" lista todo mundo e tem "Gerar senha provisória" para quem esqueceu. A pessoa troca por uma senha dela no primeiro acesso.
- Qualquer pessoa logada troca a própria senha no botão "Trocar senha" do topo.
