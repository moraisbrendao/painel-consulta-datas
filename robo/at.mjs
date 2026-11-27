// Assistência Técnica (Brenda 27/11): peças de cada ticket (360 › Eventos › "Peças de Assistência") e rastreio da Nota AT.
// Log público: só contagens. Peças e rastreio ficam só no Supabase (at_tk.pecas / at_tk.rastreio).
import { entrarMulti360 } from "./multi360.mjs";
import { abrir } from "./repo-itens.mjs";

// quadro "Peças de Assistência" da aba Eventos: linhas da tabela (Peça / descrição, SKU, Qtde)
export async function lerPecas(p) {
  const bt = p.getByText(/^\s*Eventos\s*$/).first();
  if (!(await bt.count())) return { erro: "sem botão Eventos" };
  await bt.click();
  await p.getByText(/Pe[cç]as de Assist[eê]ncia/i).first().waitFor({ timeout: 8000 }).catch(() => {}); await p.waitForTimeout(400);
  return p.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const limpa = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const tits = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.children.length === 0 && /^\s*Pe[cç]as de Assist[eê]ncia\s*$/i.test(e.textContent || ""));
    const out = [];
    for (const t of tits) {
      let d = t; for (let i = 0; i < 8 && d && !(/\bSKU\b/i.test(d.innerText || "") && /Qtde/i.test(d.innerText || "") && (d.innerText || "").split("\n").length > 4); i++) d = d.parentElement;
      if (!d) continue;
      let linhas = [...d.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td,th")].map((c) => limpa(c.innerText)));
      if (!linhas.length) linhas = [...d.querySelectorAll("[role=row]")].map((r) => [...r.querySelectorAll("[role=cell],[role=gridcell],[role=columnheader]")].map((c) => limpa(c.innerText)));
      let cab = null, pecas = [];
      if (linhas.length) {
        const iC = linhas.findIndex((l) => l.some((c) => /^SKU$/i.test(c)));
        cab = iC >= 0 ? linhas[iC] : null;
        const iS = cab ? cab.findIndex((c) => /^SKU$/i.test(c)) : -1, iQ = cab ? cab.findIndex((c) => /^Qtde?$/i.test(c)) : -1;
        const num = (t) => { const v = Number(String(t || "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); return isFinite(v) && String(t || "").trim() ? v : null; };
        const iV = cab ? cab.findIndex((c) => /valor|pre[cç]o|r\$/i.test(c)) : -1, iW = cab ? cab.findIndex((c) => /peso|kg/i.test(c)) : -1;
        let iP = cab ? cab.findIndex((c) => /pe[cç]a|descri|nome|produto/i.test(c) && !/^SKU$/i.test(c)) : 0; if (iP < 0) iP = iS >= 0 ? iS + 1 : 0;   // descrição fica logo depois do SKU
        pecas = linhas.slice(iC + 1).filter((l) => l.some(Boolean) && !(iQ >= 0 && !(Number(String(l[iQ] || "").replace(",", ".")) > 0) && iS >= 0 && !/\d/.test(l[iS] || "")))   // sem a linha de rodapé (sem qtde e sem código)
          .map((l) => ({ peca: l[iP] || "", sku: iS >= 0 ? l[iS] || "" : "", qtde: iQ >= 0 ? Number(String(l[iQ]).replace(",", ".")) || null : null, valor: iV >= 0 ? num(l[iV]) : null, peso: iW >= 0 ? num(l[iW]) : null }));
      } else {   // sem tabela: texto em linhas depois do cabeçalho "Qtde"
        const L = (d.innerText || "").split("\n").map(limpa).filter(Boolean);
        const iQ = L.findIndex((l) => /^Qtde?$/i.test(l));
        const resto = iQ >= 0 ? L.slice(iQ + 1) : [];
        for (let i = 0; i + 2 < resto.length + 1; i += 3) if (resto[i]) pecas.push({ peca: resto[i] || "", sku: resto[i + 1] || "", qtde: Number(String(resto[i + 2] || "").replace(",", ".")) || null });
      }
      out.push({ forma1: (linhas[(linhas.findIndex((l) => l.some((c) => /^SKU$/i.test(c)))) + 1] || []).map((c) => String(c).replace(/[A-Za-zÀ-ÿ]/g, "A").replace(/\d/g, "#").slice(0, 25)), cab, forma: linhas.length ? `tabela ${linhas.length} linhas, ${cab ? cab.length : "?"} colunas` : "texto", pecas });
    }
    return { forma1: (out[0] && out[0].forma1) || [], cab: (out[0] && out[0].cab) || [], quadros: out.length, forma: out.map((x) => x.forma).join(" | "), pecas: out.flatMap((x) => x.pecas) };
  });
}

export async function rodarAt({ chamar, log, ctx, R, limite = 150, so = "" }) {
  const T = await chamar("at_tk?select=ticket,fila,nota_at,transp_envio,transp_promob,redesp_promob,pecas,pecas_em,rastreio,rastreio_em&na_planilha=eq.true&order=criado_em.desc&limit=5000");
  // relê quem foi lido com a versão antiga (peça sem descrição ou linha de rodapé)
  const velho = (x) => (x.pecas || []).some((y) => !y.peca || (y.qtde == null && !/\d/.test(y.sku || "")) || !("valor" in y));   // 27/11: valor e peso da peça
  const semPeca = T.filter((x) => !x.pecas_em || velho(x)).slice(0, limite);
  const H = 20 * 3600000;
  const rast = T.filter((x) => x.nota_at && !/^entregue/i.test((x.rastreio && x.rastreio.situacao) || "") && (!x.rastreio_em || Date.now() - Date.parse(x.rastreio_em) > H));
  { const c = (f) => JSON.stringify(Object.entries(T.reduce((a, x) => { const k = f(x); a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 25));
    log(`AT filas: ${c((x) => (x.fila || "—").slice(0, 40))}`);
    log(`AT rastreio: ${c((x) => (x.rastreio && x.rastreio.situacao) || "—")} · eventos ${c((x) => String((x.rastreio && x.rastreio.evento) || "—").replace(/\d+/g, "#").trim().split(/\s+/).slice(0, 2).join(" ").slice(0, 25))}`); }
  log(`AT: ${T.length} tickets na planilha · ${semPeca.length} para ler peças · ${rast.length} para rastrear`);
  // confere que gravou de verdade (sem permissão o banco responde OK com 0 linhas)
  const patch = async (tk, c) => { const r = await chamar(`at_tk?ticket=eq.${encodeURIComponent(tk)}&select=ticket`, "PATCH", c, { Prefer: "return=representation" });
    if (!Array.isArray(r) || !r.length) throw new Error("não gravou em at_tk: falta rodar a parte 108 no Supabase"); };
  if (T.length) await patch(T[0].ticket, { ticket: T[0].ticket });   // teste de gravação antes de abrir o 360
  if (so !== "rastreio" && semPeca.length) {
    const p = await entrarMulti360(ctx, log);
    let ok = 0, vazio = 0, erro = 0; const formas = {};
    // 4 abas do 360 ao mesmo tempo (Brenda 27/11: 45 min era muito); mesma sessão logada
    const ABAS = Math.max(1, Math.min(6, Number(process.env.AT_ABAS) || 4));
    const pgs = [p]; for (let i = 1; i < Math.min(ABAS, semPeca.length); i++) pgs.push(await p.context().newPage());
    const fila = [...semPeca];
    await Promise.all(pgs.map(async (p) => { for (let x = fila.shift(); x; x = fila.shift()) {
      try {
        await abrir(p, x.ticket);
        const r = await lerPecas(p);
        formas[r.forma || r.erro || "sem quadro"] = (formas[r.forma || r.erro || "sem quadro"] || 0) + 1;
        const pecas = (r.pecas || []).filter((y) => y.peca || y.sku);
        await patch(x.ticket, { pecas, pecas_em: new Date().toISOString(), pecas_msg: r.erro || (r.quadros ? null : "sem quadro Peças de Assistência") });
        pecas.length ? ok++ : vazio++;
        if (limite <= 5) log(`  formato: cab=${JSON.stringify((r.cab || []).map((c) => c.replace(/[A-Za-zÀ-ÿ]+/g, (w) => (/^(pe[cç]as?|sku|qtde|descri[cç][aã]o|nome|c[oó]digo|valor|unit[aá]rio|total|a[cç][oõ]es|status|item|modelo|cor|lado|tipo|motivo|defeito|volume)$/i.test(w) ? w : "w:" + w.length))))} · 1ª linha ${JSON.stringify(r.forma1 || [])} · ` + pecas.map((y) => `[peça ${String(y.peca).split(/\s+/).length} palavras · sku ${String(y.sku).replace(/[A-Za-z]/g, "A").replace(/\d/g, "#")} · qtde ${y.qtde}]`).join(" "));
      } catch (e) { erro++; await patch(x.ticket, { pecas_msg: String(e.message).split("\n")[0].slice(0, 150) }).catch(() => {}); }
    } }));
    log(`AT peças: ${ok} com peça · ${vazio} sem peça · ${erro} com erro · formas ${JSON.stringify(formas).replace(/\d{5,}/g, "#")}`);
  }
  if (so !== "pecas" && R && rast.length) {
    const B = await import("./barrar.mjs");
    const cont = {};
    for (const x of rast) {
      const tp = x.transp_envio || x.redesp_promob || x.transp_promob || "";
      let r = null;
      try { r = await B.rastrear({ nf: String(x.nota_at).trim(), transp_pedido: tp }, R); } catch (_) {}
      const rs = r ? { fonte: r.fonte, situacao: r.situacao, evento: r.evento, data: r.data_evento, transp: r.transp } : { situacao: "não achado" };
      cont[rs.situacao || "?"] = (cont[rs.situacao || "?"] || 0) + 1;
      await patch(x.ticket, { rastreio: rs, rastreio_em: new Date().toISOString() }).catch(() => {});
    }
    log(`AT rastreio: ${JSON.stringify(cont)}`);
  }
}
