# Painel de Consulta de Novas Datas de Entrega

Site com login (e-mail e senha) onde outro setor consulta as **novas datas de entrega** que as
transportadoras informam à Logística. Os usuários do outro setor **só consultam**. Quem cadastra
os logins e atualiza os dados é a Logística.

```
Planilha Retorno_atrasos.xlsm
   │  botão "Exportar para o painel"  → gera painel_entregas.csv
   ▼
Painel (site no GitHub Pages)  ── Logística entra e clica em "Enviar planilha"
   │
   ▼
Supabase (guarda logins e pedidos, com segurança)  ◄── outro setor entra e consulta
```

## O que tem em cada arquivo

| Arquivo | Para que serve |
|---|---|
| `index.html`, `styles.css`, `app.js` | O site (tela de login e painel). Não precisa mexer. |
| `config.js` | **Único arquivo que você edita**: endereço e chave do Supabase. |
| `supabase/schema.sql` | Cria as tabelas e as regras de segurança no Supabase (roda uma vez). |
| `planilha/ExportarPainel.bas` | Macro para colocar na planilha. Gera o arquivo que vai para o painel. |

---

## Parte 1: Supabase (login e dados), uma vez só

1. Acesse **https://supabase.com**, clique em **Start your project** e entre com a sua conta do GitHub.
2. Clique em **New project**. Dê um nome (ex.: `painel-datas`), crie uma senha para o banco
   (guarde-a) e escolha a região **South America (São Paulo)**. Clique em **Create new project** e espere uns 2 minutos.
3. No menu da esquerda, abra **SQL Editor** → **New query**. Abra o arquivo `supabase/schema.sql`,
   copie **tudo**, cole lá e clique em **Run**. Deve aparecer "Success".
4. Ainda no SQL Editor, numa nova query, cadastre você como Logística (troque o e-mail):
   ```sql
   insert into public.admins (email) values ('seu.email@empresa.com.br');
   ```
5. **Bloqueie o cadastro público** (importante para ninguém criar conta sozinho):
   menu **Authentication** → **Sign In / Providers** → desligue **Allow new users to sign up** → **Save**.
6. **Crie os logins** (o seu e os do outro setor): **Authentication** → **Users** → **Add user** →
   **Create new user**. Digite e-mail e senha, deixe marcado **Auto Confirm User** e clique em **Create user**.
   - Para trocar a senha de alguém: clique no usuário → **Send password recovery**, ou apague e crie de novo.
   - Para tirar o acesso: clique nos três pontinhos do usuário → **Delete user**.
7. Pegue as chaves: **Project Settings** (engrenagem) → **API**. Copie a **Project URL** e a chave
   **anon public** e cole no arquivo `config.js`. *Nunca* use a chave `service_role` no site.

## Parte 2: GitHub (onde o site fica publicado)

Algumas palavras que você vai ver:
- **Repositório (repo)**: a "pasta" do projeto no GitHub, com todo o histórico de mudanças.
- **Commit**: uma "versão salva" com uma frase dizendo o que mudou.
- **Branch `main`**: a versão principal do projeto. É ela que vai para o ar.
- **GitHub Pages**: serviço gratuito do GitHub que transforma o repositório em site.

Passo a passo, tudo pelo navegador:

1. Entre em **https://github.com**, clique no **+** (canto superior direito) → **New repository**.
2. Nome: `painel-consulta-datas`. Marque **Public** (o GitHub Pages gratuito exige; o repositório só tem
   o código, **nenhum dado de pedido fica aqui**). Clique em **Create repository**.
3. Na página do repositório, clique em **uploading an existing file** (ou **Add file → Upload files**),
   arraste **todos os arquivos e pastas** deste projeto (já com o `config.js` preenchido),
   escreva em "Commit changes" algo como `Primeira versão do painel` e clique em **Commit changes**.
4. Vá em **Settings** → **Pages**. Em **Source** escolha **Deploy from a branch**, em **Branch** escolha
   **main** e **/ (root)**, e clique em **Save**.
5. Espere 1 ou 2 minutos e atualize a página: vai aparecer o endereço do site, algo como
   `https://SEU-USUARIO.github.io/painel-consulta-datas/`. Esse é o link que você manda para o outro setor.
6. No Supabase, em **Authentication** → **URL Configuration**, coloque esse endereço em **Site URL** e salve.

**Para mudar algo depois** (ex.: o texto de contato no `config.js`): abra o arquivo no GitHub, clique no
lápis ✏️, edite, clique em **Commit changes**. Em 1 minuto o site atualiza sozinho.

## Parte 3: Planilha (botão "Exportar para o painel"), uma vez só

1. Abra `Retorno_atrasos.xlsm` e aperte **Alt + F11** (abre o editor de macros).
2. Menu **Arquivo** → **Importar arquivo…** → escolha `planilha/ExportarPainel.bas`. Feche o editor.
3. Na aba **Controle Retorno**, vá em **Desenvolvedor** → **Inserir** → **Botão**, desenhe o botão e escolha
   a macro **ExportarParaPainel**. Escreva no botão "Exportar para o painel". Salve a planilha.
   (Se não aparecer a guia Desenvolvedor: Arquivo → Opções → Personalizar Faixa de Opções → marque Desenvolvedor.)

## Rotina semanal (Logística)

1. Atualize a planilha como sempre (cole os retornos na aba **Retornos**).
2. Clique em **Exportar para o painel**. O arquivo `painel_entregas.csv` é salvo na mesma pasta da planilha.
3. Abra o painel, entre com o seu login, clique em **Enviar planilha** e escolha `painel_entregas.csv`.
4. Pronto: aparece "Pedidos atualizados" e o outro setor já vê as datas novas.

## O que o outro setor vê

- Busca por número do pedido (Intelipost ou do canal) ou da nota.
- Filtros por transportadora, canal e situação; clique nos quadros do resumo para filtrar.
- **Situação** de cada pedido:
  - **Nova data informada**: a transportadora deu uma data que ainda não chegou.
  - **Vence hoje**: a nova data é hoje.
  - **Nova data vencida**: a data passou e o pedido ainda não consta como entregue.
  - **Outros retornos**: retorno sem data (ex.: "Em rota de entrega", "Em processo de devolução").
  - **Sem retorno**: a transportadora ainda não respondeu.
- Botão **Baixar (Excel)** com o que está filtrado.

Dados de cliente (nome, endereço, CPF) **não** são enviados ao painel.
