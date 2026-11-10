// Consulta SAC: visão limitada (NF, pedido, canal, transportadora, previsão,
// nova data, anotações e rastreio). Os dados vêm da função consulta_sac()
// do banco, que só devolve essas colunas.
(function () {
  const P = window.Painel;
  const { sb, $, esc, br } = P;
  const POR_PAGINA = 50;
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");

  let linhas = [];
  let filtrados = [];
  let pagina = 1;
  let carregadoEm = 0;

  async function carregar(forcar) {
    if (!forcar && carregadoEm && Date.now() - carregadoEm < 60000) return;
    $("sac-info").textContent = "Carregando…";
    const lote = 1000;
    let lista = [];
    try {
      for (let de = 0; ; de += lote) {
        const { data, error } = await sb.rpc("consulta_sac").order("pedido").range(de, de + lote - 1);
        if (error) throw error;
        lista = lista.concat(data);
        if (data.length < lote) break;
      }
    } catch (err) {
      $("sac-info").textContent = "";
      P.toast("Erro ao carregar: " + err.message, true);
      return;
    }
    linhas = lista;
    carregadoEm = Date.now();
    $("sac-info").textContent = `${fmt(linhas.length)} pedidos em aberto`;
    montarOpcoes();
    filtrar();
  }

  function montarOpcoes() {
    const preencher = (id, valores, rotulo) => {
      const sel = $(id);
      const atual = sel.value;
      const unicos = [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
      sel.innerHTML = `<option value="">${rotulo}</option>` + unicos.map((v) => `<option>${esc(v)}</option>`).join("");
      if (unicos.includes(atual)) sel.value = atual;
    };
    preencher("sac-canal", linhas.map((l) => l.canal), "Todos");
    preencher("sac-transp", linhas.map((l) => l.transportadora), "Todas");
  }

  function filtrar() {
    const busca = P.norm($("sac-busca").value);
    const canal = $("sac-canal").value;
    const transp = $("sac-transp").value;
    const nova = $("sac-nova").value;
    const hoje = P.hojeISO();
    filtrados = linhas.filter((l) =>
      (!busca || [l.nf, l.pedido].some((v) => P.norm(v).includes(busca))) &&
      (!canal || l.canal === canal) &&
      (!transp || l.transportadora === transp) &&
      (!nova ||
        (nova === "com" && l.nova_data) ||
        (nova === "sem" && !l.nova_data) ||
        (nova === "vencida" && (l.nova_data || l.previsao_entrega) && (l.nova_data || l.previsao_entrega) < hoje)));
    pagina = 1;
    desenhar();
  }

  function corData(d) {
    if (!d) return "cinza";
    const hoje = P.hojeISO();
    return d < hoje ? "vermelho" : d === hoje ? "ambar" : "verde";
  }

  function celulaNotas(l) {
    const notas = Array.isArray(l.anotacoes) ? l.anotacoes : [];
    if (!notas.length) return `<span class="secundario">—</span>`;
    const quando = (n) => new Date(n.criado_em).toLocaleDateString("pt-BR");
    const ult = notas[0];
    const resto = notas.slice(1);
    return `<div class="sac-nota">${esc(ult.texto)} <span class="secundario">(${quando(ult)})</span></div>` +
      (resto.length
        ? `<details class="sac-mais"><summary>+${resto.length} anterior${resto.length > 1 ? "es" : ""}</summary>` +
          resto.map((n) => `<div class="sac-nota">${esc(n.texto)} <span class="secundario">(${quando(n)})</span></div>`).join("") +
          `</details>`
        : "");
  }

  function desenhar() {
    const total = filtrados.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
    $("sac-linhas").innerHTML = fatia.map((l) => {
      const nova = l.nova_data
        ? `<span class="chip ${corData(l.nova_data)}">${br(l.nova_data)}</span>
           <div class="secundario">${l.origem_nova_data === "Intelipost" ? "previsão alterada na Intelipost" : "informada pela transportadora"}</div>`
        : `<span class="secundario">—</span>`;
      return `<tr>
        <td class="num-data"><b>${esc(l.nf || "—")}</b></td>
        <td>${esc(l.pedido)}</td>
        <td>${esc(l.canal || "—")}</td>
        <td>${esc(l.transportadora || "—")}</td>
        <td class="num-data">${br(l.previsao_entrega) || "—"}</td>
        <td class="num-data">${nova}</td>
        <td class="obs">${celulaNotas(l)}</td>
        <td>${/^https?:\/\//i.test(l.link_rastreio || "") ? `<a href="${esc(l.link_rastreio)}" target="_blank" rel="noopener noreferrer">Acompanhar ↗</a>` : "—"}</td>
      </tr>`;
    }).join("");
    $("sac-vazio").hidden = total > 0;
    $("sac-paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn fantasma" data-p="-1" ${pagina === 1 ? "disabled" : ""}>‹ Anterior</button>
         <span>Página ${pagina} de ${paginas} · ${fmt(total)} pedidos</span>
         <button class="btn fantasma" data-p="1" ${pagina === paginas ? "disabled" : ""}>Próxima ›</button>`
      : total ? `<span>${fmt(total)} pedido${total > 1 ? "s" : ""}</span>` : "";
  }

  $("sac-paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    pagina += Number(b.dataset.p);
    desenhar();
    window.scrollTo({ top: $("sac-linhas").closest("section").offsetTop - 10, behavior: "smooth" });
  });
  ["sac-canal", "sac-transp", "sac-nova"].forEach((id) => $(id).addEventListener("change", filtrar));
  let espera;
  $("sac-busca").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(filtrar, 200); });

  $("sac-baixar").addEventListener("click", () => {
    const cab = ["Nota fiscal", "Pedido Intelipost", "Canal", "Transportadora", "Previsão de entrega", "Nova data informada",
      "Origem da nova data", "Anotações", "Rastreio"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const corpo = filtrados.map((l) => [l.nf, l.pedido, l.canal, l.transportadora, br(l.previsao_entrega), br(l.nova_data),
      l.origem_nova_data === "Intelipost" ? "previsão alterada na Intelipost" : l.nova_data ? "transportadora" : "",
      (l.anotacoes || []).map((n) => `${new Date(n.criado_em).toLocaleDateString("pt-BR")}: ${n.texto}`).join(" | "),
      l.link_rastreio].map(q).join(";"));
    const blob = new Blob(["﻿" + [cab.map(q).join(";")].concat(corpo).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `consulta_sac_${P.hojeISO()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------------- Usuários do SAC (Logística) ----------------
  async function mostrarUsuarios() {
    const { data, error } = await sb.from("usuarios_sac").select("email").order("email");
    if (error) {
      $("lista-sac").innerHTML = `<span class="secundario">Rode de novo o schema.sql no Supabase para liberar o perfil SAC.</span>`;
      return;
    }
    $("lista-sac").innerHTML = data.length
      ? data.map((u) => `<span class="chip-regra">${esc(u.email)}<button data-email="${esc(u.email)}" title="Tirar do SAC">×</button></span>`).join("")
      : `<span class="secundario">Nenhum e-mail marcado como SAC ainda.</span>`;
  }

  $("form-sac").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("sac-email").value.trim().toLowerCase();
    if (!email) return;
    const { error } = await sb.from("usuarios_sac").upsert({ email });
    if (error) return P.toast("Não foi possível salvar: " + error.message, true);
    $("sac-email").value = "";
    P.toast(`${email} agora vê só a Consulta SAC.`);
    mostrarUsuarios();
  });

  $("lista-sac").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-email]");
    if (!b) return;
    if (!confirm(`Tirar ${b.dataset.email} do SAC? Ele passa a ver o painel como o perfil Consulta.`)) return;
    const { error } = await sb.from("usuarios_sac").delete().eq("email", b.dataset.email);
    if (error) return P.toast("Não foi possível remover: " + error.message, true);
    mostrarUsuarios();
  });

  window.SAC = { mostrar: () => carregar(false), mostrarUsuarios };
})();
