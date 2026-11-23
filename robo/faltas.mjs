// Reposições › Falta de volumes: para cada ticket da planilha, o robô só LÊ (não escreve nada em lugar nenhum):
//   1) no ticket do Multi360, as mensagens "Externo" que a transportadora mandou pelo portal do transportador
//      ("Enviado pelo portal do transportador por <nome>" + texto) e o motivo do ticket;
//   2) no portal ccp.360multi.com › Reposições › aba "Faltas / Inversões (Pós Entrega)", as anotações da NF.
// Com retorno = alguma das duas tem mensagem da transportadora. Quem respondeu pela transportadora é guardado no Supabase (pedido da Brenda, 19/11), nunca no registro.
// Registro público (Actions): só contagens e estrutura mascarada — nunca ticket, nota, nome ou texto.
import { entrarMulti360 } from "./multi360.mjs";
import { entrarPortal } from "./barrar.mjs";

const BASE = "https://appv2.360multi.com";
const mascara = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
const isoBR = (s) => { const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?/); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || "00"}-03:00` : null; };

async function abrir(p, ticket) {
  await p.goto(`${BASE}/tickets/${encodeURIComponent(ticket)}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: /executar a[cç][aã]o no ticket|coment[aá]rio interno/i }).first().waitFor({ timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(2000);
  // o chat pode carregar as mensagens antigas só ao rolar para cima
  for (let i = 0; i < 6; i++) {
    const subiu = await p.evaluate(() => { let s = false; for (const e of document.querySelectorAll("*")) { if (e.scrollHeight > e.clientHeight + 50 && e.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(e).overflowY)) { e.scrollTop = 0; s = true; } } return s; });
    if (!subiu) break; await p.waitForTimeout(1200);
  }
}

// mensagens da transportadora no ticket: blocos com "Enviado pelo portal do transportador por ..." (marcados como Externo)
async function lerTicket(p, ticket) {
  await abrir(p, ticket);
  return p.evaluate(() => {
    const ls = document.body.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
    const DATA = /(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
    const cab = (l) => DATA.test(l) && /\s[-–]\s/.test(l);   // "Nome - 17/11/2026 17:19:03"
    const msgs = [];
    ls.forEach((l, i) => {
      if (!/^Enviado pelo portal do transportador/i.test(l)) return;
      let quando = null; for (let k = i - 1; k >= Math.max(0, i - 4); k--) { const d = ls[k].match(DATA); if (d) { quando = `${d[3]}-${d[2]}-${d[1]}T${d[4]}:${d[5]}:${d[6] || "00"}-03:00`; break; } }
      const corpo = []; for (let k = i + 1; k < ls.length && k < i + 15; k++) { if (cab(ls[k]) || /^Enviado pelo portal do transportador/i.test(ls[k]) || /^(Externo|Interno)$/i.test(ls[k])
        || /^(Executar a[cç][aã]o|Coment[aá]rio Interno|Macros|Ticket Paralelo|Tickets Do Pedido|A[cç][oõ]es|Admin\b|Digite sua mensagem)|©|Desenvolvido pela/i.test(ls[k])) break; corpo.push(ls[k]); }   // para no fim da conversa: botões e rodapé da tela
      const texto = corpo.join(" ").replace(/\s+/g, " ").trim().slice(0, 1000);
      const por = ((l.match(/transportador\s+por\s+(.+)$/i) || [])[1] || "").trim().slice(0, 80) || null;   // quem respondeu pela transportadora
      if (texto) msgs.push({ quando, texto, por });
    });
    // nossas mensagens "Externo" (a equipe cobrando a transportadora): cabeçalho "Nome - data" + selo Externo, sem "Enviado pelo portal do transportador".
    // O painel conta os dias sem retorno a partir da última delas (Brenda, 23/11). Só a data é guardada.
    let cobrado = null;
    ls.forEach((l, i) => {
      if (!cab(l)) return;
      const viz = ls.slice(i, i + 3).join(" | ");
      if (!/\bExterno\b/i.test(viz) || /Enviado pelo portal do transportador/i.test(ls.slice(i, i + 4).join(" "))) return;
      const d = l.match(DATA); const q = `${d[3]}-${d[2]}-${d[1]}T${d[4]}:${d[5]}:${d[6] || "00"}-03:00`;
      if (!cobrado || q > cobrado) cobrado = q;
    });
    // motivo do ticket: rótulo "Motivo" seguido do valor
    let motivo = null; const i = ls.findIndex((l) => /^Motivo:?$/i.test(l)); if (i >= 0 && ls[i + 1]) motivo = ls[i + 1].slice(0, 120);
    if (!motivo) { const m = ls.map((l) => l.match(/^Motivo:\s*(.+)$/i)).find(Boolean); if (m) motivo = m[1].slice(0, 120); }
    const fila = (document.body.innerText.match(/Atribu[ií]do Fila:\s*([^\n]+)/i) || [])[1] || null;
    return { msgs, motivo, fila: fila && fila.trim().slice(0, 80), cobrado };
  });
}

// portal: Reposições › Faltas / Inversões (Pós Entrega)
async function abrirFaltasPortal(p, log) {
  const link = p.getByRole("link", { name: /reposi[cç][oõ]es/i }).first();
  if (await link.count()) await link.click(); else await p.getByText(/^\s*Reposi[cç][oõ]es\s*\d*\s*$/i).first().click();
  await p.waitForTimeout(2500);
  const aba = p.getByRole("tab", { name: /faltas/i }).first();
  if (await aba.count()) await aba.click(); else await p.getByText(/Faltas\s*\/\s*Invers/i).first().click();
  await p.locator("table tbody tr").first().waitFor({ timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(1500);
  log(`Portal: Faltas / Inversões aberta (${mascara(new URL(p.url()).pathname)})`);
}

async function lerPortalFalta(p, nf) {
  const filtro = p.locator("input[placeholder^='Filtrar por nota']").first();
  await filtro.fill(""); await filtro.fill(nf); await p.waitForTimeout(2200);
  const linhas = p.locator("table tbody tr"); let alvo = null;
  for (let i = 0; i < await linhas.count(); i++) { const t = ((await linhas.nth(i).locator("td").first().textContent().catch(() => "")) || "").trim(); if (t === nf) { alvo = linhas.nth(i); break; } }
  if (!alvo) return { achou: false };
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim().toLowerCase());
  const tds = (await alvo.locator("td").allTextContents()).map((t) => t.trim());
  const col = (re) => { const i = ths.findIndex((h) => re.test(h)); return i >= 0 ? tds[i] || "" : ""; };
  const out = { achou: true, transp: col(/transportadora/).slice(0, 80), solicitado: col(/solicita/), prazo: col(/prazo/), anotacoes: [] };
  // botão das anotações: o ícone ao lado do texto (title "Ver Anotações" no Barrar); senão o próprio texto da coluna
  let bt = alvo.locator("button[title*='Anota' i], [aria-label*='Anota' i]").first();
  if (!(await bt.count())) { const i = ths.findIndex((h) => /anota/.test(h)); if (i >= 0) bt = alvo.locator("td").nth(i).locator("button, svg, [role=button], span").last(); }
  const temTexto = !!col(/anota/) && !/^[-–—\s]*$/.test(col(/anota/));
  if (temTexto && await bt.count()) {
    try {
      await bt.click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 }); await p.waitForTimeout(900);
      const ls = (await d.innerText()).split("\n").map((l) => l.trim()).filter((l) => l && !/^(close|fechar|×|x)$/i.test(l) && !/^Anota[cç][oõ]es$/i.test(l) && !/^Aqui voc[eê] pode ver/i.test(l) && !/^Adicione aqui/i.test(l));
      const ehData = (l) => /^\d{2}\/\d{2}\/\d{4},?\s*\d{2}:\d{2}$/.test(l);
      const idx = ls.map((l, i) => (ehData(l) ? i : -1)).filter((i) => i >= 0);
      // cada anotação: inicial, nome, data, texto → data, quem escreveu e texto
      out.anotacoes = idx.map((i, k) => { const fim = k + 1 < idx.length ? idx[k + 1] - 2 : ls.length; const por = i > 0 && !ehData(ls[i - 1]) && ls[i - 1].length > 2 ? ls[i - 1].slice(0, 80) : null;
        return { quando: isoBR(ls[i]), texto: ls.slice(i + 1, Math.max(i + 1, fim)).join(" ").slice(0, 1000), por }; }).filter((a) => a.texto);
      await p.keyboard.press("Escape"); await p.waitForTimeout(600);
    } catch (_) { out.anotacoes = [{ quando: null, texto: col(/anota/).replace(/\.\.\.$|…$/, "").slice(0, 400) }]; out.parcial = true; }
  } else if (temTexto) out.anotacoes = [{ quando: null, texto: col(/anota/).slice(0, 400) }];
  return out;
}

export async function conferirFaltas({ chamar, log, ctx, limite = 300 }) {
  const L = await chamar(`falta_volumes?select=ticket,nf,motivo&na_planilha=eq.true&order=conferido_em.asc.nullsfirst&limit=${limite}`);
  log(`faltas: ${L.length} ticket(s) para olhar`);
  if (!L.length) return;
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  const temCobrado = await chamar("falta_volumes?select=cobrado_em&limit=1").then(() => true, () => { log("faltas: coluna cobrado_em não existe (parte 61): sigo sem a data da nossa cobrança"); return false; });
  const p360 = await entrarMulti360(ctx, log);
  let pp = null; try { pp = await entrarPortal(ctx, log); await abrirFaltasPortal(pp, log); } catch (e) { log("faltas: portal indisponível (" + mascara(e.message) + ") — sigo só com o 360"); pp = null; }
  for (const x of L) {
    try {
      const t = await lerTicket(p360, x.ticket);
      let pt = null;
      if (pp && x.nf) { try { pt = await lerPortalFalta(pp, x.nf); } catch (e) { soma("portal: erro"); pt = { achou: null, erro: true }; } }
      const datas = [...t.msgs.map((m) => m.quando), ...((pt && pt.anotacoes) || []).map((a) => a.quando)].filter(Boolean).sort();
      const tem = t.msgs.length > 0 || !!(pt && pt.anotacoes && pt.anotacoes.length);
      await chamar(`falta_volumes?ticket=eq.${encodeURIComponent(x.ticket)}`, "PATCH", {
        retorno_360: t.msgs, portal: pt, motivo_ticket: t.motivo, ...(t.fila ? { fila: t.fila } : {}), tem_retorno: tem, ...(temCobrado ? { cobrado_em: t.cobrado } : {}),
        ultimo_retorno_em: datas.length ? datas[datas.length - 1] : null, conferido_em: new Date().toISOString(), erro: null });
      soma(tem ? "com retorno" : "sem retorno"); if (t.msgs.length) soma("retorno no 360"); if (t.cobrado) soma("com cobrança nossa"); if (pt && pt.anotacoes && pt.anotacoes.length) soma("anotação no portal"); if (pt && pt.achou === false) soma("NF fora da lista do portal");
    } catch (e) {
      soma("erro"); log("  erro:", mascara(String(e.message).split("\n")[0]));
      await chamar(`falta_volumes?ticket=eq.${encodeURIComponent(x.ticket)}`, "PATCH", { erro: String(e.message).split("\n")[0].slice(0, 200), conferido_em: new Date().toISOString() }).catch(() => {});
    }
  }
  log("faltas: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}

// diagnóstico: abre 1 ticket da lista e a aba Faltas do portal, e mostra só a estrutura (mascarada). Não grava nada.
export async function diagFaltas({ chamar, log, ctx }) {
  const [x] = await chamar("falta_volumes?select=ticket,nf&na_planilha=eq.true&nf=not.is.null&limit=1");
  if (!x) { log("diag-faltas: nenhum ticket na lista"); return; }
  const p = await entrarMulti360(ctx, log);
  const t = await lerTicket(p, x.ticket);
  log(`360: mensagens da transportadora ${t.msgs.length} · motivo ${t.motivo ? "achei (" + mascara(t.motivo).length + " letras)" : "não achei"} · fila ${t.fila ? "achei" : "não achei"}`);
  const est = await p.evaluate(() => { const ls = document.body.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    return { externo: ls.filter((l) => /^externo$/i.test(l)).length, enviado: ls.filter((l) => /^Enviado pelo portal/i.test(l)).length, rotulos: ls.filter((l) => /^(motivo|fila|tipo|status|transportadora|redespacho|submotivo|categoria|assunto)\b/i.test(l)).map((l) => l.split(":")[0]).slice(0, 20) }; });
  log(`360: "Externo" ${est.externo} · "Enviado pelo portal" ${est.enviado} · rótulos: ${est.rotulos.map(mascara).join(" | ")}`);
  const pp = await entrarPortal(ctx, log); await abrirFaltasPortal(pp, log);
  const ths = (await pp.locator("table thead th").allTextContents()).map(mascara);
  log("Portal colunas:", ths.join(" | "));
  const r = await lerPortalFalta(pp, x.nf);
  log(`Portal: achou ${r.achou} · anotações ${(r.anotacoes || []).length}${r.parcial ? " (só o texto da coluna)" : ""} · prazo ${r.prazo ? "sim" : "não"}`);
}
