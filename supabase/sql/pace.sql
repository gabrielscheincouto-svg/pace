-- =====================================================================
-- Pace — banco de dados (Supabase, projeto ojqyjbzlkmsayxmigsay)
--
-- Retrato do que está no ar em 23/10/2026 (versão v44 do app), tirado
-- direto do banco. Serve de referência e para recriar o Pace num banco
-- novo; o banco em produção já tem tudo isto, não precisa rodar de novo.
--
-- Como funciona o acesso:
--   - O app NÃO usa o login do Supabase. Cada pessoa tem uma conta em
--     pace_contas (senha com bcrypt, via pgcrypto) e recebe um token de
--     sessão; no banco fica só o hash SHA-256 do token (pace_sessoes).
--   - As tabelas têm RLS ligado e nenhuma política: o navegador não lê nem
--     grava tabela nenhuma direto. Tudo passa pelas funções pace_* (SECURITY
--     DEFINER), que conferem o token antes de qualquer coisa.
--   - Os dados de treino e dieta de cada pessoa ficam num documento JSON em
--     treino_state, uma linha por grupo (pace_contas.grupo), com controle de
--     versão para dois aparelhos não sobrescreverem um ao outro.
--   - As funções _pace_* e pace_ia_* só podem ser chamadas pelo servidor
--     (service_role) — a função de IA (supabase/functions/pace-ia) usa elas.
--
-- Depende da extensão pgcrypto no schema `extensions` (crypt, gen_salt,
-- digest, gen_random_bytes), que o Supabase já traz instalada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

-- Documento de dados do app (treinos, sessões, dieta, preferências).
-- Uma linha por grupo; `version` sobe a cada gravação (ver pace_gravar).
create table if not exists public.treino_state (
  id text not null,
  data jsonb default '{}'::jsonb not null,
  version bigint default 0 not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text,
  constraint treino_state_pkey PRIMARY KEY (id)
);

-- Contas: uma por pessoa. `grupo` aponta para a linha de treino_state.
create table if not exists public.pace_contas (
  id uuid default gen_random_uuid() not null,
  login text not null,
  email text,
  nome text not null,
  perfil text not null,
  grupo text not null,
  admin boolean default false not null,
  ativo boolean default true not null,
  senha_hash text,
  convite_hash text,
  convite_expira timestamp with time zone,
  tentativas integer default 0 not null,
  bloqueado_ate timestamp with time zone,
  criado_em timestamp with time zone default now() not null,
  criado_por uuid,
  ativado_em timestamp with time zone,
  ultimo_login timestamp with time zone,
  ultimo_uso timestamp with time zone,
  constraint pace_contas_convite_hash_key UNIQUE (convite_hash),
  constraint pace_contas_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES pace_contas(id) ON DELETE SET NULL,
  constraint pace_contas_grupo_perfil UNIQUE (grupo, perfil),
  constraint pace_contas_login_key UNIQUE (login),
  constraint pace_contas_pkey PRIMARY KEY (id),
  constraint pace_grupo_fmt CHECK ((grupo ~ '^[a-z0-9_]{3,60}$'::text)),
  constraint pace_login_fmt CHECK (((login = lower(btrim(login))) AND ((length(login) >= 3) AND (length(login) <= 120)))),
  constraint pace_perfil_fmt CHECK ((perfil ~ '^[a-z][a-z0-9_]{1,30}$'::text))
);

-- Sessões abertas (token guardado só como hash). Duram 180 dias e renovam com o uso; no máximo 10 por conta.
create table if not exists public.pace_sessoes (
  token_hash text not null,
  conta_id uuid not null,
  criado_em timestamp with time zone default now() not null,
  expira_em timestamp with time zone not null,
  ultimo_uso timestamp with time zone default now() not null,
  agente text,
  constraint pace_sessoes_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES pace_contas(id) ON DELETE CASCADE,
  constraint pace_sessoes_pkey PRIMARY KEY (token_hash)
);

-- Comentários enviados pelo app para o administrador.
create table if not exists public.pace_feedback (
  id bigint generated always as identity not null,
  conta_id uuid,
  nome text,
  texto text not null,
  tela text,
  versao text,
  criado_em timestamp with time zone default now() not null,
  lido boolean default false not null,
  constraint pace_feedback_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES pace_contas(id) ON DELETE SET NULL,
  constraint pace_feedback_pkey PRIMARY KEY (id),
  constraint pace_feedback_texto_check CHECK (((length(texto) >= 1) AND (length(texto) <= 4000)))
);

-- Registro de cada uso da IA (limite diário por conta).
create table if not exists public.pace_ia_uso (
  id bigint generated always as identity not null,
  conta_id uuid,
  tipo text,
  criado_em timestamp with time zone default now() not null,
  ok boolean,
  constraint pace_ia_uso_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES pace_contas(id) ON DELETE CASCADE,
  constraint pace_ia_uso_pkey PRIMARY KEY (id)
);

-- Cópias de segurança do documento de dados.
create table if not exists public.pace_backup (
  id bigint generated always as identity not null,
  doc_id text not null,
  data jsonb not null,
  version bigint,
  motivo text,
  criado_em timestamp with time zone default now() not null,
  constraint pace_backup_pkey PRIMARY KEY (id)
);

alter table public.treino_state  enable row level security;
alter table public.pace_contas enable row level security;
alter table public.pace_sessoes enable row level security;
alter table public.pace_feedback enable row level security;
alter table public.pace_ia_uso enable row level security;
alter table public.pace_backup enable row level security;
-- Sem políticas de propósito: acesso só pelas funções abaixo.
revoke all on public.treino_state, public.pace_contas, public.pace_sessoes,
  public.pace_feedback, public.pace_ia_uso, public.pace_backup from anon, authenticated;


-- ---------------------------------------------------------------------
-- Funções internas (só servidor)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._pace_admin(p_token text)
 RETURNS pace_contas
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas := public._pace_conta(p_token);
begin
  if not c.admin then raise exception 'Acesso restrito ao administrador.'; end if;
  return c;
end $function$;

CREATE OR REPLACE FUNCTION public._pace_conta(p_token text)
 RETURNS pace_contas
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.pace_sessoes; c public.pace_contas;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{30,80}$' then raise exception 'sessao_invalida'; end if;
  select * into s from public.pace_sessoes where token_hash = public._pace_hash(p_token);
  if not found or s.expira_em < now() then raise exception 'sessao_invalida'; end if;
  select * into c from public.pace_contas where id = s.conta_id;
  if not found or not c.ativo then raise exception 'sessao_invalida'; end if;
  if s.ultimo_uso < now() - interval '10 minutes' then
    update public.pace_sessoes set ultimo_uso = now(), expira_em = greatest(expira_em, now() + interval '180 days')
     where token_hash = s.token_hash;
    update public.pace_contas set ultimo_uso = now() where id = c.id;
  end if;
  return c;
end $function$;

CREATE OR REPLACE FUNCTION public._pace_fechar_legado()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'treino_state')
     or has_table_privilege('anon', 'public.treino_state', 'select')
     or has_table_privilege('authenticated', 'public.treino_state', 'select') then
    execute 'drop policy if exists treino_state_all on public.treino_state';
    execute 'revoke all on public.treino_state from anon, authenticated';
    return true;
  end if;
  return false;
end $function$;

CREATE OR REPLACE FUNCTION public._pace_hash(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$function$;

CREATE OR REPLACE FUNCTION public._pace_info(c pace_contas)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'id', c.id, 'nome', c.nome, 'login', c.login, 'perfil', c.perfil, 'admin', c.admin, 'grupo', c.grupo,
    'perfis', coalesce((select jsonb_agg(jsonb_build_object('perfil', o.perfil, 'nome', o.nome) order by o.criado_em, o.nome)
                          from public.pace_contas o where o.grupo = c.grupo and o.ativo), '[]'::jsonb))
$function$;

CREATE OR REPLACE FUNCTION public._pace_nova_sessao(p_conta uuid, p_agente text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare tok text := public._pace_token(32);
begin
  delete from public.pace_sessoes where conta_id = p_conta and expira_em < now();
  delete from public.pace_sessoes where token_hash in (
    select token_hash from public.pace_sessoes where conta_id = p_conta order by ultimo_uso desc offset 9);
  insert into public.pace_sessoes(token_hash, conta_id, expira_em, agente)
    values (public._pace_hash(tok), p_conta, now() + interval '180 days', left(p_agente, 200));
  return tok;
end $function$;

CREATE OR REPLACE FUNCTION public._pace_token(n integer)
 RETURNS text
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  select translate(encode(extensions.gen_random_bytes(n), 'base64'), '+/=', '-_')
$function$;


-- ---------------------------------------------------------------------
-- Funções chamadas pelo app (e as de IA, só servidor)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pace_admin_ativo(p_token text, p_conta uuid, p_ativo boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.pace_contas := public._pace_admin(p_token);
begin
  if p_conta = a.id then return jsonb_build_object('erro', 'Você não pode desativar o seu próprio acesso.'); end if;
  update public.pace_contas
     set ativo = coalesce(p_ativo, false),
         convite_hash = case when coalesce(p_ativo, false) then convite_hash else null end,
         convite_expira = case when coalesce(p_ativo, false) then convite_expira else null end
   where id = p_conta;
  if not found then return jsonb_build_object('erro', 'Acesso não encontrado.'); end if;
  if not coalesce(p_ativo, false) then delete from public.pace_sessoes where conta_id = p_conta; end if;
  return jsonb_build_object('ok', true);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_admin_contas(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.pace_contas := public._pace_admin(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'nome', c.nome, 'login', c.login, 'perfil', c.perfil, 'admin', c.admin, 'ativo', c.ativo,
      'compartilhado', c.grupo = a.grupo,
      'situacao', case when not c.ativo then 'desativado'
                       when c.senha_hash is null then 'aguardando'
                       else 'ativo' end,
      'convite_expira', c.convite_expira, 'ativado_em', c.ativado_em, 'ultimo_login', c.ultimo_login,
      'ultimo_uso', greatest(c.ultimo_uso, c.ultimo_login), 'criado_em', c.criado_em,
      'ia_30d', (select count(*) from public.pace_ia_uso u where u.conta_id = c.id and u.criado_em > now() - interval '30 days'),
      'eu', c.id = a.id)
    order by (c.id = a.id) desc, c.criado_em) from public.pace_contas c), '[]'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_admin_criar(p_token text, p_nome text, p_login text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.pace_contas := public._pace_admin(p_token);
        n text := btrim(coalesce(p_nome, ''));
        l text := lower(btrim(coalesce(p_login, '')));
        perf text; grp text; tok text; novo public.pace_contas;
begin
  if length(n) < 2 or length(n) > 60 then return jsonb_build_object('erro', 'Informe o nome (de 2 a 60 caracteres).'); end if;
  if l !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then return jsonb_build_object('erro', 'Informe um e-mail válido.'); end if;
  if exists (select 1 from public.pace_contas where login = l or lower(coalesce(email, '')) = l) then
    return jsonb_build_object('erro', 'Já existe um acesso com esse e-mail.');
  end if;
  perf := lower(regexp_replace(translate(split_part(n, ' ', 1),
            'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'), '[^a-zA-Z0-9_]', '', 'g'));
  if perf !~ '^[a-z][a-z0-9_]{1,30}$' then perf := 'atleta'; end if;
  grp := 'pace_' || left(perf, 20) || '_' || substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 6);
  tok := public._pace_token(24);
  insert into public.pace_contas(login, email, nome, perfil, grupo, criado_por, convite_hash, convite_expira)
    values (l, l, n, perf, grp, a.id, public._pace_hash(tok), now() + interval '7 days')
  returning * into novo;
  return jsonb_build_object('ok', true, 'id', novo.id, 'nome', novo.nome, 'convite', tok, 'expira', novo.convite_expira);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_admin_feedback(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.pace_contas := public._pace_admin(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome, 'texto', f.texto, 'tela', f.tela,
      'versao', f.versao, 'criado_em', f.criado_em, 'lido', f.lido) order by f.criado_em desc)
    from (select * from public.pace_feedback order by criado_em desc limit 300) f), '[]'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_admin_feedback_lido(p_token text, p_id bigint, p_lido boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.pace_contas := public._pace_admin(p_token);
begin
  update public.pace_feedback set lido = coalesce(p_lido, true) where id = p_id;
  return jsonb_build_object('ok', found);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_admin_link(p_token text, p_conta uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.pace_contas := public._pace_admin(p_token); c public.pace_contas; tok text := public._pace_token(24);
begin
  update public.pace_contas set convite_hash = public._pace_hash(tok), convite_expira = now() + interval '7 days'
   where id = p_conta and ativo
  returning * into c;
  if not found then return jsonb_build_object('erro', 'Acesso não encontrado ou desativado.'); end if;
  return jsonb_build_object('ok', true, 'nome', c.nome, 'convite', tok, 'expira', c.convite_expira, 'primeiro', c.senha_hash is null);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_ativar(p_convite text, p_senha text, p_agente text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas; tok text;
begin
  perform public._pace_fechar_legado();
  if p_convite is null or p_convite !~ '^[A-Za-z0-9_-]{20,80}$' then
    return jsonb_build_object('erro', 'Link inválido. Peça um link novo para quem te convidou.');
  end if;
  if length(coalesce(p_senha, '')) < 8 then return jsonb_build_object('erro', 'A senha precisa ter pelo menos 8 caracteres.'); end if;
  if length(p_senha) > 72 then return jsonb_build_object('erro', 'A senha pode ter no máximo 72 caracteres.'); end if;
  select * into c from public.pace_contas where convite_hash = public._pace_hash(p_convite) and ativo for update;
  if not found or c.convite_expira < now() then
    return jsonb_build_object('erro', 'Este link já foi usado ou venceu. Peça um link novo para quem te convidou.');
  end if;
  update public.pace_contas
     set senha_hash = extensions.crypt(p_senha, extensions.gen_salt('bf', 10)),
         convite_hash = null, convite_expira = null, tentativas = 0, bloqueado_ate = null,
         ativado_em = coalesce(ativado_em, now()), ultimo_login = now(), ultimo_uso = now()
   where id = c.id
  returning * into c;
  delete from public.pace_sessoes where conta_id = c.id;
  tok := public._pace_nova_sessao(c.id, p_agente);
  return jsonb_build_object('token', tok, 'conta', public._pace_info(c));
end $function$;

CREATE OR REPLACE FUNCTION public.pace_convite(p_convite text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas;
begin
  perform public._pace_fechar_legado();
  if p_convite is null or p_convite !~ '^[A-Za-z0-9_-]{20,80}$' then
    return jsonb_build_object('erro', 'Link inválido. Peça um link novo para quem te convidou.');
  end if;
  select * into c from public.pace_contas where convite_hash = public._pace_hash(p_convite) and ativo;
  if not found or c.convite_expira < now() then
    return jsonb_build_object('erro', 'Este link já foi usado ou venceu. Peça um link novo para quem te convidou.');
  end if;
  return jsonb_build_object('nome', c.nome, 'login', c.login, 'primeiro', c.senha_hash is null);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_entrar(p_login text, p_senha text, p_agente text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l text := lower(btrim(coalesce(p_login, ''))); c public.pace_contas; tok text;
begin
  perform public._pace_fechar_legado();
  if l = '' or coalesce(p_senha, '') = '' then return jsonb_build_object('erro', 'Informe o usuário e a senha.'); end if;
  select * into c from public.pace_contas
   where (login = l or lower(coalesce(email, '')) = l) and ativo
   order by (login = l) desc limit 1;
  if not found then return jsonb_build_object('erro', 'Usuário ou senha incorretos.'); end if;
  if c.bloqueado_ate is not null and c.bloqueado_ate > now() then
    return jsonb_build_object('erro', 'Muitas tentativas erradas. Tente de novo daqui a alguns minutos.');
  end if;
  if c.senha_hash is null then
    return jsonb_build_object('erro', 'Seu acesso ainda não foi ativado. Abra o link que você recebeu para criar a senha.');
  end if;
  if extensions.crypt(p_senha, c.senha_hash) <> c.senha_hash then
    update public.pace_contas
       set bloqueado_ate = case when tentativas + 1 >= 8 then now() + interval '15 minutes' else null end,
           tentativas    = case when tentativas + 1 >= 8 then 0 else tentativas + 1 end
     where id = c.id;
    return jsonb_build_object('erro', 'Usuário ou senha incorretos.');
  end if;
  update public.pace_contas set tentativas = 0, bloqueado_ate = null, ultimo_login = now(), ultimo_uso = now() where id = c.id;
  tok := public._pace_nova_sessao(c.id, p_agente);
  return jsonb_build_object('token', tok, 'conta', public._pace_info(c));
end $function$;

CREATE OR REPLACE FUNCTION public.pace_estado(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas := public._pace_conta(p_token); r record;
begin
  select data, version into r from public.treino_state where id = c.grupo;
  return jsonb_build_object('conta', public._pace_info(c),
                            'data', case when found then r.data else null end,
                            'version', case when found then r.version else 0 end);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_feedback_enviar(p_token text, p_texto text, p_tela text DEFAULT NULL::text, p_versao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas := public._pace_conta(p_token); t text := btrim(coalesce(p_texto, ''));
begin
  if t = '' then return jsonb_build_object('erro', 'Escreva o que você quer contar.'); end if;
  if length(t) > 4000 then return jsonb_build_object('erro', 'Texto muito longo (máximo de 4.000 caracteres).'); end if;
  if (select count(*) from public.pace_feedback where conta_id = c.id and criado_em > now() - interval '1 day') >= 30 then
    return jsonb_build_object('erro', 'Você já mandou muitos comentários hoje. Tente amanhã.');
  end if;
  insert into public.pace_feedback(conta_id, nome, texto, tela, versao) values (c.id, c.nome, t, left(p_tela, 60), left(p_versao, 30));
  return jsonb_build_object('ok', true);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_gravar(p_token text, p_data jsonb, p_versao bigint, p_dispositivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas := public._pace_conta(p_token); nv bigint; atual bigint;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'dados_invalidos'; end if;
  if pg_column_size(p_data) > 8000000 then raise exception 'dados_grandes'; end if;
  update public.treino_state
     set data = p_data, version = version + 1, updated_at = now(),
         updated_by = left(c.perfil || coalesce(':' || p_dispositivo, ''), 80)
   where id = c.grupo and version = p_versao
  returning version into nv;
  if found then return jsonb_build_object('ok', true, 'version', nv); end if;
  select version into atual from public.treino_state where id = c.grupo;
  if not found then
    if coalesce(p_versao, 0) <> 0 then return jsonb_build_object('ok', false, 'version', 0); end if;
    insert into public.treino_state(id, data, version, updated_at, updated_by)
      values (c.grupo, p_data, 1, now(), left(c.perfil || coalesce(':' || p_dispositivo, ''), 80))
      on conflict (id) do nothing;
    if found then return jsonb_build_object('ok', true, 'version', 1); end if;
    select version into atual from public.treino_state where id = c.grupo;
  end if;
  return jsonb_build_object('ok', false, 'version', coalesce(atual, 0));
end $function$;

CREATE OR REPLACE FUNCTION public.pace_ia_autorizar(p_token text, p_tipo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas; n integer; uso bigint; t text := lower(left(coalesce(p_tipo, ''), 20)); lim integer;
begin
  begin
    c := public._pace_conta(p_token);
  exception when others then
    return jsonb_build_object('erro', 'Sua sessão terminou. Entre de novo no app.', 'sessao', true);
  end;
  lim := case when t = 'importar' then 20 else 80 end;
  select count(*) into n from public.pace_ia_uso
   where conta_id = c.id and criado_em > now() - interval '1 day'
     and (case when t = 'importar' then tipo = 'importar' else tipo is distinct from 'importar' end);
  if n >= lim then
    return jsonb_build_object('erro', case when t = 'importar'
      then 'Você chegou ao limite de leituras de arquivo de hoje. Tente de novo amanhã.'
      else 'Você chegou ao limite de consultas à IA de hoje. Tente de novo amanhã.' end);
  end if;
  insert into public.pace_ia_uso(conta_id, tipo) values (c.id, t) returning id into uso;
  return jsonb_build_object('ok', true, 'uso', uso, 'nome', c.nome, 'perfil', c.perfil);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_ia_resultado(p_uso bigint, p_ok boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.pace_ia_uso set ok = p_ok where id = p_uso
$function$;

CREATE OR REPLACE FUNCTION public.pace_preparar()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public._pace_fechar_legado();
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.pace_sair(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_token is not null then delete from public.pace_sessoes where token_hash = public._pace_hash(p_token); end if;
end $function$;

CREATE OR REPLACE FUNCTION public.pace_sessao(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas := public._pace_conta(p_token);
begin
  return public._pace_info(c);
end $function$;

CREATE OR REPLACE FUNCTION public.pace_trocar_senha(p_token text, p_atual text, p_nova text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.pace_contas := public._pace_conta(p_token);
begin
  if c.senha_hash is null or extensions.crypt(coalesce(p_atual, ''), c.senha_hash) <> c.senha_hash then
    return jsonb_build_object('erro', 'A senha atual não confere.');
  end if;
  if length(coalesce(p_nova, '')) < 8 then return jsonb_build_object('erro', 'A senha nova precisa ter pelo menos 8 caracteres.'); end if;
  if length(p_nova) > 72 then return jsonb_build_object('erro', 'A senha nova pode ter no máximo 72 caracteres.'); end if;
  update public.pace_contas set senha_hash = extensions.crypt(p_nova, extensions.gen_salt('bf', 10)) where id = c.id;
  delete from public.pace_sessoes where conta_id = c.id and token_hash <> public._pace_hash(p_token);
  return jsonb_build_object('ok', true);
end $function$;


-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------

revoke all on function public._pace_admin(text) from public, anon, authenticated;
revoke all on function public._pace_conta(text) from public, anon, authenticated;
revoke all on function public._pace_fechar_legado() from public, anon, authenticated;
revoke all on function public._pace_hash(text) from public, anon, authenticated;
revoke all on function public._pace_info(pace_contas) from public, anon, authenticated;
revoke all on function public._pace_nova_sessao(uuid, text) from public, anon, authenticated;
revoke all on function public._pace_token(integer) from public, anon, authenticated;
revoke all on function public.pace_admin_ativo(text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.pace_admin_contas(text) from public, anon, authenticated;
revoke all on function public.pace_admin_criar(text, text, text) from public, anon, authenticated;
revoke all on function public.pace_admin_feedback(text) from public, anon, authenticated;
revoke all on function public.pace_admin_feedback_lido(text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.pace_admin_link(text, uuid) from public, anon, authenticated;
revoke all on function public.pace_ativar(text, text, text) from public, anon, authenticated;
revoke all on function public.pace_convite(text) from public, anon, authenticated;
revoke all on function public.pace_entrar(text, text, text) from public, anon, authenticated;
revoke all on function public.pace_estado(text) from public, anon, authenticated;
revoke all on function public.pace_feedback_enviar(text, text, text, text) from public, anon, authenticated;
revoke all on function public.pace_gravar(text, jsonb, bigint, text) from public, anon, authenticated;
revoke all on function public.pace_ia_autorizar(text, text) from public, anon, authenticated;
revoke all on function public.pace_ia_resultado(bigint, boolean) from public, anon, authenticated;
revoke all on function public.pace_preparar() from public, anon, authenticated;
revoke all on function public.pace_sair(text) from public, anon, authenticated;
revoke all on function public.pace_sessao(text) from public, anon, authenticated;
revoke all on function public.pace_trocar_senha(text, text, text) from public, anon, authenticated;
grant execute on function public.pace_admin_ativo(text, uuid, boolean) to anon, authenticated;
grant execute on function public.pace_admin_contas(text) to anon, authenticated;
grant execute on function public.pace_admin_criar(text, text, text) to anon, authenticated;
grant execute on function public.pace_admin_feedback(text) to anon, authenticated;
grant execute on function public.pace_admin_feedback_lido(text, bigint, boolean) to anon, authenticated;
grant execute on function public.pace_admin_link(text, uuid) to anon, authenticated;
grant execute on function public.pace_ativar(text, text, text) to anon, authenticated;
grant execute on function public.pace_convite(text) to anon, authenticated;
grant execute on function public.pace_entrar(text, text, text) to anon, authenticated;
grant execute on function public.pace_estado(text) to anon, authenticated;
grant execute on function public.pace_feedback_enviar(text, text, text, text) to anon, authenticated;
grant execute on function public.pace_gravar(text, jsonb, bigint, text) to anon, authenticated;
grant execute on function public.pace_preparar() to anon, authenticated;
grant execute on function public.pace_sair(text) to anon, authenticated;
grant execute on function public.pace_sessao(text) to anon, authenticated;
grant execute on function public.pace_trocar_senha(text, text, text) to anon, authenticated;
grant execute on function public._pace_admin(text) to service_role;
grant execute on function public._pace_conta(text) to service_role;
grant execute on function public._pace_fechar_legado() to service_role;
grant execute on function public._pace_hash(text) to service_role;
grant execute on function public._pace_info(pace_contas) to service_role;
grant execute on function public._pace_nova_sessao(uuid, text) to service_role;
grant execute on function public._pace_token(integer) to service_role;
grant execute on function public.pace_admin_ativo(text, uuid, boolean) to service_role;
grant execute on function public.pace_admin_contas(text) to service_role;
grant execute on function public.pace_admin_criar(text, text, text) to service_role;
grant execute on function public.pace_admin_feedback(text) to service_role;
grant execute on function public.pace_admin_feedback_lido(text, bigint, boolean) to service_role;
grant execute on function public.pace_admin_link(text, uuid) to service_role;
grant execute on function public.pace_ativar(text, text, text) to service_role;
grant execute on function public.pace_convite(text) to service_role;
grant execute on function public.pace_entrar(text, text, text) to service_role;
grant execute on function public.pace_estado(text) to service_role;
grant execute on function public.pace_feedback_enviar(text, text, text, text) to service_role;
grant execute on function public.pace_gravar(text, jsonb, bigint, text) to service_role;
grant execute on function public.pace_ia_autorizar(text, text) to service_role;
grant execute on function public.pace_ia_resultado(bigint, boolean) to service_role;
grant execute on function public.pace_preparar() to service_role;
grant execute on function public.pace_sair(text) to service_role;
grant execute on function public.pace_sessao(text) to service_role;
grant execute on function public.pace_trocar_senha(text, text, text) to service_role;
