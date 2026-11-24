// Alterar pedidos › Nota não localizada (fila "Nota não localizada (Sem Emissão)" do Multi360).
// Para cada nota da planilha: olha o rastreio da transportadora (a do ticket: redespacho, se tiver) e executa a ação no ticket:
//   · ENTREGUE no rastreio → volta para o barrar + entra no Barrar entrega como "não barrado (Entregue)" (o robô do Barrar aplica no portal)
//   · está no rastreio      → volta para o barrar
//   · fora do rastreio e passou do prazo → seguir para cancelamento, comentário "Pedido não localizado em rastreio"
//       prazo (Brenda, 24/11): séries 35, 34 e 25 = 20 dias úteis; séries 7, 31 e 4 = 10 dias úteis (da criação do ticket); o rastreio é olhado todo dia
// Depois do cancelamento o robô continua olhando o rastreio (até 90 dias) e avisa no painel se aparecer CT-e.
// Registro público (GitHub): só contagens. Nada de nota, ticket ou nome no log.

import * as B from "./barrar.mjs";

const LIBERADO = true;   // Brenda liberou em 23/11 ("faça isso para o restante dos tickets") depois do teste em 3 tickets
const MSG = { voltar_barrar: "Pedido localizado em rastreio", entregue: "Pedido entregue conforme rastreio", cancelar: "Pedido não localizado em rastreio" };
// botões da caixinha "Executar ação no ticket" desta fila (diag-naoloc 23/11): Cancelar / Voltar para barrar / Seguir cancelamento.
// A caixinha não tem campo de texto: "Envie seu comentário antes de executar a ação" → o comentário vai antes, como Comentário Interno.
const OPCAO = { voltar_barrar: /^\s*voltar para barrar\s*$/i, entregue: /^\s*voltar para barrar\s*$/i, cancelar: /^\s*seguir cancelamento\s*$/i };
const FORA = /^(sem cte|sem nf|sem permissao)$/;

const diaISO = (d) => d.toISOString().slice(0, 10);
export function prazoAte(serie, criado) {
  if (!criado) return null;
  const d = new Date(String(criado).replace(" ", "T").slice(0, 19) + "-03:00");
  if (isNaN(d)) return null;
  const s = String(serie || "").replace(/^0+/, "");
  const du = { "35": 20, "34": 20, "25": 20, "7": 10, "31": 10, "4": 10 }[s];   // dias úteis (Brenda 24/11: 35, 34 e 25 = 20; 7, 31 e 4 = 10)
  if (du) { const x = new Date(d); let n = 0; while (n < du) { x.setDate(x.getDate() + 1); const w = x.getDay(); if (w !== 0 && w !== 6) n++; } return diaISO(x); }
  return null;
}
const hojeBR = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

export function sugerir(x, r) {
  const sit = r && r.situacao;
  if (sit === "entregue") return { sugestao: "entregue", motivo: `Entregue no rastreio ${r.fonte || ""}`.trim() };
  if (sit && !FORA.test(sit)) return { sugestao: "voltar_barrar", motivo: `Está no rastreio ${r.fonte || ""}${r.evento ? ": " + r.evento : ""}`.trim() };
  const ate = prazoAte(x.serie, x.ticket_criado);
  if (!ate) return { sugestao: "manual", motivo: `Fora do rastreio; série ${x.serie || "?"} sem regra de prazo`, prazo_ate: null };
  if (hojeBR() > ate) return { sugestao: "cancelar", motivo: `Fora do rastreio e passou do prazo (${ate.split("-").reverse().join("/")})`, prazo_ate: ate };
  return { sugestao: "aguardar", motivo: `Fora do rastreio; espera até ${ate.split("-").reverse().join("/")}`, prazo_ate: ate };
}

// 1) comentário interno (mensagem + print do rastreio); 2) "Executar ação no ticket" → botão da ação. No teste: não comenta e clica em Cancelar.
const filaDe = (p) => p.evaluate(() => (document.body.innerText.match(/Atribu[ií]do Fila:\s*([^\n]+)/i) || [])[1] || "").then((x) => x.trim());
async function executar(M, p, ticket, acao, print, real, jaComentou, marcarComentado) {
  await M.abrirTicket(p, ticket);
  const antes = await filaDe(p);
  if (antes && !/n[aã]o localizada/i.test(antes)) return real && jaComentou ? "feito" : "saiu";   // já saiu da fila (alguém ou uma rodada anterior fez)
  if (real && !jaComentou) { await M.comentarioInterno(p, ticket, MSG[acao], print ? [{ name: "rastreio.png", mimeType: "image/png", buffer: print }] : []); await marcarComentado(); }
  await M.abrirTicket(p, ticket);
  await p.getByRole("button", { name: /executar a[cç][aã]o no ticket/i }).first().click();
  const bt = p.getByRole("button", { name: OPCAO[acao] }).last();
  try { await bt.waitFor({ timeout: 15000 }); }
  catch { const c = p.getByRole("button", { name: /^\s*cancelar\s*$/i }).last(); if (await c.count()) await c.click().catch(() => {}); else await p.keyboard.press("Escape").catch(() => {});
    throw new Error("a caixinha da ação não tem o botão esperado (Voltar para barrar / Seguir cancelamento)"); }
  if (!real) { await p.getByRole("button", { name: /^\s*cancelar\s*$/i }).last().click().catch(() => p.keyboard.press("Escape")); return "teste"; }
  await bt.click(); await p.waitForTimeout(2500);
  // se aparecer uma confirmação, confirma
  const conf = p.getByRole("button", { name: /^\s*(sim|confirmar|ok)\s*$/i }).last(); if (await conf.count()) { await conf.click().catch(() => {}); await p.waitForTimeout(2000); }
  for (let i = 0; i < 5; i++) { await p.waitForTimeout(4000); await M.abrirTicket(p, ticket).catch(() => {}); const f = await filaDe(p).catch(() => ""); if (f && !/n[aã]o localizada/i.test(f)) return "feito"; }
  throw new Error("cliquei na ação, mas o ticket continua na fila Nota não localizada");
}

export async function rodarNaoloc({ chamar, log, ctx, R, subirArquivo, teste, limite = 200 }) {
  const L = [];
  for (let de = 0; ; de += 1000) { const P = await chamar(`nao_localizada?select=*&or=(na_planilha.eq.true,and(acao.eq.cancelar,acao_status.eq.feito))&limit=1000&offset=${de}`); L.push(...P); if (P.length < 1000) break; }
  // só alguns tickets (pedido da Brenda): TRANSP = "h:" + hashes sha256 (10 letras) dos tickets, para não expor o número no registro público
  const { createHash } = await import("node:crypto");
  const hs = /^h:/.test(process.env.TRANSP || "") ? new Set(process.env.TRANSP.slice(2).split(",").map((t) => t.trim()).filter(Boolean)) : null;
  const xs = /^x:/.test(process.env.TRANSP || "") ? new Set(process.env.TRANSP.slice(2).split(",").map((t) => t.trim()).filter(Boolean)) : null;   // tickets para deixar de fora
  const hsh = (t) => createHash("sha256").update(String(t)).digest("hex").slice(0, 10);
  const real = (LIBERADO || !!hs) && !teste;
  const fila = L.filter((x) => x.na_planilha && x.acao_status !== "feito" && !x.segurar && (!hs || hs.has(hsh(x.ticket))) && (!xs || !xs.has(hsh(x.ticket)))).slice(0, limite);
  // depois do cancelamento: reconfere o rastreio a cada 20 h, por até 90 dias, para avisar se aparecer CT-e
  const vigiar = hs ? [] : L.filter((x) => x.acao === "cancelar" && x.acao_status === "feito" && !x.cte_alerta_em && x.acao_em && Date.now() - Date.parse(x.acao_em) < 90 * 864e5
    && (!x.conferido_em || Date.now() - Date.parse(x.conferido_em) > 20 * 3600e3));
  log(`naoloc: ${fila.length} nota(s) na fila · ${vigiar.length} cancelada(s) para vigiar CT-e · ${real ? "REAL" : "TESTE (cancela no fim)"}`);
  if (!fila.length && !vigiar.length) return;
  await R.carregarSenhasDB();
  const M = await import("./multi360.mjs");
  let m = null; try { m = await M.entrarMulti360(ctx, log); } catch (e) { log("naoloc: não entrei no 360:", String(e.message).slice(0, 100)); }
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1); let entreguesFeitos = 0;
  // mesma lógica da Conferência SSW (Brenda, 23/11):
  //  · TSL série 35 (dropshipping): a TSL só faz a first mile → fora do RJ vale o rastreio do redespacho da base; sem redespacho = verificar à mão
  //  · Dominalog / Tempo Justo / Trans Sua / Transvanio nas séries 25, 34 e 35: vale o rastreio da própria transportadora; CT-e da Rajlog (milk run) não conta
  const REGRA_RAJ = (t, serie) => /dominalog|tempo\s*justo|trans\s*sua|transvanio/i.test(t || "") && ["25", "34", "35"].includes(String(serie));
  const daBase = async (nf) => (await chamar(`base_pedidos?select=uf,rd:extra->>redespacho&nf=eq.${encodeURIComponent(nf)}&limit=1`).catch(() => []))[0] || {};
  const alvoDe = async (x) => {
    let tk = { transp: null, redesp: null };
    if (m && x.ticket) { try { tk = await M.lerTranspTicket(m, x.ticket); } catch (_) { soma("ticket não abriu"); } }
    let alvo = tk.redesp || tk.transp || x.transp_ticket || x.transp_pedido || null;
    const serie = String(x.serie || x.nf.split("-")[1] || "").replace(/^0+/, "");
    if (serie === "35" && /\btsl\b/i.test(alvo || "")) {
      const b = await daBase(x.nf);
      if (String(b.uf || "").trim().toUpperCase() !== "RJ") { const rd = String(b.rd || "").trim() || (x.transp_pedido && !/\btsl\b/i.test(x.transp_pedido) ? x.transp_pedido : "");
        if (!rd) { soma("TSL 35 sem redespacho"); return { semAlvo: "TSL série 35 fora do RJ sem redespacho na base: verificar à mão" }; }
        alvo = rd; soma("TSL 35 pelo redespacho"); }
    }
    // DLOG série 35 (Brenda, 24/11): a DLOG só faz a first mile → o rastreio dela não vale; usa o redespacho da base; sem redespacho = verificar à mão
    if (serie === "35" && /\bDLOG\b/i.test(alvo || "")) {
      const b = await daBase(x.nf);
      const rd = [String(b.rd || "").trim(), x.transp_pedido].find((t) => t && !/\bDLOG\b/i.test(t) && !/^(sem\b|-$)/i.test(t)) || "";
      if (!rd) { soma("DLOG 35 sem redespacho"); return { semAlvo: "DLOG série 35 é só first mile e não há redespacho na base: verificar à mão" }; }
      alvo = rd; soma("DLOG 35 pelo redespacho");
    }
    return alvo;
  };
  // séries 25/34/35 dessas transportadoras: CT-e da Rajlog (milk run) não vale como rastreio (Brenda, 23/11)
  const ajustaRaj = (r, alvo, serie) => {
    // série 35: CT-e emitido pela DLOG (first mile) não conta como rastreio (Brenda, 24/11)
    if (String(serie || "").replace(/^0+/, "") === "35" && r && r.situacao && !/^(sem cte|sem nf|sem permissao)$/.test(r.situacao) && (/\bDLOG\b/i.test(r.transp || "") || /\bDLOG\b/i.test(r.evento || ""))) return { ...r, situacao: "sem cte", evento: "SÓ CT-E DA DLOG (FIRST MILE)" };
    if (!REGRA_RAJ(alvo, serie) || !r || !r.situacao || /^(sem cte|sem nf|sem permissao)$/.test(r.situacao)) return r;
    if (/rajlog/i.test(r.transp || "") || /rajlog|milk\s*run/i.test(r.evento || "")) return { ...r, situacao: "sem cte", evento: "SÓ CT-E DA RAJLOG (MILK RUN)" };
    return r;
  };

  for (const x of vigiar) {
    try {
      const alvo = await alvoDe(x); if (!alvo || alvo.semAlvo) continue;
      const r = ajustaRaj(await B.rastrear({ nf: x.nf, transp_pedido: alvo }, R), alvo, x.serie); r.alvo = alvo;
      const campos = { conferido_em: new Date().toISOString() };
      if (r.situacao && !FORA.test(r.situacao)) { campos.cte_depois = { ...r }; campos.cte_alerta_em = new Date().toISOString(); soma("CT-e depois do cancelamento"); }
      await chamar(`nao_localizada?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", campos);
    } catch (_) { soma("erro ao vigiar"); }
  }

  for (const x of fila) {
    try {
      const a0 = await alvoDe(x), alvo = a0 && a0.semAlvo ? null : a0;
      const r = alvo ? ajustaRaj(await B.rastrear({ nf: x.nf, transp_pedido: alvo }, R), alvo, x.serie) : { situacao: null, fonte: null };
      r.alvo = alvo;
      const s = alvo ? sugerir(x, r) : { sugestao: "manual", motivo: (a0 && a0.semAlvo) || "Sem transportadora no ticket nem na planilha" };
      let print_rastreio = x.print_rastreio || null, png = null;
      if (r.fonte && s.sugestao !== "aguardar") { try { png = await B.printRastreio(ctx, x.nf, r); print_rastreio = await subirArquivo("barrar", `naoloc-${encodeURIComponent(x.nf)}-rastreio.png`, png); } catch (_) { soma("print falhou"); } }
      const campos = { rastreio: r, sugestao: s.sugestao, sugestao_motivo: s.motivo, prazo_ate: s.prazo_ate ?? prazoAte(x.serie, x.ticket_criado), conferido_em: new Date().toISOString(), print_rastreio };
      soma(`sugestão ${s.sugestao}`);
      if (["voltar_barrar", "entregue", "cancelar"].includes(s.sugestao) && m && x.ticket) {
        let comentou = false;
        try {
          const jaComentou = x.acao_status === "comentado" || /^coment|cliquei na a[cç][aã]o/i.test(x.acao_msg || "");   // nunca comenta duas vezes
          comentou = jaComentou;
          const marcarComentado = () => (comentou = true, chamar(`nao_localizada?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", { acao: s.sugestao, acao_status: "erro", acao_msg: "comentado; falta clicar na ação", acao_em: new Date().toISOString() }).catch(() => {}));
          let st = await executar(M, m, x.ticket, s.sugestao, s.sugestao === "cancelar" ? null : png, real, jaComentou, marcarComentado);
          if (st === "saiu") { soma("já tinha saído da fila"); campos.acao_status = "erro"; campos.acao_msg = "o ticket já não estava na fila Nota não localizada: conferir no Multi360"; campos.acao = s.sugestao; campos.acao_em = new Date().toISOString(); await chamar(`nao_localizada?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", campos); continue; }
          Object.assign(campos, { acao: s.sugestao, acao_status: st, acao_msg: st === "teste" ? "teste: preenchido e cancelado" : MSG[s.sugestao], acao_em: new Date().toISOString() });
          soma(st === "teste" ? "ação testada" : "ação feita");
          // entregue: entra no Barrar entrega já como "não barrado (Entregue)"; o robô do Barrar aplica no portal e põe os prints
          if (st === "feito" && s.sugestao === "entregue") { entreguesFeitos++;
            await chamar("barrar_entrega?on_conflict=nf", "POST", [{ nf: x.nf, ticket: x.ticket, transp_pedido: alvo, status_intelipost: x.status_intelipost, ticket_criado: x.ticket_criado, na_planilha: true,
              rastreio: r, sugestao: "nao_barrar", sugestao_opcao: "Entregue", sugestao_motivo: s.motivo, conferido_em: new Date().toISOString(), print_rastreio,
              decisao: "nao_barrar", decisao_opcao: "Entregue", decisao_motivo: s.motivo, decisao_por: "robô (entregue · nota não localizada)", decisao_em: new Date().toISOString() }], { Prefer: "resolution=merge-duplicates,return=representation" }).catch(() => soma("não entrou no Barrar"));
          }
        } catch (e) { Object.assign(campos, { acao: s.sugestao, acao_status: "erro", acao_msg: (comentou ? "comentado · " : "") + String(e.message).split("\n")[0].slice(0, 200), acao_em: new Date().toISOString() }); soma("ação com erro"); log("  ação com erro:", String(e.message).split("\n")[0].replace(/\d{3,}/g, "#").slice(0, 140)); }
      }
      await chamar(`nao_localizada?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", campos);
    } catch (e) { soma("erro"); log("  erro:", String(e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 120)); }
  }
  log("naoloc: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
  // entregues que voltaram para o barrar: já marca no portal "não barrado · Entregue" (X vermelho) + prints no ticket (Brenda, 23/11)
  if (entreguesFeitos) { log(`naoloc: ${entreguesFeitos} entregue(s) de volta no barrar → portal`); await new Promise((ok) => setTimeout(ok, 20000)); await B.aplicarBarrar({ chamar, log, ctx, soAuto: true }).catch((e) => log("naoloc: portal erro " + String(e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 120))); }
}

// contagem (só números) das conferências que usaram o rastreio da DLOG na série 35
export async function diagDlog({ chamar, log }) {
  const L = await chamar("nao_localizada?select=*&limit=5000");
  const hs = (process.env.SSW_LIMITE_H || "").split(",").filter(Boolean);
  if (/^dlog:/.test(process.env.TRANSP || "")) {   // uma nota (hash sha256[:16] da NF): o que foi gravado, sem número nem nomes de pessoas
    const { createHash } = await import("node:crypto"); const h = process.env.TRANSP.slice(5);
    const x = L.find((y) => createHash("sha256").update(String(y.nf)).digest("hex").slice(0, 16) === h);
    if (!x) return log("diag-dlog: nota não encontrada");
    const r = x.rastreio || {}, mask = (t) => String(t ?? "").replace(/\d{4,}/g, "#");
    log(`diag-dlog nota: série ${x.serie} · transp ticket ${mask(x.transp_ticket)} · transp pedido ${mask(x.transp_pedido)} · rastreio alvo ${mask(r.alvo)} · redesp ticket ${mask(r.redesp_ticket)} · fonte ${r.fonte} · situação ${r.situacao} · transp do CT-e ${mask(r.transp)} · evento ${mask(r.evento)} · data ${r.data_evento} · sugestão ${x.sugestao} · motivo ${mask(x.sugestao_motivo)} · ação ${x.acao}/${x.acao_status} em ${x.acao_em}`);
    log(`diag-dlog nota: chaves do rastreio: ${Object.keys(r).join(",")}`);
    return;
  }
  const D = L.filter((x) => String(x.serie || String(x.nf).split("-")[1] || "").replace(/^0+/, "") === "35" && (/\bDLOG\b/i.test((x.rastreio || {}).alvo || "") || /\bDLOG\b/i.test((x.rastreio || {}).transp || "")));
  const c = {}; D.forEach((x) => { const k = `sugestão ${x.sugestao || "-"} · ação ${x.acao_status === "feito" ? x.acao + " feita" : x.acao_status || "nenhuma"}`; c[k] = (c[k] || 0) + 1; });
  log(`diag-dlog: ${D.length} nota(s) série 35 conferidas pelo rastreio da DLOG (de ${L.length})`); Object.entries(c).forEach(([k, v]) => log(`  ${k}: ${v}`));
  // nomes de transportadora (não são dado pessoal): quem foi usada no rastreio, por série, e onde aparece DLOG
  const d2 = {}; L.forEach((x) => { const sr = String(x.serie || String(x.nf).split("-")[1] || "").replace(/^0+/, ""); const k = `série ${sr} · rastreio por ${(x.rastreio || {}).alvo || "(nenhuma)"} · sugestão ${x.sugestao || "-"} · ação ${x.acao_status === "feito" ? x.acao : x.acao_status || "-"}`; d2[k] = (d2[k] || 0) + 1; });
  Object.entries(d2).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log(`  ${k}: ${v}`));
  const dl = L.filter((x) => /\bDLOG\b/i.test(JSON.stringify([x.transp_ticket, x.transp_pedido, (x.rastreio || {}).transp_ticket, (x.rastreio || {}).transp]))).length;
  log(`  linhas com DLOG em algum campo de transportadora: ${dl}`);
}

// só olha a ação de 1 ticket da fila (sem clicar em nada além de Cancelar)
export async function diagNaoloc({ chamar, log, ctx }) {
  const L = await chamar("nao_localizada?select=ticket&na_planilha=eq.true&ticket=not.is.null&limit=1");
  if (!L.length) return log("diag-naoloc: nenhuma nota na planilha");
  const M = await import("./multi360.mjs");
  const m = await M.entrarMulti360(ctx, log);
  await M.diagTicketBarrar(m, L[0].ticket, log);
  // tenta também abrir as opções (se for um select/combobox) para listar os nomes
  await M.abrirTicket(m, L[0].ticket);
  await m.getByRole("button", { name: /executar a[cç][aã]o no ticket/i }).first().click(); await m.waitForTimeout(2500);
  const r = await m.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const d = [...document.querySelectorAll("[role=dialog]")].filter(vis).pop() || document.body;
    return { texto: (d.innerText || "").replace(/\s+/g, " ").slice(0, 400), radios: [...d.querySelectorAll("[role=radio], input[type=radio]")].map((e) => (e.getAttribute("aria-label") || e.closest("label")?.innerText || e.value || "").trim().slice(0, 50)) };
  });
  log("  caixinha (texto):", r.texto.replace(/\d{4,}/g, "#"));
  log("  rádios:", r.radios.join(" | ") || "nenhum");
  const c = m.getByRole("button", { name: /^\s*cancelar\s*$/i }).last(); if (await c.count()) await c.click().catch(() => {}); else await m.keyboard.press("Escape").catch(() => {});
}
