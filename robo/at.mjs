// Assistência Técnica (Brenda 27/11): peças de cada ticket (360 › Eventos › "Peças de Assistência") e rastreio da Nota AT.
// Log público: só contagens. Peças e rastreio ficam só no Supabase (at_tk.pecas / at_tk.rastreio).
import { entrarMulti360 } from "./multi360.mjs";
import { abrir } from "./repo-itens.mjs";

// quadro "Peças de Assistência" da aba Eventos: linhas da tabela (Peça / descrição, SKU, Qtde)
export async function lerPecas(p) {
  const bt = p.getByText(/^\s*Eventos\s*$/).first();
  if (!(await bt.count())) return { erro: "sem botão Eventos" };
  await bt.click(); await p.waitForTimeout(2500);
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
        let iP = cab ? cab.findIndex((c) => /pe[cç]a|descri|nome|produto/i.test(c) && !/^SKU$/i.test(c)) : 0; if (iP < 0) iP = iS >= 0 ? iS + 1 : 0;   // descrição fica logo depois do SKU
        pecas = linhas.slice(iC + 1).filter((l) => l.some(Boolean) && !(iQ >= 0 && !String(l[iQ] || "").trim() && iS >= 0 && !/\d/.test(l[iS] || "")))   // sem a linha de rodapé (sem qtde e sem código).map((l) => ({ peca: l[iP] || "", sku: iS >= 0 ? l[iS] || "" : "", qtde: iQ >= 0 ? Number(String(l[iQ]).replace(",", ".")) || null : null }));
      } else {   // sem tabela: texto em linhas depois do cabeçalho "Qtde"
        const L = (d.innerText || "").split("\n").map(limpa).filter(Boolean);
        const iQ = L.findIndex((l) => /^Qtde?$/i.test(l));
        const resto = iQ >= 0 ? L.slice(iQ + 1) : [];
        for (let i = 0; i + 2 < resto.length + 1; i += 3) if (resto[i]) pecas.push({ peca: resto[i] || "", sku: resto[i + 1] || "", qtde: Number(String(resto[i + 2] || "").replace(",", ".")) || null });
      }
      out.push({ cab, forma: linhas.length ? `tabela ${linhas.length} linhas, ${cab ? cab.length : "?"} colunas` : "texto", pecas });
    }
    return { cab: (out[0] && out[0].cab) || [], quadros: out.length, forma: out.map((x) => x.forma).join(" | "), pecas: out.flatMap((x) => x.pecas) };
  });
}

export async function rodarAt({ chamar, log, ctx, R, limite = 150, so = "" }) {
  const T = await chamar("at_tk?select=ticket,nota_at,transp_envio,transp_promob,redesp_promob,pecas,pecas_em,rastreio,rastreio_em&na_planilha=eq.true&order=criado_em.desc&limit=5000");
  // relê quem foi lido com a versão antiga (peça sem descrição ou linha de rodapé)
  const velho = (x) => (x.pecas || []).some((y) => !y.peca || (y.qtde == null && !/\d/.test(y.sku || "")));
  const semPeca = T.filter((x) => !x.pecas_em || velho(x)).slice(0, limite);
  const H = 20 * 3600000;
  const rast = T.filter((x) => x.nota_at && !/^entregue/i.test((x.rastreio && x.rastreio.situacao) || "") && (!x.rastreio_em || Date.now() - Date.parse(x.rastreio_em) > H));
  log(`AT: ${T.length} tickets na planilha · ${semPeca.length} para ler peças · ${rast.length} para rastrear`);
  const patch = (tk, c) => chamar(`at_tk?ticket=eq.${encodeURIComponent(tk)}`, "PATCH", c);
  if (so !== "rastreio" && semPeca.length) {
    const p = await entrarMulti360(ctx, log);
    let ok = 0, vazio = 0, erro = 0; const formas = {};
    for (const x of semPeca) {
      try {
        await abrir(p, x.ticket);
        const r = await lerPecas(p);
        formas[r.forma || r.erro || "sem quadro"] = (formas[r.forma || r.erro || "sem quadro"] || 0) + 1;
        const pecas = (r.pecas || []).filter((y) => y.peca || y.sku);
        await patch(x.ticket, { pecas, pecas_em: new Date().toISOString(), pecas_msg: r.erro || (r.quadros ? null : "sem quadro Peças de Assistência") });
        pecas.length ? ok++ : vazio++;
        if (limite <= 5) log(`  formato: cab=${JSON.stringify((r.cab || []).map((c) => c.replace(/[A-Za-zÀ-ÿ]+/g, (w) => (/^(pe[cç]a|sku|qtde|descri[cç][aã]o|nome|c[oó]digo|valor|unit[aá]rio|total|a[cç][oõ]es|status)$/i.test(w) ? w : "w"))))} · ` + pecas.map((y) => `[peça ${String(y.peca).split(/\s+/).length} palavras · sku ${String(y.sku).replace(/[A-Za-z]/g, "A").replace(/\d/g, "#")} · qtde ${y.qtde}]`).join(" "));
      } catch (e) { erro++; await patch(x.ticket, { pecas_msg: String(e.message).split("\n")[0].slice(0, 150) }).catch(() => {}); }
    }
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
