// Passo a passo do E-loggia: como usar cada aba (para quem cobre a Logística). Só texto; nenhum dado.
(function () {
  const el = document.getElementById("pagina-ajuda");
  if (!el) return;
  // [id da página, título, para que serve, quando usar, passos, atenção]
  const A = [
    ["rotina", "Rotina do dia (comece por aqui)", "A ordem do dia para manter o E-loggia em dia.", "Todo dia, logo cedo, e de novo depois do almoço.", [
      "Entre no E-loggia com o seu login (e-mail e senha). Se esqueceu a senha, peça a alguém com acesso à aba <b>Logins</b> para gerar uma senha provisória.",
      "No topo, clique em <b>Carregar planilha</b> e escolha a planilha da base (BI, aba <b>Export</b>). Ela é a fonte de tudo: Visão Gerencial, Preventivo, canais, UF etc. Espere a mensagem de que terminou.",
      "Clique em <b>Enviar Intelipost</b> e escolha o arquivo <b>transactions</b> exportado da Intelipost. Ele tira do painel o que já foi entregue ou cancelado.",
      "Clique em <b>Carregar tickets</b> e escolha o <b>detalhamento_tickets360</b> (recebido por e-mail). Ele mostra a fila do ticket de cada pedido.",
      "Abra a <b>Cobrança do dia</b>: ela já diz o que cobrar de cada transportadora, na ordem de prioridade (cards 1 a 6). Baixe a <b>⤓ Cobrança</b> ou copie a <b>⧉ Mensagem</b> de cada transportadora e mande.",
      "Quando a transportadora responder, suba a planilha no <b>Preventivo › Enviar retornos</b> (ou preencha <b>Nova data</b> e <b>Observação</b> direto na lista). O pedido sai da cobrança sozinho.",
      "Em <b>Alterar pedidos</b>, rode as filas <b>Aguardando entrega</b> e <b>Aguardando entrega AT</b> (subir o relatório do Multi360) e confira as <b>Ocorrências</b>.",
      "Em <b>Alterar pedidos › Nova previsão de entrega</b>, clique em <b>↓ Trazer do Preventivo e SSW</b>, confira, clique em <b>➕ Colocar na fila</b> e depois em <b>▶ Enviar para o robô</b>.",
      "Na <b>Conferência SSW</b>, veja o card <b>Falta atualizar a Intelipost</b> e dê baixa na Intelipost nos pedidos que já foram entregues.",
    ], "No topo aparece a data da planilha carregada. Se estiver amarelo (planilha antiga), carregue de novo. Tudo que alguém salva aparece para toda a Logística na hora."],

    ["gerencial", "Visão Gerencial", "Mostra a foto geral dos pedidos: em aberto, atrasados, em risco, parados e a performance contra a meta.", "Para saber como está a operação e para tirar listas por transportadora, UF, cidade ou canal.", [
      "Use o cartão <b>Filtros</b> (canal, UF, transportadora, série, origem, status, micro status, nota fiscal, datas). Pode escolher mais de um em cada filtro.",
      "Clique nos cards (Atrasados, Em risco, Parados…) para ver a lista daquele grupo.",
      "No quadro <b>Atraso por transportadora, UF, cidade e canal</b>: clique numa transportadora para ver só os estados, cidades e canais dela (filtro cruzado). Clique de novo para tirar.",
      "A lista de pedidos aparece embaixo. Use <b>Baixar Excel</b> ou <b>Extrair tabelas</b> para levar para a planilha.",
    ], "Clique no título de qualquer coluna para ordenar (maior → menor → original)."],

    ["entregas", "Entregas e SLA", "Só os pedidos já entregues: SLA, entregues no prazo e com atraso por transportadora.", "Para reunião com transportadora e para medir o SLA.", [
      "Escolha os filtros no topo (mesmos da Visão Gerencial).",
      "Clique numa transportadora para ver as entregas com atraso dela.",
      "Use <b>Baixar Excel</b> para mandar a lista para a transportadora.",
    ], "Se a base só tiver pedidos em aberto, esta página fica vazia."],

    ["transp", "Transportadoras", "Desempenho de cada transportadora: volume, em aberto, atrasados, em risco, atraso médio, SLA e histórico.", "Para comparar transportadoras e acompanhar a evolução.", [
      "Veja a tabela <b>Detalhe por transportadora</b>.",
      "Marque até 8 na coluna <b>Comparar</b> para ver lado a lado (a melhor de cada linha fica em negrito).",
      "Clique no nome para abrir os pedidos dela na Visão Gerencial.",
      "Quadro <b>Tempos reais de entrega</b>: mediana, P80 e P90 em dias úteis das entregas dos últimos 3 meses, por transportadora (redespacho, se houver), UF e cidade. Card <b>Etapas para conferir</b> mostra em qual etapa logística cada micro status entra.",
    ], ""],

    ["uf", "Atrasos por UF", "Mapa do Brasil com o percentual de atraso por estado, cidades e transportadoras de cada estado.", "Para descobrir onde está o atraso e quem atende cada região.", [
      "Clique num estado no mapa (ou use <b>Ranking e tabela</b>).",
      "Embaixo aparecem <b>Quem atende e por quais séries</b> e <b>Cidades</b>.",
      "Clique numa <b>transportadora</b>: as cidades e o mapa passam a mostrar só ela. Clique numa <b>cidade</b>: as transportadoras mostram só quem atende ali. Clique de novo (ou no ✕) para tirar.",
      "Use <b>Baixar atrasados do estado</b> para a lista (segue a seleção).",
    ], ""],

    ["canais", "Análise de canais", "Mostra, por canal de venda, os pedidos que precisam de ação primeiro. Amazon e Mercado Livre têm o índice de reclamações (meta abaixo de 1%) e o risco de cada pedido.", "Todo dia, principalmente para Amazon e Mercado Livre.", [
      "Quadro <b>🧭 Gargalos por transportadora</b>: escolha a transportadora e veja onde ela mais atrasa (capital de SP por zona pelo CEP, Grande SP, litoral, interior; outros estados capital e interior). Clique na região para ver as cidades e em qual micro status os atrasados travam; clique num número para a lista.",
      "Escolha o <b>Canal</b> no alto à direita.",
      "Trate na ordem: card <b>1 · Atrasados sem nova data</b>, depois <b>2 · Vencem hoje ou amanhã</b>, depois <b>3 · Risco alto no canal</b> (vale para todos os canais; em Amazon e Mercado Livre também conta a transportadora com mais reclamações).",
      "Na lista, preencha a <b>Nova data</b> e a <b>Observação</b> ali mesmo (vale também no Preventivo). Clique na linha para ver o detalhe do pedido.",
      "Para Amazon/ML: abra <b>Ver análise completa</b> (no fim da página) e use <b>Enviar impactos</b> com a planilha de impactos do canal (Amazon: aba Impactos; ML: Baixar vendas afetadas). No ✎ informe as vendas dos últimos 60 dias.",
      "<b>Copiar resumo</b> copia um texto pronto para e-mail ou WhatsApp.",
    ], ""],

    ["drop", "Dropshipping", "Controle só dos pedidos com origem Dropshipping na base: em aberto, atrasados, parados no rastreio, provável extravio, reposição, ocorrência e outros problemas.", "Todo dia, para cobrar a transportadora e o fornecedor do dropshipping.", [
      "Clique num card (ou numa linha das tabelas Diagnóstico e Por transportadora) para filtrar a lista.",
      "A coluna <b>Diagnóstico</b> diz o que provavelmente aconteceu: já coletado, atrasado e 15 dias ou mais sem movimento = provável extravio; mais de 7 dias = parado. Ainda \"Despachado\" (sem movimento da transportadora) e atrasado = atrasado sem coleta.",
      "Use <b>Ver rastreio</b> para conferir na transportadora; grave a nova data e a observação na própria linha (valem em todas as abas).",
      "Baixar Excel leva a lista filtrada com diagnóstico, ocorrência, reposição e a nova data.",
      "Pedidos desmembrados (a mesma ordem de compra virou mais de um pedido no Promob): clique em <b>Subir pedidos desmembrados</b> e envie o relatório Consulta do Promob (Pedido, Item, Descrição, Qtde, Ordem de compra, Data de emissão). O painel liga a <b>Ordem de compra</b> ao <b>Pedido Anymarket</b> da base (tirando o final <b>.DROP</b> da Ordem de compra) e o <b>Pedido</b> ao <b>Pedido Promob</b>; embaixo da situação aparece a outra parte, com a nota e o status dela na base. O card <b>Desmembrados</b> lista só esses pedidos.",
    ], "Reposição e ocorrência vêm do último detalhamento de tickets enviado. O fornecedor aparece depois do próximo envio da base."],

    ["preventivo", "Preventivo", "A lista de trabalho da Logística: pedidos em aberto pela data prometida ao cliente, para agir antes de atrasar.", "Todo dia, várias vezes.", [
      "Clique nos cards: <b>Atrasados</b> (mesmo número da Visão Gerencial), <b>Vencem hoje</b>, <b>Vencem amanhã</b>, <b>Vencem em até 5 dias</b>, <b>Parados no rastreio</b>, <b>Data do SSW</b> (pode marcar vários).",
      "Use a tabela <b>O que está acontecendo, por micro status</b> (já com o range de vencimento ao lado) para filtrar: clique no micro status, num número ou no nome da coluna.",
      "Quadro <b>Retornos das transportadoras</b>: compara o retorno de cada pedido em aberto no começo da semana com o de agora (mudou, mesmo retorno, novo, sem retorno, quantas vezes trocou) e audita pelo tempo real de entrega do CEP e pelos dias parados. <b>⧉ Mensagem</b> monta a cobrança da transportadora; o Excel traz o histórico de cada pedido.",
      "Na lista, para cada pedido: veja o rastreio (<b>Rastreio ↗</b>), cobre a transportadora e preencha <b>Nova data</b> e <b>Observação</b>. Salva sozinho, para todos.",
      "Para muitos pedidos: <b>Modelo de retornos</b> → preencha no Excel → <b>Enviar retornos</b>.",
      "<b>Exportar (Excel)</b> baixa a lista que está na tela.",
    ], "A nova data passa a valer como vencimento do pedido. \"🤖 data do SSW\" quer dizer que o robô preencheu pela previsão do SSW; se você mudar à mão, ele não mexe mais."],

    ["retornos", "Cobrança do dia", "O controle dos retornos das transportadoras: diz todo dia quais pedidos cobrar, de quem e por quê, para nenhuma nota ficar para trás.", "Todo dia, logo cedo e depois do almoço.", [
      "Os cards estão em ordem de prioridade: <b>1 · Atrasado sem retorno</b> (sem data nem observação), <b>2 · Promessa quebrada</b> (a nova data passou e não entregou), <b>3 · Atrasado só com observação</b> (falta a data), <b>4 · Vence hoje sem retorno</b>, <b>5 · Vence amanhã sem retorno</b>, <b>6 · Nova data vence hoje/amanhã</b> (confirmar). <b>Em dia</b> = já tem nova data válida.",
      "Comece pelos cards 1 e 2. O número vermelho no menu é a soma deles.",
      "Na tabela <b>Por transportadora</b>, clique no nome para ver só os pedidos dela. <b>⤓ Cobrança</b> baixa o Excel (mesmo modelo do Enviar retornos) e <b>⧉ Mensagem</b> copia um texto pronto para e-mail ou WhatsApp.",
      "<b>Cobertura</b> = quanto dos atrasados e vencendo já tem retorno válido (abaixo de 70% fica vermelho). <b>Promessas quebradas</b> = quantas vezes a data informada passou sem entregar nos últimos 60 dias.",
      "Dá para marcar <b>vários cards</b> ao mesmo tempo (ex.: 1 + 4). <b>Tudo para cobrar</b> limpa a seleção.",
      "<b>Retornos padronizados</b> mostra o retorno (observação) de cada pedido já padronizado (Entrega agendada, Em rota de entrega, Pendência transportadora, Ocorrência - pendência SAC…) com o <b>responsável</b>. Clique para ver os pedidos. Use o filtro <b>Responsável</b> para cada um ver só os seus.",
      "Em <b>Como padronizar o retorno</b>: escreva a categoria e as palavras (separadas por vírgula) e clique em <b>Guardar regra</b>. Vale a 1ª regra da lista que bater. Escolha o responsável de cada categoria no seletor ao lado do nome. O que cair em <b>Não padronizado</b> precisa de uma regra nova.",
      "Na lista dá para preencher <b>Nova data</b> e <b>Observação</b> direto. Clique no pedido para ver o <b>Histórico de retornos</b> dele.",
      "<b>Resumo por retorno</b>: para os cards marcados, quantos pedidos há em cada retorno padronizado, o responsável, a média de dias de atraso e quantos ainda estão sem nova data válida.",
      "<b>Transportadoras sem nova data e em reposição</b>: por transportadora, os atrasados e os que vencem hoje/amanhã sem nova data válida, e os que estão em reposição. <b>⤓ Excel</b> baixa a lista.",
      "<b>⧉ Copiar resumo do dia</b> copia os números do dia para mandar no grupo.",
    ], "Pedido que já aparece entregue no arquivo da Intelipost sai da cobrança. Um retorno só vale se a nova data for de hoje em diante."],

    ["responsaveis", "Responsáveis (dentro do Preventivo)", "Define quem cuida de cada micro status.", "Quando entra um micro status novo ou muda alguém da equipe.", [
      "Fica no fim da aba <b>Preventivo</b>: clique no botão <b>👤 Responsáveis</b> ao lado do título (ou no quadro \"Responsáveis por micro status\" lá embaixo) para abrir.",
      "Clique em <b>+ Adicionar responsável</b> para cadastrar a pessoa ou área.",
      "Na tabela, escolha o responsável de cada micro status (os pendentes aparecem primeiro). Salva na hora.",
    ], "O botão 👤 Responsáveis mostra quantos micro status estão sem dono."],

    ["reposicao", "Reposição", "Indicadores de reposição pré e pós-entrega, por mês, transportadora e motivo.", "Para o acompanhamento mensal de reposições.", [
      "Clique em <b>⇪ Subir tabela de acompanhamento</b> e escolha a TABELA DE ACOMPANHAMENTO (BI, aba Export).",
      "Para os dados da nova NF e transportadora da reposição, suba também o detalhamento de tickets (Alterar pedidos › Ajuste Intelipost).",
      "Use as abas <b>Visão geral</b>, <b>Pré-entrega</b>, <b>Pós-entrega</b> e <b>Detalhamento operacional</b>, e os filtros de mês, transportadora, tipo e motivo.",
      "Clique em qualquer card (Em aberto, Finalizados, Recuperação de crédito, Totais...) para ver os tickets dele no Detalhamento; <b>Baixar Excel</b> leva essa lista.",
      "Clique no card <b>Em aberto</b> (Visão geral, Pré ou Pós) para abrir o quadro <b>Em aberto por fila · dias parados na fila</b>: por responsável e fila, há quantos dias os casos estão parados, separado por <b>Grupo</b> (Logística, Sac, Faturamento, Projetos) e fila, com filtros próprios de <b>Grupo</b> e <b>Fila atual</b> (a <b>Série da NF</b> fica nos filtros do topo); clique num número para ver os tickets. Clique no card de novo para fechar. O card <b>Gargalos por fila</b> abre o ranking das filas com mais dias parados (casos, média de dias, mais antigo, +10 dias), com filtros de Grupo e Fila e <b>Baixar Excel</b> (ranking + casos).",
      "<b>Baixar Excel</b> leva os tickets filtrados.",
      "Aba <b>Falta de volumes</b>: envie a planilha de tickets (Inversão / Falta de volumes) e clique em <b>Conferir retornos agora</b>. O robô olha no 360 as mensagens <b>Externo</b> da transportadora e no portal as anotações da NF (Faltas / Inversões). No card <b>Sem retorno</b>, cada transportadora tem um quadrinho com os casos por motivo, dias parados, mensagem para o WhatsApp e Excel.",
      "Na <b>Falta de volumes</b>, cada ticket mostra todas as mensagens da transportadora com o nome de quem respondeu. Use a coluna <b>Data prometida</b> para gravar a data que a transportadora informou (fica vermelha quando passa) e <b>Anotações</b> para as notas da Logística; o link <b>histórico</b> mostra quem mudou e quando.",
      "Aba <b>Filas atualizadas e ocorrências</b>: em <b>Filas</b>, os tickets em aberto da tabela de acompanhamento por responsável › fila e dias (vermelho = 20 dias ou mais); clique em <b>Editar responsáveis</b> para escrever quem cuida de cada fila. Em <b>Ocorrências</b>, a aba Ocorrências do detalhamento de tickets por transportador, com os filtros da Planilha1. Clique em qualquer número para ver os casos com o link e exportar.",
    ], "Tipo \"Reposição\" = pré-entrega; \"Reposição Pós Entrega\" = pós-entrega. Transportadora = redespacho (coluna R) se tiver, senão a coluna Q. Status Resolvido ou Encerrado = finalizado. Ticket na fila Recuperação de crédito = pendente de solução da Recuperação de crédito (não conta como em aberto)."],

    ["alterar", "Alterar pedidos", "Onde a Logística manda os robôs alterarem a Intelipost e o Multi360. Tem 6 botões no alto; cada um abre uma tela.", "Todo dia.", [
      "<b>📅 Nova previsão de entrega</b>: escreva uma linha por pedido (<i>PEDIDO dd/mm/aaaa</i>) ou suba a planilha, ou clique em <b>↓ Trazer do Preventivo e SSW</b>. Confira a lista, clique em <b>➕ Colocar na fila</b> e, quando quiser que o robô altere, em <b>▶ Enviar para o robô</b>. Em \"O que o robô fez\" aparece o resultado (Alterado / Não alterou e o motivo). Datas vencidas, iguais à prometida ou antes dela ficam de fora.",
      "<b>⇄ Ajuste Intelipost</b> (troca de notas): <b>⇪ Subir detalhamento_tickets</b> (aba Reposições). Clique no ticket para ver nova NF, série, chave, data e método; marque as etapas e quem pegou. Parcial não mexe nos volumes; Total altera todos; série 4 só ação no ticket.",
      "<b>🚚 Fila Aguardando entrega</b> e <b>🔧 Aguardando entrega AT</b>: extraia o relatório da fila no Multi360 e clique em <b>⇪ Subir relatório</b>. O robô abre cada ticket, pega a nova NF no chat, confere o rastreio e, se entregue, dá baixa \"Nota entregue?\" → Sim com o print. Trate os cards <b>Não entregues</b> e <b>Conferir à mão</b> e escreva a observação.",
      "<b>⇄ Transportadora divergente</b>: compara a transportadora da Intelipost com a do Promob. Trate os <b>Divergentes</b> e cadastre transportadora nova em <b>Transportadoras e apelidos</b>. O Excel tem a aba de resumo e a aba <b>Pedidos</b> com a lista completa.",
      "<b>⚑ Ocorrências</b>: pedidos com destinatário ausente, endereço não localizado, aguardando instrução, mudou-se, carga recusada ou estabelecimento fechado. Clique em <b>Mandar pendentes para o robô</b> (ele cadastra no portal 360multi a cada 10 min) ou baixe os templates e cadastre à mão. Depois, <b>Enviar ocorrências cadastradas</b> com a planilha do dia.",
    ], "Tudo que vai para a Intelipost ou o Multi360 pede confirmação antes. Se o robô parar, aparece um aviso vermelho no alto da tela."],

    ["conferencia", "Conferência SSW", "O robô confere no rastreio (SSW, Jadlog, Bento, Trânsito, Transiga) se os pedidos em aberto na Intelipost já foram entregues.", "Todo dia, para dar baixa na Intelipost.", [
      "Envie o arquivo transactions da Intelipost no botão <b>Enviar Intelipost</b>, no topo: ele já alimenta a Conferência SSW.",
      "O robô confere sozinho: de 30 em 30 min das 6h às 18h e de 2 em 2 h à noite. Para conferir na hora, <b>🔄 Conferir tudo agora</b>.",
      "Trate o card <b>Falta atualizar a Intelipost</b> (entregue no rastreio, mas não na Intelipost).",
      "Use <b>Ver no SSW</b> para abrir o rastreio da nota; na Jadlog abre uma janela com o histórico.",
      "<b>Senhas do SSW</b>: cadastre a senha de rastreio das transportadoras que pedem (ex.: Trans Sua, VM, Aceville, Flog).",
    ], "\"Sem CT-e ainda\" = a transportadora ainda não emitiu o CT-e. VM Transportes e Tempo Justo são a mesma transportadora. Para Dominalog, Tempo Justo, Trans Sua e Transvanio (séries 25, 34, 35) vale o rastreio da Dominalog; Rajlog é só milk run."],

    ["documentos", "Gerar XML", "Acha a chave das notas e monta o PDF (DANFE) e o XML para mandar às transportadoras.", "Quando a transportadora pede o PDF/XML da nota.", [
      "Digite a nota em <b>Digite a nota</b> (ex.: <i>12365-35</i>) e aperte Enter, ou suba a planilha com NF e Transportadora (<b>Modelo da planilha</b>).",
      "Em cada nota, clique em <b>Copiar chave ↗</b>: a chave é copiada e abre o site de consulta. Cole a chave, resolva o captcha e baixe o XML.",
      "Clique em <b>Enviar XMLs</b> e escolha os XMLs baixados (pode ser vários ou um .zip).",
      "Em <b>Por transportadora</b>, clique em <b>Baixar .zip</b> (XML + PDF de cada nota) e mande para a transportadora.",
    ], "Os XMLs ficam só no seu computador; nada vai para o banco."],

    ["barrar", "Barrar entrega (em Alterar pedidos)", "Confere as notas que o Multi pediu para barrar: rastreio (status atual em devolução) e anotações da transportadora no portal.", "Quando chega a planilha de tickets Barrar entrega.", [
      "Clique em <b>Enviar planilha</b> e escolha a planilha de tickets <b>Barrar entrega</b>.",
      "Clique em <b>Conferir agora</b>: o robô olha o rastreio e as anotações do portal e tira print da anotação.",
      "Confira a <b>Sugestão do robô</b>, marque as notas e clique em <b>Aprovar sugestão</b> (ou escolha a decisão na linha).",
      "Clique em <b>Mandar para o portal</b>: o robô aperta o ✓ (barrado) ou o ✗ (não barrado, com opção e motivo) só nas aprovadas.",
      "Card <b>Erro: verificar</b>: mostra um quadrinho por transportadora com as notas que ela ainda não atuou (dias pendentes e último status). Use <b>Copiar mensagem</b> ou <b>WhatsApp</b> para cobrar e <b>Excel</b> para mandar a lista. Acima dos quadrinhos, o quadro <b>Com anotação da transportadora no portal</b> mostra as notas em que a transportadora escreveu algo no portal (todas as anotações, mais recente primeiro, com o print) para você ler e escolher a <b>Decisão</b> de cada uma (fica em rascunho; ✗ já vem com a anotação como motivo). No fim, clique em <b>Enviar decisões para o robô</b>: salva tudo de uma vez e o robô marca no portal.",
    ], "Transportadora diferente entre o pedido e o portal aparece no card <b>Transportadora diferente</b>. Os entregues no rastreio o robô aprova e aplica sozinho; o resto só com a sua aprovação. O quadro <b>Envios ao portal</b> mostra cada envio por horário, separando o que você aprovou e o que o robô fez sozinho."],

    ["sac", "Consulta SAC", "Consulta para o SAC: pedidos vencidos ou que vencem hoje/amanhã, com a nova data e a observação da Logística.", "Quando o cliente pergunta do pedido.", [
      "Busque pelo pedido ou NF, ou use os cards <b>Já vencidos</b>, <b>Vencem hoje</b>, <b>Vencem amanhã</b>.",
      "Leia a <b>Nova data</b> e a <b>Observação</b> que a Logística informou.",
      "<b>Baixar Excel</b> leva a lista.",
    ], "Quem é do SAC entra vendo só esta consulta, sem editar nada."],

    ["logins", "Logins", "Quem entra no E-loggia (só administradores veem).", "Quando entra ou sai alguém, ou alguém esquece a senha.", [
      "Login novo: no Supabase › Authentication › Users › <b>Add user</b> › Create new user (marque <b>Auto Confirm User</b>) e passe o e-mail e a senha para a pessoa.",
      "Esqueceu a senha: clique em <b>Gerar senha provisória</b> e passe para a pessoa; no primeiro acesso ela cria uma senha dela.",
      "Para limitar o que a pessoa vê: clique em <b>Escolher abas</b> na linha dela, marque as abas e salve. Tudo marcado = todas as abas. Vale no próximo acesso dela (ou Ctrl+F5). Administradores sempre veem tudo.",
      "Para alguém ver só a Consulta SAC, adicione o e-mail em <b>Logins do SAC</b>.",
    ], ""],
  ];
  const ICONE = { rotina: "★", gerencial: "▦", entregas: "✓", transp: "🚚", uf: "⌖", canais: "◎", preventivo: "◷", responsaveis: "👤", reposicao: "↻", alterar: "✎", conferencia: "☑", documentos: "🗎", barrar: "⛔", sac: "☎", logins: "🔑" };
  const sec = ([id, tit, serve, quando, passos, atencao]) => `
    <details class="cartao aj-sec" data-aj="${id}"${id === "rotina" ? " open" : ""}>
      <summary><span class="aj-ic">${ICONE[id] || "•"}</span><b>${tit}</b><span class="sub"> · ${serve}</span></summary>
      <div class="aj-corpo">
        <p><b>Para que serve:</b> ${serve}</p>
        <p><b>Quando usar:</b> ${quando}</p>
        <ol>${passos.map((x) => `<li>${x}</li>`).join("")}</ol>
        ${atencao ? `<p class="aj-atencao">⚠ ${atencao}</p>` : ""}
        ${id !== "rotina" ? `<p><button class="link" data-ir="${id === "documentos" ? "documentos" : id}">Abrir a aba ${tit} ›</button></p>` : ""}
      </div>
    </details>`;
  el.innerHTML = `
    <div class="titulo-pagina com-acoes">
      <div>
        <h1>Passo a passo</h1>
        <p class="sub">Como usar cada aba do E-loggia. Comece pela <b>Rotina do dia</b>. Clique no nome da aba para abrir as instruções.</p>
      </div>
      <div class="acoes-robo">
        <input id="aj-busca" type="search" placeholder="Procurar (ex.: nova data, SSW, ocorrência)">
        <button id="aj-abrir" class="btn contorno" type="button">Abrir tudo</button>
        <button id="aj-imprimir" class="btn contorno" type="button">Imprimir / PDF</button>
      </div>
    </div>
    ${A.map(sec).join("")}`;
  const busca = el.querySelector("#aj-busca");
  busca.addEventListener("input", () => {
    const q = busca.value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    el.querySelectorAll(".aj-sec").forEach((d) => { const t = d.textContent.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); const ok = !q || t.includes(q); d.hidden = !ok; if (q && ok) d.open = true; });
  });
  el.querySelector("#aj-abrir").addEventListener("click", (e) => { const abrir = e.target.textContent === "Abrir tudo"; el.querySelectorAll(".aj-sec").forEach((d) => (d.open = abrir)); e.target.textContent = abrir ? "Fechar tudo" : "Abrir tudo"; });
  el.querySelector("#aj-imprimir").addEventListener("click", () => { el.querySelectorAll(".aj-sec").forEach((d) => (d.open = true)); setTimeout(() => window.print(), 100); });
  el.addEventListener("click", (e) => { const b = e.target.closest("[data-ir]"); if (!b) return; const m = document.querySelector(`.menu-item[data-pagina="${b.dataset.ir}"]`); if (m) m.click(); });
  // botão "❔" do topo: abre o passo a passo já na aba em que a pessoa está
  window.__abrirAjuda = (pag) => { const m = document.querySelector('.menu-item[data-pagina="ajuda"]'); if (m) m.click();
    const d = el.querySelector(`.aj-sec[data-aj="${pag === "ocorrencias" || pag === "divtp" ? "alterar" : pag}"]`); if (d) { d.open = true; setTimeout(() => d.scrollIntoView({ behavior: "smooth", block: "start" }), 50); } };
})();
