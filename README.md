# Painel de Consulta de Novas Datas de Entrega

Site com login (e-mail e senha) onde outro setor consulta as **novas datas de entrega** que as
transportadoras informam à Logística. Não depende de planilha com macro: a Logística envia dois
arquivos simples pelo próprio site.

- **Outro setor** (perfil "Consulta"): só consulta os pedidos, a nova data e o histórico de retornos.
- **Logística** (perfil "Logística"): envia os arquivos, padroniza os retornos e cadastra os logins.

```
Logística envia no site:
  1. Lista de pedidos em cobrança  (modelo multimoveis-atrasados-em-aberto)
  2. Retorno da transportadora     (modelo Retorno_atrasos_tp)
        │
        ▼
Supabase guarda: pedidos em cobrança + histórico de TODOS os retornos + regras de padronização
        │
        ▼
Consulta: nova data informada, situação padronizada e histórico de cada pedido
```

## Painel Preventivo (Intelipost)

Aba **Preventivo** (aberta para todos): mostra os pedidos **ainda não entregues nem cancelados** da última base da Intelipost,
para agir antes do atraso.

- **Cards**: pedidos em aberto, em risco (vence hoje até 3 dias), já vencidos, pendentes de responsável e entregues no prazo.
- **Range de vencimento**: conta pela *nova data informada* pela transportadora (aba Retornos); sem ela, pela previsão atual
  da Intelipost. Clique numa linha para filtrar.
- **Micro status por responsável**: quantos pedidos cada pessoa tem. Clique para filtrar.
- **Tabela**: NF, Pedido Intelipost, Transportadora, Previsão original, Nova data informada, Micro status, Responsável,
  Situação do último retorno da transportadora e link de rastreio.

Como a Logística atualiza:
1. **Enviar arquivos → 3. Base da Intelipost**: escolha o `transactions_....xlsx` exportado da Intelipost. O site lê o arquivo
   (uns 20 a 30 segundos para 67 mil linhas), mostra quantos pedidos entram e substitui a base anterior.
2. **Responsáveis**: cadastre as pessoas/áreas e escolha o responsável de cada micro status. Micro status novos que aparecerem
   na base entram sozinhos como **Pendente de responsável** (aparecem primeiro, em vermelho).
3. Os retornos das transportadoras continuam sendo enviados como antes (**2. Retorno da transportadora**) e aparecem
   na coluna "Situação último retorno".

## O que tem em cada arquivo

| Arquivo | Para que serve |
|---|---|
| `index.html`, `styles.css`, `app.js` | O site (login, consulta, envio de arquivos e padronização). |
| `padronizacao.js` | Como o site acha a data no texto e aplica as regras de padronização. |
| `preventivo.js`, `leitor-intelipost.js` | Painel preventivo e leitura da base da Intelipost. |
| `config.js` | **Único arquivo que você edita**: endereço e chave do Supabase. |
| `supabase/schema.sql` | Cria as tabelas e as regras de segurança no Supabase. |
| `assets/logo.png` | Logo da Multimóveis. |

## Como a Logística usa

### Aba "Enviar arquivos"

1. **Pedidos que estou cobrando**: escolha o arquivo `multimoveis-atrasados-em-aberto` (aba *Pedidos*).
   O site mostra uma prévia (quantos pedidos entram e quantos saem da cobrança) e você clica em **Salvar**.
   A lista nova substitui a anterior. Quem saiu da lista some da consulta, mas o histórico fica guardado.
2. **Retorno da transportadora**: confira a **data do retorno** (vem com a data de hoje) e anexe o arquivo
   no modelo `Retorno_atrasos_tp` (colunas *Pedido Intelipost*, *Nota-Série*, *Transportadora*,
   *Retorno Transportadora*). Se o pedido estiver vazio, o site procura pela nota (ou pela nova NF de reposição).
   Na prévia aparece, para cada linha, a data encontrada e a categoria. Clique em **Salvar**.
3. Em **Últimos envios** dá para apagar um envio feito por engano e mandar de novo.

### Aba "Padronização"

- **Considerar como** = a categoria (ex.: *Em rota de entrega*).
- **quando o retorno tiver** = palavras separadas por vírgula (ex.: *EM ROTA, SAIDA PARA ENTREGA*).
  Maiúsculas e acentos não importam. Basta o retorno *conter* a palavra.
- A ordem importa: o retorno vai para a **primeira** categoria (de cima para baixo) que encontrar.
- **Retornos sem padronização** mostra os textos que ainda não caíram em nenhuma regra. Clique em um para
  usá-lo numa regra nova.
- Quando a transportadora manda uma data (ex.: *Previsão 20/11*), a data vira a **nova data informada**.
  Sem ano, o site usa o ano mais próximo do dia do retorno. Se tiver duas datas ("entre 06/11 e 09/11"), vale a última.
- As regras valem na hora para **todos** os retornos, inclusive os antigos.
- **voltar para as regras de fábrica** apaga as regras criadas e volta para a lista inicial.

### Situação que o outro setor vê

| Situação | Quando |
|---|---|
| Nova data informada | A transportadora deu uma data que ainda não chegou. |
| Vence hoje | A nova data é hoje. |
| Nova data vencida | A nova data já passou. |
| *Categoria* (ex.: Em rota de entrega) | O retorno caiu numa regra de padronização. |
| Não padronizado | O retorno não tem data e não caiu em nenhuma regra. |
| Sem retorno | A transportadora ainda não respondeu sobre esse pedido. |

Clicando em **histórico** aparece tudo o que a transportadora já respondeu sobre o pedido, com as datas.

---

## Instalação (já feita em 10/11/2026)

### Supabase
1. Criar o projeto em https://supabase.com (região São Paulo).
2. **SQL Editor** → **New query** → colar todo o `supabase/schema.sql` → **Run**.
   *Pode rodar de novo quando o arquivo mudar: retornos e regras salvos são mantidos.*
3. Cadastrar quem é da Logística:
   `insert into public.admins (email) values ('seu.email@empresa.com.br');`
4. **Authentication** → **Sign In / Providers** → desligar **Allow new users to sign up**.
5. Criar os logins em **Authentication** → **Users** → **Add user** → **Create new user**
   (com **Auto Confirm User** marcado). Para tirar o acesso: três pontinhos → **Delete user**.
6. Copiar **Project URL** e a chave **anon** (Project Settings → API) para o `config.js`.
   *Nunca* use a chave `service_role` no site.

### GitHub
- **Repositório**: a "pasta" do projeto no GitHub. **Commit**: cada versão salva, com uma frase do que mudou.
- O site é publicado pelo **GitHub Pages** (Settings → Pages → Deploy from a branch → `main` / root).
- Para ver o histórico de mudanças: na página do repositório, clique em **Commits** (ícone de relógio).
- Para editar um arquivo pelo navegador: abra o arquivo, clique no lápis ✏️, edite e clique em **Commit changes**.

Dados de cliente (nome, endereço, telefone) **não** são enviados ao painel.
