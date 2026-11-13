// Acesso ao Supabase do painel com o login do robô (secrets ROBO_EMAIL / ROBO_SENHA).
import { readFileSync, appendFileSync } from "node:fs";

const cfg = readFileSync(new URL("../config.js", import.meta.url), "utf8");
const URL_SB = process.env.SB_URL_TESTE || cfg.match(/SUPABASE_URL:\s*"([^"]+)"/)[1];
const ANON = cfg.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/)[1];
let token = null;

export async function entrarSupabase() {
  const { ROBO_EMAIL, ROBO_SENHA } = process.env;
  if (!ROBO_EMAIL || !ROBO_SENHA) throw new Error("Faltam os segredos ROBO_EMAIL e ROBO_SENHA no GitHub.");
  const r = await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: ROBO_EMAIL, password: ROBO_SENHA }),
  });
  if (!r.ok) throw new Error("O login do robô no painel (ROBO_EMAIL/ROBO_SENHA) não funcionou: " + r.status);
  token = (await r.json()).access_token;
}

async function chamar(caminho, metodo = "GET", corpo) {
  const r = await fetch(`${URL_SB}/rest/v1/${caminho}`, {
    method: metodo,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${metodo} ${caminho.split("?")[0]}: ${r.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

export const temPedido = async () => (await chamar("fila_portal?select=id&status=in.(pendente,processando)&limit=1")).length > 0;
export const pegarPedido = async () => (await chamar("rpc/pegar_fila_portal", "POST", {}))[0] || null;
export const atualizarPedido = (id, campos) => chamar(`fila_portal?id=eq.${id}`, "PATCH", campos);
export const registrarCadastradas = (linhas) =>
  chamar("rpc/importar_ocorrencias", "POST", { linhas, arquivo: "robô do portal", primeiro: false, total: linhas.length });

export function saida(nome, valor) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${nome}=${valor}\n`);
}

// ---- robô da Intelipost (aba Alterar pedidos) ----
export const contarIntelipost = async () => (await chamar("fila_intelipost?select=pedido&status=eq.pendente&limit=1")).length > 0;
export const pegarIntelipost = async (limite = 100) => (await chamar("rpc/pegar_fila_intelipost", "POST", { limite })) || [];
export const resultadoIntelipost = (p, st, mot = null) => chamar("rpc/resultado_intelipost", "POST", { p, st, mot });
export async function lerEstado(nome) { const r = await chamar(`robo_estado?nome=eq.${encodeURIComponent(nome)}&select=valor`); return r && r[0] ? r[0].valor : null; }
export const gravarEstado = (nome, valor) =>
  fetch(`${URL_SB}/rest/v1/robo_estado?on_conflict=nome`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ nome, valor, atualizado_em: new Date().toISOString() }),
  }).then(async (r) => { if (!r.ok) throw new Error("Supabase robo_estado: " + r.status + " " + (await r.text()).slice(0, 200)); });

// ---- troca de notas: só para o diagnóstico (lê um pedido, não muda nada) ----
export async function umPedidoParaOlhar() {
  try {
    const t = await chamar("troca_notas?select=pedido&na_planilha=eq.true&concluido_em=is.null&pedido=not.is.null&limit=1");
    if (t && t[0] && t[0].pedido) return { pedido: String(t[0].pedido), de: "troca" };
  } catch { /* tabela ainda não criada */ }
  const f = await chamar("fila_intelipost?select=pedido&status=eq.alterado&order=feito_em.desc&limit=1");
  return f && f[0] ? { pedido: String(f[0].pedido), de: "alterar" } : null;
}
export async function temTroca() { try { return (await chamar("troca_notas?select=ticket&robo_status=eq.pendente&limit=1")).length > 0; } catch { return false; } }
export const pegarTroca = async (limite = 20) => (await chamar("rpc/pegar_troca", "POST", { limite })) || [];
export const resultadoTroca = (tk, st, msg, passos, prazo = null, nova = null) => chamar("rpc/resultado_troca", "POST", { tk, st, msg, passos, prazo, nova });
export async function ultimaTrocaComErro() { const r = await chamar("troca_notas?select=ticket,pedido,robo_metodo,tipo,robo_passos,robo_msg,robo_iniciado_em&robo_status=eq.erro&order=robo_feito_em.desc&limit=1"); return r && r[0] ? r[0] : null; }
export async function trocaDoTicket(tk) { const r = await chamar(`troca_notas?select=ticket,pedido,tipo,robo_metodo,robo_passos,robo_status&ticket=eq.${encodeURIComponent(tk)}&limit=1`); return r && r[0] ? r[0] : null; }
export { chamar };
