// Troca de notas (reposição TOTAL): DE × PARA das transportadoras (Promob -> método de entrega na Intelipost).
// Tabela passada pela Logística em 12/11/2026 ("ajuste intelipost.docx"). A SÉRIE da nova nota decide o método.
// Colunas: [ID do método, Método de entrega (Intelipost), Transportadora, Apelido (Promob), Séries]
// Transvanio: o apelido no Promob é o nome do MEI; aqui casamos só pelo CNPJ (44.657.205), sem guardar o nome.
(function () {
  const DEPARA = [
    [230, "Aceville Standard", "Aceville", "Aceville", "7-31-4-35-36"],
    [22615, "Atual Cargas Filial SP", "Atual Cargas", "Atual Cargas", "25-34-35-36"],
    [33, "Atual Cargas Standard", "Atual Cargas", "Atual Cargas", "7-31-4-35-36"],
    [1345, "Bento Brasil", "Bento Brasil", "Bento Brasil", "7-31-4-35-36"],
    [20844, "Costa Transportes", "Costa Transportes", "Costa Transportes", ""],
    [21816, "Dlog Standard", "DLOG Transportes", "DLOG Transportes", "7-31-4-35-36"],
    [17467, "Dominalog - Filial MG", "Dominalog", "Dominalog", "24"],
    [18383, "Dominalog - Filial PE", "Dominalog", "Dominalog", "14"],
    [196, "Dominalog Express", "Dominalog", "Dominalog", "7-31-4-35-36"],
    [22614, "Dominalog Filial SP", "Dominalog", "Dominalog", "25-34-35-36"],
    [19510, "Dominalog Sul", "Dominalog", "Dominalog", "7-31-4-35-36"],
    [22576, "FLOG Filial SP", "Flog Transportes", "Flog Transportes", "25-34-35-36"],
    [4946, "Flog Transportes", "Flog Transportes", "Flog Transportes", "302"],
    [20684, "Flog Transportes - Matriz", "Flog Transportes", "Flog Transportes", "7-31-4-35-36"],
    [880, "Formato Transportes Standard", "Formato Transportes", "Formato Transportes", "25-34-35-36"],
    [15578, "IDH Transportes", "IDH Transportes", "IDH Transportes", "25-34-35-36"],
    [22, "JadLog Standard", "JadLog", "LDC", "7-31-4-35-36"],
    [21601, "MF Transportes", "MF Transportes", "MF Transportes", "25-34-35-36"],
    [20028, "MULTI ENTREGAS", "Frota Interna", "Frota Interna", "7-31-4-35-36"],
    [10897, "Petrymar Transportes", "Petrymar", "Petrymar", "7-31-4-35-36"],
    [9704, "PROLOG TRANSPORTES", "PROLOG TRANSPORTES E LOGISTICA LTDA", "PROLOG TRANSPORTES E LOGISTICA LTDA", "7-31-4-35-36"],
    [17301, "PROLOG TRANSPORTES FILIAL RJ", "PROLOG TRANSPORTES E LOGISTICA LTDA", "PROLOG TRANSPORTES E LOGISTICA LTDA", "25"],
    [23558, "RAJLOG SERVICO LOGISTICO", "RAJLOG SERVICOS LOGISTICOS", "RAJLOG SERVICOS LOGISTICOS", "25-34-35-36"],
    [22359, "Rapido Alem Paraiba - Standard", "Rapido Alem Paraiba", "Rapido Alem Paraiba", "7-31-4-35-36"],
    [22579, "Rapido Alem Paraiba Filial SP", "Rapido Alem Paraiba", "Rapido Alem Paraiba", "25-34-35-36"],
    [149, "Reunidas Standard", "Reunidas", "Reunidas", "7-31-4-35-36"],
    [16749, "SAJOB", "SAJOB OPERACOES E LOGISTICAS LTDA", "SAJOB OPERACOES E LOGISTICAS LTDA", "7-31-4-35-36"],
    [22578, "TEMPO JUSTO MATRIZ", "VM TRANSPORTES", "VM TRANSPORTES", "7-31-4-35-36"],
    [76, "Termaco Standard", "Termaco", "Termaco", "7-31-4-35-36"],
    [17241, "TRADICIONAL LOG", "Tradicional Log", "Tradicional Log", "25-34-35-36"],
    [20871, "Trans Sua Log - Matriz", "Trans Sua Log", "JS Oliveira", "7-31-4-35-36"],
    [15128, "Trans Sua Log - Standard", "Trans Sua Log", "JS Oliveira", "25-34-35-36"],
    [21511, "TRANSCAI TRANSPORTES", "TRANSCAI TRANSPORTES", "TRANSCAI TRANSPORTES", "7-31-4-35-36"],
    [22613, "TRANSCAÍ SC", "TRANSCAI TRANSPORTES", "TRANSCAI TRANSPORTES", "7-31-4-35-36"],
    [22575, "TRANSIGA FILIAL SP", "Transiga", "Via Cargas", "25-34-35-36"],
    [16087, "Transiga Standard", "Transiga", "Via Cargas", "7-31-4-35-36"],
    [617, "Transito Brasil Standard", "Transito Brasil", "HB Transportes", "7-31-4-35-36"],
    [624, "Translaguna", "Translaguna", "Translaguna", "7-31-4-35-36"],
    [256, "Translovato Standard", "Translovato", "Translovato", "7-31-4-35-36"],
    [14980, "Transportadora BLZ", "Transportadora BLZ", "BLZ", "7-31-4-35-36"],
    [20062, "Transvanio", "Transvanio", "CNPJ 44657205", "25-34-35-36"],
    [21758, "TRANSVANIO - MATRIZ", "Transvanio", "CNPJ 44657205", "7-31-4-35-36"],
    [21211, "Trilog Express", "Trilog Express", "Trilog Express", "25-34-35-36"],
    [22577, "TSL Filial SP", "TSL Transportes", "LLS", "25-34-35-36"],
    [18001, "TSL Transportes", "TSL Transportes", "LLS", "303"],
    [20252, "TSL Transportes - Sul", "TSL Transportes", "LLS", "7-31-4-35-36"],
    [601, "VM TRANSPORTES", "VM TRANSPORTES", "VM TRANSPORTES", "7-31-4-35-36"],
    [22950, "Zafer Standard", "Zafer Standard", "Zafer Standard", "25-34-35-36"],
    [20686, "Zelog - Matriz", "Zelog Transportes", "Zelog Transportes", "301"],
    [19536, "Zelog Standard", "Zelog Transportes", "Zelog Transportes", "7-31-4-35-36"],
    [21436, "Zelog Transportes", "Zelog Transportes", "Zelog Transportes", "25-34-35-36"],
    [18105, "Anjun Express", "Anjun Express", "Anjun Express", "7-31-4-35-36"],
    [23677, "Anjun Express Matriz", "Anjun Express", "Anjun Express", "25-34-35-36"],
    [23678, "Passaro transportes", "Passaro transportes", "Passaro transportes", "25-34-35-36"],
  ].map(([id, metodo, transp, apelido, series]) => ({ id, metodo, transp, apelido, series: series ? series.split("-").map((s) => s.trim()) : [] }));

  // palavras que não ajudam a reconhecer a transportadora
  const GEN = new Set(["LTDA", "ME", "EPP", "SA", "S", "A", "E", "DE", "DA", "DO", "DOS", "EIRELI", "TRANSPORTE", "TRANSPORTES", "TRANSPORTADORA",
    "LOGISTICA", "LOGISTICAS", "LOGISTICO", "CARGAS", "CARGA", "SERVICO", "SERVICOS", "OPERACOES", "RODOVIARIA", "INTEGRADA", "ARMA", "ARMAZENAGEM"]);
  // palavras do nome do método que só dizem matriz/filial
  const LOCAL = new Set(["STANDARD", "MATRIZ", "FILIAL", "SP", "MG", "PE", "RJ", "SC", "SUL"]);
  const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  function palavras(t) {
    const brutas = semAcento(t).replace(/[^A-Z0-9]+/g, " ").trim().split(" ").filter(Boolean);
    const juntas = []; // "J S DE OLIVEIRA" -> "JS OLIVEIRA"; "G.I." -> "GI"
    for (const w of brutas) { if (w.length === 1 && juntas.length && /^[A-Z]+$/.test(juntas[juntas.length - 1]) && juntas[juntas.length - 1].length <= 2 && juntas.solta) { juntas[juntas.length - 1] += w; } else { juntas.push(w); } juntas.solta = w.length === 1 || (juntas[juntas.length - 1].length <= 2 && w.length === 1); }
    return juntas.filter((w) => !GEN.has(w) || w === "A");
  }
  const contem = (todas, parte) => parte.length > 0 && parte.every((w) => todas.includes(w));
  const tiraLocal = (ws) => ws.filter((w) => !LOCAL.has(w));

  // nome da transportadora no Promob + série da nova nota -> método na Intelipost
  // G.I. e Zarpelog só levam até o redespacho: vale sempre a transportadora de redespacho (regra da Logística, 12/11/2026)
  const SO_COLETA = ["GI", "ZARPELOG"];
  function transpDaTroca(redespacho, transpNota) {
    const r = String(redespacho || "").trim(), n = String(transpNota || "").trim();
    if (r) return { nome: r };
    if (n && palavras(n).some((w) => SO_COLETA.includes(w))) return { nome: "", erro: `Falta a transportadora de redespacho (${n} só leva até o redespacho).` };
    return { nome: n };
  }

  function metodoPara(nomePromob, serie) {
    const nome = String(nomePromob || "").trim();
    if (!nome) return { erro: "Sem transportadora na planilha (nem de redespacho nem da nota)." };
    const s = String(serie || "").replace(/^0+(?=\d)/, "").trim();
    const digitos = nome.replace(/\D/g, "");
    const pw = palavras(nome).filter((w) => w !== "A");
    const casa = (r) => {
      if (r.apelido.startsWith("CNPJ ")) return digitos.includes(r.apelido.slice(5));
      return contem(pw, tiraLocal(palavras(r.apelido))) || contem(pw, tiraLocal(palavras(r.transp))) || contem(pw, tiraLocal(palavras(r.metodo)));
    };
    const daTransp = DEPARA.filter(casa);
    if (!daTransp.length) return { erro: `"${nome}" não está no DE × PARA.` };
    const grupos = [...new Set(daTransp.map((r) => r.transp))];
    if (grupos.length > 1) {
      // mais de uma transportadora casou: fica com a que casou pelo nome do método (ex.: TEMPO JUSTO)
      const pelo = daTransp.filter((r) => contem(pw, tiraLocal(palavras(r.metodo))));
      if (new Set(pelo.map((r) => r.transp)).size !== 1) return { erro: `"${nome}" parece mais de uma transportadora (${grupos.join(", ")}).` };
    }
    let cands = daTransp.filter((r) => r.series.includes(s));
    if (!s) return { erro: "Sem a série da nova nota." };
    if (!cands.length) {
      const semSerie = daTransp.filter((r) => !r.series.length);
      if (semSerie.length === 1) return { ok: semSerie[0], aviso: "Esse método não tem série no DE × PARA." };
      return { erro: `Nenhum método de ${daTransp[0].transp} para a série ${s} no DE × PARA.` };
    }
    if (cands.length > 1) {
      // desempate: o método cujo nome tem mais palavras em comum com o nome do Promob (ex.: DOMINALOG EXPRESS, TEMPO JUSTO)
      const nota = (r) => palavras(r.metodo).filter((w) => pw.includes(w)).length;
      const melhor = Math.max(...cands.map(nota));
      const top = cands.filter((r) => nota(r) === melhor);
      if (top.length === 1) return { ok: top[0] };
      return { erro: `Mais de um método para a série ${s}: ${top.map((r) => r.metodo).join(" ou ")}. Escolha na hora.`, opcoes: top };
    }
    return { ok: cands[0] };
  }

  // prazo em dias úteis -> data (pula sábado e domingo; feriado NÃO, porque muda por estado e cidade)
  function somaDiasUteis(isoInicio, dias) {
    const d = new Date(isoInicio + "T12:00:00Z");
    let n = 0;
    while (n < dias) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return d.toISOString().slice(0, 10);
  }

  // Apelidos do Promob (coluna BD "Transportadora Promob" da base) -> apelido do DE × PARA + método padrão
  // (planilha "modelos_eloggia_ajuste tp", aba Apelidos, 13/11/2026). [chave procurada no nome do Promob, apelido, ID padrão]
  const APELIDOS = [
    ["Aceville", "Aceville"], ["Atual Cargas", "Atual Cargas", 33], ["Bento Brasil", "Bento Brasil"], ["Costa", "Costa Transportes"],
    ["Dlog", "DLOG Transportes"], ["Dominalog", "Dominalog", 196], ["Flog", "Flog Transportes", 4946], ["Formato", "Formato Transportes"],
    ["IDH", "IDH Transportes"], ["LDC", "LDC"], ["MF Almeida", "MF Transportes"], ["Frota Interna", "Frota Interna"], ["Petrymar", "Petrymar"],
    ["Prolog", "PROLOG TRANSPORTES E LOGISTICA LTDA", 9704], ["Rajlog", "RAJLOG SERVICOS LOGISTICOS"], ["Rapido Alem Paraiba", "Rapido Alem Paraiba", 22359],
    ["Reunidas", "Reunidas"], ["Sajob", "SAJOB OPERACOES E LOGISTICAS LTDA"], ["Tempo Justo", "VM TRANSPORTES", 601], ["Termaco", "Termaco"],
    ["Tradicional Log", "Tradicional Log"], ["J S De Oliveira", "JS Oliveira", 15128], ["Transcai", "TRANSCAI TRANSPORTES", 21511],
    ["Via Cargas", "Via Cargas", 22575], ["HB Transportes", "HB Transportes"], ["Translaguna", "Translaguna"], ["Translovato", "Translovato"],
    ["BLZ", "BLZ"], ["CNPJ 44657205", "CNPJ 44.657.205", 20062], ["Trilog", "Trilog Express"], ["LLS", "LLS", 18001], ["Zafer", "Zafer Standard"],
    ["Zelog", "Zelog Transportes", 19536], ["Anjun", "Anjun Express"], ["Passaro", "Passaro transportes"],
  ];
  const chaveAp = (t) => semAcento(t).replace(/[^A-Z0-9]+/g, " ").trim();
  // nome no Promob + série -> método certo na Intelipost (pela série; se a série não decidir, o ID padrão)
  function esperadoPromob(nomePromob, serie) {
    const nome = String(nomePromob || "").trim();
    if (!nome) return { erro: "sem transportadora no Promob" };
    const n = " " + chaveAp(nome) + " ", dig = nome.replace(/\D/g, "");
    const ap = APELIDOS.filter(([k]) => k.startsWith("CNPJ ") ? dig.includes(k.slice(5)) : n.includes(" " + chaveAp(k) + " ")).sort((a, b) => b[0].length - a[0].length)[0];
    if (!ap) return { erro: "não está no DE × PARA" };
    const rows = DEPARA.filter((r) => chaveAp(r.apelido) === chaveAp(ap[1]) || (ap[1].startsWith("CNPJ ") && r.apelido.startsWith("CNPJ ")));
    if (!rows.length) return { erro: "não está no DE × PARA" };
    const s = String(serie || "").replace(/^0+(?=\d)/, "").trim();
    const pela = rows.filter((r) => r.series.includes(s));
    if (pela.length === 1) return { ok: pela[0], grupo: rows };
    const pad = ap[2] && rows.find((r) => r.id === ap[2]);
    if (pad) return { ok: pad, grupo: rows, padrao: true };
    if (rows.length === 1) return { ok: rows[0], grupo: rows };
    return { erro: `mais de um método para a série ${s || "?"}`, grupo: rows };
  }
  // o nome da transportadora na Intelipost (coluna H) é de algum método desse grupo?
  function mesmaTransp(nomeIntelipost, grupo) {
    const pw = palavras(nomeIntelipost);
    return grupo.some((r) => contem(pw, tiraLocal(palavras(r.transp))) || contem(pw, tiraLocal(palavras(r.metodo))));
  }

  const api = { DEPARA, metodoPara, transpDaTroca, somaDiasUteis, palavras, esperadoPromob, mesmaTransp };
  if (typeof window !== "undefined") window.TROCA = api;
  if (typeof module !== "undefined") module.exports = api;
})();
