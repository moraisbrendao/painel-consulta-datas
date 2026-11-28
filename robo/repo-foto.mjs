// Reposição pré › TESTE da leitura da foto com o Claude (Brenda 27/11). Precisa do segredo ANTHROPIC_API_KEY.
// Lê a(s) foto(s) que a transportadora anexou e diz quais volumes aparecem nas etiquetas. NÃO marca nada:
// grava a resposta em repo_pre.foto_ia para a equipe comparar no painel. Log público: só contagens.
import Anthropic from "@anthropic-ai/sdk";

const MODELO = "claude-opus-5-5";

function pedido(x, cad) {
  const vols = (x.volumes || []).map((v) => { const c = cad.get(v); return c ? `${v} (volume ${c.nro}${c.total ? "/" + c.total : ""}${c.descricao ? ", " + c.descricao : ""})` : v; });
  return `Você confere fotos de volumes de móveis enviadas por uma transportadora num pedido de reposição.
A nota fiscal é ${x.nf} (número-série). Os volumes desta NF são:
${vols.map((v) => "- " + v).join("\n")}

As etiquetas da fábrica costumam ter: o código do volume (ex.: 76280.0002), o texto "VOL. NF: 01/02" (volume 1 de 2 da nota) e um código de barras que junta NF (7 dígitos) + série (2) + volume (2) + total (2).
${/avaria/i.test(x.motivo || "") ? `MOTIVO: AVARIA. Regra da equipe: as fotos de avaria costumam ser TODAS do MESMO volume. Uma foto mais de perto mostra a etiqueta (só para identificar qual volume é) e as outras mostram a avaria (amassado, rasgado, quebrado, molhado) desse mesmo volume, de outros ângulos. Não trate a foto da etiqueta como um volume diferente das outras.
Diga qual volume da lista acima é o AVARIADO (o da etiqueta), comparando o código do volume, o "VOL x/y", a descrição e o código de barras. Se a NF lida na etiqueta for diferente de ${x.nf}, avise na observação, mas ainda diga qual volume da lista combina com a etiqueta (código do volume / VOL x/y / descrição), se combinar.
Em "volumes_vistos" coloque só o(s) volume(s) avariado(s).` : `MOTIVO: ${x.motivo || "Falta de volumes"}. As fotos mostram o(s) volume(s) que ESTÃO com a transportadora. Diga quais volumes da lista aparecem nas etiquetas.`}
Só use o que dá para ler; não chute.
Responda SOMENTE com um JSON neste formato:
{"volumes_vistos": ["códigos da lista acima"], "nf_na_etiqueta": "número da NF lido na etiqueta ou null", "vol_nf": ["textos tipo 01/02 lidos"], "confianca": "alta|media|baixa", "observacao": "frase curta (ex.: etiqueta borrada, foto sem etiqueta, avaria visível, etiqueta de outra NF)"}`;
}

export async function rodarFotoTeste({ chamar, log, limite = 10, alvo = "" }) {   // alvo: "h:<sha256 do nº da NF[:16]>" relê 1 caso; "avaria" relê as avarias
  const { createHash } = await import("node:crypto"); const hNf = (nf) => createHash("sha256").update(String(nf).split("-")[0].trim()).digest("hex").slice(0, 16);
  if (!process.env.ANTHROPIC_API_KEY) { log("repo-foto: falta o segredo ANTHROPIC_API_KEY no GitHub. Nada foi lido."); return; }
  const client = new Anthropic();
  const L = (await chamar("repo_pre?select=nf,motivo,volumes,fotos,sku,foto_ia&na_lista=eq.true&order=criado_em.desc&limit=200"))
    .filter((x) => (x.fotos || []).length && (x.volumes || []).length && (alvo.startsWith("h:") ? hNf(x.nf) === alvo.slice(2) : alvo === "avaria" ? /avaria/i.test(x.motivo || "") : !x.foto_ia)).slice(0, limite);
  const skus = [...new Set(L.flatMap((x) => x.sku || []))];
  const cad = new Map();
  if (skus.length) {
    const C = await chamar(`vol_cadastro?select=modelo,volume,nro,descricao&modelo=in.(${skus.map((s) => `"${encodeURIComponent(s)}"`).join(",")})`).catch(() => []);
    const tot = C.reduce((a, c) => ((a[c.modelo] = Math.max(a[c.modelo] || 0, c.nro || 0)), a), {});
    C.forEach((c) => cad.set(c.volume, { nro: c.nro, total: tot[c.modelo], descricao: c.descricao }));
  }
  log(`repo-foto (teste): ${L.length} caso(s) com foto para ler`);
  let ok = 0, erro = 0, tokIn = 0, tokOut = 0; const conf = {};
  for (const x of L) {
    try {
      const fotos = x.fotos.slice(0, 5);
      const r = await client.messages.create({
        model: MODELO, max_tokens: 4000, output_config: { effort: "low" },
        messages: [{ role: "user", content: [...fotos.map((u) => ({ type: "image", source: { type: "url", url: u } })), { type: "text", text: pedido(x, cad) }] }],
      });
      tokIn += r.usage?.input_tokens || 0; tokOut += r.usage?.output_tokens || 0;
      const txt = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error("resposta sem JSON");
      const j = JSON.parse(m[0]);
      const validos = new Set(x.volumes);
      const res = { volumes_vistos: (j.volumes_vistos || []).filter((v) => validos.has(v)), nf_na_etiqueta: j.nf_na_etiqueta || null, vol_nf: j.vol_nf || [],
        confianca: j.confianca || null, observacao: String(j.observacao || "").slice(0, 300), modelo: MODELO, fotos: fotos.length, em: new Date().toISOString() };
      await chamar(`repo_pre?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", { foto_ia: res });
      ok++; conf[res.confianca || "?"] = (conf[res.confianca || "?"] || 0) + 1;
    } catch (e) { erro++; log("  erro: " + String(e.message).split("\n")[0].replace(/\d{5,}/g, "#").slice(0, 140)); }
  }
  log(`repo-foto (teste): ${ok} lidos · ${erro} com erro · confiança ${JSON.stringify(conf)} · tokens entrada ${tokIn}, saída ${tokOut}`);
}
