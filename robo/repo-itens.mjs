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
  const itens = []; let txt = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i); const c = await pg.getTextContent();
    const its = c.items.filter((it) => (it.str || "").trim()).map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5], p: i }));
    itens.push(...its);
    // linhas na ordem de leitura: de cima para baixo, da esquerda para a direita
    its.sort((a, b) => b.y - a.y || a.x - b.x);
    let lin = [], y = null;
    const fecha = () => { if (lin.length) txt += lin.sort((a, b) => a.x - b.x).map((t) => t.s).join(" ") + "\n"; lin = []; };
    for (const it of its) { if (y !== null && Math.abs(it.y - y) > 2.5) fecha(); lin.push(it); y = it.y; }
    fecha();
  }
  return { txt, itens };
}

// valor logo abaixo de um rótulo da DANFE (mesma coluna)
function abaixo(itens, rot) {
  const v = itens.filter((t) => t.p === rot.p && t.y < rot.y - 1 && t.y > rot.y - 16 && t.x > rot.x - 8 && t.x < rot.x + 260 && t !== rot);
  v.sort((a, b) => b.y - a.y || Math.abs(a.x - rot.x) - Math.abs(b.x - rot.x));
  return v[0] || null;
}

// do texto da DANFE: volumes (código + descrição), quantidade de volumes e a razão social do destinatário (só para comparar)
export function lerDanfe({ txt, itens }) {
  const vols = [...txt.matchAll(RE_VOL)].map((m) => ({ codigo: m[1], descricao: m[2].replace(/\s+/g, " ").trim() }));
  const codigos = [...new Set(txt.match(/\b\d{5}\.\d{4}\b/g) || [])];
  // bloco DESTINATÁRIO / REMETENTE: rótulos "NOME / RAZÃO SOCIAL" e "CNPJ / CPF" logo abaixo do título
  const tit = itens.find((t) => /DESTINAT[AÁ]RIO\s*\/\s*REMETENTE/i.test(t.s));
  const perto = (re) => tit ? itens.filter((t) => t.p === tit.p && re.test(t.s) && t.y <= tit.y + 2 && t.y > tit.y - 40).sort((a, b) => b.y - a.y)[0] : null;
  const rNome = perto(/^NOME\s*\/?\s*RAZ/i), rDoc = perto(/^CNPJ\s*\/\s*CPF/i);
  const vNome = rNome ? abaixo(itens, rNome) : null, vDoc = rDoc ? abaixo(itens, rDoc) : null;
  const dtxt = vDoc ? vDoc.s : "";
  const doc = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/.test(dtxt) ? "cnpj" : /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/.test(dtxt) ? "cpf" : null;
  const cnpj = doc === "cnpj" ? dtxt.replace(/\D/g, "").slice(0, 14) : null;
  const qVol = itens.find((t) => /^QUANTIDADE$/i.test(t.s)); const vq = qVol ? abaixo(itens, qVol) : null;
  return { vols, codigos, qtd: vq && /^\d+$/.test(vq.s) ? vq.s : null, doc, cnpj, razao: vNome ? vNome.s : "",
    achou: { titulo: !!tit, rotNome: !!rNome, rotDoc: !!rDoc } };
}

const semAc = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// transportadora pela razão social: chave de busca / apelido / nome cadastrados em Alterar pedidos › TP divergente
export function qualTransp(razao, apelidos) {
  const r = semAc(razao); if (!r) return null;
  for (const a of apelidos) for (const k of [a.chave, a.apelido]) { const kk = semAc(k); if (kk.length >= 4 && r.includes(kk)) return a.apelido || a.chave; }
  return /TRANSP|LOGIST|CARGAS|EXPRESS/.test(r) ? "?" : null;
}

export async function diagRepo({ chamar, log, ctx }) {
  const APEL = await chamar("apelidos_transp?select=apelido,chave").catch(() => []);
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
        log(`  PDF ${i + 1}: ${t.txt.length} letras · rótulos ${JSON.stringify(d.achou)} · códigos ${d.codigos.length} · razão (forma)="${d.razao.replace(/\d/g, "#").replace(/[A-Za-zÀ-ÿ]+/g, (w) => /^(LTDA|EIRELI|ME|SA|S\/A|TRANSPORTES?|LOG[IÍ]STICA|LOG|CARGAS|EXPRESS|E)$/i.test(w) ? w : "w")}" · volumes com código=${d.vols.length} · qtd volumes=${d.qtd ?? "?"} · doc destinatário=${d.doc || "?"} · razão social achada=${d.razao ? "sim" : "não"} · transportadora=${(() => { const q = qualTransp(d.razao, APEL); return q === null ? "não" : q === "?" ? "parece, sem cadastro" : q; })()} · parece empresa=${/LTDA|EIRELI|S\.?A\.?\b|TRANSP|LOG[IÍ]ST/i.test(d.razao) ? "sim" : "não"}`); });
      if (an.pdfs[0]) {   // forma das linhas: números viram #, palavras que não são rótulos da DANFE viram "w" (nenhum dado de cliente)
        const ROT = /^(DANFE|DOCUMENTO|AUXILIAR|NOTA|FISCAL|ELETR[OÔ]NICA|DESTINAT[AÁ]RIO|REMETENTE|NOME|RAZ[AÃ]O|SOCIAL|CNPJ|CPF|ENDERE[CÇ]O|BAIRRO|CEP|MUNIC[IÍ]PIO|UF|FONE|FAX|INSCRI[CÇ][AÃ]O|ESTADUAL|DATA|EMISS[AÃ]O|SA[IÍ]DA|ENTRADA|HORA|TRANSPORTADOR|VOLUMES?|TRANSPORTADOS|QUANTIDADE|ESP[EÉ]CIE|MARCA|NUMERA[CÇ][AÃ]O|PESO|BRUTO|L[IÍ]QUIDO|DADOS|PRODUTOS?|SERVI[CÇ]OS?|C[OÓ]DIGO|DESCRI[CÇ][AÃ]O|NCM|SH|CST|CFOP|UNID|QUANT|VALOR|UNIT|TOTAL|DESC|BC|ICMS|IPI|AL[IÍ]Q|ADICIONAIS|INFORMA[CÇ][OÕ]ES|COMPLEMENTARES|FRETE|CONTA|S[EÉ]RIE|FOLHA|CHAVE|ACESSO|PROTOCOLO|AUTORIZA[CÇ][AÃ]O|NATUREZA|OPERA[CÇ][AÃ]O|DE|DA|DO|POR|E|VOL|ANTT|PLACA|VE[IÍ]CULO|C[AÁ]LCULO|IMPOSTO|BASE|FATURA|DUPLICATA|RECEBEMOS|IDENTIFICA[CÇ][AÃ]O|ASSINATURA|RECEBEDOR)$/i;
        an.pdfs[0].txt.split("\n").slice(0, 90).forEach((l, k) => { const f = l.replace(/\d/g, "#").replace(/[A-Za-zÀ-ÿ]+/g, (w) => ROT.test(w) ? w : "w").replace(/\s+/g, " ").trim(); if (f) log(`  L${k}: ${f.slice(0, 140)}`); });
      }
    } catch (e) { log(`${rot}: erro ${String(e.message).split("\n")[0].slice(0, 120)}`); }
  }
}

// modo "repo-itens": lê os tickets de reposição em Aguardando entrega que ainda não foram lidos (só contagens no log)
export async function rodarRepo({ chamar, log, ctx, limite = 80 }) {
  const sem = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const APEL = await chamar("apelidos_transp?select=apelido,chave").catch(() => []);
  // todos os tickets de reposição (pré e pós): Eventos dá Parcial/Total em qualquer fila;
  // o PDF da nota (cobrança) só no pré-entrega quando chega em Aguardando entrega com nova NF
  const T = [];
  for (let de = 0; ; de += 1000) { const P = await chamar(`reposicoes_tk?select=ticket,tipo,fila,status&order=ticket&limit=1000&offset=${de}`); T.push(...P); if (P.length < 1000) break; }
  const L0 = T.filter((x) => /pos/i.test(sem(x.tipo)) || /^reposicao$/i.test(sem(x.tipo)));
  const ehAE = (x) => /aguardando\s*entrega/i.test(sem(x.fila)) && !/^(RESOLVID|ENCERRAD|FINALIZAD)/i.test(sem(x.status).toUpperCase());
  const AE = L0.filter(ehAE), comNf = new Set();
  for (let i = 0; i < AE.length; i += 150) {
    const ids = AE.slice(i, i + 150).map((x) => `"${x.ticket}"`).join(",");
    (await chamar(`repo_atual?select=ticket&nfs_novas=not.is.null&ticket=in.(${encodeURIComponent(ids)})`)).forEach((x) => comNf.add(String(x.ticket)));
  }
  const lidos = new Map(); for (let de = 0; ; de += 1000) { const P = await chamar(`repo_itens_tk?select=ticket,eventos_ok,pdf_ok,lido_em&order=ticket&limit=1000&offset=${de}`); P.forEach((x) => lidos.set(String(x.ticket), x)); if (P.length < 1000) break; }
  const pre = (x) => /^reposicao$/i.test(sem(x.tipo));
  const querPdf = (x) => pre(x) && ehAE(x) && comNf.has(String(x.ticket));
  const velho = (l) => Date.now() - new Date(l.lido_em).getTime() > 20 * 3600e3;   // falhou: tenta de novo no dia seguinte
  const falta = L0.filter((x) => {
    const l = lidos.get(String(x.ticket)); if (!l) return true;
    if (!l.eventos_ok) return velho(l);
    if (querPdf(x) && !l.pdf_ok) return l.pdf_ok === null || velho(l);   // chegou agora em Aguardando entrega: lê a nota
    return false;
  }).sort((a, b) => Number(querPdf(b)) - Number(querPdf(a)));   // primeiro os que precisam da nota
  log(`repo-itens: ${L0.length} reposições (pré e pós) · ${AE.length} em Aguardando entrega · ${comNf.size} com nova NF · ${falta.length} para ler (limite ${limite})`);
  if (!falta.length) return;
  const p = await entrarMulti360(ctx, log);
  const cont = { lidos: 0, eventos: 0, pdf: 0, cobrado: 0, cpf: 0, erro: 0 };
  for (const x of falta.slice(0, limite)) {
    const reg = { ticket: String(x.ticket), lido_em: new Date().toISOString(), fila: x.fila, eventos_ok: false, volumes: null, parcial: null, quando: null, pdf_ok: null, dest_doc: null, cobrado_transp: null, erro: null };
    let cods = [];
    try {
      await p.goto("about:blank"); await abrir(p, x.ticket);
      const ev = await lerEventos(p);
      const c = (ev.cards || [])[0];
      if (c) { reg.eventos_ok = true; reg.volumes = c.volumes ? Number(c.volumes) : null; reg.parcial = c.parcial; reg.quando = c.quando; cods = [...new Set(ev.cards.flatMap((k) => k.codigos))].map((codigo) => ({ codigo, fonte: "eventos" })); cont.eventos++; }
      if (querPdf(x)) {
        await p.goto("about:blank"); await abrir(p, x.ticket);
        const an = await lerPdfs(p);
        const ds = an.pdfs.map(lerDanfe).filter((d) => d.achou.titulo && d.doc);
        const d = ds.find((k) => k.codigos.some((cc) => cods.some((o) => o.codigo === cc))) || ds[0];
        reg.pdf_ok = !!d;
        if (d) {
          cont.pdf++; reg.dest_doc = d.doc;
          if (d.doc === "cpf") cont.cpf++;
          else { const q = qualTransp(d.razao, APEL); if (q) { reg.cobrado_transp = q === "?" ? d.razao.replace(/\s+/g, " ").trim().slice(0, 80) : q; cont.cobrado++; } }
          if (!cods.length) cods = d.codigos.map((codigo) => ({ codigo, fonte: "pdf" }));
        }
      }
    } catch (e) { reg.erro = String(e.message).split("\n")[0].slice(0, 120); cont.erro++; }
    try {
      await chamar(`repo_itens_tk?ticket=eq.${encodeURIComponent(reg.ticket)}`, "DELETE");
      await chamar("repo_itens_tk", "POST", reg);
      await chamar(`repo_itens?ticket=eq.${encodeURIComponent(reg.ticket)}`, "DELETE");
      if (cods.length) await chamar("repo_itens", "POST", cods.map((k) => ({ ticket: reg.ticket, ...k })));
    } catch (e) { log("gravar: " + String(e.message).split("\n")[0].slice(0, 120)); cont.erro++; }
    cont.lidos++;
  }
  log(`repo-itens: lidos ${cont.lidos} · com quadro Reposição ${cont.eventos} · PDF da nota lido ${cont.pdf} · cobrados da transportadora ${cont.cobrado} · CPF (sem cobrança) ${cont.cpf} · erros ${cont.erro}`);
}

// diagnóstico: tickets (por hash do número no input) com "Nota não lida": anexos, PDFs baixados e o que achou em cada um (só sim/não e contagens)
export async function diagRepo2({ chamar, log, ctx, hashes }) {
  const { createHash } = await import("node:crypto"); const hs = new Set(hashes);
  const T = []; for (let de = 0; ; de += 1000) { const P = await chamar(`reposicoes_tk?select=ticket,tipo,fila&order=ticket&limit=1000&offset=${de}`); P.forEach((x) => { if (hs.has(createHash("sha256").update(String(x.ticket)).digest("hex").slice(0, 16))) T.push(x); }); if (P.length < 1000) break; }
  log("achei", T.length, "de", hs.size);
  const p = await entrarMulti360(ctx, log);
  for (const [i, x] of T.entries()) {
    const it = (await chamar(`repo_itens_tk?select=eventos_ok,pdf_ok,dest_doc,erro,lido_em&ticket=eq.${encodeURIComponent(x.ticket)}`).catch(() => []))[0] || {};
    log(`[${i + 1}] fila ${x.fila} · gravado: pdf_ok=${it.pdf_ok} eventos_ok=${it.eventos_ok} doc=${it.dest_doc} lido ${String(it.lido_em || "").slice(0, 16)} erro=${(it.erro || "").replace(/\d{4,}/g, "#")}`);
    try {
      await abrir(p, x.ticket);
      const an = await lerPdfs(p, 8);
      log(`   anexos ${an.anexos} · PDFs lidos ${an.pdfs.length}`);
      an.pdfs.forEach((pd, j) => { const d = lerDanfe(pd); log(`   pdf ${j + 1}: ${pd.txt.length} letras · DANFE ${/DANFE/i.test(pd.txt) ? "sim" : "não"} · título dest ${d.achou.titulo} · rot nome ${d.achou.rotNome} · rot doc ${d.achou.rotDoc} · doc ${d.doc} · volumes ${d.codigos.length}`); });
      const outros = await p.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => (a.getAttribute("href") || "").split("?")[0].split(".").pop().toLowerCase()).filter((e) => /^(pdf|xml|jpg|jpeg|png|zip)$/.test(e)));
      log(`   links com extensão: ${JSON.stringify(outros.reduce((o, e) => ((o[e] = (o[e] || 0) + 1), o), {}))}`);
    } catch (e) { log("   erro:", String(e.message).split("\n")[0].slice(0, 100)); }
  }
}
