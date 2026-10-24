// pace-conversa: chat com o coach do Pace (pergunta livre). Só atende quem tem sessão no app.
// O token da sessão é conferido com a service role (pace_ia_autorizar, tipo 'conversa', mesmo limite diário
// das outras consultas), por isso a função é publicada com verify_jwt = false.
//
// POST JSON { token, mensagens: [{ papel: 'user' | 'coach', texto }], dados: { retrato do app }, perfil_nome, esporte, contexto }
//   → { resposta, treino_letra | null, sugestoes_rapidas: string[], modelo }
// Erro: { ok: false, error, sessao? }  (sessao = true: o app pede para entrar de novo)

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MODELOS_CONVERSA = [Deno.env.get('PACE_IA_MODELO') || 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'];
const TEMPO_RAPIDO_MS = 45_000;
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// ------------------------------------------------------------ texto
const arr = (x: unknown): any[] => Array.isArray(x) ? x : [];
const semTags = (s: unknown) => String(s ?? '').replace(/<\/?[a-zA-Z_][\w:-]*(?:\s[^<>]*)?>/g, ' ');
const linha = (s: unknown, n: number) => { const t = semTags(s).replace(/\s+/g, ' ').trim(); return t ? t.slice(0, n) : ''; };
const bloco = (s: unknown, n: number) => {
  const t = semTags(s).replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, n);
};

// ------------------------------------------------------------ acesso
async function autorizar(token: unknown): Promise<any> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,80}$/.test(token)) return { erro: 'Sua sessão terminou. Entre de novo no app.', sessao: true };
  const { data, error } = await admin.rpc('pace_ia_autorizar', { p_token: token, p_tipo: 'conversa' });
  if (error || !data) return { erro: 'Não foi possível conferir o acesso. Tente de novo.' };
  return data;
}
async function registrarResultado(uso: unknown, ok: boolean) {
  if (uso == null) return;
  try { await admin.rpc('pace_ia_resultado', { p_uso: uso, p_ok: ok }); } catch { /* só registro de uso */ }
}

// ------------------------------------------------------------ IA
class ErroIA extends Error { constructor(msg: string, public status = 502) { super(msg); } }
async function chamarIA(o: { modelos: string[]; system: string; mensagens: any[]; ferramenta: any; max_tokens: number; tempo: number; temperatura: number }) {
  let ultimo = '';
  const inicio = Date.now();
  for (const modelo of o.modelos) {
    const resta = o.tempo - (Date.now() - inicio);
    if (resta < 12_000) break;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), resta);
    let r: Response;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelo, max_tokens: o.max_tokens, temperature: o.temperatura, system: o.system, tools: [o.ferramenta],
          tool_choice: { type: 'tool', name: o.ferramenta.name }, messages: o.mensagens,
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === 'AbortError') throw new ErroIA('O coach demorou demais para responder. Tente de novo.', 504);
      ultimo = 'Falha de rede ao chamar a IA.'; continue;
    }
    clearTimeout(timer);
    const txt = await r.text();
    if (!r.ok) {
      if (/credit balance/i.test(txt)) throw new ErroIA('IA sem créditos no momento. Tente mais tarde.', 503);
      ultimo = `A IA respondeu com erro (${r.status}).`;
      if ([400, 404, 429, 500, 502, 503, 529].includes(r.status)) continue;
      throw new ErroIA(ultimo);
    }
    let msg: any;
    try { msg = JSON.parse(txt); } catch { ultimo = 'Resposta inválida da IA.'; continue; }
    const uso = arr(msg.content).find((c: any) => c.type === 'tool_use' && c.name === o.ferramenta.name);
    if (!uso || !uso.input || typeof uso.input !== 'object') { ultimo = 'A IA não devolveu a resposta no formato esperado.'; continue; }
    return { modelo, dados: uso.input };
  }
  throw new ErroIA(ultimo || 'Falha na IA.');
}

// ------------------------------------------------------------ partes comuns
const DIA_LABEL: Record<string, string> = { seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta', sex: 'sexta', sab: 'sábado', dom: 'domingo' };
const DIA_ORDEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const diaDe = (iso: string, mais = 0) => { const d = new Date(iso + 'T12:00:00'); if (isNaN(d.getTime())) return null; d.setDate(d.getDate() + mais); return DIA_ORDEM[d.getDay()]; };
const CAT: Record<string, string> = { sup: 'superiores', inf: 'inferiores', full: 'corpo inteiro' };
const contextoTxt = (b: any, n = 2500) => { const c = bloco(b?.contexto, n); return c ? `\n### CONTEXTO INFORMADO PELO ATLETA (vale sobre as regras gerais)\n${c}\n` : ''; };
const nomeDe = (b: any, auth: any) => linha(b?.perfil_nome, 40) || linha(String(auth?.nome || '').split(' ')[0], 40) || 'atleta';
function fmtPlan(p: any) {
  if (!p || typeof p !== 'object') return '(nada marcado)';
  const parts: string[] = [];
  if (p.musc !== undefined) parts.push(p.musc === null ? 'musculação: descanso' : 'musculação escolhida: ' + linha(p.musc, 3));
  ['jiu', 'corrida', 'futebol', 'bike', 'natacao', 'caminhada', 'jejum'].forEach((k) => { if (p[k]) parts.push(k); });
  return parts.length ? parts.join(' · ') : '(nada marcado)';
}

// ------------------------------------------------------------ conversa com o coach (pergunta livre)
const FERR_CONVERSA = {
  name: 'responder',
  description: 'Responde a mensagem do atleta no chat do coach.',
  input_schema: {
    type: 'object',
    properties: {
      resposta: { type: 'string', description: 'Resposta ao atleta, em texto simples. Pode usar listas com "- " e **negrito** em poucas palavras.' },
      treino_letra: { type: ['string', 'null'], description: 'Letra do treino do plano que você recomenda fazer agora, se a resposta recomenda um treino; senão null.' },
      sugestoes_rapidas: { type: 'array', items: { type: 'string' }, description: 'Até 3 perguntas curtas (máx. 45 caracteres) que o atleta pode fazer em seguida.' },
    },
    required: ['resposta', 'sugestoes_rapidas'],
  },
};

function dadosConversaTxt(d: any, nome: string) {
  const L: string[] = [];
  const hoje = /^\d{4}-\d{2}-\d{2}$/.test(String(d?.hoje)) ? String(d.hoje) : new Date().toISOString().slice(0, 10);
  const kHoje = diaDe(hoje);
  L.push(`Hoje: ${hoje} (${kHoje ? DIA_LABEL[kHoje] : ''}). Hora local: ${linha(d?.hora, 5) || '?'}.`);
  // plano completo
  const plano = d?.plano && typeof d.plano === 'object' ? d.plano : {};
  const pl = Object.keys(plano).filter((k) => /^[A-H]$/.test(k)).sort().slice(0, 8).map((k) => {
    const t = plano[k] || {};
    const ex = arr(t.ex).slice(0, 14).map((x: any) => `    - ${linha(x?.n, 60)}: ${Number(x?.s) || '?'} × ${linha(x?.p, 20) || '?'}${x?.ty === 'time' ? ' (tempo)' : x?.ty === 'reps' ? ' (sem carga)' : ''}`).join('\n');
    return `  ${k} · ${linha(t.t, 60)}${CAT[t.cat] ? ` (${CAT[t.cat]})` : ''}${t.ultimo ? ` · último: ${linha(t.ultimo, 10)}` : ' · nunca feito'}\n${ex}`;
  });
  L.push(`\n=== PLANO DE TREINO ===\n${pl.join('\n') || '(sem plano)'}`);
  // cronograma
  const sc = d?.cronograma && typeof d.cronograma === 'object' ? d.cronograma : null;
  if (sc) L.push(`\n=== CRONOGRAMA (padrão da semana; o que vale é o marcado no dia) ===\n${DIAS.map((k) => { const x = sc[k] || {}; return `  - ${DIA_LABEL[k]}: ${x.musc ? 'treino ' + linha(x.musc, 3) : 'sem musculação'}${x.nota ? ' (' + linha(x.nota, 60) + ')' : ''}`; }).join('\n')}`);
  // sugestão do app e o dia
  const sug = d?.sugestao || {};
  L.push(`\n=== HOJE NO APP ===\nMarcado em "Planejar hoje": ${fmtPlan(d?.planejado_hoje)}\nAmanhã: ${fmtPlan(d?.planejado_amanha)}\nSugestão do app: ${sug.letra ? 'treino ' + linha(sug.letra, 3) : 'sem musculação'}${sug.motivo ? ' — ' + linha(sug.motivo, 300) : ''}\nTreino de hoje: ${linha(d?.treino_hoje, 200) || 'ainda não registrado'}\nTreino em andamento: ${linha(d?.em_andamento, 200) || 'nenhum'}`);
  // semana
  if (d?.semana) {
    const sm = d.semana;
    const gr = sm.grupos && typeof sm.grupos === 'object' ? Object.entries(sm.grupos).slice(0, 12).map(([g, v]: any) => `${linha(g, 15)} ${Number(v?.feito) || 0}/${Number(v?.meta) || 0}`).join(', ') : '';
    L.push(`\n=== SEMANA ===\nTreinos de musculação: ${Number(sm.feitos) || 0} de ${Number(sm.meta) || 0}.${gr ? `\nGrupos trabalhados/meta: ${gr}.` : ''}`);
  }
  // recordes
  const rec = arr(d?.recordes).slice(0, 20).map((r: any) => `  - ${linha(r?.exercicio, 60)}: melhor ${linha(r?.melhor, 30)}${r?.e1rm ? ` · 1RM estimado ${Number(r.e1rm)} kg` : ''}${r?.data ? ` (${linha(r.data, 10)})` : ''}`);
  if (rec.length) L.push(`\n=== RECORDES POR EXERCÍCIO ===\n${rec.join('\n')}`);
  // histórico
  const hist = arr(d?.historico).slice(0, 20).map((e: any) => {
    if (e?.tipo === 'musc') return `${linha(e.data, 10)} · TREINO ${linha(e.dia, 3)}${e.titulo ? ' (' + linha(e.titulo, 50) + ')' : ''}\n${arr(e.exercicios).slice(0, 14).map((x: any) => `    - ${linha(x?.nome, 60)}: ${linha(x?.series, 90)}`).join('\n')}`;
    if (e?.tipo === 'extra') return `${linha(e.data, 10)} · ${linha(e.atividade, 30) || 'atividade'}${e.duracao ? ' ' + Number(e.duracao) + ' min' : ''}${e.nota ? ': ' + linha(e.nota, 80) : ''}`;
    if (e?.tipo === 'skip') return `${linha(e.data, 10)} · descanso${e.motivo ? ': ' + linha(e.motivo, 60) : ''}`;
    return '';
  }).filter(Boolean);
  L.push(`\n=== HISTÓRICO RECENTE (mais novo primeiro) ===\n${hist.join('\n') || '(sem registros)'}`);
  // alimentação
  const di = d?.dieta || {};
  const alvo = di.alvo || {};
  L.push(`\n=== ALIMENTAÇÃO ===\nTipo do dia: ${linha(di.tipo_dia, 30) || '?'}${di.alvo_dia ? ' → ' + linha(di.alvo_dia, 120) : ''}\nAlvo base: ${linha(alvo.kcal, 15) || '?'} kcal · P ${linha(alvo.prot, 12) || '?'} · C ${linha(alvo.carb, 12) || '?'} · G ${linha(alvo.gord, 12) || '?'}\nRefeições do plano:\n${arr(di.refs).slice(0, 12).map((r: any) => `  - ${linha(r?.nome, 40)}${r?.feita ? ' [feita hoje]' : ''}: ${linha(String(r?.itens || '').replace(/\n/g, '; '), 400)}`).join('\n') || '  (nenhuma)'}${di.nota ? `\nObservações do plano: ${linha(di.nota, 600)}` : ''}\nÁgua hoje: ${linha(di.agua, 20) || '?'}`);
  const log = arr(di.diario).slice(0, 20).map((l: any) => `  - ${linha(l?.data, 10)} ${linha(l?.hora, 5)} ${linha(l?.refeicao, 30)}: ${linha(l?.texto, 200)}`);
  if (log.length) L.push(`Diário recente:\n${log.join('\n')}`);
  return L.join('\n');
}

async function conversa(body: any, auth: any) {
  const nome = nomeDe(body, auth);
  const esporte = linha(body?.esporte, 40);
  const letras = Object.keys(body?.dados?.plano || {}).filter((k) => /^[A-H]$/.test(k));
  const hist = arr(body?.mensagens).slice(-14).map((m: any) => ({ role: m?.papel === 'coach' ? 'assistant' : 'user', content: bloco(m?.texto, 2500) })).filter((m: any) => m.content);
  // a conversa começa e termina com o atleta; mensagens seguidas do mesmo lado viram uma
  const msgs: any[] = [];
  hist.forEach((m: any) => { const u = msgs[msgs.length - 1]; if (u && u.role === m.role) u.content += '\n\n' + m.content; else msgs.push({ ...m }); });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new ErroIA('Escreva uma pergunta para o coach.', 400);

  const system = `Você é o coach de treino e alimentação do app Pace, conversando por chat com ${nome}. Português do Brasil, tom de treinador experiente: direto, específico e prático, sem emojis.

${esporte ? `Atividade principal fora da musculação: ${esporte}.` : ''}
${contextoTxt(body)}
### COMO RESPONDER
- Responda exatamente o que foi perguntado, usando os dados abaixo (plano, histórico, cargas, recordes, alimentação). Cite números reais: cargas, repetições, datas, dias sem treinar.
- Para carga: baseie-se nas séries registradas. Se bateu o topo da faixa de repetições em todas as séries, sugira subir 2 a 5% (ou 1 a 2,5 kg); se não, manter e buscar mais repetições.
- Se a pergunta for sobre o que treinar: considere o que está marcado no dia (jiu, corrida, bike, jejum), o histórico e a recuperação. O cronograma é só o padrão. Jiu, corrida, futebol ou bike no dia: evite pernas pesadas. Se recomendar um treino do plano, preencha treino_letra (${letras.length ? letras.join(', ') : 'letras do plano'}).
- Se já treinou hoje, não proponha outra sessão de musculação.
- Jejum: siga só o que o atleta informou no contexto; não recomende jejum por conta própria.
- Você pode montar ajustes dentro do plano (trocar a ordem, tirar uma série, substituir um exercício por outro equivalente quando pedido), mas não reescreva a dieta prescrita nem indique suplemento ou medicamento novo.
- Com dor, lesão, tontura ou mal-estar: oriente parar e procurar um profissional. Você não substitui médico, nutricionista ou professor.
- Se faltar um dado para responder bem, diga qual e responda com o que dá.
- Tamanho: até 8 linhas curtas na maioria das respostas; listas com "- " quando ajudar. Sem títulos.
- sugestoes_rapidas: 2 ou 3 perguntas de continuação naturais, na voz do atleta.

### DADOS DO APP (atualizados agora)
${dadosConversaTxt(body?.dados || {}, nome)}`;

  const r = await chamarIA({ modelos: MODELOS_CONVERSA, system, mensagens: msgs, ferramenta: FERR_CONVERSA, max_tokens: 1500, tempo: TEMPO_RAPIDO_MS, temperatura: 0.4 });
  const p = r.dados || {};
  const resposta = bloco(p.resposta, 3000);
  if (!resposta) throw new ErroIA('O coach não respondeu. Tente de novo.');
  const L = linha(p.treino_letra, 2).toUpperCase();
  return {
    resposta,
    treino_letra: /^[A-H]$/.test(L) && letras.includes(L) ? L : null,
    sugestoes_rapidas: arr(p.sugestoes_rapidas).map((x: unknown) => linha(x, 60)).filter(Boolean).slice(0, 3),
    modelo: r.modelo,
  };
}

// ------------------------------------------------------------ entrada
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método não suportado.' }, 405);
  if (!ANTHROPIC_API_KEY || !SERVICE) return json({ ok: false, error: 'IA indisponível no momento.' }, 503);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Pedido inválido.' }, 400); }
  if (JSON.stringify(body).length > 200_000) return json({ ok: false, error: 'Conversa grande demais. Comece uma nova.' }, 413);
  const auth = await autorizar(body?.token);
  if (!auth?.ok) return json({ ok: false, error: auth?.erro || 'Acesso negado.', sessao: !!auth?.sessao }, auth?.sessao ? 401 : 429);
  try {
    const out = await conversa(body, auth);
    await registrarResultado(auth.uso, true);
    return json(out);
  } catch (e) {
    const err = e instanceof ErroIA ? e : new ErroIA('Erro inesperado na IA. Tente de novo.', 500);
    if (!(e instanceof ErroIA)) console.error('pace-conversa', e);
    await registrarResultado(auth.uso, false);
    return json({ ok: false, error: err.message }, err.status);
  }
});
