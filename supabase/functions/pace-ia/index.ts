// pace-ia: funções de IA do Pace (app de treino). Só atende quem tem sessão no app.
// O token da sessão (pace_entrar / pace_ativar) é conferido aqui com a service role (pace_ia_autorizar),
// por isso a função é publicada com verify_jwt = false. Cópia de referência: a versão publicada é a do Supabase.
//
// POST JSON { acao, token, ... }
//   importar: { tipo: 'treino' | 'dieta', texto?, arquivos?: [{ nome, mime, base64 }] }
//     treino → { ok, tipo, plano: { A: { t, cat, grupos, ex: [{ n, p, s, ty, d?, no?, ap }] } }, schedule | null, atividades, avisos }
//     dieta  → { ok, tipo, dieta: { alvo: { kcal, prot, carb, gord }, nota, refs: [{ nome, hora, itens, kcal }], extras: [{ nome }] },
//                agua | null, avisos }
//   coach:    payload do coach do app + perfil_nome, esporte, contexto, letras  → { recomendacao_treino, por_que, cargas_sugeridas,
//             dieta_hoje, alerta_recuperacao, motivacional }
//   dia:      payload do "por que este treino" + perfil_nome, esporte, esporte_chave, contexto, letras
//             → { treino_hoje, justificativa, proximos_3_dias, alerta }
//   refeicao: { refeicao, itens_atuais, perfil_nome, contexto } → { sugestoes: [{ nome, itens }] }
// Erro: { ok: false, error, sessao? }  (sessao = true: o app pede para entrar de novo)

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MODELOS_LEITURA = [Deno.env.get('PACE_IA_MODELO') || 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'];
const MODELOS_RAPIDOS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5'];
const MAX_ARQUIVOS = 6;
const MAX_B64_TOTAL = 12_000_000;          // ~9 MB somando os arquivos
const MAX_TEXTO = 30_000;
const TEMPO_LEITURA_MS = 115_000;
const TEMPO_RAPIDO_MS = 45_000;
const TIPOS_IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const GRUPOS = ['peito', 'costas', 'ombro', 'biceps', 'triceps', 'antebraco', 'perna_ant', 'perna_post', 'panturrilha', 'core', 'cardio'];
const ATIVS = ['corrida', 'jiu', 'futebol', 'bike', 'natacao', 'caminhada'];
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
// tira marcações que às vezes vazam na resposta do modelo (ex.: "</invoke>")
const semTags = (s: unknown) => String(s ?? '').replace(/<\/?[a-zA-Z_][\w:-]*(?:\s[^<>]*)?>/g, ' ');
const linha = (s: unknown, n: number) => { const t = semTags(s).replace(/\s+/g, ' ').trim(); return t ? t.slice(0, n) : ''; };
const bloco = (s: unknown, n: number) => {
  const t = semTags(s).replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, n);
};
// "Nenhum alerta." e parecidos contam como sem alerta
const alerta = (s: unknown, n: number) => { const t = bloco(s, n); return /^(nenhum|sem)\s+(alerta|aviso)|^n[aã]o h[aá]\s+(alerta|aviso)/i.test(t) ? '' : t; };
const numEntre = (x: unknown, min: number, max: number) => { const n = Number(String(x ?? '').replace(',', '.')); return isFinite(n) && n >= min && n <= max ? n : null; };
function hora(x: unknown) {
  const m = /^(\d{1,2})\s*(?:[:hH]\s*(\d{2})?)?\s*(?:min)?$/.exec(String(x ?? '').trim());
  if (!m) return '';
  const h = +m[1], mi = m[2] ? +m[2] : 0;
  return h <= 23 && mi <= 59 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : '';
}

// ------------------------------------------------------------ acesso
async function autorizar(token: unknown, tipo: string): Promise<any> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,80}$/.test(token)) return { erro: 'Sua sessão terminou. Entre de novo no app.', sessao: true };
  const { data, error } = await admin.rpc('pace_ia_autorizar', { p_token: token, p_tipo: tipo });
  if (error || !data) return { erro: 'Não foi possível conferir o acesso. Tente de novo.' };
  return data;
}
async function registrarResultado(uso: unknown, ok: boolean) {
  if (uso == null) return;
  try { await admin.rpc('pace_ia_resultado', { p_uso: uso, p_ok: ok }); } catch { /* só registro de uso */ }
}

// ------------------------------------------------------------ IA
class ErroIA extends Error { constructor(msg: string, public status = 502) { super(msg); } }
async function chamarIA(o: { modelos: string[]; system: string; conteudo: unknown; ferramenta: any; max_tokens: number; tempo: number }) {
  let ultimo = '';
  const inicio = Date.now();
  for (const modelo of o.modelos) {
    const resta = o.tempo - (Date.now() - inicio);
    if (resta < 15_000) break;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), resta);
    let r: Response;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelo, max_tokens: o.max_tokens, temperature: 0.2, system: o.system, tools: [o.ferramenta],
          tool_choice: { type: 'tool', name: o.ferramenta.name }, messages: [{ role: 'user', content: o.conteudo }],
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === 'AbortError') throw new ErroIA('A IA demorou demais para responder. Tente de novo; se for arquivo, envie menos páginas.', 504);
      ultimo = 'Falha de rede ao chamar a IA.'; continue;
    }
    clearTimeout(timer);
    const txt = await r.text();
    if (!r.ok) {
      if (/credit balance/i.test(txt)) throw new ErroIA('IA sem créditos no momento. Tente mais tarde.', 503);
      if (r.status === 413 || /too large|exceeds/i.test(txt)) throw new ErroIA('Arquivo grande demais para a IA. Envie menos páginas ou uma imagem menor.', 413);
      ultimo = `A IA respondeu com erro (${r.status}).`;
      if ([400, 404, 429, 500, 502, 503, 529].includes(r.status)) continue;
      throw new ErroIA(ultimo);
    }
    let msg: any;
    try { msg = JSON.parse(txt); } catch { ultimo = 'Resposta inválida da IA.'; continue; }
    const uso = arr(msg.content).find((c: any) => c.type === 'tool_use' && c.name === o.ferramenta.name);
    if (!uso || !uso.input || typeof uso.input !== 'object') { ultimo = 'A IA não devolveu a resposta no formato esperado.'; continue; }
    if (msg.stop_reason === 'max_tokens') throw new ErroIA('O conteúdo é grande demais para uma leitura. Divida em partes (por exemplo, um treino por vez).', 422);
    return { modelo, dados: uso.input };
  }
  throw new ErroIA(ultimo || 'Falha na IA.');
}

// ------------------------------------------------------------ importar: treino
const SIS_TREINO = `Você transcreve planos de treino de musculação para o app Pace. O texto ou arquivo foi enviado pelo próprio usuário (ficha da academia, PDF do professor, print ou foto).
Transcreva só o que está escrito. Não crie exercícios, não mude séries, repetições ou cargas e não acrescente dicas.
Registre com a ferramenta registrar_treino.

TREINOS
- Cada divisão do plano vira um treino com uma letra (A, B, C...), na ordem do arquivo. Se o arquivo já usa letras, mantenha as letras. Se usa números, dias da semana ou nomes (ex.: "Segunda: peito"), use A, B, C na ordem e guarde o nome no título.
- titulo: nome curto do treino como está no arquivo (ex.: "Peito e tríceps"). Se não houver nome, descreva os grupos (ex.: "Costas e bíceps").
- categoria: "sup" (membros superiores), "inf" (membros inferiores) ou "full" (corpo inteiro ou misto).
- grupos: grupos musculares trabalhados, só destes valores: peito, costas, ombro, biceps, triceps, antebraco, perna_ant (quadríceps), perna_post (posterior de coxa e glúteo), panturrilha, core (abdômen e lombar), cardio.
- exercicios, na ordem do arquivo:
  - nome: como escrito; só expanda abreviações óbvias (ex.: "sup. inclinado" vira "Supino inclinado").
  - series: número de séries (inteiro). Se o arquivo não disser, use 3 e registre em avisos.
  - repeticoes: como escrito (ex.: "8-12", "10", "até a falha", "30 s"). Se não houver, deixe vazio.
  - tipo: "load" (carga e repetições), "time" (por tempo: prancha, isometria, "30 s") ou "reps" (só repetições, sem carga: flexão, abdominal sem peso).
  - descanso_seg: descanso em segundos se o arquivo disser (ex.: "1'30" = 90); senão null.
  - observacao: técnica, cadência, bi-set, drop-set ou carga indicada, como escrito; senão vazio.
- Bi-set ou tri-set: registre cada exercício separado e diga "bi-set com <outro exercício>" na observação.
- Aquecimento e alongamento só entram se estiverem listados como exercícios do treino.

CRONOGRAMA (opcional): se o arquivo disser em que dia da semana fazer cada treino, preencha cronograma com os 7 dias (seg, ter, qua, qui, sex, sab, dom): treino (letra, ou null no dia sem musculação), nota curta (como escrita, ou vazio) e atividades daquele dia que não são musculação (corrida, jiu, futebol, bike, natacao, caminhada). Se o arquivo não disser os dias, cronograma = null.

ATIVIDADES: liste em atividades as atividades físicas fora da musculação citadas no arquivo (corrida, jiu, futebol, bike, natacao, caminhada).

AVISOS: tudo o que não deu para ler ou ficou ambíguo (ex.: "Treino C: número de séries ilegível no 3º exercício"). Se o conteúdo não for um plano de treino, deixe treinos vazio e explique em avisos.`;

const FERR_TREINO = {
  name: 'registrar_treino',
  description: 'Registra o plano de treino transcrito do arquivo ou texto do usuário.',
  input_schema: {
    type: 'object',
    properties: {
      treinos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            letra: { type: 'string' },
            titulo: { type: 'string' },
            categoria: { type: 'string', enum: ['sup', 'inf', 'full'] },
            grupos: { type: 'array', items: { type: 'string', enum: GRUPOS } },
            exercicios: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  nome: { type: 'string' },
                  series: { type: ['integer', 'null'] },
                  repeticoes: { type: 'string' },
                  tipo: { type: 'string', enum: ['load', 'time', 'reps'] },
                  descanso_seg: { type: ['integer', 'null'] },
                  observacao: { type: 'string' },
                },
                required: ['nome', 'series', 'repeticoes', 'tipo'],
              },
            },
          },
          required: ['letra', 'titulo', 'categoria', 'grupos', 'exercicios'],
        },
      },
      cronograma: {
        type: ['object', 'null'],
        properties: Object.fromEntries(DIAS.map((k) => [k, {
          type: 'object',
          properties: {
            treino: { type: ['string', 'null'] },
            nota: { type: 'string' },
            atividades: { type: 'array', items: { type: 'string', enum: ATIVS } },
          },
        }])),
      },
      atividades: { type: 'array', items: { type: 'string', enum: ATIVS } },
      avisos: { type: 'array', items: { type: 'string' } },
    },
    required: ['treinos', 'avisos'],
  },
};

function montarTreino(d: any) {
  const avisos: string[] = arr(d.avisos).map((s) => linha(s, 300)).filter(Boolean);
  const LETRAS = 'ABCDEFGH'.split('');
  const usadas = new Set<string>();
  const mapa = new Map<string, string>();
  const plano: Record<string, any> = {};
  arr(d.treinos).slice(0, 8).forEach((t: any, i: number) => {
    const ex = arr(t?.exercicios).slice(0, 25).map((e: any) => {
      const n = linha(e?.nome, 80);
      if (!n) return null;
      let s = Math.round(Number(e?.series));
      if (!(s >= 1 && s <= 12)) { s = 3; avisos.push(`${n}: número de séries não informado; ficou 3.`); }
      const ty = ['load', 'time', 'reps'].includes(e?.tipo) ? e.tipo : 'load';
      const out: any = { n, p: linha(e?.repeticoes, 40), s, ty, ap: '' };
      const dsc = numEntre(e?.descanso_seg, 10, 600);
      if (dsc != null) out.d = Math.round(dsc);
      const no = linha(e?.observacao, 200);
      if (no) out.no = no;
      return out;
    }).filter(Boolean);
    const orig = String(t?.letra ?? '').trim().toUpperCase();
    if (!ex.length) { avisos.push(`Treino ${orig || i + 1}: nenhum exercício legível; ficou de fora.`); return; }
    let L = /^[A-H]$/.test(orig) && !usadas.has(orig) ? orig : (LETRAS.find((x) => !usadas.has(x)) || '');
    if (!L) return;
    usadas.add(L);
    if (orig) mapa.set(orig, L);
    const grupos = [...new Set(arr(t?.grupos).filter((g: unknown) => GRUPOS.includes(String(g))))];
    plano[L] = { t: linha(t?.titulo, 60) || `Treino ${L}`, cat: ['sup', 'inf', 'full'].includes(t?.categoria) ? t.categoria : 'full', grupos, ex };
  });
  const ordenado: Record<string, any> = {};
  Object.keys(plano).sort().forEach((k) => { ordenado[k] = plano[k]; });
  let schedule: Record<string, any> | null = null;
  if (d.cronograma && typeof d.cronograma === 'object') {
    const sc: Record<string, any> = {};
    let algum = false;
    DIAS.forEach((k) => {
      const x = d.cronograma[k] || {};
      const lt = String(x.treino ?? '').trim().toUpperCase();
      const L = mapa.get(lt) || (ordenado[lt] ? lt : null);
      const dia: any = { musc: L || null, nota: linha(x.nota, 60) };
      arr(x.atividades).forEach((a: unknown) => { if (ATIVS.includes(String(a))) dia[String(a)] = true; });
      if (L) algum = true;
      sc[k] = dia;
    });
    if (algum) schedule = sc;
  }
  const atividades = [...new Set(arr(d.atividades).map(String).filter((a) => ATIVS.includes(a)))];
  return { ok: true, tipo: 'treino', plano: ordenado, schedule, atividades, avisos: avisos.slice(0, 30) };
}

// ------------------------------------------------------------ importar: dieta
const SIS_DIETA = `Você transcreve planos alimentares (dietas) para o app Pace. O texto ou arquivo foi enviado pelo próprio usuário (plano do nutricionista, PDF, print ou foto).
Transcreva só o que está escrito. Não crie refeições, não troque alimentos, não mude quantidades e não calcule calorias ou macronutrientes que não estejam no arquivo.
Registre com a ferramenta registrar_dieta.

- refeicoes, na ordem do dia:
  - nome: como escrito (ex.: "Café da manhã", "Lanche da tarde").
  - hora: "HH:MM" se o arquivo disser; senão vazio.
  - itens: um alimento por linha, com a quantidade, como escrito. Quando a refeição tiver opções, escreva "OPÇÃO 1:", "OPÇÃO 2:" em linhas próprias, cada uma seguida dos seus itens, e separe as opções com uma linha em branco.
  - kcal: calorias da refeição se o arquivo informar; senão null.
- meta: calorias e macronutrientes do dia só se estiverem escritos (kcal, proteina_g, carboidrato_g, gordura_g); o que não estiver escrito fica null.
- itens_fixos: suplementos e hábitos diários listados à parte (ex.: "Creatina 5 g", "Ômega 3"), um por item.
- agua_litros: meta de água por dia, se escrita.
- observacoes: orientações gerais do plano, curtas e como escritas.
- avisos: o que não deu para ler ou ficou ambíguo. Se o conteúdo não for um plano alimentar, deixe refeicoes vazio e explique em avisos.`;

const FERR_DIETA = {
  name: 'registrar_dieta',
  description: 'Registra o plano alimentar transcrito do arquivo ou texto do usuário.',
  input_schema: {
    type: 'object',
    properties: {
      refeicoes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            hora: { type: 'string' },
            itens: { type: 'string' },
            kcal: { type: ['number', 'null'] },
          },
          required: ['nome', 'itens'],
        },
      },
      meta: {
        type: ['object', 'null'],
        properties: {
          kcal: { type: ['number', 'null'] },
          proteina_g: { type: ['number', 'null'] },
          carboidrato_g: { type: ['number', 'null'] },
          gordura_g: { type: ['number', 'null'] },
        },
      },
      itens_fixos: { type: 'array', items: { type: 'string' } },
      agua_litros: { type: ['number', 'null'] },
      observacoes: { type: 'string' },
      avisos: { type: 'array', items: { type: 'string' } },
    },
    required: ['refeicoes', 'avisos'],
  },
};

function montarDieta(d: any) {
  const avisos: string[] = arr(d.avisos).map((s) => linha(s, 300)).filter(Boolean);
  const refs = arr(d.refeicoes).slice(0, 12).map((r: any) => {
    const nome = linha(r?.nome, 50), itens = bloco(r?.itens, 4000);
    if (!nome && !itens) return null;
    const kc = numEntre(r?.kcal, 1, 4000);
    return { nome: nome || 'Refeição', hora: hora(r?.hora), itens, kcal: kc == null ? null : Math.round(kc) };
  }).filter(Boolean);
  const m = d.meta && typeof d.meta === 'object' ? d.meta : {};
  const kcal = numEntre(m.kcal, 500, 10000), pr = numEntre(m.proteina_g, 1, 600), cb = numEntre(m.carboidrato_g, 1, 1500), gd = numEntre(m.gordura_g, 1, 500);
  const alvo = {
    kcal: kcal == null ? '' : String(Math.round(kcal)),
    prot: pr == null ? '' : `${Math.round(pr)} g`,
    carb: cb == null ? '' : `${Math.round(cb)} g`,
    gord: gd == null ? '' : `${Math.round(gd)} g`,
  };
  const extras = arr(d.itens_fixos).slice(0, 15).map((s) => linha(s, 120)).filter(Boolean).map((nome) => ({ nome }));
  const agua = numEntre(d.agua_litros, 0.5, 8);
  return { ok: true, tipo: 'dieta', dieta: { alvo, nota: bloco(d.observacoes, 1500), refs, extras }, agua: agua == null ? null : Math.round(agua * 10) / 10, avisos: avisos.slice(0, 30) };
}

async function importar(body: any) {
  const tipo = body?.tipo === 'dieta' ? 'dieta' : body?.tipo === 'treino' ? 'treino' : '';
  if (!tipo) throw new ErroIA('Informe se é treino ou dieta.', 400);
  const texto = bloco(body?.texto, MAX_TEXTO);
  const arquivos = arr(body?.arquivos);
  if (!texto && !arquivos.length) throw new ErroIA('Envie um arquivo ou cole o texto.', 400);
  if (arquivos.length > MAX_ARQUIVOS) throw new ErroIA(`Envie no máximo ${MAX_ARQUIVOS} arquivos por vez.`, 400);
  let total = 0;
  const conteudo: unknown[] = [];
  for (const a of arquivos) {
    const mime = String(a?.mime || '').toLowerCase(), b64 = typeof a?.base64 === 'string' ? a.base64 : '';
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64.slice(0, 200))) throw new ErroIA('Arquivo inválido.', 400);
    total += b64.length;
    if (total > MAX_B64_TOTAL) throw new ErroIA('Arquivos grandes demais. O limite é de cerca de 9 MB somando tudo.', 413);
    if (mime === 'application/pdf') conteudo.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
    else if (TIPOS_IMG.includes(mime)) conteudo.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
    else throw new ErroIA('Formato não aceito. Envie PDF, foto (JPG, PNG) ou cole o texto.', 400);
  }
  conteudo.push({ type: 'text', text: (texto ? `Texto enviado pelo usuário:\n"""\n${texto}\n"""\n\n` : '') + (tipo === 'treino' ? 'Registre o plano de treino.' : 'Registre o plano alimentar.') });
  const r = await chamarIA({
    modelos: MODELOS_LEITURA, system: tipo === 'treino' ? SIS_TREINO : SIS_DIETA, conteudo,
    ferramenta: tipo === 'treino' ? FERR_TREINO : FERR_DIETA, max_tokens: 12000, tempo: TEMPO_LEITURA_MS,
  });
  const out: any = tipo === 'treino' ? montarTreino(r.dados) : montarDieta(r.dados);
  const vazio = tipo === 'treino' ? !Object.keys(out.plano).length : !out.dieta.refs.length;
  if (vazio) return { ok: false, error: (out.avisos[0] || (tipo === 'treino' ? 'Não encontrei um plano de treino no que foi enviado.' : 'Não encontrei um plano alimentar no que foi enviado.')), avisos: out.avisos };
  out.modelo = r.modelo;
  return out;
}

// ------------------------------------------------------------ partes comuns do coach
const DIA_LABEL: Record<string, string> = { seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta', sex: 'sexta', sab: 'sábado', dom: 'domingo' };
const DIA_ORDEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const diaDe = (iso: string, mais = 0) => { const d = new Date(iso + 'T12:00:00'); if (isNaN(d.getTime())) return null; d.setDate(d.getDate() + mais); return DIA_ORDEM[d.getDay()]; };
const CAT: Record<string, string> = { sup: 'superiores', inf: 'inferiores', full: 'corpo inteiro' };
function letrasTxt(b: any) {
  const l = arr(b?.letras).slice(0, 8).map((x: any) => {
    const L = linha(x?.letra, 2).toUpperCase();
    if (!/^[A-H]$/.test(L)) return '';
    const g = arr(x?.grupos).filter((y: unknown) => GRUPOS.includes(String(y))).join(', ');
    return `${L} · ${linha(x?.nome, 60)}${CAT[x?.cat] ? ` (${CAT[x.cat]})` : ''}${g ? ` [${g}]` : ''}`;
  }).filter(Boolean);
  return l.length ? `Treinos do plano: ${l.join('; ')}.` : 'Treinos do plano: não informados.';
}
const contextoTxt = (b: any, n = 2500) => { const c = bloco(b?.contexto, n); return c ? `\n### CONTEXTO INFORMADO PELO ATLETA (vale sobre as regras gerais)\n${c}\n` : ''; };
const nomeDe = (b: any, auth: any) => linha(b?.perfil_nome, 40) || linha(String(auth?.nome || '').split(' ')[0], 40) || 'atleta';
function fmtPlan(p: any) {
  if (!p || typeof p !== 'object') return '(nenhum)';
  const parts: string[] = [];
  if (p.musc !== undefined) parts.push(p.musc === null ? 'musc=DESCANSO' : 'musc=' + linha(p.musc, 3));
  ['jiu', 'corrida', 'futebol', 'bike', 'natacao', 'caminhada', 'jejum'].forEach((k) => { if (p[k]) parts.push(k); });
  return parts.length ? parts.join(' · ') : '(nenhum)';
}

// ------------------------------------------------------------ coach
const FERR_COACH = {
  name: 'registrar_analise',
  description: 'Registra a análise do coach para o dia.',
  input_schema: {
    type: 'object',
    properties: {
      recomendacao_treino: { type: 'string' },
      por_que: { type: 'string' },
      cargas_sugeridas: { type: 'array', items: { type: 'object', properties: { exercicio: { type: 'string' }, sugestao: { type: 'string' } }, required: ['exercicio', 'sugestao'] } },
      dieta_hoje: { type: 'string' },
      alerta_recuperacao: { type: 'string' },
      motivacional: { type: 'string' },
    },
    required: ['recomendacao_treino', 'por_que', 'cargas_sugeridas', 'dieta_hoje', 'alerta_recuperacao', 'motivacional'],
  },
};

async function coach(body: any, auth: any) {
  const nome = nomeDe(body, auth);
  const esporte = linha(body?.esporte, 40);
  const hoje = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.hoje)) ? String(body.hoje) : new Date().toISOString().slice(0, 10);
  const planoDia = body?.plano_dia_sugerido || {};
  const historico = arr(body?.historico_recente).slice(0, 25);
  const dieta = body?.dieta_atual || {};
  const dietaLog = arr(body?.dieta_log).slice(0, 40);
  const checks = body?.checks && typeof body.checks === 'object' ? body.checks : {};
  const schedule = body?.schedule && typeof body.schedule === 'object' ? body.schedule : null;
  const diasTipo = body?.dias_tipo && typeof body.dias_tipo === 'object' ? body.dias_tipo : null;
  const alvosDia = body?.alvos_dia && typeof body.alvos_dia === 'object' ? body.alvos_dia : null;
  const planHoje = body?.planejado_hoje || {}, planAmanha = body?.planejado_amanha || {}, planSemana = body?.planejado_semana || {};
  const kHoje = diaDe(hoje), kAmanha = diaDe(hoje, 1);
  const labHoje = kHoje ? DIA_LABEL[kHoje] : hoje, labAmanha = kAmanha ? DIA_LABEL[kAmanha] : '';
  const muscHojeSched = (schedule && kHoje && schedule[kHoje] && schedule[kHoje].musc) || null;

  const descDia = (s: any) => `${s.musc ? 'Treino ' + linha(s.musc, 3) : 'sem musculação'}${s.jiu ? ' + jiu' : ''}${s.corrida ? ' + corrida' : ''}${s.nota ? ' (' + linha(s.nota, 60) + ')' : ''}`;
  const schedTxt = schedule ? DIAS.map((k) => `  - ${DIA_LABEL[k]}: ${descDia(schedule[k] || {})}`).join('\n') : '(sem cronograma semanal)';

  const treinoHoje = historico.find((e: any) => e && e.data === hoje && e.tipo === 'musc');
  const exTxt = (e: any) => arr(e.exercicios).slice(0, 15).map((x: any) => `  - ${linha(x.nome, 60)}: ${linha(x.series, 80) || '(sem dados)'}`).join('\n');
  const treinoHojeTxt = treinoHoje
    ? `SIM. ${nome} já treinou hoje (${hoje}, ${labHoje}): treino ${linha(treinoHoje.dia, 3) || '?'}${treinoHoje.titulo ? ' - ' + linha(treinoHoje.titulo, 60) : ''}. Séries:\n${exTxt(treinoHoje)}`
    : `NÃO. ${nome} ainda não fez musculação hoje (${hoje}, ${labHoje}).`;
  const histTxt = historico.slice(0, 20).map((e: any) => {
    const flag = e.data === hoje ? ' (hoje)' : '';
    if (e.tipo === 'musc') return `${e.data}${flag} · TREINO ${linha(e.dia, 3) || '?'}${e.titulo ? ' (' + linha(e.titulo, 60) + ')' : ''}\n${exTxt(e) || '  (sem séries registradas)'}`;
    if (e.tipo === 'extra') return `${e.data}${flag} · EXTRA ${linha(e.atividade, 30) || '?'}${e.duracao ? ' ' + Number(e.duracao) + ' min' : ''}${e.nota ? ': ' + linha(e.nota, 100) : ''}`;
    if (e.tipo === 'skip') return `${e.data}${flag} · DESCANSO${e.motivo ? ': ' + linha(e.motivo, 80) : ''}`;
    return `${e.data}${flag} · ${linha(e.tipo, 20)}`;
  }).join('\n');

  const semanaKeys = Object.keys(planSemana).sort().slice(0, 10);
  const semanaTxt = semanaKeys.length ? semanaKeys.map((k) => `  - ${linha(k, 20)}: ${fmtPlan(planSemana[k])}`).join('\n') : '(nenhum planejamento na semana)';
  let intensas = 0;
  semanaKeys.forEach((k) => { const p = planSemana[k] || {}; ['jiu', 'corrida', 'futebol', 'musc'].forEach((x) => { if (p[x]) intensas++; }); });

  let tipoDia: string | null = null;
  if (planHoje.jejum) tipoDia = planHoje.jiu && alvosDia && alvosDia.jejum_jiu ? 'jejum_jiu' : 'jejum';
  else if (diasTipo && kHoje && diasTipo[kHoje]) tipoDia = linha(diasTipo[kHoje], 20);
  let alvosTxt = '(sem tipo de dia definido)';
  if (tipoDia) {
    const a = alvosDia && alvosDia[tipoDia];
    alvosTxt = a ? `Tipo de dia hoje: ${tipoDia} → alvo ${linha(a.kcal, 10)} kcal · ${linha(a.prot, 10)} g prot · ${linha(a.carb, 10)} g carb · ${linha(a.gord, 10)} g gord.` : `Tipo de dia hoje: ${tipoDia}.`;
  }
  const alvo = dieta.alvo || {};
  const dietaTxt = `Alvo base: ${linha(alvo.kcal, 15) || '?'} kcal · P ${linha(alvo.prot, 12) || '?'} · C ${linha(alvo.carb, 12) || '?'} · G ${linha(alvo.gord, 12) || '?'}\nRefeições planejadas:\n` +
    (arr(dieta.refs).slice(0, 12).map((r: any) => `- ${linha(r.nome, 40)}: ${linha(String(r.itens || '(vazio)').replace(/\n/g, '; '), 600)}`).join('\n') || '(nenhuma)') +
    `\nItens fixos:\n${arr(dieta.extras).slice(0, 15).map((x: any) => `- ${linha(x.nome, 120)}`).join('\n') || '(nenhum)'}` + (dieta.nota ? `\nObservações: ${linha(dieta.nota, 800)}` : '');
  const grupos: Record<string, string[]> = {};
  dietaLog.forEach((l: any) => { const d = linha(l.data, 10); (grupos[d] = grupos[d] || []).push(`  - ${linha(l.hora, 5)} ${linha(l.refeicao, 40)}: ${linha(l.texto, 300)}`); });
  const logTxt = Object.keys(grupos).sort().reverse().map((d) => `${d}:\n${grupos[d].join('\n')}`).join('\n') || '(sem registros nos últimos 14 dias)';
  const planoTxt = `Treino sugerido pelo app: ${linha(planoDia.id, 3) || '?'} - ${linha(planoDia.nome || planoDia.t, 60) || '?'}\n` +
    arr(planoDia.ex).slice(0, 15).map((x: any) => `  - ${linha(x.n, 60)} (${linha(x.p, 30)}, ${Number(x.s) || '?'} séries)`).join('\n');
  const ok = Object.values(checks).filter((v) => v === 'ok').length, nao = Object.values(checks).filter((v) => v === 'no').length;
  const jejumTxt = planHoje.jejum ? `\n=== JEJUM PLANEJADO HOJE ===\n${planHoje.jiu ? 'Com jiu no mesmo dia.' : 'Sem jiu no dia.'}${muscHojeSched && planHoje.musc !== null ? ` Atenção: há musculação no cronograma de hoje (${linha(muscHojeSched, 3)}).` : ''}` : '';

  const system = `Você é o coach de treino e alimentação do app Pace e está falando com ${nome}. Responda em português do Brasil, direto e curto, sem emojis.

### PLANO
${letrasTxt(body)}
${esporte ? `Atividade principal fora da musculação: ${esporte}.` : 'Atividade principal fora da musculação: não informada.'}
${contextoTxt(body)}
### CRONOGRAMA É SUGESTÃO
O cronograma semanal serve para planejar o padrão. Quando ${nome} marca atividades no dia (jiu, corrida, futebol, bike, jejum), adapte-se a elas.

### REGRAS GERAIS
1. Com jiu, corrida ou futebol planejado hoje: se o treino sugerido for de membros inferiores, sugira trocar por um treino de superiores do plano e explique; se for de superiores, mantenha com RIR 2-3, sem falha e sem volume alto. Na alimentação, mais carboidrato antes e depois da atividade e reforço de hidratação.
2. Com jiu ou corrida planejado amanhã: oriente o dia de hoje como preparação (hidratação, sono, evitar volume alto).
3. Com 5 ou mais atividades intensas planejadas na semana: sinalize o risco de excesso em alerta_recuperacao.
4. Se ${nome} já treinou hoje: nunca sugira nova sessão; comente o desempenho, oriente as próximas refeições e prepare o dia seguinte.
5. Jejum: siga só o que estiver no contexto do atleta. Não recomende jejum por conta própria. Com jejum e musculação no mesmo dia, avise em alerta_recuperacao.

### LIMITES
Você não substitui médico, nutricionista ou professor de educação física. Não faça diagnóstico, não indique medicamento nem suplemento novo e não troque a dieta prescrita; sugira ajustes de rotina dentro do plano. Com dor, lesão ou mal-estar, oriente procurar um profissional.

### RESPOSTA
Registre com a ferramenta registrar_analise. Cada campo de texto com 2 a 4 linhas curtas.
- recomendacao_treino: letra do plano + nome curto, ou "Descanso", "Recuperação" ou "Jejum, sem musculação".
- por_que: 1ª linha, o que fazer agora; 2ª, por quê; 3ª, alerta ou dica prática.
- dieta_hoje: no máximo 3 linhas.
- alerta_recuperacao: só quando houver algo real; senão vazio.
- cargas_sugeridas: no máximo 5 itens; vazio se já treinou hoje ou se o dia é de descanso.
- motivacional: 1 frase curta e sóbria.`;

  const user = `Perfil: ${nome}\nHoje: ${hoje} (${labHoje})\n\n=== CRONOGRAMA SEMANAL ===\n${schedTxt}\n\n=== PLANEJAMENTO DO ATLETA ===\nHoje (${labHoje}): ${fmtPlan(planHoje)}\nAmanhã (${labAmanha}): ${fmtPlan(planAmanha)}\nSemana:\n${semanaTxt}\nAtividades intensas planejadas na semana: ${intensas}${jejumTxt}\n\n=== TREINO REGISTRADO HOJE ===\n${treinoHojeTxt}\n\n=== TIPO DE DIA (alimentação) ===\n${alvosTxt}\n\n=== SUGESTÃO DO APP ===\n${planoTxt}\n\n=== HISTÓRICO RECENTE ===\n${histTxt || '(sem histórico)'}\n\n=== DIETA PLANEJADA ===\n${dietaTxt}\n\n=== DIÁRIO DOS ÚLTIMOS 14 DIAS ===\n${logTxt}\n\nHoje: ${ok} refeições feitas, ${nao} não feitas.\n\nResponda considerando o planejamento acima antes do cronograma fixo.`;

  const r = await chamarIA({ modelos: MODELOS_RAPIDOS, system, conteudo: user, ferramenta: FERR_COACH, max_tokens: 1800, tempo: TEMPO_RAPIDO_MS });
  const p = r.dados || {};
  return {
    recomendacao_treino: linha(p.recomendacao_treino, 80),
    por_que: bloco(p.por_que, 900),
    cargas_sugeridas: arr(p.cargas_sugeridas).slice(0, 6).map((c: any) => ({ exercicio: linha(c?.exercicio, 80), sugestao: linha(c?.sugestao, 300) })).filter((c: any) => c.exercicio),
    dieta_hoje: bloco(p.dieta_hoje, 700),
    alerta_recuperacao: alerta(p.alerta_recuperacao, 600),
    motivacional: linha(p.motivacional, 200),
  };
}

// ------------------------------------------------------------ por que este treino (validação + próximos 3 dias)
const FERR_DIA = {
  name: 'registrar_sugestao',
  description: 'Registra a validação do treino de hoje e os próximos 3 dias.',
  input_schema: {
    type: 'object',
    properties: {
      treino_hoje: {
        type: 'object',
        properties: {
          letra: { type: 'string' }, nome: { type: 'string' },
          grupos_alvo: { type: 'array', items: { type: 'string' } },
          intensidade: { type: 'string', enum: ['leve', 'moderada', 'forte', 'descanso'] },
        },
        required: ['letra', 'nome', 'intensidade'],
      },
      justificativa: { type: 'string' },
      proximos_3_dias: { type: 'array', items: { type: 'object', properties: { data: { type: 'string' }, letra: { type: 'string' }, nome: { type: 'string' }, por_que: { type: 'string' } }, required: ['data', 'letra', 'nome', 'por_que'] } },
      alerta: { type: 'string' },
    },
    required: ['treino_hoje', 'justificativa', 'proximos_3_dias', 'alerta'],
  },
};

async function dia(body: any, auth: any) {
  const nome = nomeDe(body, auth);
  const esporte = linha(body?.esporte, 40);
  const chave = linha(body?.esporte_chave, 20).toLowerCase();
  const hoje = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.hoje)) ? String(body.hoje) : new Date().toISOString().slice(0, 10);
  const ultimos = arr(body?.ultimos_14_dias).slice(0, 40);
  const meta = body?.meta_semanal && typeof body.meta_semanal === 'object' ? body.meta_semanal : {};
  const candidato = body?.candidato_regras && typeof body.candidato_regras === 'object' ? body.candidato_regras : {};
  const fadiga = body?.fadiga_atual && typeof body.fadiga_atual === 'object' ? body.fadiga_atual : {};
  const desde = body?.dias_desde && typeof body.dias_desde === 'object' ? body.dias_desde : {};
  const hojeD = new Date(hoje + 'T12:00:00').getTime();
  const jiuDias = ultimos.filter((e: any) => e && e.tipo === 'extra' && /^jiu/.test(String(e.atividade || '').toLowerCase()) && e.data)
    .map((e: any) => Math.max(0, Math.floor((hojeD - new Date(e.data + 'T12:00:00').getTime()) / 86400000)));
  const temJiu = chave === 'jiu' || jiuDias.length > 0;
  const jiu24 = jiuDias.some((d: number) => d <= 1), jiu48 = jiuDias.some((d: number) => d <= 2), jiu72x2 = jiuDias.filter((d: number) => d <= 3).length >= 2;

  const histTxt = ultimos.length ? ultimos.slice(0, 20).map((e: any) => {
    const g = arr(e.grupos).map((x: unknown) => linha(x, 15)).join('+');
    return `  ${linha(e.data, 10)} · ${linha(e.tipo, 10)}${e.atividade ? ' (' + linha(e.atividade, 20) + ')' : ''}${g ? ' [' + g + ']' : ''}${e.duracao_min ? ' ' + Number(e.duracao_min) + ' min' : ''}${e.dia_musc ? ' treino ' + linha(e.dia_musc, 3) : ''}`;
  }).join('\n') : '  (sem histórico)';
  const kv = (o: any, f: (v: any) => string) => Object.entries(o).slice(0, 20).map(([k, v]) => `  ${linha(k, 15)}: ${f(v)}`).join('\n') || '  (não informado)';
  const letras = arr(body?.letras).map((x: any) => linha(x?.letra, 2).toUpperCase()).filter((L: string) => /^[A-H]$/.test(L));

  const jiuBloco = temJiu ? `
PÓS-JIU (consciência, não bloqueio):
- Com jiu nas últimas 24 h e sugestão de membros inferiores (perna_ant, perna_post, panturrilha) ou core, a justificativa começa reconhecendo o jiu recente e propõe volume ou intensidade menor (uma série a menos, carga mais leve, acessório no lugar do composto pesado).
- Com jiu 2 vezes nas últimas 72 h, mais cautela com membros inferiores; superiores ou descanso podem ser melhores, sem proibição.
- Se o candidato vier com avisoJiu = true, a intensidade é "leve" e a justificativa cita o jiu.
Sinais de jiu recente:
${[jiu24 ? '  - jiu nas últimas 24 h' : '', jiu48 ? '  - jiu nas últimas 48 h' : '', jiu72x2 ? '  - jiu 2 vezes nas últimas 72 h' : ''].filter(Boolean).join('\n') || '  (sem jiu recente)'}
` : '';

  const system = `Você é o coach de treino do app Pace e está falando com ${nome}. Valide a sugestão de treino calculada pelo app e sugira os próximos 3 dias. Português do Brasil, curto, sem emojis.

PLANO
${letrasTxt(body)}
${esporte ? `Atividade principal fora da musculação: ${esporte}.` : ''}
Grupos: peito, costas, perna_ant, perna_post, panturrilha, ombro, biceps, triceps, core, cardio, antebraco.
Objetivo geral: evitar excesso e respeitar 48 h entre grupos grandes, com bom senso; prefira orientar a bloquear.
${contextoTxt(body, 1500)}
COMO DECIDIR (guia, não regra rígida)
- Use a fadiga acumulada, os dias desde o último estímulo e a meta semanal para escolher o melhor treino de hoje entre os treinos do plano.
- Se o candidato do app faz sentido, mantenha; se estiver claramente errado, troque.
- Se todos os grupos disponíveis estiverem muito cansados, sugira DESCANSO ou treino bem leve.
- letra: só ${letras.length ? letras.join(', ') : 'as letras do plano'} ou DESCANSO.
${jiuBloco}
Você não substitui professor de educação física nem médico; com dor ou lesão, oriente procurar um profissional.
Registre com a ferramenta registrar_sugestao: justificativa em 2 ou 3 linhas; próximos 3 dias com data (AAAA-MM-DD), letra, nome e 1 linha de porquê; alerta só se houver algo real.`;

  const user = `Perfil: ${nome}\nHoje: ${hoje}\n\n=== HISTÓRICO 14 DIAS ===\n${histTxt}\n\n=== FADIGA POR GRUPO ===\n${kv(fadiga, (v) => Number(v).toFixed(2))}\n\n=== DIAS DESDE O ÚLTIMO ESTÍMULO ===\n${kv(desde, (v) => `${Number(v)} dias`)}\n\n=== META SEMANAL ===\n${kv(meta, (v) => `${Number(v)}x/semana`)}\n\n=== CANDIDATO DO APP ===\n${JSON.stringify(candidato).slice(0, 1500)}\n\nValide e responda.`;

  const r = await chamarIA({ modelos: MODELOS_RAPIDOS, system, conteudo: user, ferramenta: FERR_DIA, max_tokens: 1400, tempo: TEMPO_RAPIDO_MS });
  const p = r.dados || {};
  const th = p.treino_hoje || {};
  return {
    treino_hoje: { letra: linha(th.letra, 10), nome: linha(th.nome, 60), grupos_alvo: arr(th.grupos_alvo).map((g: unknown) => linha(g, 15)).slice(0, 8), intensidade: linha(th.intensidade, 12) },
    justificativa: bloco(p.justificativa, 700),
    proximos_3_dias: arr(p.proximos_3_dias).slice(0, 3).map((d: any) => ({ data: linha(d?.data, 10), letra: linha(d?.letra, 10), nome: linha(d?.nome, 60), por_que: linha(d?.por_que, 200) })),
    alerta: alerta(p.alerta, 400),
  };
}

// ------------------------------------------------------------ alternativas para uma refeição
const FERR_REF = {
  name: 'registrar_sugestoes',
  description: 'Registra 3 alternativas para a refeição.',
  input_schema: {
    type: 'object',
    properties: { sugestoes: { type: 'array', items: { type: 'object', properties: { nome: { type: 'string' }, itens: { type: 'string' } }, required: ['nome', 'itens'] } } },
    required: ['sugestoes'],
  },
};
async function refeicao(body: any, auth: any) {
  const nome = nomeDe(body, auth);
  const ref = linha(body?.refeicao, 60) || 'refeição';
  const itens = bloco(body?.itens_atuais, 3000) || '(sem itens definidos)';
  const ctx = bloco(body?.contexto, 600);
  const system = `Você sugere alternativas de refeição no app Pace. Português do Brasil, sem emojis.
Sugira refeições práticas, com alimentos comuns no Brasil, na mesma faixa de calorias e no mesmo estilo da refeição atual (café, almoço, lanche, jantar, ceia, pré ou pós-treino; deduza pelo nome).
Não sugira suplementos, medicamentos nem dietas restritivas. Respeite restrições visíveis na refeição atual (ex.: sem lactose, vegetariana).
Exatamente 3 sugestões. Em cada uma, itens tem de 3 a 6 linhas separadas por quebra de linha, cada linha um alimento com quantidade (ex.: "2 ovos mexidos", "100 g de aveia").${ctx ? `\nObjetivo e observações informados por ${nome}: ${ctx}` : ''}
Registre com a ferramenta registrar_sugestoes.`;
  const user = `Refeição: "${ref}"\nItens atuais:\n${itens}\n\nSugira 3 alternativas.`;
  const r = await chamarIA({ modelos: MODELOS_RAPIDOS, system, conteudo: user, ferramenta: FERR_REF, max_tokens: 1500, tempo: TEMPO_RAPIDO_MS });
  const sug = arr(r.dados?.sugestoes).slice(0, 5).map((s: any) => ({ nome: linha(s?.nome, 60) || 'Sugestão', itens: bloco(s?.itens, 800) })).filter((s: any) => s.itens);
  if (!sug.length) throw new ErroIA('A IA não devolveu sugestões. Tente de novo.');
  return { sugestoes: sug };
}

// ------------------------------------------------------------ entrada
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método não suportado.' }, 405);
  if (!ANTHROPIC_API_KEY || !SERVICE) return json({ ok: false, error: 'IA indisponível no momento.' }, 503);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Pedido inválido.' }, 400); }
  const acao = String(body?.acao || '');
  if (!['importar', 'coach', 'dia', 'refeicao'].includes(acao)) return json({ ok: false, error: 'Ação desconhecida.' }, 400);
  const auth = await autorizar(body?.token, acao);
  if (!auth?.ok) return json({ ok: false, error: auth?.erro || 'Acesso negado.', sessao: !!auth?.sessao }, auth?.sessao ? 401 : 429);
  try {
    let out: any;
    if (acao === 'importar') out = await importar(body);
    else if (acao === 'coach') out = await coach(body, auth);
    else if (acao === 'dia') out = await dia(body, auth);
    else out = await refeicao(body, auth);
    await registrarResultado(auth.uso, out?.ok !== false);
    return json(out, out?.ok === false ? 422 : 200);
  } catch (e) {
    const err = e instanceof ErroIA ? e : new ErroIA('Erro inesperado na IA. Tente de novo.', 500);
    if (!(e instanceof ErroIA)) console.error('pace-ia', acao, e);
    await registrarResultado(auth.uso, false);
    return json({ ok: false, error: err.message }, err.status);
  }
});
