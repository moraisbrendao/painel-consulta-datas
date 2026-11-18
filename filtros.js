// Filtros do topo no mesmo padrão da Visão Gerencial: cada <select> dos cartões de filtro vira o mesmo
// botão com lista (rótulo em cima, valor, ▾, busca e opções). O <select> original continua na página
// (escondido) e recebe o valor escolhido + o evento "change", então a lógica de cada aba não muda.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const ALVO = ".filtros-cartao:not(#g-filtros) select, #filtros select, .rp-pv-filtros select";
  const todos = [];

  function montar(sel) {
    if (sel.dataset.bonito) return; sel.dataset.bonito = "1";
    const lab = sel.closest("label");
    const rot = lab ? [...lab.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").trim() : (sel.title || "");
    const box = document.createElement("div");
    box.className = "multi sel-bonito" + (sel.multiple ? " sel-multi" : "");
    if (lab) { if (lab.id) { box.id = lab.id; lab.removeAttribute("id"); } if (lab.hidden) box.hidden = true; if (lab.className) box.className += " " + lab.className; }
    box.innerHTML = `<span class="multi-rotulo">${esc(rot)}</span>
      <button type="button" class="multi-botao"><span class="multi-valor"></span><span class="seta">▾</span></button>
      <div class="multi-painel" hidden><input class="multi-busca" type="search" placeholder="Procurar…"><div class="multi-lista"></div>
        <div class="multi-acoes"><button type="button" class="link" data-acao="limpar">Limpar</button><span class="s"></span></div></div>`;
    (lab || sel).replaceWith(box);
    box.appendChild(sel); sel.hidden = true; sel.tabIndex = -1;
    todos.push({ sel, box });
    atualizar(sel, box);
  }
  function atualizar(sel, box) {
    if (sel.multiple) {   // várias escolhas: "Todas", o nome (se 1) ou "N selecionados"
      const ss = [...sel.selectedOptions];
      const t = !ss.length ? (sel.dataset.todos || "Todos") : ss.length === 1 ? ss[0].textContent : `${ss.length} selecionados`;
      const vv = box.querySelector(".multi-valor"); if (vv.textContent !== t) vv.textContent = t;
      box.classList.toggle("ativo", ss.length > 0); return;
    }
    const op = sel.options[sel.selectedIndex];
    const txt = op ? op.textContent : "";
    const v = box.querySelector(".multi-valor"); if (v.textContent !== txt) v.textContent = txt;
    box.classList.toggle("ativo", !!(sel.selectedIndex > 0 && sel.value !== ""));
  }
  function listar(sel, box) {
    const ops = [...sel.options];
    const marcado = (o, i) => (sel.multiple ? o.selected : i === sel.selectedIndex);
    box.querySelector(".multi-lista").innerHTML = ops.map((o, i) => `<label class="multi-op sel-op${marcado(o, i) ? " escolhido" : ""}" data-i="${i}">${sel.multiple ? `<span class="caixa">${marcado(o, i) ? "☑" : "☐"}</span>` : ""}<span>${esc(o.textContent)}</span>${!sel.multiple && marcado(o, i) ? "<em>✓</em>" : ""}</label>`).join("");
    box.querySelector(".multi-acoes .s").textContent = `${ops.length} opções`;
    const b = box.querySelector(".multi-busca"); b.value = ""; b.hidden = ops.length <= 6;
  }
  const fechar = (exceto) => todos.forEach(({ box }) => { if (box !== exceto) box.querySelector(".multi-painel").hidden = true; });
  function escolher(sel, box, i) {
    if (sel.multiple) {   // liga/desliga a opção e deixa a lista aberta
      if (i < 0) [...sel.options].forEach((o) => (o.selected = false)); else sel.options[i].selected = !sel.options[i].selected;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      const lst = box.querySelector(".multi-lista"), top = lst.scrollTop, q = box.querySelector(".multi-busca").value;
      listar(sel, box); box.querySelector(".multi-busca").value = q; box.querySelector(".multi-busca").dispatchEvent(new Event("input", { bubbles: true })); lst.scrollTop = top;
      atualizar(sel, box); return;
    }
    if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true })); }
    box.querySelector(".multi-painel").hidden = true; atualizar(sel, box);
  }

  document.addEventListener("click", (e) => {
    const box = e.target.closest(".sel-bonito");
    if (!box) { if (!e.target.closest(".multi")) fechar(null); return; }
    const it = todos.find((x) => x.box === box); if (!it) return;
    if (e.target.closest(".multi-botao")) {
      const pn = box.querySelector(".multi-painel"), abrir = pn.hidden; fechar(box);
      if (abrir) { listar(it.sel, box); pn.hidden = false; const b = pn.querySelector(".multi-busca"); if (!b.hidden) b.focus(); } else pn.hidden = true;
      return;
    }
    const op = e.target.closest(".sel-op"); if (op) { e.preventDefault(); escolher(it.sel, box, +op.dataset.i); return; }
    if (e.target.closest('[data-acao="limpar"]')) escolher(it.sel, box, it.sel.multiple ? -1 : 0);
  });
  document.addEventListener("input", (e) => {
    if (!e.target.classList.contains("multi-busca") || !e.target.closest(".sel-bonito")) return;
    const q = norm(e.target.value);
    e.target.closest(".sel-bonito").querySelectorAll(".sel-op").forEach((op) => (op.hidden = q && !norm(op.textContent).includes(q)));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") fechar(null);
    if (e.key === "Enter" && e.target.classList.contains("multi-busca") && e.target.closest(".sel-bonito")) {
      const op = [...e.target.closest(".sel-bonito").querySelectorAll(".sel-op")].find((x) => !x.hidden);
      if (op) { e.preventDefault(); op.click(); }
    }
  });
  // a lógica das abas troca as opções e o valor dos <select> (ex.: "Limpar filtros"): mantém o botão em dia
  setInterval(() => { document.querySelectorAll(ALVO).forEach(montar); todos.forEach(({ sel, box }) => { if (box.offsetParent) atualizar(sel, box); }); }, 400);
  document.querySelectorAll(ALVO).forEach(montar);
})();
