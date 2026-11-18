// Reposição: itens/volumes de cada ticket com nova NF (pedido da Brenda, 18/11/2026).
// Pós-entrega: Multi360 > ticket > Eventos > quadro "Reposição" (código do volume, qtd, Parcial/Total, Antes/Depois da entrega).
// Pré-entrega: PDF da nota anexado no chat do ticket (volumes "NNNNN.NNNN - DESCRIÇÃO" e razão social do destinatário:
// se for uma transportadora, a reposição saiu com cobrança para ela).
// Registro público: nunca nome, CPF, endereço ou o PDF. Só contagens e "sim/não".
import { entrarMulti360 } from "./multi360.mjs";

const BASE = (process.env.MULTI360_URL || "https://appv2.360multi.com").replace(/\/$/, "");
export const RE_VOL = /(\d{5}\.\d{4})\s*[-–]\s*([^\n]{3,120})/g;

async function abrir(p, ticket) {
  await p.goto(`${BASE}/tickets/${encodeURIComponent(ticket)}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: /executar a[cç][aã]o no ticket/i }).first().waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
}

// quadro "Reposição" da aba Eventos
export async function lerEventos(p) {
  const bt = p.getByText(/^\s*Eventos\s*$/).first();
  if (!(await bt.count())) return { erro: "sem botão Eventos" };
  await bt.click(); await p.waitForTimeout(2500);
  return p.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const tits = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.children.length === 0 && /^\s*Reposi[cç][aã]o\s*$/i.test(e.textContent || ""));
    const cards = [];
    for (const t of tits) {
      let d = t; for (let i = 0; i < 10 && d && !/\d{5}\.\d{4}/.test(d.innerText || ""); i++) d = d.parentElement;
      if (!d || !/\d{5}\.\d{4}/.test(d.innerText || "")) { d = t; for (let i = 0; i < 6 && d && !/volume/i.test(d.innerText || ""); i++) d = d.parentElement; }
      if (!d) continue;
      const txt = d.innerText || "";
      const codigos = [...txt.matchAll(/\b(\d{5}\.\d{4})\b/g)].map((m) => m[1]);
      cards.push({ volumes: (txt.match(/(\d+)\s*Volumes?/i) || [])[1] || null, parcial: /parcial/i.test(txt) ? "Parcial" : /total/i.test(txt) ? "Total" : null,
        quando: (txt.match(/(antes|depois|ap[oó]s)\s+da\s+entrega/i) || [])[0] || null, codigos,
        forma: txt.replace(/\d/g, "#").replace(/\s+/g, " ").slice(0, 160) });
    }
    return { cards, titulos: tits.length };
  });
}

// estrutura (mascarada) de onde podem estar os anexos e o código do volume
export async function sondar(p) {
  return p.evaluate(() => {
    const m = (x) => String(x || "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);
    const cand = [...document.querySelectorAll("button,a,[role=button],[title],[aria-label],[download]")]
      .filter((e) => /anexo|baixar|download|pdf|arquivo|attach/i.test([e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("href"), e.textContent].join(" ")));
    const abas = [...document.querySelectorAll("button,[role=tab],a")].map((e) => (e.textContent || "").trim()).filter((t) => t && t.length < 25 && !/\d{3}/.test(t));
    return { anexos: cand.slice(0, 15).map((e) => `${e.tagName}|aria=${m(e.getAttribute("aria-label"))}|title=${m(e.getAttribute("title"))}|txt=${m(e.textContent)}|href=${/\.pdf/i.test(e.getAttribute("href") || "") ? "pdf" : e.getAttribute("href") ? "sim" : ""}`),
      abas: [...new Set(abas)].slice(0, 40), codigosNaPagina: (document.body.innerText.match(/\b\d{5}\.\d{4}\b/g) || []).length };
  });
}

// PDFs anexados no chat: baixa cada um (só na memória) e devolve o texto
export async function lerPdfs(p, max = 3) {
  // os anexos do chat são links <a href="...pdf">Baixar anexo</a>: baixa pelo próprio navegador logado (só na memória)
  const hrefs = await p.evaluate(() => [...document.querySelectorAll("a[href]")]
    .filter((a) => /\.pdf(\?|#|$)/i.test(a.getAttribute("href") || "") || /baixar anexo/i.test(a.textContent || ""))
    .map((a) => a.href));
  const out = [];
  for (const h of [...new Set(hrefs)].reverse()) {   // do mais novo para o mais velho
    if (out.length >= max) break;
    try {
      const r = await p.context().request.get(h, { timeout: 30000 });
      if (!r.ok()) continue;
      const buf = await r.body();
      if (buf.slice(0, 4).toString() !== "%PDF") continue;
      out.push(await textoPdf(buf));
    } catch (_) { /* anexo que não baixou: segue */ }
  }
  return { anexos: hrefs.length, pdfs: out };
}

export async function textoPdf(buf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  let txt = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i); const c = await pg.getTextContent();
    let y = null; for (const it of c.items) { const yy = Math.round(it.transform[5]); if (y !== null && Math.abs(yy - y) > 2) txt += "\n"; else if (y !== null) txt += " "; txt += it.str; y = yy; }
    txt += "\n";
  }
  return txt;
}

// do texto da DANFE: volumes (código + descrição), quantidade de volumes e a razão social do destinatário (só para comparar)
export function lerDanfe(txt) {
  const vols = [...txt.matchAll(RE_VOL)].map((m) => ({ codigo: m[1], descricao: m[2].replace(/\s+/g, " ").trim() }));
  const qtd = (txt.match(/QUANTIDADE[\s\S]{0,40}?\n?\s*(\d+)\s*\n?[\s\S]{0,20}VOLUMES?/i) || [])[1] || null;
  const rz = (txt.match(/NOME\s*\/\s*RAZ[AÃ]O\s+SOCIAL[^\n]*\n([^\n]+)/i) || [])[1] || "";
  // documento do destinatário: CPF = sem cobrança (regra da Brenda, 18/11); CNPJ = pode ser transportadora
  const blocoDest = (txt.match(/DESTINAT[AÁ]RIO[\s\S]{0,400}/i) || [""])[0];
  const doc = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/.test(blocoDest) ? "cnpj" : /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(blocoDest) ? "cpf" : null;
  return { vols, qtd, doc, razao: rz.replace(/\s+\d{3}\.\d{3}\.\d{3}-\d{2}.*$/, "").replace(/\s+\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}.*$/, "").trim() };
}

export async function diagRepo({ chamar, log, ctx }) {
  // fila pela tabela de acompanhamento (mais atual); nova NF pelo detalhamento
  const T = await chamar("reposicoes_tk?select=ticket,tipo,fila,status&fila=ilike.*aguardando*entrega*&limit=1000");
  const ids = T.map((x) => `"${x.ticket}"`).join(",");
  const A = ids ? await chamar(`repo_atual?select=ticket,nfs_novas&nfs_novas=not.is.null&ticket=in.(${encodeURIComponent(ids)})`) : [];
  const comNf = new Set(A.map((x) => String(x.ticket)));
  const L = T.filter((x) => comNf.has(String(x.ticket)) && !/^(RESOLVID|ENCERRAD|FINALIZAD)/i.test((x.status || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
  const sem = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const pos = L.find((x) => /pos/i.test(sem(x.tipo)));
  const pre = L.find((x) => /^reposicao$/i.test(sem(x.tipo)));
  log(`diag-repo: ${T.length} tickets em Aguardando entrega · ${L.length} com nova NF e em aberto · pós ${pos ? "achei" : "não"} · pré ${pre ? "achei" : "não"}`);
  const p = await entrarMulti360(ctx, log);
  for (const [rot, x] of [["PÓS", pos], ["PRÉ", pre]]) {
    if (!x) continue;
    try {
      await abrir(p, x.ticket);
      const ev = await lerEventos(p);
      const so2 = await sondar(p); log(`${rot}: depois de Eventos, códigos NNNNN.NNNN na página=${so2.codigosNaPagina}`);
      log(`${rot}: Eventos → quadros Reposição: ${ev.titulos ?? 0} · ` + (ev.cards || []).map((c) => `volumes=${c.volumes} ${c.parcial || "?"} ${c.quando || "?"} códigos=${c.codigos.length} forma="${c.forma}"`).join(" | ") + (ev.erro ? " · " + ev.erro : ""));
      await abrir(p, x.ticket);
      const so = await sondar(p);
      log(`${rot}: códigos NNNNN.NNNN na página=${so.codigosNaPagina} · abas/botões: ${so.abas.join(" / ")}`);
      so.anexos.forEach((a) => log(`  anexo? ${a}`));
      const an = await lerPdfs(p);
      log(`${rot}: anexos=${an.anexos} · PDFs lidos=${an.pdfs.length}`);
      an.pdfs.forEach((t, i) => { const d = lerDanfe(t);
        log(`  PDF ${i + 1}: ${t.length} letras · DANFE=${/DANFE|DOCUMENTO AUXILIAR/i.test(t) ? "sim" : "não"} · volumes com código=${d.vols.length} · qtd volumes=${d.qtd ?? "?"} · doc destinatário=${d.doc || "?"} · razão social achada=${d.razao ? "sim" : "não"} · parece empresa=${/LTDA|EIRELI|S\.?A\.?\b|TRANSP|LOG[IÍ]ST/i.test(d.razao) ? "sim" : "não"}`); });
    } catch (e) { log(`${rot}: erro ${String(e.message).split("\n")[0].slice(0, 120)}`); }
  }
}
