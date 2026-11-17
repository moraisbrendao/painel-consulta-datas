// Recebe os webhooks da Transiga ("envio de ocorrências" e "envio de encomendas") e grava o rastreio no painel.
// Guarda só: número/série da NF, encomenda, código e descrição do status, data do evento, data prevista e se foi entregue.
// Nomes, documentos, endereços, motorista, fotos e comprovantes que vêm no evento são descartados.
// Segredo da função: TRANSIGA_WEBHOOK_TOKEN (o mesmo token que a Transiga manda no cabeçalho).
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BASE = Deno.env.get("SUPABASE_URL") ?? "";

function iso(v: unknown): string | null {   // "01/03/2024 15:21:19" ou "01/03/2024" → ISO
  const m = String(v ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
}

// previsão de entrega: procura em qualquer nível do evento um campo com "previs"/"prevista"/"prazo_entrega" que tenha data
function acharPrevisao(o: unknown, nivel = 0): string | null {
  if (!o || typeof o !== "object" || nivel > 4) return null;
  const ents = Object.entries(o as Record<string, unknown>);
  for (const [k, v] of ents) if (/previs|prevista|prazo_?entrega|data_?entrega_?prev/i.test(k) && (typeof v === "string" || typeof v === "number")) {
    const d = iso(v) ?? (String(v).match(/^\d{4}-\d{2}-\d{2}/) ? String(v).slice(0, 10) : null); if (d) return d.slice(0, 10); }
  for (const [, v] of ents) { const d = acharPrevisao(v, nivel + 1); if (d) return d; }
  return null;
}
function chaves(o: unknown, pre = "", nivel = 0): string[] {   // só os NOMES dos campos (para conferir o formato no log), nunca os valores
  if (!o || typeof o !== "object" || Array.isArray(o) || nivel > 3) return [];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [pre + k, ...chaves(v, pre + k + ".", nivel + 1)]);
}

function linha(e: Record<string, any>) {
  const nf = e.nota_fiscal ?? e.documento ?? {};
  const oc = e.ocorrencia ?? null;
  const descricao = String(oc ? oc.descricao ?? "" : e.descricao_status ?? "").trim();
  const quando = iso(oc ? oc.data : e.data_hora_envio) ?? iso(e.data_hora_envio);
  return {
    numero: String(nf.numero ?? "").trim(),
    serie: String(nf.serie ?? "").trim(),
    encomenda: String(e.encomenda ?? e.codigo_encomenda ?? ""),
    codigo: String(oc ? oc.codigo ?? "" : e.codigo_status ?? ""),
    descricao,
    data_evento: quando,
    previsao: (iso(e.data_prevista) ?? "").slice(0, 10) || acharPrevisao(e),
    entregue: /^entreg/i.test(descricao) && !/n[aã]o/i.test(descricao),
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const token = Deno.env.get("TRANSIGA_WEBHOOK_TOKEN") ?? "";
  const h = req.headers, url = new URL(req.url);
  const recebido = [h.get("authorization")?.replace(/^(Bearer|Basic|Token)\s+/i, ""), h.get("token"), h.get("x-token"), h.get("x-api-key"), h.get("apikey"), url.searchParams.get("token")];
  if (!token || !recebido.includes(token)) return new Response(JSON.stringify({ erro: "token inválido" }), { status: 401, headers: { "Content-Type": "application/json" } });
  let corpo: unknown;
  try { corpo = await req.json(); } catch { return new Response(JSON.stringify({ erro: "json inválido" }), { status: 400, headers: { "Content-Type": "application/json" } }); }
  const eventos = (Array.isArray(corpo) ? corpo : [corpo]).filter((x) => x && typeof x === "object") as Record<string, any>[];
  const linhas = eventos.filter((e) => e.nota_fiscal || e.documento).map(linha).filter((l) => l.numero);
  if (linhas.length) {
    const r = await fetch(`${BASE}/rest/v1/rpc/receber_transiga`, {
      method: "POST",
      headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
      body: JSON.stringify({ linhas }),
    });
    if (!r.ok) { console.log("gravar falhou", r.status); return new Response(JSON.stringify({ erro: "não gravou" }), { status: 500, headers: { "Content-Type": "application/json" } }); }
  }
  console.log("eventos", eventos.length, "gravados", linhas.length, "com previsão", linhas.filter((l) => l.previsao).length,
    "campos", [...new Set(eventos.flatMap((e) => chaves(e)))].filter((k) => !/nome|cpf|cnpj|documento\.numero|endereco|logradouro|telefone|email|foto|comprovante|assinatura|motorista/i.test(k)).join(","));   // só contagens e nomes de campos
  return new Response(JSON.stringify({ ok: true, recebidos: eventos.length }), { status: 200, headers: { "Content-Type": "application/json" } });
});
