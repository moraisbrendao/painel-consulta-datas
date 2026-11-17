// Recebe o "Webhook: retorno dos pedidos ao ERP" do Scallia (faturado → coletado → entregue; cancelado) e grava no painel.
// Guarda só: pedido, marco, número/série/chave da NF, transportadora e data. Nome, documento e endereço do cliente são descartados.
// Segredo da função: SCALLIA_WEBHOOK_SECRET (o segredo do HMAC-SHA256 configurado no Scallia).
// Aceita a assinatura em qualquer cabeçalho com "signature"/"assinatura" (hex ou base64, com ou sem "sha256=", ou no formato t=...,v1=...),
// ou ?token=SEGREDO na URL (para o teste, se o Scallia não assinar).
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BASE = Deno.env.get("SUPABASE_URL") ?? "";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function hmac(segredo: string, texto: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(texto)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
function igual(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

async function assinaturaOk(req: Request, corpo: string, segredo: string) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") && igual(url.searchParams.get("token")!, segredo)) return true;
  const cab = [...req.headers.entries()].filter(([k]) => /signature|assinatura|hmac/i.test(k)).map(([, v]) => v.trim());
  const ts = req.headers.get("x-scallia-timestamp") ?? req.headers.get("x-timestamp") ?? "";
  for (const v of cab) {
    const partes = v.split(",").map((x) => x.trim());
    const t = (partes.find((x) => /^t=/.test(x)) ?? "").slice(2) || ts;
    const sigs = partes.map((x) => x.replace(/^(sha256|v1)=/i, "")).filter((x) => !/^t=/.test(x));
    const textos = [corpo]; if (t) textos.push(`${t}.${corpo}`, `${t}${corpo}`);
    for (const tx of textos) {
      const h = await hmac(segredo, tx), H = hex(h), B = b64(h);
      if (sigs.some((s) => igual(s.toLowerCase(), H) || igual(s, B))) return true;
    }
  }
  return false;
}

// procura um campo pelo nome em qualquer nível do objeto
function achar(o: any, re: RegExp, prof = 0): any {
  if (!o || typeof o !== "object" || prof > 4) return null;
  for (const [k, v] of Object.entries(o)) if (re.test(k) && v != null && typeof v !== "object") return v;
  for (const v of Object.values(o)) if (v && typeof v === "object" && !Array.isArray(v)) { const r = achar(v, re, prof + 1); if (r != null) return r; }
  return null;
}
const txt = (v: any) => (v == null ? "" : String(v).trim());
function dataIso(v: any) { const s = txt(v); let m;
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/))) return m[2] ? `${m[1]}T${m[2]}` : m[1];
  if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/))) return `${m[3]}-${m[2]}-${m[1]}${m[4] ? "T" + m[4] : ""}`;
  return null; }
function marcoDe(e: any) {
  const s = txt(achar(e, /^(marco|evento|event|status|tipo|type|situacao)$/i)).toLowerCase();
  if (/cancel/.test(s)) return "cancelado"; if (/entreg|deliver/.test(s)) return "entregue"; if (/colet|coleta|picked|shipp|despach|expedi/.test(s)) return "coletado";
  if (/fatur|invoice|nf/.test(s)) return "faturado"; return s.slice(0, 40) || "desconhecido";
}
function linha(e: any) {
  const nfObj = e.nfe ?? e.nf ?? e.notaFiscal ?? e.nota_fiscal ?? e.nota ?? {};
  const num = txt(typeof nfObj === "object" ? achar(nfObj, /^(numero|number|nNF|nf)$/i) : nfObj) || txt(achar(e, /^(numeroNf|numero_nf|nfNumero|numeroNota|nNF)$/i));
  const serie = txt(typeof nfObj === "object" ? achar(nfObj, /^(serie|series)$/i) : "") || txt(achar(e, /^(serieNf|serie_nf|serie)$/i));
  const chave = txt(achar(e, /^(chave|chaveNfe|chave_nfe|chaveAcesso|accessKey)$/i)).replace(/\D/g, "");
  const tr = e.transportadora ?? e.carrier ?? null;
  return {
    pedido: txt(achar(e, /^(pedido|numeroPedido|pedidoId|order|orderId|idPedido|numero_pedido)$/i)),
    marco: marcoDe(e),
    nf: num.replace(/\D/g, "") || null, serie: serie.replace(/\D/g, "") || null, chave: chave.length === 44 ? chave : null,
    transportadora: txt(tr && typeof tr === "object" ? achar(tr, /^(nome|name|razao|fantasia)$/i) : tr) || null,
    data_evento: dataIso(achar(e, /^(data|dataEvento|data_evento|dataColeta|dataEntrega|dataFaturamento|dataCancelamento|date|ocorridoEm|timestamp|em)$/i)),
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const segredo = Deno.env.get("SCALLIA_WEBHOOK_SECRET") ?? "";
  const corpo = await req.text();
  if (!segredo || !(await assinaturaOk(req, corpo, segredo))) {
    console.log("assinatura recusada · cabeçalhos:", [...req.headers.keys()].join(","));   // só os NOMES dos cabeçalhos
    return json({ erro: "assinatura inválida" }, 401);
  }
  let dado: any; try { dado = JSON.parse(corpo); } catch { return json({ erro: "json inválido" }, 400); }
  const lista = Array.isArray(dado) ? dado : dado.eventos ?? dado.events ?? dado.pedidos ?? dado.itens ?? dado.items ?? dado.data ?? [dado];
  const eventos = (Array.isArray(lista) ? lista : [lista]).filter((x) => x && typeof x === "object");
  const linhas = eventos.map(linha).filter((l) => l.pedido || l.nf || l.chave);
  if (linhas.length) {
    const r = await fetch(`${BASE}/rest/v1/rpc/receber_scallia`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify({ linhas }) });
    if (!r.ok) { console.log("gravar falhou", r.status); return json({ erro: "não gravou" }, 500); }
  }
  // só contagens e os nomes dos campos do 1º evento (para ajustar a leitura sem guardar dados)
  console.log("eventos", eventos.length, "gravados", linhas.length, "campos", eventos[0] ? Object.keys(eventos[0]).join(",") : "");
  return json({ ok: true, recebidos: eventos.length, gravados: linhas.length });
});
