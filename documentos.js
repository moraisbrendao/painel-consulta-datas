// Consulta Documento: planilha (NF + transportadora) → chave da base → XML enviado pelo usuário → PDF (DANFE) + .zip por transportadora.
// Tudo fica só no navegador (nada dos XMLs vai para o banco).
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("pagina-documentos")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const sem0 = (t) => String(t ?? "").trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");
  const hoje = () => new Date().toISOString().slice(0, 10);
  const SITE = "https://meudanfe.com.br/";
  const LIBS = {
    jspdf: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
    barcode: "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js",
    zip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  };
  const carregadas = {};
  const lib = (k) => carregadas[k] || (carregadas[k] = new Promise((ok, erro) => { const s = document.createElement("script"); s.src = LIBS[k]; s.onload = ok; s.onerror = () => { delete carregadas[k]; erro(new Error("Não consegui carregar a biblioteca " + k + ". Confira a internet e tente de novo.")); }; document.head.appendChild(s); }));

  let linhas = [];        // {id, num, serie, transp, pedido, chave, xml, dados, pdf, fora}
  let card = "todos";
  const info = (t, erro) => { const p = $("dc-info"); p.innerHTML = t; p.classList.toggle("erro", !!erro); };
  const chaveFmt = (c) => (c || "").replace(/(\d{4})(?=\d)/g, "$1 ");
  const nfTxt = (l) => l.num + (l.serie ? "-" + l.serie : "");
  const temXml = (l) => !!l.xml;
  const passa = (l) => {
    if (card === "chave" && !l.chave) return false;
    if (card === "semchave" && l.chave) return false;
    if (card === "falta" && (temXml(l) || !l.chave)) return false;
    if (card === "pronto" && !temXml(l)) return false;
    const t = $("dc-transp").value; if (t && l.transp !== t) return false;
    const b = norm($("dc-busca").value).replace(/\s/g, "");
    if (b && ![l.num, nfTxt(l), l.pedido, l.chave].some((x) => norm(x).replace(/\s/g, "").includes(b))) return false;
    return true;
  };

  function desenhar() {
    const cont = { todos: linhas.length, chave: 0, semchave: 0, falta: 0, pronto: 0 };
    linhas.forEach((l) => { if (l.chave) cont.chave++; else cont.semchave++; if (temXml(l)) cont.pronto++; else if (l.chave) cont.falta++; });
    document.querySelectorAll("#dc-cards .kpi").forEach((b) => { b.querySelector(".kpi-num").textContent = cont[b.dataset.dc].toLocaleString("pt-BR"); b.classList.toggle("ativa", b.dataset.dc === card); });
    // filtro de transportadora
    const sel = $("dc-transp"), atual = sel.value, ts = [...new Set(linhas.map((l) => l.transp))].sort();
    sel.innerHTML = `<option value="">Todas</option>` + ts.map((t) => `<option${t === atual ? " selected" : ""}>${esc(t)}</option>`).join("");
    // por transportadora
    const g = new Map(); linhas.forEach((l) => { const x = g.get(l.transp) || g.set(l.transp, { n: 0, c: 0, x: 0, f: 0 }).get(l.transp); x.n++; if (l.chave) x.c++; if (temXml(l)) x.x++; else if (l.chave) x.f++; });
    $("dc-transp-linhas").innerHTML = [...g.entries()].sort((a, b) => b[1].n - a[1].n).map(([t, x]) => `<tr><td>${esc(t)}</td><td>${x.n}</td><td>${x.c}</td><td>${x.x}</td><td>${x.f ? `<b class="ruim-t">${x.f}</b>` : 0}</td>
      <td>${x.x ? `<button class="btn contorno pequeno" data-zip="${esc(t)}">Baixar .zip (${x.x})</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="vazio">—</td></tr>`;
    const L = linhas.filter(passa);
    $("dc-titulo").textContent = `Notas (${L.length})`;
    $("dc-vazio").hidden = !!L.length; $("dc-vazio").textContent = linhas.length ? "Nenhuma nota aqui." : "Digite uma nota acima ou envie a planilha.";
    $("dc-linhas").innerHTML = L.slice(0, 500).map((l) => `<tr>
      <td><b>${esc(nfTxt(l))}</b>${l.fora ? `<div class="s">veio só no XML (não estava na planilha)</div>` : ""}</td>
      <td>${esc(l.transp)}</td><td>${esc(l.pedido || "—")}</td>
      <td class="mono">${l.chave ? esc(chaveFmt(l.chave)) : `<span class="ruim-t">${l.achouBase ? "NF na base sem chave" : "NF não está na base"}</span>`}</td>
      <td>${temXml(l) ? `<span class="chip ok">✓ XML e PDF</span>` : l.chave ? `<span class="chip">falta</span>` : "—"}</td>
      <td class="acoes-linha">${l.chave ? `<button class="btn contorno pequeno" data-copiar="${l.id}" title="Copia a chave e abre o site de consulta">Copiar chave ↗</button>` : ""}
        ${temXml(l) ? `<button class="link" data-pdf="${l.id}">PDF</button> <button class="link" data-xmlb="${l.id}">XML</button>` : ""}</td></tr>`).join("")
      + (L.length > 500 ? `<tr><td colspan="6" class="vazio">Mostrando 500 de ${L.length}. Use os filtros.</td></tr>` : "");
  }

  // ---------- planilha ----------
  $("dc-modelo").addEventListener("click", () => {
    const ws = XLSX.utils.aoa_to_sheet([["NF", "Série", "Transportadora"]]); ws["!cols"] = [{ wch: 14 }, { wch: 8 }, { wch: 28 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Notas"); XLSX.writeFile(wb, "modelo_consulta_documento.xlsx");
  });
  $("dc-arq").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    info("Lendo a planilha…");
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
      const iCab = rows.findIndex((r) => r && r.some((c) => /^(NF|NOTA|NOTA FISCAL|NOTA-SERIE|NF-SERIE|NUMERO NF|N NF)/.test(norm(c))));
      if (iCab < 0) throw new Error('Não achei a coluna "NF" na planilha. Use o botão Modelo da planilha.');
      const cab = rows[iCab].map(norm);
      const iNf = cab.findIndex((c) => /^(NF|NOTA|NUMERO NF|N NF)/.test(c) && !/SERIE$/.test(c) || /^(NOTA-SERIE|NF-SERIE)/.test(c));
      const iSer = cab.findIndex((c, i) => i !== iNf && /^SERIE/.test(c));
      const iTr = cab.findIndex((c) => /TRANSPORTADORA/.test(c));
      if (iTr < 0) throw new Error('Não achei a coluna "Transportadora" na planilha.');
      const vistos = new Set(); linhas = []; let id = 0;
      for (const r of rows.slice(iCab + 1)) {
        let [num, ser] = String(r[iNf] ?? "").split("-").map((x) => sem0(x.replace(/\D/g, "") ? x.trim() : ""));
        num = sem0(String(num || "").replace(/\D/g, "")); if (!num) continue;
        if (!ser && iSer >= 0) ser = sem0(String(r[iSer] ?? "").replace(/\D/g, ""));
        const transp = String(r[iTr] ?? "").trim() || "(sem transportadora)", k = num + "-" + (ser || "") + "|" + norm(transp);
        if (vistos.has(k)) continue; vistos.add(k);
        linhas.push({ id: ++id, num, serie: ser || "", transp, pedido: "", chave: "", xml: null });
      }
      if (!linhas.length) throw new Error("A planilha não tem nenhuma NF.");
      card = "todos"; desenhar();
      info(`Procurando a chave de ${linhas.length} notas na base…`);
      await buscarChaves();
      const ach = linhas.filter((l) => l.chave).length;
      info(`<b>${esc(arq.name)}</b> · ${linhas.length} notas · chave encontrada em ${ach}${ach < linhas.length ? ` · ${linhas.length - ach} sem chave na base` : ""}.`);
    } catch (err) { info("⚠ " + esc(err.message || err), true); }
    desenhar();
  });

  async function buscarChaves(alvo = linhas) {
    const sb = window.__sb; if (!sb) throw new Error("Entre no painel de novo (sessão expirada).");
    const nums = [...new Set(alvo.map((l) => l.num))], achados = [];
    for (let i = 0; i < nums.length; i += 40) {
      const parte = nums.slice(i, i + 40), filtro = parte.flatMap((n) => [`nf.eq.${n}`, `nf.like.${n}-*`]).join(",");
      const { data, error } = await sb.from("base_pedidos").select("pedido,nf,transportadora,chave:extra->>chave").or(filtro);
      if (error) throw new Error("Não consegui ler a base: " + error.message);
      achados.push(...(data || []));
      info(`Procurando a chave na base… ${Math.min(i + 40, nums.length)} de ${nums.length}`);
    }
    const porNum = new Map(); achados.forEach((b) => { const [n, s] = String(b.nf || "").split("-").map(sem0); (porNum.get(n) || porNum.set(n, []).get(n)).push({ ...b, s: s || "" }); });
    for (const l of alvo) {
      let c = porNum.get(l.num) || []; l.achouBase = !!c.length;
      if (l.serie) c = c.filter((b) => !b.s || b.s === l.serie);
      const com = c.find((b) => /^\d{44}$/.test(String(b.chave || "").replace(/\D/g, ""))) || c[0];
      if (!com) continue;
      l.pedido = com.pedido || ""; if (!l.serie) l.serie = com.s || ""; if (!l.transp) l.transp = com.transportadora || "(sem transportadora)";
      const ch = String(com.chave || "").replace(/\D/g, ""); if (ch.length === 44) l.chave = ch;
    }
  }

  // ---------- digitar NF-série ----------
  async function adicionarDigitadas() {
    const txt = $("dc-nf").value.trim(); if (!txt) return;
    const novos = []; let id = linhas.reduce((m, l) => Math.max(m, l.id), 0), repetidas = 0;
    for (const pedaco of txt.split(/[\s,;]+/)) {
      const [n, se] = pedaco.split("-"), num = sem0(String(n || "").replace(/\D/g, "")), serie = sem0(String(se || "").replace(/\D/g, ""));
      if (!num) continue;
      if (linhas.some((l) => l.num === num && (!serie || l.serie === serie)) || novos.some((l) => l.num === num && l.serie === serie)) { repetidas++; continue; }
      novos.push({ id: ++id, num, serie, transp: "", pedido: "", chave: "", xml: null, digitada: true });
    }
    if (!novos.length) { info(repetidas ? "Essa nota já está na tabela." : "Digite a nota como NF-série, ex.: 12365-35.", !repetidas); return; }
    info(`Procurando a chave de ${novos.length} nota(s) na base…`);
    try { await buscarChaves(novos); } catch (err) { info("⚠ " + esc(err.message || err), true); return; }
    novos.forEach((l) => { if (!l.transp) l.transp = "(não está na base)"; });
    linhas = novos.concat(linhas); card = "todos"; $("dc-nf").value = "";
    const ach = novos.filter((l) => l.chave).length;
    info(`${novos.length} nota(s) digitada(s) · chave encontrada em ${ach}${ach < novos.length ? ` · ${novos.length - ach} sem chave na base` : ""}${repetidas ? ` · ${repetidas} já estava(m) na tabela` : ""}.`, !ach);
    desenhar();
  }
  $("dc-nf-add").addEventListener("click", adicionarDigitadas);
  $("dc-nf").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); adicionarDigitadas(); } });

  // ---------- XML ----------
  const tag = (el, nome) => (el ? el.getElementsByTagNameNS("*", nome)[0] || null : null);
  const tx = (el, nome) => { const t = tag(el, nome); return t ? t.textContent.trim() : ""; };
  function lerXml(texto) {
    const doc = new DOMParser().parseFromString(texto, "application/xml");
    const inf = tag(doc, "infNFe"); if (!inf) return null;
    const chave = (inf.getAttribute("Id") || "").replace(/\D/g, "") || tx(doc, "chNFe");
    if (chave.length !== 44) return null;
    const ide = tag(inf, "ide"), emit = tag(inf, "emit"), dest = tag(inf, "dest"), tot = tag(inf, "ICMSTot"), transp = tag(inf, "transp"), prot = tag(doc, "infProt");
    const end = (e) => { const x = tag(e, "enderEmit") || tag(e, "enderDest"); return x ? { lgr: [tx(x, "xLgr"), tx(x, "nro"), tx(x, "xCpl")].filter(Boolean).join(", "), bairro: tx(x, "xBairro"), mun: tx(x, "xMun"), uf: tx(x, "UF"), cep: tx(x, "CEP"), fone: tx(x, "fone") } : {}; };
    const itens = [...inf.getElementsByTagNameNS("*", "det")].map((d) => { const p = tag(d, "prod"); return { cod: tx(p, "cProd"), desc: tx(p, "xProd"), ncm: tx(p, "NCM"), cfop: tx(p, "CFOP"), un: tx(p, "uCom"), q: tx(p, "qCom"), vu: tx(p, "vUnCom"), vt: tx(p, "vProd") }; });
    const vol = tag(transp, "vol"), tr = tag(transp, "transporta");
    return {
      chave, num: sem0(tx(ide, "nNF")), serie: sem0(tx(ide, "serie")), natOp: tx(ide, "natOp"), dhEmi: tx(ide, "dhEmi") || tx(ide, "dEmi"), tpNF: tx(ide, "tpNF"),
      emit: { nome: tx(emit, "xNome"), fant: tx(emit, "xFant"), doc: tx(emit, "CNPJ") || tx(emit, "CPF"), ie: tx(emit, "IE"), ...end(emit) },
      dest: { nome: tx(dest, "xNome"), doc: tx(dest, "CNPJ") || tx(dest, "CPF"), ie: tx(dest, "IE"), ...end(dest) },
      tot: { vBC: tx(tot, "vBC"), vICMS: tx(tot, "vICMS"), vBCST: tx(tot, "vBCST"), vST: tx(tot, "vST"), vProd: tx(tot, "vProd"), vFrete: tx(tot, "vFrete"), vSeg: tx(tot, "vSeg"), vDesc: tx(tot, "vDesc"), vOutro: tx(tot, "vOutro"), vIPI: tx(tot, "vIPI"), vNF: tx(tot, "vNF") },
      transp: { mod: tx(transp, "modFrete"), nome: tx(tr, "xNome"), doc: tx(tr, "CNPJ") || tx(tr, "CPF"), ie: tx(tr, "IE"), end: tx(tr, "xEnder"), mun: tx(tr, "xMun"), uf: tx(tr, "UF"), qVol: tx(vol, "qVol"), esp: tx(vol, "esp"), pesoL: tx(vol, "pesoL"), pesoB: tx(vol, "pesoB") },
      prot: prot ? `${tx(prot, "nProt")} ${tx(prot, "dhRecbto").replace("T", " ").slice(0, 19)}` : "",
      infCpl: tx(tag(inf, "infAdic"), "infCpl"), itens,
    };
  }
  $("dc-xml").addEventListener("change", async (e) => {
    const arqs = [...e.target.files]; e.target.value = ""; if (!arqs.length) return;
    info(`Lendo ${arqs.length} arquivo(s)…`);
    const textos = [];
    try {
      for (const a of arqs) {
        if (/\.zip$/i.test(a.name)) { await lib("zip"); const z = await JSZip.loadAsync(a); for (const f of Object.values(z.files)) if (!f.dir && /\.xml$/i.test(f.name)) textos.push(await f.async("string")); }
        else textos.push(await a.text());
      }
    } catch (err) { info("⚠ " + esc(err.message || err), true); return; }
    let ok = 0, novos = 0, ruins = 0; let id = linhas.reduce((m, l) => Math.max(m, l.id), 0);
    for (const t of textos) {
      const d = lerXml(t); if (!d) { ruins++; continue; }
      let l = linhas.find((x) => x.chave === d.chave) || linhas.find((x) => !x.chave && x.num === d.num && (!x.serie || x.serie === d.serie));
      if (!l) { l = { id: ++id, num: d.num, serie: d.serie, transp: d.transp.nome || "(sem transportadora)", pedido: "", chave: d.chave, fora: true }; linhas.push(l); novos++; }
      l.chave = d.chave; l.serie = l.serie || d.serie; l.xml = t; l.dados = d; l.pdf = null; ok++;
    }
    info(`${ok} XML recebido(s)${novos ? ` · ${novos} não estavam na planilha (entraram pela transportadora do XML)` : ""}${ruins ? ` · ${ruins} arquivo(s) não são XML de NF-e` : ""}.`, !ok);
    desenhar();
  });

  // ---------- DANFE (PDF montado a partir do XML) ----------
  const moeda = (v) => (v === "" || v == null ? "" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const qtd = (v) => (v === "" || v == null ? "" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 4 }));
  const docFmt = (d) => (d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") : d);
  const dataBr = (s) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
  const MODFRETE = { 0: "0 - Por conta do emitente", 1: "1 - Por conta do destinatário", 2: "2 - Por conta de terceiros", 3: "3 - Próprio (remetente)", 4: "4 - Próprio (destinatário)", 9: "9 - Sem frete" };
  async function montarPdf(l) {
    if (l.pdf) return l.pdf;
    await lib("jspdf"); await lib("barcode");
    const d = l.dados, { jsPDF } = window.jspdf, pdf = new jsPDF({ unit: "mm", format: "a4" });
    const M = 6, W = 210 - 2 * M;
    const caixa = (x, y, w, h, rot, val, op = {}) => { pdf.setDrawColor(0); pdf.setLineWidth(0.2); pdf.rect(x, y, w, h);
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(5.5); pdf.text(rot.toUpperCase(), x + 1, y + 2.3);
      pdf.setFont("helvetica", op.negrito ? "bold" : "normal"); pdf.setFontSize(op.fs || 8);
      const linhasV = pdf.splitTextToSize(String(val ?? ""), w - 2); pdf.text(linhasV.slice(0, op.max || 1), op.dir ? x + w - 1 : x + 1, y + 5.6, op.dir ? { align: "right" } : undefined); };
    const titulo = (y, t) => { pdf.setFont("helvetica", "bold"); pdf.setFontSize(7); pdf.text(t, M, y - 0.8); };
    let y = M;
    // canhoto
    caixa(M, y, W - 40, 10, "Recebemos de " + (d.emit.nome || "") + " os produtos constantes da nota fiscal indicada ao lado", "Data de recebimento / Identificação e assinatura do recebedor", { fs: 6 });
    caixa(M + W - 40, y, 40, 10, "NF-e", `Nº ${d.num}  Série ${d.serie}`, { negrito: true }); y += 13;
    // cabeçalho
    pdf.rect(M, y, 80, 32); pdf.setFont("helvetica", "bold"); pdf.setFontSize(9);
    pdf.text(pdf.splitTextToSize(d.emit.nome || "", 76).slice(0, 2), M + 2, y + 6);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7);
    pdf.text(pdf.splitTextToSize([d.emit.lgr, d.emit.bairro, `${d.emit.mun} - ${d.emit.uf}`, d.emit.cep ? "CEP " + d.emit.cep : "", d.emit.fone ? "Fone " + d.emit.fone : ""].filter(Boolean).join(" · "), 76).slice(0, 4), M + 2, y + 15);
    pdf.rect(M + 80, y, 32, 32); pdf.setFont("helvetica", "bold"); pdf.setFontSize(12); pdf.text("DANFE", M + 96, y + 6, { align: "center" });
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(6); pdf.text(["Documento Auxiliar da", "Nota Fiscal Eletrônica"], M + 96, y + 9.5, { align: "center" });
    pdf.setFontSize(7); pdf.text(`${d.tpNF === "0" ? "[0] Entrada" : "[1] Saída"}`, M + 96, y + 17, { align: "center" });
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8); pdf.text([`Nº ${d.num}`, `Série ${d.serie}`], M + 96, y + 23, { align: "center" });
    const cv = document.createElement("canvas"); JsBarcode(cv, d.chave, { format: "CODE128C", displayValue: false, margin: 0, height: 60, width: 2 });
    pdf.rect(M + 112, y, W - 112, 32); pdf.addImage(cv.toDataURL("image/png"), "PNG", M + 114, y + 2, W - 116, 11);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(5.5); pdf.text("CHAVE DE ACESSO", M + 114, y + 16);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(7.5); pdf.text(chaveFmt(d.chave), M + 114, y + 19.5);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(6); pdf.text(pdf.splitTextToSize("Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora", W - 116), M + 114, y + 24);
    y += 32;
    caixa(M, y, 112, 8, "Natureza da operação", d.natOp); caixa(M + 112, y, W - 112, 8, "Protocolo de autorização de uso", d.prot); y += 8;
    caixa(M, y, 70, 8, "Inscrição estadual", d.emit.ie); caixa(M + 70, y, 70, 8, "Inscrição estadual do subst. trib.", ""); caixa(M + 140, y, W - 140, 8, "CNPJ", docFmt(d.emit.doc)); y += 11;
    titulo(y, "DESTINATÁRIO / REMETENTE");
    caixa(M, y, 120, 8, "Nome / razão social", d.dest.nome); caixa(M + 120, y, 45, 8, "CNPJ / CPF", docFmt(d.dest.doc)); caixa(M + 165, y, W - 165, 8, "Data da emissão", dataBr(d.dhEmi)); y += 8;
    caixa(M, y, 100, 8, "Endereço", d.dest.lgr); caixa(M + 100, y, 45, 8, "Bairro / distrito", d.dest.bairro); caixa(M + 145, y, W - 145, 8, "CEP", d.dest.cep); y += 8;
    caixa(M, y, 80, 8, "Município", d.dest.mun); caixa(M + 80, y, 15, 8, "UF", d.dest.uf); caixa(M + 95, y, 45, 8, "Fone / fax", d.dest.fone); caixa(M + 140, y, W - 140, 8, "Inscrição estadual", d.dest.ie); y += 11;
    titulo(y, "CÁLCULO DO IMPOSTO");
    const t = d.tot, w5 = W / 5;
    [["Base de cálculo do ICMS", t.vBC], ["Valor do ICMS", t.vICMS], ["Base de cálc. ICMS S.T.", t.vBCST], ["Valor do ICMS subst.", t.vST], ["Valor total dos produtos", t.vProd]].forEach(([r, v], i) => caixa(M + i * w5, y, w5, 8, r, moeda(v), { dir: true })); y += 8;
    [["Valor do frete", t.vFrete], ["Valor do seguro", t.vSeg], ["Desconto", t.vDesc], ["Outras despesas", t.vOutro], ["Valor total da nota", t.vNF]].forEach(([r, v], i) => caixa(M + i * w5, y, w5, 8, r, moeda(v), { dir: true, negrito: i === 4 })); y += 11;
    titulo(y, "TRANSPORTADOR / VOLUMES TRANSPORTADOS");
    const tr = d.transp;
    caixa(M, y, 85, 8, "Nome / razão social", tr.nome); caixa(M + 85, y, 45, 8, "Frete por conta", MODFRETE[tr.mod] || tr.mod, { fs: 6.5 }); caixa(M + 130, y, W - 130, 8, "CNPJ / CPF", docFmt(tr.doc)); y += 8;
    caixa(M, y, 85, 8, "Endereço", tr.end); caixa(M + 85, y, 50, 8, "Município", tr.mun); caixa(M + 135, y, 12, 8, "UF", tr.uf); caixa(M + 147, y, W - 147, 8, "Inscrição estadual", tr.ie); y += 8;
    caixa(M, y, 40, 8, "Quantidade", tr.qVol); caixa(M + 40, y, 50, 8, "Espécie", tr.esp); caixa(M + 90, y, 50, 8, "Peso bruto", qtd(tr.pesoB), { dir: true }); caixa(M + 140, y, W - 140, 8, "Peso líquido", qtd(tr.pesoL), { dir: true }); y += 11;
    // produtos
    const cols = [["Código", 22], ["Descrição do produto / serviço", 78], ["NCM", 15], ["CFOP", 10], ["Un", 9], ["Qtd", 18], ["V. unit.", 22], ["V. total", W - 174]];
    const cabProd = () => { titulo(y, "DADOS DO PRODUTO / SERVIÇO"); let x = M; pdf.setFont("helvetica", "bold"); pdf.setFontSize(6); cols.forEach(([n, w]) => { pdf.rect(x, y, w, 5); pdf.text(n.toUpperCase(), x + 1, y + 3.4); x += w; }); y += 5; };
    cabProd();
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(6.5);
    for (const it of d.itens) {
      const desc = pdf.splitTextToSize(it.desc, 76), h = Math.max(4.5, desc.length * 2.8 + 1.6);
      if (y + h > 297 - M - 30) { pdf.addPage(); y = M + 4; cabProd(); pdf.setFont("helvetica", "normal"); pdf.setFontSize(6.5); }
      let x = M; const v = [it.cod, desc, it.ncm, it.cfop, it.un, qtd(it.q), moeda(it.vu), moeda(it.vt)];
      cols.forEach(([, w], i) => { pdf.rect(x, y, w, h); const dir = i >= 5; pdf.text(v[i], dir ? x + w - 1 : x + 1, y + 3, dir ? { align: "right" } : undefined); x += w; }); y += h;
    }
    y += 4; if (y > 297 - M - 28) { pdf.addPage(); y = M + 4; }
    titulo(y, "DADOS ADICIONAIS");
    pdf.rect(M, y, W, 26); pdf.setFont("helvetica", "normal"); pdf.setFontSize(5.5); pdf.text("INFORMAÇÕES COMPLEMENTARES", M + 1, y + 2.3);
    pdf.setFontSize(6.5); pdf.text(pdf.splitTextToSize(d.infCpl || "", W - 2).slice(0, 9), M + 1, y + 5.5);
    pdf.setFontSize(5.5); pdf.text("DANFE montado no E-loggia a partir do XML autorizado da NF-e.", M, 297 - 3);
    l.pdf = pdf.output("blob"); return l.pdf;
  }
  const nomeArq = (l, ext) => `NF_${l.num}${l.serie ? "-" + l.serie : ""}.${ext}`;
  const baixar = (blob, nome) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); };
  const pasta = (t) => t.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "transportadora";
  async function zip(lista, nome, porPasta) {
    await lib("zip"); const z = new JSZip(); let n = 0;
    for (const l of lista) { if (!l.xml) continue; const p = porPasta ? z.folder(pasta(l.transp)) : z; info(`Montando PDF ${++n} de ${lista.filter((x) => x.xml).length}…`);
      p.file(nomeArq(l, "xml"), l.xml); p.file(nomeArq(l, "pdf"), await montarPdf(l)); }
    if (!n) { info("Nenhum XML recebido para baixar.", true); return; }
    baixar(await z.generateAsync({ type: "blob" }), nome); info(`${n} nota(s) no arquivo ${esc(nome)}.`);
  }

  // ---------- cliques ----------
  $("dc-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi"); if (!b) return; card = b.dataset.dc; desenhar(); });
  $("dc-busca").addEventListener("input", desenhar); $("dc-transp").addEventListener("change", desenhar);
  $("dc-limpar").addEventListener("click", () => { $("dc-busca").value = ""; $("dc-transp").value = ""; card = "todos"; desenhar(); });
  $("dc-zip-tudo").addEventListener("click", () => zip(linhas, `documentos_${hoje()}.zip`, true).catch((err) => info("⚠ " + esc(err.message || err), true)));
  $("pagina-documentos").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.zip != null) { const t = b.dataset.zip; await zip(linhas.filter((l) => l.transp === t), `documentos_${pasta(t)}_${hoje()}.zip`, false); }
      const l = linhas.find((x) => String(x.id) === (b.dataset.copiar || b.dataset.pdf || b.dataset.xmlb)); if (!l) return;
      if (b.dataset.copiar) {
        let ok = false; try { await navigator.clipboard.writeText(l.chave); ok = true; } catch (_) {}
        window.open(SITE, "_blank", "noopener");
        b.textContent = ok ? "✓ Chave copiada" : "Copie: " + l.chave;
      }
      if (b.dataset.pdf) baixar(await montarPdf(l), nomeArq(l, "pdf"));
      if (b.dataset.xmlb) baixar(new Blob([l.xml], { type: "application/xml" }), nomeArq(l, "xml"));
    } catch (err) { info("⚠ " + esc(err.message || err), true); }
  });
  desenhar();
})();
