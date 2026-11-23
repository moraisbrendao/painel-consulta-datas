// Alterar pedidos › Nota não localizada (fila "Nota não localizada (Sem Emissão)" do Multi360).
// Para cada nota da planilha: olha o rastreio da transportadora (a do ticket: redespacho, se tiver) e executa a ação no ticket:
//   · ENTREGUE no rastreio → volta para o barrar + entra no Barrar entrega como "não barrado (Entregue)" (o robô do Barrar aplica no portal)
//   · está no rastreio      → volta para o barrar
//   · fora do rastreio e passou do prazo → seguir para cancelamento, comentário "Pedido não localizado em rastreio"
//       prazo (Brenda, 23/11): série 35 = 30 dias corridos; séries 34 e 25 = 7 dias úteis; séries 7, 31 e 4 = 5 dias úteis (da criação do ticket)
// Depois do cancelamento o robô continua olhando o rastreio (até 90 dias) e avisa no painel se aparecer CT-e.
// Registro público (GitHub): só contagens. Nada de nota, ticket ou nome no log.

import * as B from "./barrar.mjs";

const LIBERADO = false;   // até a Brenda aprovar o teste: o robô abre a ação, preenche e clica em Cancelar
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
  if (s === "35") { const x = new Date(d); x.setDate(x.getDate() + 30); return diaISO(x); }
  const du = { "34": 7, "25": 7, "7": 5, "31": 5, "4": 5 }[s];   // dias úteis (Brenda 23/11: 34 e 25 = 7; 7, 31 e 4 = 5)
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
async function executar(M, p, ticket, acao, print, real) {
  await M.abrirTicket(p, ticket);
  const antes = await filaDe(p);
  if (!/n[aã]o localizada/i.test(antes)) throw new Error(`o ticket não está mais na fila Nota não localizada (está em "${antes.replace(/\d/g, "#")}")`);
  if (real) await M.comentarioInterno(p, ticket, MSG[acao], print ? [{ name: "rastreio.png", mimeType: "image/png", buffer: print }] : []);
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
  const real = LIBERADO && !teste;
  const fila = L.filter((x) => x.na_planilha && x.acao_status !== "feito" && !x.segurar).slice(0, limite);
  // depois do cancelamento: reconfere o rastreio a cada 20 h, por até 90 dias, para avisar se aparecer CT-e
  const vigiar = L.filter((x) => x.acao === "cancelar" && x.acao_status === "feito" && !x.cte_alerta_em && x.acao_em && Date.now() - Date.parse(x.acao_em) < 90 * 864e5
    && (!x.conferido_em || Date.now() - Date.parse(x.conferido_em) > 20 * 3600e3));
  log(`naoloc: ${fila.length} nota(s) na fila · ${vigiar.length} cancelada(s) para vigiar CT-e · ${real ? "REAL" : "TESTE (cancela no fim)"}`);
  if (!fila.length && !vigiar.length) return;
  await R.carregarSenhasDB();
  const M = await import("./multi360.mjs");
  let m = null; try { m = await M.entrarMulti360(ctx, log); } catch (e) { log("naoloc: não entrei no 360:", String(e.message).slice(0, 100)); }
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  const alvoDe = async (x) => {
    let tk = { transp: null, redesp: null };
    if (m && x.ticket) { try { tk = await M.lerTranspTicket(m, x.ticket); } catch (_) { soma("ticket não abriu"); } }
    return tk.redesp || tk.transp || x.transp_ticket || x.transp_pedido || null;
  };

  for (const x of vigiar) {
    try {
      const alvo = await alvoDe(x); if (!alvo) continue;
      const r = await B.rastrear({ nf: x.nf, transp_pedido: alvo }, R); r.alvo = alvo;
      const campos = { conferido_em: new Date().toISOString() };
      if (r.situacao && !FORA.test(r.situacao)) { campos.cte_depois = { ...r }; campos.cte_alerta_em = new Date().toISOString(); soma("CT-e depois do cancelamento"); }
      await chamar(`nao_localizada?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", campos);
    } catch (_) { soma("erro ao vigiar"); }
  }

  for (const x of fila) {
    try {
      const alvo = await alvoDe(x);
      const r = alvo ? await B.rastrear({ nf: x.nf, transp_pedido: alvo }, R) : { situacao: null, fonte: null };
      r.alvo = alvo;
      const s = alvo ? sugerir(x, r) : { sugestao: "manual", motivo: "Sem transportadora no ticket nem na planilha" };
      let print_rastreio = x.print_rastreio || null, png = null;
      if (r.fonte && s.sugestao !== "aguardar") { try { png = await B.printRastreio(ctx, x.nf, r); print_rastreio = await subirArquivo("barrar", `naoloc-${encodeURIComponent(x.nf)}-rastreio.png`, png); } catch (_) { soma("print falhou"); } }
      const campos = { rastreio: r, sugestao: s.sugestao, sugestao_motivo: s.motivo, prazo_ate: s.prazo_ate ?? prazoAte(x.serie, x.ticket_criado), conferido_em: new Date().toISOString(), print_rastreio };
      soma(`sugestão ${s.sugestao}`);
      if (["voltar_barrar", "entregue", "cancelar"].includes(s.sugestao) && m && x.ticket) {
        try {
          const st = await executar(M, m, x.ticket, s.sugestao, s.sugestao === "cancelar" ? null : png, real);
          Object.assign(campos, { acao: s.sugestao, acao_status: st, acao_msg: st === "teste" ? "teste: preenchido e cancelado" : MSG[s.sugestao], acao_em: new Date().toISOString() });
          soma(st === "teste" ? "ação testada" : "ação feita");
          // entregue: entra no Barrar entrega já como "não barrado (Entregue)"; o robô do Barrar aplica no portal e põe os prints
          if (st === "feito" && s.sugestao === "entregue") {
            await chamar("barrar_entrega?on_conflict=nf", "POST", [{ nf: x.nf, ticket: x.ticket, transp_pedido: alvo, status_intelipost: x.status_intelipost, ticket_criado: x.ticket_criado, na_planilha: true,
              rastreio: r, sugestao: "nao_barrar", sugestao_opcao: "Entregue", sugestao_motivo: s.motivo, conferido_em: new Date().toISOString(), print_rastreio,
              decisao: "nao_barrar", decisao_opcao: "Entregue", decisao_motivo: s.motivo, decisao_por: "robô (entregue · nota não localizada)", decisao_em: new Date().toISOString() }], { Prefer: "resolution=merge-duplicates,return=representation" }).catch(() => soma("não entrou no Barrar"));
          }
        } catch (e) { Object.assign(campos, { acao: s.sugestao, acao_status: "erro", acao_msg: String(e.message).split("\n")[0].slice(0, 200), acao_em: new Date().toISOString() }); soma("ação com erro"); }
      }
      await chamar(`nao_localizada?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", campos);
    } catch (e) { soma("erro"); log("  erro:", String(e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 120)); }
  }
  log("naoloc: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
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
