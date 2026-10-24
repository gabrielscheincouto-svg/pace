# Pace

App de treino e dieta do Gabriel e da Eduarda (e de quem mais receber acesso).
Funciona no navegador e pode ser instalado na tela de início do celular.

- **No ar:** https://treino-gabi-eduarda.netlify.app (Netlify, projeto `treino-gabi-eduarda`)
- **Versão atual:** v46 (24/10/2026) — ver [docs/HISTORICO.md](docs/HISTORICO.md)

## Como está organizado

```
index.html                      o app inteiro (HTML, CSS e JavaScript num arquivo só)
icon-180.png                    ícone da tela de início do iPhone
netlify.toml                    configuração de publicação no Netlify
supabase/sql/pace.sql           banco de dados: tabelas, funções e permissões
supabase/functions/pace-ia/     função de IA (análise do dia, leitura de treino e dieta por arquivo)
supabase/functions/pace-conversa/ conversa com o coach (pergunta livre)
docs/HISTORICO.md               o que mudou em cada versão
```

### App (`index.html`)

Arquivo único, sem etapa de build: o que está no repositório é exatamente o
que vai para o ar. Usa a biblioteca do Supabase pelo CDN
(`@supabase/supabase-js@2`) e as fontes Inter, Instrument Serif e JetBrains
Mono do Google Fonts. Telas principais: Hoje, Treinos, Dieta, Evolução e
Calendário; administrador tem ainda Acessos e Comentários.

O número da versão aparece em dois lugares do `index.html` (tela de
configurações e envio de comentário, procure por `v46`) — atualize os dois a
cada versão nova.

### Banco (`supabase/sql/pace.sql`)

Fica no projeto Supabase `ojqyjbzlkmsayxmigsay` (o mesmo de outros sistemas;
tudo do Pace começa com `pace_` ou é a tabela `treino_state`).

- O app **não** usa o login do Supabase. Cada pessoa tem uma conta em
  `pace_contas`, com senha em bcrypt, e recebe um token de sessão; o banco
  guarda só o hash do token.
- As tabelas têm RLS ligado e nenhuma política: o navegador não acessa
  tabela nenhuma direto. Tudo passa pelas funções `pace_*`, que conferem o
  token.
- Os dados de cada pessoa (treinos, sessões, dieta, preferências) ficam num
  documento JSON em `treino_state`, com número de versão para dois aparelhos
  não sobrescreverem um ao outro.
- Acesso novo: o administrador cria pela tela Acessos e manda o link de uso
  único (vale 7 dias); a pessoa abre o link e cria a senha.

O arquivo é um retrato do banco em 23/10/2026. Mudou alguma função no
Supabase? Atualize o arquivo aqui também.

### IA (`supabase/functions/pace-ia`)

Função do Supabase (Edge Function) chamada pelo app em
`/functions/v1/pace-ia`. Ações: `importar` (lê treino ou dieta de texto, PDF
ou foto), `coach`, `dia` (por que este treino + próximos 3 dias) e
`refeicao` (alternativas para uma refeição). Confere o token da sessão antes
de chamar a IA e tem limite diário por pessoa (`pace_ia_autorizar`).

`pace-conversa` atende o chat do coach: recebe a conversa e um retrato do
app (plano com exercícios, cronograma, o que foi marcado no dia, sugestão do
app, histórico com as séries, recordes, grupos da semana e dieta) e devolve a
resposta, a letra do treino recomendado (quando houver) e perguntas de
continuação. Usa o mesmo controle de acesso e o mesmo limite diário
(`pace_ia_autorizar`, tipo `conversa`). A conversa fica guardada só no
aparelho (localStorage).

Segredos usados (cadastrados no Supabase, nunca no código):
`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e, opcional,
`PACE_IA_MODELO`.

## Como publicar

O Netlify publica sozinho a cada commit na `main` deste repositório (sem
build — só copia os arquivos). Então:

1. Mudança no app → commit do `index.html` na `main` → no ar em segundos.
2. Mudança no banco → aplicar no Supabase e atualizar `supabase/sql/pace.sql`.
3. Mudança na IA → publicar a função no Supabase e atualizar a cópia em
   `supabase/functions/` (`pace-ia` ou `pace-conversa`).

**Não publique pelo `netlify deploy` do computador.** Uma publicação manual
fica no ar só até o próximo commit, que a substitui pelo que está aqui — e o
que não estava no GitHub some.
