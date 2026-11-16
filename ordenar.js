// Ordenar qualquer tabela do painel: clique no título da coluna (1º clique = maior→menor nos números / A→Z nos textos, 2º inverte, 3º volta ao original).
// A ordem escolhida continua valendo quando a tabela é redesenhada (filtros, cliques). Linhas de Total ficam sempre no fim.
// Tabelas com paginação ordenam a página que está na tela.
(() => {
  const estado = new WeakMap();   // table -> { col, dir }
  const ignora = (th) => th.closest("table.sem-ordem") || th.hasAttribute("data-fx") || th.classList.contains("clic") || th.querySelector("input,button,select") || th.colSpan > 1;
  function valor(td) {
    if (!td) return { n: null, t: "" };
    const t = td.textContent.replace(/[●↘↗▲▼]/g, "").trim();
    let m = t.match(/^(\d{2})\/(\d{2})\/(\d{2,4})/);
    if (m) return { n: Number((m[3].length === 2 ? "20" + m[3] : m[3]) + m[2] + m[1]), t };
    m = t.match(/^-?[\d.]+(,\d+)?\s*%?/);
    if (m && /\d/.test(m[0])) return { n: parseFloat(m[0].replace(/\./g, "").replace(",", ".").replace("%", "")), t };
    if (t === "—" || t === "" || t === "·") return { n: null, t: "" };
    return { n: null, t };
  }
  function linhasFixas(tr) { return tr.classList.contains("tot-linha") || /^total\b/i.test((tr.cells[0] && tr.cells[0].textContent.trim()) || "") || (tr.cells.length === 1 && tr.cells[0].colSpan > 1); }
  let obs = null;
  function aplicar(table) {
    const st = estado.get(table), tb = table.tBodies[0]; if (!st || !tb) return;
    const rows = [...tb.rows]; if (rows.length < 2) return;
    rows.forEach((r, i) => { if (r.dataset.ordOrig === undefined) r.dataset.ordOrig = i; });
    const mov = rows.filter((r) => !linhasFixas(r)), fixas = rows.filter(linhasFixas);
    mov.sort((a, b) => {
      if (!st.dir) return a.dataset.ordOrig - b.dataset.ordOrig;
      const x = valor(a.cells[st.col]), y = valor(b.cells[st.col]);
      if (x.n !== null || y.n !== null) { if (x.n === null) return 1; if (y.n === null) return -1; return st.dir * (y.n - x.n); }
      if (!x.t) return 1; if (!y.t) return -1;
      return -st.dir * x.t.localeCompare(y.t, "pt-BR", { numeric: true });
    });
    mov.concat(fixas).forEach((r) => tb.appendChild(r)); if (obs) obs.takeRecords();   // não reage às próprias mudanças
    [...table.tHead.rows[table.tHead.rows.length - 1].cells].forEach((th, i) => { th.classList.toggle("ord-desc", i === st.col && st.dir === 1); th.classList.toggle("ord-asc", i === st.col && st.dir === -1); });
  }
  document.addEventListener("click", (e) => {
    const th = e.target.closest("thead th"); if (!th || ignora(th)) return;
    const table = th.closest("table"); if (!table.tBodies[0]) return;
    const col = [...th.parentElement.cells].indexOf(th), ant = estado.get(table);
    const dir = !ant || ant.col !== col ? 1 : ant.dir === 1 ? -1 : 0;
    estado.set(table, { col, dir }); aplicar(table);
  });
  // tabela redesenhada (innerHTML novo): reaplica a ordem escolhida
  obs = new MutationObserver((ms) => {
    const tabs = new Set(); ms.forEach((m) => { const t = m.target.closest && m.target.closest("table"); if (t && estado.has(t)) tabs.add(t); });
    tabs.forEach(aplicar);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
