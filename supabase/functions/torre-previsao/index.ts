// Torre de Controle → E-loggia: recebe PREVISÕES LOGÍSTICAS (estimativa, não é promessa de entrega).
// A promessa original do pedido (base_pedidos.prev_original) nunca é alterada; a previsão fica na tabela previsao_torre.
// Segredo da função: TORRE_PREVISAO_TOKEN (a Torre manda no cabeçalho "Authorization: Bearer <token>").
// Corpo: um objeto ou uma lista (até 1000) de { pedido, nf, previsao, confianca, situacao, revisao, calculada_em }.
// Log: só contagens por resultado, nunca pedido/NF.
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BASE = Deno.env.get("SUPABASE_URL") ?? "";
// compara em tempo constante (não dá pista do token pelo tempo de resposta)
const iguais = (a: string, b: string) => {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) d |= (x[i] ?? 0) ^ y[i];
  return d === 0;
};
const RESULTADOS = ["nova", "atualizada", "duplicada", "antiga", "pedido_nao_encontrado", "invalida"];
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const token = Deno.env.get("TORRE_PREVISAO_TOKEN") ?? "";
  const recebido = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !iguais(recebido, token)) return json({ erro: "token inválido" }, 401);
  let corpo: unknown;
  try { corpo = await req.json(); } catch { return json({ erro: "json inválido" }, 400); }
  const lista = (Array.isArray(corpo) ? corpo : [corpo]).filter((x) => x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length) as Record<string, unknown>[];   // {} vazio não conta
  if (!lista.length) return json({ erro: "nenhuma previsão no corpo" }, 400);
  if (lista.length > 1000) return json({ erro: "máximo 1000 previsões por envio" }, 413);
  const txt = (v: unknown) => (v === null || v === undefined ? null : String(v).trim());
  const itens = lista.map((e) => ({
    pedido: txt(e.pedido), nf: txt(e.nf), previsao: txt(e.previsao), confianca: txt(e.confianca),
    situacao: txt(e.situacao), revisao: txt(e.revisao), calculada_em: txt(e.calculada_em),
  }));
  const r = await fetch(`${BASE}/rest/v1/rpc/receber_torre`, {
    method: "POST",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ itens }),
  });
  if (!r.ok) { console.log("gravar falhou", r.status); return json({ erro: "não gravou, tente de novo" }, 500); }
  const brutos = await r.json() as { pedido: string; nf: string; resultado: string }[];
  // contrato da Torre: resumo sempre com os 6 resultados; cada resultado traz o pedido (e a nf só quando veio sem pedido)
  const resumo: Record<string, number> = Object.fromEntries(RESULTADOS.map((k) => [k, 0]));
  for (const x of brutos) resumo[x.resultado] = (resumo[x.resultado] ?? 0) + 1;
  const resultados = brutos.map((x) => (x.pedido ? { pedido: x.pedido, resultado: x.resultado } : { pedido: "", nf: x.nf, resultado: x.resultado }));
  console.log("previsões", itens.length, JSON.stringify(resumo));   // só contagens
  return json({ ok: true, recebidas: itens.length, resumo, resultados });
});
