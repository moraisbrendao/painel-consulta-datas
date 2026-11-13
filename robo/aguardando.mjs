// Fila Aguardando entrega (aba Alterar pedidos): para cada ticket do relatório enviado no painel,
// 1) lê no chat do ticket no Multi360 a nova NF ("NF 123-7 emitida para o pedido");
// 2) confere essa NF no rastreio (SSW com a senha da transportadora, Jadlog pela API, Bento Brasil, Trânsito Brasil);
// 3) se entregue (com data de entrega depois da emissão da NF): print do rastreio + "Executar ação no ticket" →
//    "Nota entregue?" → mensagem + print → Sim (no modo aguardando-teste clica Cancelar);
// 4) insucesso na entrega (ausente, endereço não localizado, mudou-se, recusa, fechado) fica marcado para a aba Ocorrências.
// Registro público (Actions): só contagens. Nunca ticket, NF, nome, endereço ou o print (o print fica no runner e some no fim).
import { chromium } from "playwright";
import { entrarMulti360, lerChatTicket, executarAcao } from "./multi360.mjs";

const INSUCESSO = [[/AUSENTE/, "DESTINATÁRIO AUSENTE"], [/MUDOU/, "DESTINATÁRIO MUDOU-SE"], [/RECUS/, "CARGA RECUSADA PELO DESTINATARIO"],
  [/FECHAD/, "ESTABELECIMENTO FECHADO"], [/(ENDERE[CÇ]O|LOCAL).*(N[AÃ]O\s*(LOCALIZAD|ENCONTRAD)|INSUFICIENTE|INCORRET|INEXISTENTE|ERRAD)|N[AÃ]O\s*LOCALIZAD/, "ENDEREÇO NÃO LOCALIZADO"]];
const insucessoDe = (ev) => { const t = String(ev || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase(); const a = INSUCESSO.find(([re]) => re.test(t)); return a ? a[1] : null; };
const FORA = /transiga|formato/i;   // não usam SSW (regra da Brenda) e ainda não temos o rastreio delas
// a transportadora que emitiu o CT-e no SSW é a do ticket? (compara as palavras do nome, sem as genéricas)
const GEN = /^(TRANS|TRANSPORTES?|TRANSPORTADORA|LOGISTICA|LOG|LTDA|EIRELI|EXPRESS|EXPRESSO|CARGAS?|FILIAL|MATRIZ|STANDARD|SERVICOS|E|DE|DO|DA|ME|SA|S\/A)$/;
const palavras = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3 && !GEN.test(w));
const mesmaTransp = (emissor, tp) => { const a = palavras(emissor), b = new Set(palavras(tp)); return a.some((w) => b.has(w)); };
// primeira rodada é sempre teste (Cancelar): só libero o Sim depois de conferir o resultado do teste
const LIBERADO = !!Number(process.env.SSW_LIMITE || 0);   // por enquanto: Sim só nas rodadas com limite (Brenda liberou os 10 do teste em 13/11)
const BR = (iso) => iso ? iso.split("-").reverse().join("/") : "";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function rodar(R) {
  const { chamar, log, jadlog, bento, transito, pagina, lerEntrega, cnpjDaSerie, chaveDe, carregarSenhasDB, sohTexto, EH_JADLOG, EH_BENTO, EH_TRANSITO, MODO } = R;
  const REAL = MODO === "aguardando" && LIBERADO;
  const LIMITE = Number(process.env.SSW_LIMITE || 0);
  await carregarSenhasDB();
  let L = [];
  for (let de = 0; ; de += 1000) { const P = await chamar(`aguardando_entrega?select=*&na_planilha=eq.true&or=(baixa_status.is.null,baixa_status.neq.feita)&order=ticket_criado.asc.nullslast,ticket&limit=1000&offset=${de}`); L.push(...P); if (P.length < 1000) break; }
  if (LIMITE) L = L.slice(0, LIMITE);
  log(`Aguardando entrega: ${L.length} ticket(s) para olhar · ${REAL ? "DE VERDADE (clica Sim)" : "TESTE (clica Cancelar)"}`);
  if (!L.length) return;
  const grava = async (linhas) => { for (let i = 0; i < linhas.length; i += 50) await chamar("rpc/gravar_aguardando", "POST", { linhas: linhas.slice(i, i + 50) }).catch((e) => log("Não gravei um lote:", e.message.slice(0, 120))); };

  const nav = await chromium.launch({ headless: true });
  const ctx = await nav.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  try {
    // 1) nova NF no chat do ticket (só de quem ainda não tem)
    const ler = L.filter((t) => !t.nf_nova);
    let p = null;
    if (ler.length) {
      p = await entrarMulti360(ctx, log);
      const lote = []; let erros = 0;
      for (const t of ler) {
        try {
          const c = await lerChatTicket(p, t.ticket); erros = 0;
          const x = { ticket: t.ticket, fila_360: c.fila || null, transp_chat: c.transp || null };
          if (c.nf) { x.nf_nova = c.nf; x.nf_emitida_em = c.em || null; Object.assign(t, x); soma("NF achada no chat"); }
          else { x.situacao = "sem nf nova"; soma("sem NF no chat"); }
          if (c.nfs > 1) soma("ticket com mais de uma NF no chat (usei a última)");
          lote.push(x);
        } catch (e) { soma("não abriu o ticket"); lote.push({ ticket: t.ticket, situacao: "sem nf nova", fila_360: "não abriu no Multi360" }); if (++erros >= 8) { log("Multi360: 8 tickets seguidos sem abrir; paro a leitura."); break; } }
        if (lote.length >= 20) await grava(lote.splice(0));
      }
      await grava(lote);
    }

    // 2) rastreio da nova NF: primeiro pela transportadora do ticket, depois procura nas outras
    const com = L.filter((t) => t.nf_nova);
    const tp = (t) => `${t.transp_chat || ""} / ${t.transportadora || ""}`;
    const fontes = {
      jadlog: { nome: "Jadlog", fn: process.env.JADLOG_TOKEN ? (it) => jadlog(it) : null },
      bento: { nome: "Bento Brasil", fn: (it) => bento(it) },
      transito: { nome: "Trânsito Brasil", fn: (it) => transito(it) },
      ssw: { nome: "SSW", fn: async (it) => { const out = new Map();
        for (const l of it) { const [num, ser] = String(l.nf || "").split("-").map((x) => (x || "").trim()), c = cnpjDaSerie(ser);
          if (!num || !c) { out.set(l.pedido, { situacao: "sem nf" }); continue; }
          const pg = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: c, NR: num, chave: l.chave || "" }).toString() }).catch(() => null);
          if (pg && pg.status === 200) { const r = lerEntrega(pg.txt);
            // entregue: quem emitiu o CT-e no SSW (para não dar baixa com a entrega da transportadora de first mile)
            const det = r.situacao === "entregue" && (pg.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1];
            if (det) { await new Promise((ok) => setTimeout(ok, 2500)); const d = await pagina("https://ssw.inf.br" + det).catch(() => null);
              r.emissor = d && ((sohTexto(d.txt).join("\n").match(/transportando a sua mercadoria:\s*([^\n]+)/i) || [])[1] || "").trim().slice(0, 60) || null; }
            out.set(l.pedido, r); }
          else if (pg && (pg.status === 403 || pg.status === 429)) { log("SSW bloqueou; espero 5 min."); await new Promise((ok) => setTimeout(ok, 300000)); }
          await new Promise((ok) => setTimeout(ok, 3000)); }
        return out; } },
    };
    const primeira = (t) => EH_JADLOG.test(tp(t)) ? "jadlog" : EH_BENTO.test(tp(t)) ? "bento" : EH_TRANSITO.test(tp(t)) ? "transito" : FORA.test(tp(t)) ? null : "ssw";
    const resultado = new Map(); const falta = new Map();   // ticket -> fontes ainda a tentar
    for (const t of com) { const f = primeira(t); falta.set(t.ticket, [f, ...["ssw", "jadlog", "transito"].filter((x) => x !== f && !(x === "ssw" && FORA.test(tp(t))))].filter(Boolean)); }
    for (let rodada = 0; rodada < 4; rodada++) {
      for (const k of Object.keys(fontes)) {
        const it = com.filter((t) => !resultado.has(t.ticket) && (falta.get(t.ticket) || [])[0] === k);
        if (!it.length) continue;
        if (!fontes[k].fn) { it.forEach((t) => falta.get(t.ticket).shift()); continue; }
        const m = await fontes[k].fn(it.map((t) => ({ pedido: t.ticket, nf: t.nf_nova, transportadora: tp(t), chave: k === "ssw" ? chaveDe(t.transp_chat) || chaveDe(t.transportadora) : "" })));
        for (const t of it) { falta.get(t.ticket).shift(); const r = m.get(t.ticket);
          if (r && !/^(sem cte|sem nf|sem permissao)$/.test(r.situacao)) resultado.set(t.ticket, { ...r, fonte: fontes[k].nome });
          else if (r && !t._primeiro) t._primeiro = { ...r, fonte: fontes[k].nome }; }
      }
    }
    const linhas = [];
    for (const t of com) {
      const r = resultado.get(t.ticket) || t._primeiro || { situacao: FORA.test(tp(t)) ? "sem rastreio" : "sem cte" };
      const ev = r.ultimo_evento || (r.detalhe && r.detalhe.eventos && r.detalhe.eventos.length ? r.detalhe.eventos[r.detalhe.eventos.length - 1].status : null);
      const ins = r.situacao === "nao entregue" ? insucessoDe(ev) : null;
      Object.assign(t, { situacao: r.situacao, fonte: r.fonte || null, ultimo_evento: ev || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, insucesso: ins, detalhe: r.detalhe || null, _r: r });
      soma(`rastreio: ${r.situacao}${r.fonte ? " (" + r.fonte + ")" : ""}`); if (ins) soma("insucesso na entrega → Ocorrências");
      linhas.push({ ticket: t.ticket, situacao: t.situacao, fonte: t.fonte, ultimo_evento: t.ultimo_evento, data_evento: t.data_evento, data_entrega: t.data_entrega, insucesso: ins, detalhe: t.detalhe });
    }
    await grava(linhas);

    // 3) entregue: print do rastreio e "Nota entregue?" → Sim
    const ent = com.filter((t) => t.situacao === "entregue");
    if (ent.length && !p) p = await entrarMulti360(ctx, log);
    const lote = [];
    for (const t of ent) {
      const emi = t.nf_emitida_em ? t.nf_emitida_em.slice(0, 10) : null;
      if (!t.data_entrega || (emi && t.data_entrega < emi)) { soma("entregue sem data confiável (conferir à mão)"); lote.push({ ticket: t.ticket, baixa_status: "conferir", baixa_msg: !t.data_entrega ? "O rastreio diz entregue, mas sem a data da entrega." : "A data de entrega do rastreio é de antes da emissão da nova NF." }); continue; }
      if (t.fonte === "SSW" && !(t._r.emissor && mesmaTransp(t._r.emissor, tp(t)))) { soma("entregue no SSW por outra transportadora (conferir à mão)"); lote.push({ ticket: t.ticket, baixa_status: "conferir", baixa_msg: t._r.emissor ? `O SSW mostra a entrega pela ${t._r.emissor}, que não é a transportadora do ticket (pode ser a de first mile).` : "Não consegui ver no SSW qual transportadora fez a entrega." }); continue; }
      const arq = `/tmp/ag-${Date.now()}.png`;
      try {
        await printRastreio(ctx, t, arq, { cnpjDaSerie, chaveDe, pagina });
        const msg = `Nota ${t.nf_nova} entregue em ${BR(t.data_entrega)} conforme rastreio (${t.fonte}).`;
        const r = await executarAcao(p, t.ticket, { titulo: /Nota entregue\?/i, msg, print: arq, real: REAL });
        soma(REAL ? "baixa feita (Sim)" : "teste da baixa ok (Cancelar)");
        lote.push({ ticket: t.ticket, baixa_status: REAL ? "feita" : "teste", baixa_msg: REAL ? `Nota entregue → Sim${r.fila ? ` · fila agora: ${r.fila}` : ""}` : "Teste: caixinha \"Nota entregue?\" achada, print anexado e Cancelar." });
      } catch (e) { soma("baixa com erro"); log("  erro na baixa:", String(e.message || e).split("\n")[0].replace(/\d{5,}/g, "#").slice(0, 200)); lote.push({ ticket: t.ticket, baixa_status: "erro", baixa_msg: String(e.message || e).split("\n")[0].replace(/\d{5,}/g, "#").slice(0, 200) }); }
      if (lote.length >= 10) await grava(lote.splice(0));
    }
    await grava(lote);
  } finally { await nav.close().catch(() => {}); }
  log("Aguardando entrega:", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · ") || "nada");
}

// print do rastreio que mostra a entrega: a própria página do SSW ou da Bento; Jadlog e Trânsito Brasil: relatório do rastreio (API)
async function printRastreio(ctx, t, arq, { cnpjDaSerie, chaveDe, pagina }) {
  const pg = await ctx.newPage();
  try {
    const [num, ser] = String(t.nf_nova).split("-");
    const posta = async (url, campos) => {
      await pg.setContent(`<form id="f" method="POST" action="${url}">${Object.entries(campos).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}</form>`);
      await Promise.all([pg.waitForNavigation({ timeout: 45000 }), pg.evaluate(() => document.getElementById("f").submit())]);
      await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    };
    if (t.fonte === "SSW") {
      // a mesma página que o robô leu (o navegador do runner não abre o SSW igual): HTML do resultado com os estilos do SSW
      const r = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: cnpjDaSerie(ser), NR: num, chave: chaveDe(t.transp_chat) || chaveDe(t.transportadora) || "" }).toString() });
      if (!/MERCADORIA ENTREGUE|ENTREGA REALIZADA/i.test(r.txt)) throw new Error("a página do SSW não mostrou a entrega para o print");
      await pg.setViewportSize({ width: 1100, height: 700 });
      await pg.setContent(r.txt.replace(/<head[^>]*>/i, (h) => h + '<base href="https://ssw.inf.br/2/">'), { waitUntil: "load", timeout: 30000 }).catch(() => {});
      await pg.waitForTimeout(1500);
    } else if (t.fonte === "Bento Brasil") {
      await posta("https://sistema.bentobrasil.com.br/consultaNotas.php", { nr: "00349443000192", nrNota: num });
    } else {
      const d = t.detalhe || {}, ev = d.eventos || [];
      await pg.setViewportSize({ width: 900, height: 600 });
      await pg.setContent(`<html><body style="font:14px Arial,sans-serif;margin:24px;color:#1b2540">
        <h2 style="margin:0 0 4px">Rastreio ${esc(t.fonte)}</h2>
        <div style="color:#667">Consulta no sistema da transportadora em ${esc(new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))}</div>
        <table style="margin:16px 0;border-collapse:collapse">
          <tr><td style="padding:3px 12px 3px 0;color:#667">Nota fiscal</td><td><b>${esc(t.nf_nova)}</b></td></tr>
          ${d.codigo ? `<tr><td style="padding:3px 12px 3px 0;color:#667">Código</td><td>${esc(d.codigo)}</td></tr>` : ""}
          ${d.cte ? `<tr><td style="padding:3px 12px 3px 0;color:#667">CT-e</td><td>${esc(d.cte)}</td></tr>` : ""}
          <tr><td style="padding:3px 12px 3px 0;color:#667">Situação</td><td><b style="color:#0a7a3b">ENTREGUE em ${esc(BR(t.data_entrega))}</b></td></tr>
        </table>
        <table style="border-collapse:collapse;width:100%">
          <tr style="background:#eef1f7"><th style="text-align:left;padding:6px">Data</th><th style="text-align:left;padding:6px">Evento</th><th style="text-align:left;padding:6px">Unidade</th></tr>
          ${ev.map((e) => `<tr><td style="padding:6px;border-top:1px solid #e3e6ee">${esc(e.data)}</td><td style="padding:6px;border-top:1px solid #e3e6ee">${esc(e.status)}</td><td style="padding:6px;border-top:1px solid #e3e6ee">${esc(e.unidade)}</td></tr>`).join("")}
        </table></body></html>`);
    }
    await pg.screenshot({ path: arq, fullPage: true });
  } finally { await pg.close().catch(() => {}); }
}
