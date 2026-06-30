/* ADM Refeitório Offline - MVP v5
   - Cadastro de colaboradores com geração de QR.
   - Inativar/Reativar colaborador.
   - Tela de leitura mais compacta.
   - Flash verde/vermelho em tela cheia + som mais forte.
   - Visual corporativo em cores ADM.
*/

let sb = null;
let currentUser = null;
let currentProfile = null;
let db = null;
let html5QrCode = null;
let scannerRunning = false;
let pendingQrToBind = null;
let lastQr = "";
let lastQrAt = 0;
let qrPreviewData = null;

const DB_NAME = "adm_refeitorio_offline_v5";
const DB_VERSION = 1;
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupSupabase();
  db = await openDb();
  bindUi();
  updateOnlineStatus();
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);

  const today = toISODate(new Date());
  if ($("dateFrom")) $("dateFrom").value = today;
  if ($("dateTo")) $("dateTo").value = today;

  const restored = await tryAutoRestore();
  await refreshPendingCount();
  await refreshLocalMetrics();

  if (!restored) $("loginView").classList.remove("hidden");
}

function setupSupabase() {
  if (!window.supabase || !SUPABASE_URL || SUPABASE_URL.includes("SEU-PROJETO")) {
    console.warn("Configure o config.js");
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }

function bindUi() {
  on("btnLogin", "click", login);
  on("btnLogout", "click", logout);
  on("btnSync", "click", syncAll);
  on("btnDownloadBase", "click", () => downloadBase(true));
  on("btnDownloadBaseTop", "click", () => downloadBase(true));
  on("btnLoadMeals", "click", renderMealsAdmin);
  on("btnSaveMeals", "click", saveMealsAdmin);
  on("btnStartCamera", "click", startCamera);
  on("btnStopCamera", "click", stopCamera);
  on("btnManualQr", "click", () => { const v = $("manualQr").value.trim(); if (v) processQr(v); $("manualQr").value = ""; });
  on("manualQr", "keydown", (e) => { if (e.key === "Enter") $("btnManualQr").click(); });
  on("btnBindMatricula", "click", bindQrWithMatricula);
  on("btnCancelBind", "click", cancelBind);
  on("btnGuestAdm", "click", () => openGuestDialog("convidado_adm"));
  on("btnTerceiro", "click", () => openGuestDialog("terceiro"));
  on("btnRegisterGuest", "click", registerGuest);
  on("btnExportLocal", "click", exportLocalCsv);
  on("btnExportSupabase", "click", exportSupabaseCsv);
  on("btnNovoColaborador", "click", openNewColabDialog);
  on("btnSaveColaborador", "click", saveColaborador);
  on("btnSearchColab", "click", renderColaboradoresList);
  on("btnRefreshColab", "click", async () => { $("colabSearch").value = ""; await renderColaboradoresList(); });
  on("colabSearch", "input", debounce(renderColaboradoresList, 220));
  on("btnPrintQr", "click", printQrPreview);
  on("btnCloseQrPreview", "click", hideQrPreview);

  document.querySelectorAll('.nav-item').forEach((btn)=>btn.addEventListener('click', ()=>activateTab(btn.dataset.tab)));
}

/* LOGIN */
async function login() {
  if (!sb) return showToast("Configure o Supabase no arquivo config.js.", "bad");
  if (!navigator.onLine) return showToast("Sem internet. Entre online uma vez primeiro.", "bad");
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  if (!email || !password) return showToast("Informe e-mail e senha.", "bad");

  setButtonLoading("btnLogin", true, "Entrando...");
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    await loadProfile();
    await saveAuthSnapshot();
    openApp();
    await downloadBase(false);
    await renderAll();
    showToast("Login realizado e salvo neste aparelho.", "ok");
  } catch (err) {
    showToast("Falha no login: " + cleanError(err.message), "bad");
  } finally {
    setButtonLoading("btnLogin", false, "Entrar");
  }
}

async function loadProfile() {
  const { data, error } = await sb.from('usuarios_app').select('*').eq('id', currentUser.id).single();
  if (error) throw new Error('Usuário não cadastrado em usuarios_app.');
  if (!data.ativo) throw new Error('Usuário inativo.');
  currentProfile = data;
}

async function saveAuthSnapshot() {
  if (!currentUser || !currentProfile) return;
  await idbPut('meta', { key:'auth_snapshot', user:{ id:currentUser.id, email: currentUser.email || currentProfile.email || null }, profile: currentProfile, saved_at:new Date().toISOString() });
}

async function tryAutoRestore() {
  const saved = await idbGet('meta', 'auth_snapshot');
  if (!saved?.user || !saved?.profile) return false;
  currentUser = saved.user;
  currentProfile = saved.profile;
  openApp();
  if ($("userInfo")) $("userInfo").textContent = `${currentProfile.nome} • ${currentProfile.perfil} • modo salvo`;
  await renderAll();
  if (navigator.onLine && sb) {
    try {
      const { data } = await sb.auth.getSession();
      if (data?.session?.user) {
        currentUser = data.session.user;
        await loadProfile();
        await saveAuthSnapshot();
        openApp();
        await downloadBase(false);
      }
    } catch (e) { console.warn('offline restore', e); }
  }
  showToast(navigator.onLine ? 'Sessão restaurada.' : 'Modo offline: sessão restaurada.', navigator.onLine ? 'ok' : 'warn');
  return true;
}

function openApp() {
  applyRoleLayout();
  $("loginView").classList.add('hidden');
  $("appView").classList.remove('hidden');
  if ($("userInfo")) $("userInfo").textContent = `${currentProfile.nome} • ${currentProfile.perfil}`;
  if ($("sideProfile")) $("sideProfile").textContent = currentProfile.perfil === 'admin' ? 'Administrador' : 'Leitura';
}

async function logout() {
  await stopCamera();
  await idbDelete('meta', 'auth_snapshot').catch(()=>{});
  if (sb && navigator.onLine) { try { await sb.auth.signOut(); } catch(_){} }
  currentUser = null; currentProfile = null;
  document.body.classList.remove('role-admin','role-refeitorio','role-consulta');
  $("appView").classList.add('hidden');
  $("loginView").classList.remove('hidden');
  neutralResult('Aguardando leitura', 'Passe o crachá do colaborador.');
  showToast('Sessão removida deste aparelho.', 'warn');
}

function applyRoleLayout() {
  document.body.classList.remove('role-admin','role-refeitorio','role-consulta');
  document.body.classList.add(`role-${currentProfile.perfil}`);
  if (currentProfile.perfil !== 'admin') activateTab('leitura');
}

/* IndexedDB */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('colaboradores')) { const s = d.createObjectStore('colaboradores', { keyPath:'id' }); s.createIndex('matricula','matricula',{unique:true}); s.createIndex('nome_completo','nome_completo',{unique:false}); }
      if (!d.objectStoreNames.contains('qr_vinculos')) { const s = d.createObjectStore('qr_vinculos', { keyPath:'qr_token' }); s.createIndex('matricula','matricula',{unique:false}); }
      if (!d.objectStoreNames.contains('refeicoes')) d.createObjectStore('refeicoes', { keyPath:'id' });
      if (!d.objectStoreNames.contains('registros')) { const s = d.createObjectStore('registros', { keyPath:'local_id' }); s.createIndex('data_refeicao','data_refeicao',{unique:false}); s.createIndex('matricula','matricula',{unique:false}); }
      if (!d.objectStoreNames.contains('pendentes')) d.createObjectStore('pendentes', { keyPath:'local_id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath:'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txStore(store, mode='readonly') { return db.transaction(store, mode).objectStore(store); }
function idbGet(store, key) { return new Promise((res, rej) => { const r = txStore(store).get(key); r.onsuccess=()=>res(r.result||null); r.onerror=()=>rej(r.error); }); }
function idbGetAll(store) { return new Promise((res, rej) => { const r = txStore(store).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }
function idbGetByIndex(store, indexName, value) { return new Promise((res, rej) => { const r = txStore(store).index(indexName).get(value); r.onsuccess=()=>res(r.result||null); r.onerror=()=>rej(r.error); }); }
function idbPut(store, value) { return new Promise((res, rej) => { const r = txStore(store,'readwrite').put(value); r.onsuccess=()=>res(value); r.onerror=()=>rej(r.error); }); }
function idbDelete(store, key) { return new Promise((res, rej) => { const r = txStore(store,'readwrite').delete(key); r.onsuccess=()=>res(true); r.onerror=()=>rej(r.error); }); }
function idbClear(store) { return new Promise((res, rej) => { const r = txStore(store,'readwrite').clear(); r.onsuccess=()=>res(true); r.onerror=()=>rej(r.error); }); }
async function replaceStore(store, rows){ await idbClear(store); for(const row of rows) await idbPut(store,row); }

/* Base e sync */
async function downloadBase(showMessage=true) {
  if (!sb || !navigator.onLine || !currentUser) { if (showMessage) showToast('Sem conexão. Usando base local.', 'warn'); return; }
  try {
    if (showMessage) showToast('Baixando base...', 'warn');
    const [colabs,qrs,meals] = await Promise.all([
      sb.from('colaboradores').select('*').limit(10000),
      sb.from('qr_vinculos').select('*').eq('ativo', true).limit(10000),
      sb.from('refeicoes').select('*').order('hora_inicio',{ascending:true}).limit(100)
    ]);
    if (colabs.error) throw colabs.error; if (qrs.error) throw qrs.error; if (meals.error) throw meals.error;
    await replaceStore('colaboradores', colabs.data||[]);
    await replaceStore('qr_vinculos', qrs.data||[]);
    await replaceStore('refeicoes', meals.data||[]);
    await renderAll();
    if (showMessage) showToast('Base baixada para uso offline.', 'ok');
  } catch (err) {
    showToast('Erro ao baixar base: ' + cleanError(err.message), 'bad');
  }
}

async function hasSupabaseSession() {
  if (!sb || !navigator.onLine) return false;
  try { const { data } = await sb.auth.getSession(); return !!data?.session?.user; } catch(_) { return false; }
}

async function syncAll() {
  if (!sb || !navigator.onLine || !currentUser) return showToast('Sem internet. Os registros continuam salvos localmente.', 'warn');
  if (!(await hasSupabaseSession())) return showToast('Sessão online expirada. Entre online novamente para sincronizar.', 'warn');
  const pendentes = await idbGetAll('pendentes');
  if (!pendentes.length) return showToast('Nada pendente para sincronizar.', 'ok');
  let ok=0, fail=0;
  for (const item of pendentes) {
    try {
      if (item.tipo === 'qr_vinculo') await syncQrVinculo(item.vinculo);
      else if (item.tipo === 'registro') await syncRegistro(item.registro);
      else if (item.tipo === 'colaborador_upsert') await syncColaboradorUpsert(item.colaborador);
      else if (item.tipo === 'colaborador_status') await syncColaboradorStatus(item.id, item.ativo_refeitorio);
      await idbDelete('pendentes', item.local_id); ok++;
    } catch (err) {
      console.warn('Falha ao sincronizar', item, err); fail++;
    }
  }
  await refreshPendingCount();
  await renderAll();
  if (!fail) { showToast(`Sincronização concluída: ${ok} item(ns).`, 'ok'); await downloadBase(false); }
  else showToast(`Sincronizou ${ok}, falhou ${fail}.`, 'warn');
}

async function refreshPendingCount() {
  const el = $('pendingStatus'); if (!el) return;
  const rows = await idbGetAll('pendentes'); el.textContent = `Pendentes: ${rows.length}`; el.className = rows.length ? 'pill warn' : 'pill ok';
}

/* Scanner */
async function startCamera() {
  try {
    if (!window.Html5Qrcode) return showToast('Biblioteca de QR não carregou.', 'bad');
    if (scannerRunning) return;
    html5QrCode = html5QrCode || new Html5Qrcode('reader', { verbose:false });
    const config = { fps: 10, qrbox: (w,h)=>{ const s = Math.floor(Math.min(w,h)*0.72); return { width:s, height:s }; }, aspectRatio:1.333, rememberLastUsedCamera:true, supportedScanTypes:[Html5QrcodeScanType.SCAN_TYPE_CAMERA] };
    await html5QrCode.start({ facingMode:'environment' }, config, async(decodedText)=>{
      const qr = String(decodedText||'').trim(); const now = Date.now(); if (!qr) return; if (qr===lastQr && now-lastQrAt<2500) return; lastQr=qr; lastQrAt=now; await processQr(qr);
    }, ()=>{});
    scannerRunning = true; showToast('Câmera aberta.', 'ok');
  } catch (err) { showToast('Não consegui abrir a câmera: ' + cleanError(err.message), 'bad'); }
}
async function stopCamera() { try { if (html5QrCode && scannerRunning) { await html5QrCode.stop(); await html5QrCode.clear(); } } catch(e){ console.warn(e); } finally { scannerRunning = false; } }

async function processQr(qrToken) {
  hideBindBox(); pendingQrToBind = null;
  const meal = await getCurrentMeal();
  if (!meal) { failResult('Fora de horário', 'Nenhuma refeição ativa agora.'); return; }
  const vinculo = await idbGet('qr_vinculos', qrToken);
  if (!vinculo || !vinculo.ativo) {
    pendingQrToBind = qrToken; warnResult('QR não vinculado', 'Digite a matrícula ADM.'); $('bindBox').classList.remove('hidden'); $('bindMatricula').focus(); playFail(); flashScreen('warn','QR NÃO VINCULADO','Informe a matrícula ADM'); return;
  }
  const colab = await idbGet('colaboradores', vinculo.colaborador_id);
  if (!colab) { failResult('Vínculo inválido', 'Colaborador não existe na base local.'); return; }
  await registerColaboradorMeal(colab, qrToken, meal);
}

async function bindQrWithMatricula() {
  const matricula = $('bindMatricula').value.trim();
  if (!pendingQrToBind) return showToast('Nenhum QR pendente.', 'bad');
  if (!matricula) return showToast('Informe a matrícula.', 'bad');
  const colab = await idbGetByIndex('colaboradores', 'matricula', matricula);
  if (!colab) return failResult('Matrícula não encontrada', 'Essa matrícula não está na base ADM.');
  if (!isColabLiberado(colab)) return failResult('Colaborador bloqueado', `${colab.nome_completo} está inativo para refeição.`);
  const qrs = await idbGetAll('qr_vinculos');
  const existing = qrs.find(q => q.matricula === matricula && q.ativo && q.qr_token !== pendingQrToBind);
  if (existing) return failResult('Matrícula já tem QR', 'Peça ao admin para trocar o QR.');
  const vinculo = { qr_token: pendingQrToBind, colaborador_id: colab.id, matricula: colab.matricula, ativo:true, vinculado_em:new Date().toISOString(), vinculado_por: currentUser?.id || null, observacao:'Vinculado no primeiro uso pelo app offline' };
  await idbPut('qr_vinculos', vinculo);
  if (await hasSupabaseSession()) { try { await syncQrVinculo(vinculo); } catch(_) { await addPendente('qr_vinculo', { vinculo }); } }
  else await addPendente('qr_vinculo', { vinculo });
  hideBindBox();
  const meal = await getCurrentMeal();
  await registerColaboradorMeal(colab, pendingQrToBind, meal);
  pendingQrToBind = null; $('bindMatricula').value=''; await refreshPendingCount(); await refreshLocalMetrics();
}
function cancelBind(){ pendingQrToBind = null; hideBindBox(); neutralResult('Aguardando leitura','Passe o crachá do colaborador.'); }
function hideBindBox(){ if ($('bindBox')) $('bindBox').classList.add('hidden'); }

/* Refeição e registro */
async function getCurrentMeal(now = new Date()) {
  const refeicoes = (await idbGetAll('refeicoes')).filter(r=>r.ativo);
  const nowMin = now.getHours()*60 + now.getMinutes();
  for (const meal of refeicoes) {
    const start = timeToMinutes(meal.hora_inicio), end = timeToMinutes(meal.hora_fim);
    let active = false, dataRef = toISODate(now);
    if (start <= end) active = nowMin >= start && nowMin <= end;
    else { active = nowMin >= start || nowMin <= end; if (active && nowMin <= end) { const d = new Date(now); d.setDate(d.getDate()-1); dataRef = toISODate(d); } }
    if (active) return { ...meal, data_refeicao:dataRef };
  }
  return null;
}
async function refreshCurrentMeal() {
  const meal = await getCurrentMeal();
  const el = $('currentMeal'), badge = $('mealBadge');
  if (!el) return;
  if (meal) {
    el.textContent = currentProfile?.perfil === 'admin' ? `Refeição atual: ${meal.nome} • R$ ${money(meal.custo)} • dia ${formatDateBR(meal.data_refeicao)}` : `Refeição atual: ${meal.nome}`;
    if (badge) badge.textContent = meal.nome;
  } else {
    el.textContent = 'Nenhuma refeição ativa agora';
    if (badge) badge.textContent = 'Fora de horário';
  }
}
function isColabLiberado(colab){ const situacao = String(colab.situacao || '').toUpperCase(); return colab.ativo_refeitorio !== false && situacao === 'ATIVO'; }

async function registerColaboradorMeal(colab, qrToken, meal) {
  if (!isColabLiberado(colab)) { failResult('Bloqueado', `${colab.nome_completo} está inativo para refeição.`); playFail(); flashScreen('bad','BLOQUEADO', colab.nome_completo); return; }
  const duplicate = await hasDuplicate({ tipo_pessoa:'colaborador_adm', matricula: colab.matricula, cpf:'', data_refeicao: meal.data_refeicao, refeicao_nome: meal.nome });
  if (duplicate) { warnResult('Já registrado', `${colab.nome_completo} • ${formatTime(duplicate.hora_registro)}`); playFail(); flashScreen('warn','JÁ REGISTRADO', colab.nome_completo); return; }
  const record = makeRecord({ tipo_pessoa:'colaborador_adm', colaborador_id: colab.id, matricula: colab.matricula, nome_completo: colab.nome_completo, cpf:null, empresa:null, unidade_origem: colab.localidade || null, qr_token: qrToken, meal });
  await saveRegistro(record);
  if (currentProfile?.perfil === 'admin') okResult(`${meal.nome} registrado`, `${colab.nome_completo} • Matrícula ${colab.matricula} • R$ ${money(meal.custo)}`);
  else okResult('Liberado', colab.nome_completo);
  flashScreen('ok', 'LIBERADO', colab.nome_completo);
}

function makeRecord({ tipo_pessoa, colaborador_id, matricula, nome_completo, cpf, empresa, unidade_origem, qr_token, meal }) {
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  return { local_id:id, id, tipo_pessoa, colaborador_id, matricula, nome_completo, cpf, cpf_mascarado: cpf ? maskCpf(cpf) : null, empresa, unidade_origem, refeicao_id: meal.id, refeicao_nome: meal.nome, data_refeicao: meal.data_refeicao, hora_registro: now, custo_refeicao: Number(meal.custo || 0), qr_token, dispositivo_id:null, dispositivo_nome: APP_DEVICE_NAME || 'Dispositivo Refeitório', origem: navigator.onLine ? 'online' : 'offline', sincronizado:false, criado_por: currentUser?.id || null, criado_em: now };
}

async function saveRegistro(record) {
  await idbPut('registros', record);
  let synced = false;
  if (await hasSupabaseSession()) { try { await syncRegistro(record); synced = true; } catch(err){ console.warn('pendente', err.message); } }
  if (!synced) await addPendente('registro', { registro: record }, record.local_id);
  await refreshPendingCount(); await refreshLocalMetrics(); if (currentProfile?.perfil === 'admin') { await renderTodaySummary(); await renderLastRecords(); }
}

async function hasDuplicate({ tipo_pessoa, matricula, cpf, data_refeicao, refeicao_nome }) {
  const regs = await idbGetAll('registros');
  return regs.find(r => {
    if (r.data_refeicao !== data_refeicao || r.refeicao_nome !== refeicao_nome) return false;
    if (tipo_pessoa === 'colaborador_adm') return r.tipo_pessoa === 'colaborador_adm' && r.matricula === matricula;
    if (cpf) return r.tipo_pessoa === tipo_pessoa && onlyDigits(r.cpf || '') === cpf;
    return false;
  });
}

/* Convidados */
function openGuestDialog(tipo) {
  $('guestType').value = tipo; const isAdm = tipo === 'convidado_adm';
  $('guestTitle').textContent = isAdm ? 'Convidado ADM' : 'Terceiro / Visitante';
  $('guestMatriculaBox').classList.toggle('hidden', !isAdm);
  $('guestUnidadeBox').classList.toggle('hidden', !isAdm);
  $('guestEmpresaBox').classList.toggle('hidden', isAdm);
  clearGuestForm(); $('guestType').value = tipo; $('guestDialog').showModal();
}
function clearGuestForm(){ ['guestName','guestMatricula','guestCpf','guestUnidade','guestEmpresa'].forEach(id => { if($(id)) $(id).value=''; }); }
async function registerGuest(e) {
  e.preventDefault();
  const tipo = $('guestType').value, nome = $('guestName').value.trim(), cpf = onlyDigits($('guestCpf').value), matricula = $('guestMatricula').value.trim(), unidade = $('guestUnidade').value.trim(), empresa = $('guestEmpresa').value.trim();
  if (!nome || !cpf) return showToast('Nome completo e CPF são obrigatórios.', 'bad');
  if (tipo === 'convidado_adm' && !matricula) return showToast('Matrícula é obrigatória para convidado ADM.', 'bad');
  if (tipo === 'terceiro' && !empresa) return showToast('Empresa é obrigatória para terceiro.', 'bad');
  const meal = await getCurrentMeal(); if (!meal) { failResult('Fora de horário','Nenhuma refeição ativa agora.'); return; }
  const duplicate = await hasDuplicate({ tipo_pessoa: tipo, matricula, cpf, data_refeicao: meal.data_refeicao, refeicao_nome: meal.nome });
  if (duplicate) { warnResult('Já registrado', `${nome} • ${formatTime(duplicate.hora_registro)}`); playFail(); flashScreen('warn','JÁ REGISTRADO', nome); return; }
  const record = makeRecord({ tipo_pessoa: tipo, colaborador_id:null, matricula: tipo === 'convidado_adm' ? matricula : null, nome_completo:nome, cpf, empresa: tipo === 'terceiro' ? empresa : null, unidade_origem: tipo === 'convidado_adm' ? unidade : null, qr_token:null, meal });
  await saveRegistro(record); $('guestDialog').close(); clearGuestForm(); okResult(`${meal.nome} registrado`, `${nome} • ${tipo === 'terceiro' ? empresa : 'Convidado ADM'}`); flashScreen('ok','LIBERADO', nome);
}

/* Colaboradores */
function openNewColabDialog() {
  ['colabId','colabMatricula','colabNome','colabDepartamento','colabLocalidade','colabCargo','colabGestor'].forEach(id=>$(id).value='');
  $('colabDialog').showModal();
}

async function saveColaborador(e) {
  e.preventDefault();
  if (currentProfile?.perfil !== 'admin') return showToast('Somente admin pode cadastrar colaborador.', 'bad');
  const matricula = $('colabMatricula').value.trim();
  const nome = $('colabNome').value.trim();
  const departamento = $('colabDepartamento').value.trim();
  const localidade = $('colabLocalidade').value.trim();
  const cargo = $('colabCargo').value.trim();
  const gestor = $('colabGestor').value.trim();
  if (!matricula || !nome || !departamento) return showToast('Matrícula, nome e departamento são obrigatórios.', 'bad');
  const existing = await idbGetByIndex('colaboradores', 'matricula', matricula);
  if (existing) return showToast('Essa matrícula já existe na base local.', 'bad');
  const colab = {
    id: crypto.randomUUID(),
    matricula, nome_completo: nome, departamento, localidade, cargo, gestor,
    id_adm: null, data_admissao: null, tipo_colaborador: 'FUNCIONARIO CLT', situacao: 'ATIVO', ativo_refeitorio: true,
    criado_localmente: true
  };
  await idbPut('colaboradores', colab);
  const qrToken = 'RF-' + crypto.randomUUID();
  const vinculo = { qr_token: qrToken, colaborador_id: colab.id, matricula: colab.matricula, ativo:true, vinculado_em:new Date().toISOString(), vinculado_por: currentUser?.id || null, observacao:'QR gerado no cadastro do colaborador' };
  await idbPut('qr_vinculos', vinculo);

  if (await hasSupabaseSession()) {
    try { await syncColaboradorUpsert(colab); } catch(_) { await addPendente('colaborador_upsert', { colaborador: colab }); }
    try { await syncQrVinculo(vinculo); } catch(_) { await addPendente('qr_vinculo', { vinculo }); }
  } else {
    await addPendente('colaborador_upsert', { colaborador: colab });
    await addPendente('qr_vinculo', { vinculo });
  }

  $('colabDialog').close();
  await refreshPendingCount();
  await refreshLocalMetrics();
  await renderColaboradoresList();
  showQrPreview(colab, qrToken);
  showToast('Colaborador cadastrado e QR gerado.', 'ok');
}

async function renderColaboradoresList() {
  const wrap = $('colabListWrap'); if (!wrap) return;
  let colabs = await idbGetAll('colaboradores');
  const term = ($('colabSearch')?.value || '').trim().toLowerCase();
  if (term) colabs = colabs.filter(c => String(c.nome_completo||'').toLowerCase().includes(term) || String(c.matricula||'').toLowerCase().includes(term));
  colabs.sort((a,b) => (a.ativo_refeitorio===false) - (b.ativo_refeitorio===false) || String(a.nome_completo||'').localeCompare(String(b.nome_completo||'')));
  const total = colabs.length, ativos = colabs.filter(c => c.ativo_refeitorio !== false).length, inativos = total - ativos;
  $('colabCounters').innerHTML = `
    <div><span>Total</span><strong>${total}</strong></div>
    <div><span>Ativos</span><strong>${ativos}</strong></div>
    <div><span>Inativos</span><strong>${inativos}</strong></div>`;
  if (!colabs.length) { wrap.innerHTML = `<p class="hint">Nenhum colaborador encontrado.</p>`; return; }
  wrap.innerHTML = `
    <table class="colab-table">
      <thead>
        <tr><th>Matrícula</th><th>Nome</th><th>Setor</th><th>Status</th><th>Ações</th></tr>
      </thead>
      <tbody>
        ${colabs.slice(0, 300).map(c => `
          <tr>
            <td>${escapeHtml(c.matricula || '')}</td>
            <td>${escapeHtml(c.nome_completo || '')}</td>
            <td>${escapeHtml(c.departamento || '')}</td>
            <td>${c.ativo_refeitorio === false ? '<span class="badge-inactive">Inativo</span>' : '<span class="badge-active">Ativo</span>'}</td>
            <td>
              <div class="action-row">
                <button class="ghost js-show-qr" data-id="${escapeHtml(c.id)}">QR</button>
                <button class="ghost js-toggle-colab" data-id="${escapeHtml(c.id)}">${c.ativo_refeitorio === false ? 'Reativar' : 'Inativar'}</button>
              </div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  wrap.querySelectorAll('.js-toggle-colab').forEach(btn => btn.addEventListener('click', ()=>toggleColaboradorStatus(btn.dataset.id)));
  wrap.querySelectorAll('.js-show-qr').forEach(btn => btn.addEventListener('click', ()=>showColaboradorQr(btn.dataset.id)));
}

async function toggleColaboradorStatus(id) {
  const colab = await idbGet('colaboradores', id); if (!colab) return;
  colab.ativo_refeitorio = colab.ativo_refeitorio === false ? true : false;
  await idbPut('colaboradores', colab);
  if (await hasSupabaseSession()) {
    try { await syncColaboradorStatus(id, colab.ativo_refeitorio); } catch(_) { await addPendente('colaborador_status', { id, ativo_refeitorio: colab.ativo_refeitorio }); }
  } else {
    await addPendente('colaborador_status', { id, ativo_refeitorio: colab.ativo_refeitorio });
  }
  await refreshPendingCount();
  await renderColaboradoresList();
  showToast(`Colaborador ${colab.ativo_refeitorio === false ? 'inativado' : 'reativado'}.`, colab.ativo_refeitorio === false ? 'warn' : 'ok');
}

async function showColaboradorQr(id) {
  const colab = await idbGet('colaboradores', id); if (!colab) return;
  const all = await idbGetAll('qr_vinculos');
  let vinculo = all.find(q => q.colaborador_id === colab.id && q.ativo);
  if (!vinculo) {
    vinculo = { qr_token: 'RF-' + crypto.randomUUID(), colaborador_id: colab.id, matricula: colab.matricula, ativo:true, vinculado_em:new Date().toISOString(), vinculado_por: currentUser?.id || null, observacao:'QR gerado depois do cadastro' };
    await idbPut('qr_vinculos', vinculo);
    if (await hasSupabaseSession()) { try { await syncQrVinculo(vinculo); } catch(_) { await addPendente('qr_vinculo', { vinculo }); } }
    else await addPendente('qr_vinculo', { vinculo });
  }
  showQrPreview(colab, vinculo.qr_token);
}

function showQrPreview(colab, qrToken) {
  qrPreviewData = { colab, qrToken };
  $('qrPreviewCard').classList.remove('hidden');
  $('qrPreviewMeta').innerHTML = `<b>${escapeHtml(colab.nome_completo)}</b><br>Matrícula: ${escapeHtml(colab.matricula)}<br>Setor: ${escapeHtml(colab.departamento || '')}`;
  const box = $('qrPreviewBox'); box.innerHTML = '';
  new QRCode(box, { text: qrToken, width: 210, height: 210, colorDark: '#0a2741', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
  document.querySelector('[data-tab="colaboradores"]')?.click();
}
function hideQrPreview() { qrPreviewData = null; $('qrPreviewCard').classList.add('hidden'); $('qrPreviewBox').innerHTML=''; }
function printQrPreview() {
  if (!qrPreviewData) return;
  const box = $('qrPreviewBox'); const img = box.querySelector('img') || box.querySelector('canvas'); if (!img) return;
  let src = '';
  if (img.tagName.toLowerCase() === 'canvas') src = img.toDataURL('image/png'); else src = img.src;
  const w = window.open('', '_blank', 'width=480,height=640');
  w.document.write(`<!DOCTYPE html><html><head><title>QR Code</title><style>body{font-family:Arial;padding:28px;text-align:center;} .card{border:1px solid #ccc;border-radius:18px;padding:20px;} img{width:260px;height:260px;} h1{font-size:22px;} p{margin:6px 0;}</style></head><body><div class="card"><h1>${escapeHtml(qrPreviewData.colab.nome_completo)}</h1><p>Matrícula: ${escapeHtml(qrPreviewData.colab.matricula)}</p><p>${escapeHtml(qrPreviewData.colab.departamento || '')}</p><img src="${src}" /><p style="font-size:12px;word-break:break-all;">${escapeHtml(qrPreviewData.qrToken)}</p></div><script>window.onload=()=>window.print();</script></body></html>`);
  w.document.close();
}

async function syncColaboradorUpsert(colab) {
  const payload = { id: colab.id, matricula: colab.matricula, nome_completo: colab.nome_completo, departamento: colab.departamento || null, localidade: colab.localidade || null, cargo: colab.cargo || null, gestor: colab.gestor || null, id_adm: colab.id_adm || null, data_admissao: colab.data_admissao || null, tipo_colaborador: colab.tipo_colaborador || null, situacao: colab.situacao || 'ATIVO', ativo_refeitorio: colab.ativo_refeitorio !== false };
  const { error } = await sb.from('colaboradores').upsert(payload);
  if (error) throw error;
}
async function syncColaboradorStatus(id, ativo_refeitorio) {
  const { error } = await sb.from('colaboradores').update({ ativo_refeitorio }).eq('id', id);
  if (error) throw error;
}
async function syncQrVinculo(vinculo) {
  const { error } = await sb.from('qr_vinculos').insert(vinculo);
  if (error) throw error;
}
async function syncRegistro(record) {
  const payload = { ...record }; delete payload.local_id; delete payload.tipo_pendente;
  const { error } = await sb.from('registros_refeicao').insert(payload); if (error) throw error; record.sincronizado = true; await idbPut('registros', record);
}
async function addPendente(tipo, data = {}, customId) {
  await idbPut('pendentes', { local_id: customId || crypto.randomUUID(), tipo, ...data, criado_em: new Date().toISOString() });
}

/* Administração */
async function renderMealsAdmin() {
  const wrap = $('mealsTableWrap'); if (!wrap) return; const meals = await idbGetAll('refeicoes'); meals.sort((a,b)=>String(a.hora_inicio).localeCompare(String(b.hora_inicio)));
  if (!meals.length) { wrap.innerHTML = `<p class="hint">Nenhuma refeição local. Clique em "Baixar base do Supabase".</p>`; return; }
  wrap.innerHTML = `<table class="meals-table"><thead><tr><th>Refeição</th><th>Início</th><th>Fim</th><th>Custo</th><th>Ativa</th></tr></thead><tbody>${meals.map(m => `<tr data-id="${escapeHtml(m.id)}"><td><input data-field="nome" value="${escapeAttr(m.nome)}" /></td><td><input data-field="hora_inicio" type="time" value="${safeTime(m.hora_inicio)}" /></td><td><input data-field="hora_fim" type="time" value="${safeTime(m.hora_fim)}" /></td><td><input data-field="custo" type="number" min="0" step="0.01" value="${Number(m.custo || 0)}" /></td><td><input data-field="ativo" type="checkbox" ${m.ativo ? 'checked' : ''} /></td></tr>`).join('')}</tbody></table>`;
}
async function saveMealsAdmin() {
  if (currentProfile?.perfil !== 'admin') return showToast('Somente admin pode alterar horários/custos.', 'bad');
  const trs = [...document.querySelectorAll('.meals-table tbody tr')]; const updated=[];
  for (const tr of trs) { const current = await idbGet('refeicoes', tr.dataset.id); if (!current) continue; const row = { ...current }; tr.querySelectorAll('input').forEach(inp => { const f = inp.dataset.field; row[f] = inp.type === 'checkbox' ? inp.checked : inp.value; }); row.custo = Number(row.custo || 0); row.atualizado_em = new Date().toISOString(); updated.push(row); }
  for (const meal of updated) await idbPut('refeicoes', meal);
  if (await hasSupabaseSession()) {
    for (const meal of updated) { const { error } = await sb.from('refeicoes').update({ nome: meal.nome, hora_inicio: meal.hora_inicio, hora_fim: meal.hora_fim, custo: meal.custo, ativo: meal.ativo, atualizado_em: meal.atualizado_em }).eq('id', meal.id); if (error) return showToast('Falha ao salvar no Supabase: ' + cleanError(error.message), 'bad'); }
    showToast('Horários e custos salvos.', 'ok');
  } else showToast('Salvo localmente. Entre online para salvar no Supabase.', 'warn');
  await renderAll();
}
async function refreshLocalMetrics() {
  if ($('metricColabs')) $('metricColabs').textContent = (await idbGetAll('colaboradores')).length;
  if ($('metricQr')) $('metricQr').textContent = (await idbGetAll('qr_vinculos')).length;
  if ($('metricMeals')) $('metricMeals').textContent = (await idbGetAll('refeicoes')).length;
  if ($('metricRegs')) $('metricRegs').textContent = (await idbGetAll('registros')).length;
}

/* Painel / exportação */
async function renderTodaySummary() {
  const el = $('todaySummary'); if (!el) return;
  const today = toISODate(new Date()); const regs = (await idbGetAll('registros')).filter(r=>r.data_refeicao === today);
  const byMeal={}; let totalQtd=0, totalCost=0;
  for (const r of regs) { if (!byMeal[r.refeicao_nome]) byMeal[r.refeicao_nome]={ qtd:0, custo:0 }; byMeal[r.refeicao_nome].qtd++; byMeal[r.refeicao_nome].custo += Number(r.custo_refeicao || 0); totalQtd++; totalCost += Number(r.custo_refeicao || 0); }
  const cards = Object.entries(byMeal).map(([meal,v]) => `<div class="summary-card"><span>${escapeHtml(meal)}</span><strong>${v.qtd}</strong><span>R$ ${money(v.custo)}</span></div>`).join('');
  el.innerHTML = `${cards || `<div class="summary-card"><span>Sem registros</span><strong>0</strong><span>Hoje</span></div>`}<div class="summary-card"><span>Total dia</span><strong>${totalQtd}</strong><span>R$ ${money(totalCost)}</span></div>`;
}
async function renderLastRecords() {
  const el = $('lastRecords'); if (!el) return; const regs = await idbGetAll('registros'); regs.sort((a,b)=>new Date(b.hora_registro)-new Date(a.hora_registro)); const top = regs.slice(0,12);
  if (!top.length) { el.innerHTML = `<p class="hint">Nenhum registro local.</p>`; return; }
  el.innerHTML = `<table class="records-table"><thead><tr><th>Hora</th><th>Nome</th><th>Refeição</th><th>Status</th></tr></thead><tbody>${top.map(r=>`<tr><td>${formatTime(r.hora_registro)}</td><td>${escapeHtml(r.nome_completo)}</td><td>${escapeHtml(r.refeicao_nome)}</td><td>${r.sincronizado ? 'OK' : 'Pendente'}</td></tr>`).join('')}</tbody></table>`;
}
async function exportLocalCsv() { const from=$('dateFrom').value, to=$('dateTo').value; const regs = filterByDate(await idbGetAll('registros'), from, to); downloadCsv('registros_refeitorio_local.csv', regsToCsv(regs)); }
async function exportSupabaseCsv() {
  if (!sb || !navigator.onLine) return showToast('Precisa de internet para extrair do Supabase.', 'bad');
  if (!(await hasSupabaseSession())) return showToast('Sessão online expirada. Entre novamente para extrair.', 'warn');
  const from = $('dateFrom').value, to = $('dateTo').value; let query = sb.from('registros_refeicao').select('*').order('hora_registro',{ascending:true}).limit(10000); if (from) query = query.gte('data_refeicao', from); if (to) query = query.lte('data_refeicao', to); const { data, error } = await query; if (error) return showToast('Erro ao extrair: ' + cleanError(error.message), 'bad'); downloadCsv('registros_refeitorio_supabase.csv', regsToCsv(data || []));
}

/* Navegação */
async function renderAll() {
  await refreshCurrentMeal();
  await refreshPendingCount();
  await refreshLocalMetrics();
  if (currentProfile?.perfil === 'admin') { await renderMealsAdmin(); await renderTodaySummary(); await renderLastRecords(); await renderColaboradoresList(); }
}
function activateTab(name) {
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  const btn = document.querySelector(`.nav-item[data-tab="${name}"]`), panel = $(`tab-${name}`); if (btn) btn.classList.add('active'); if (panel) panel.classList.add('active'); renderAll();
}

/* UI */
function okResult(title,msg){ $('resultBox').className='result ok compact-result'; $('resultBox').innerHTML=`<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`; playOk(); }
function failResult(title,msg){ $('resultBox').className='result bad compact-result'; $('resultBox').innerHTML=`<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`; playFail(); }
function warnResult(title,msg){ $('resultBox').className='result warn compact-result'; $('resultBox').innerHTML=`<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`; }
function neutralResult(title,msg){ if (!$('resultBox')) return; $('resultBox').className='result neutral compact-result'; $('resultBox').innerHTML=`<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`; }
function showToast(msg, type='ok') { const el = $('toast'); if (!el) return; el.textContent = msg; el.className = `toast ${type}`; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'), 3800); }
function updateOnlineStatus(){ const el = $('onlineStatus'); if (!el) return; const online = navigator.onLine; el.textContent = online ? 'Online' : 'Offline'; el.className = online ? 'pill ok' : 'pill bad'; }
function setButtonLoading(id, loading, text){ const btn = $(id); if (!btn) return; btn.disabled = loading; btn.textContent = text; }
function flashScreen(type, title, msg) {
  const wrap = $('scanFlash'); if (!wrap) return;
  const icon = $('scanFlashIcon'), t = $('scanFlashTitle'), m = $('scanFlashMsg');
  wrap.className = `scan-flash ${type}`;
  icon.textContent = type === 'ok' ? '✓' : (type === 'warn' ? '!' : '✕');
  t.textContent = title; m.textContent = msg || '';
  wrap.classList.remove('hidden');
  setTimeout(()=>wrap.classList.add('hidden'), 1220);
  if (navigator.vibrate) navigator.vibrate(type === 'ok' ? [80, 30, 80] : [120, 60, 120]);
}
function playOk(){ beepSequence([{f:1046,d:0.11,v:0.28},{f:1318,d:0.12,v:0.30}]); }
function playFail(){ beepSequence([{f:190,d:0.18,v:0.35},{f:150,d:0.18,v:0.33}]); }
function beepSequence(seq) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let offset = 0;
    seq.forEach(s => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.frequency.value = s.f; osc.type = 'triangle'; gain.gain.value = s.v || 0.22;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + s.d);
      offset += s.d + 0.04;
    });
    setTimeout(()=>ctx.close(), (offset + .3) * 1000);
  } catch(_){}
}

/* Utils */
function debounce(fn, wait=200){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait); }; }
function timeToMinutes(time){ const [h,m] = String(time).slice(0,5).split(':').map(Number); return h*60 + m; }
function safeTime(time){ return String(time || '00:00').slice(0,5); }
function toISODate(d){ const local = new Date(d.getTime() - d.getTimezoneOffset()*60000); return local.toISOString().slice(0,10); }
function formatDateBR(iso){ if (!iso) return ''; const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }
function formatTime(iso){ return new Date(iso).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' }); }
function money(v){ return Number(v||0).toLocaleString('pt-BR',{ minimumFractionDigits:2, maximumFractionDigits:2 }); }
function onlyDigits(v){ return String(v||'').replace(/\D/g,''); }
function maskCpf(cpf){ const d = onlyDigits(cpf); if (d.length < 4) return '***'; return `***.***.***-${d.slice(-2)}`; }
function filterByDate(rows, from, to){ return rows.filter(r => { if (from && r.data_refeicao < from) return false; if (to && r.data_refeicao > to) return false; return true; }); }
function regsToCsv(rows){ const headers=['data_refeicao','hora_registro','refeicao_nome','tipo_pessoa','matricula','nome_completo','cpf_mascarado','empresa','unidade_origem','custo_refeicao','qr_token','dispositivo_nome','origem','sincronizado']; const lines=[headers.join(';')]; for(const r of rows) lines.push(headers.map(h=>csvCell(r[h])).join(';')); return '\ufeff' + lines.join('\n'); }
function csvCell(v){ if (v===null||v===undefined) return ''; const s = String(v).replace(/"/g,'""'); return `"${s}"`; }
function downloadCsv(filename, content){ const blob = new Blob([content], { type:'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }
function escapeHtml(str){ return String(str ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[m])); }
function escapeAttr(str){ return escapeHtml(str).replace(/`/g,'&#096;'); }
function cleanError(msg){ return String(msg||'erro desconhecido').replace(/JWT|token/gi,'autenticação').replace('Invalid login credentials','e-mail ou senha incorretos').replace('NotAllowedError','permissão da câmera negada').replace('NotFoundError','câmera não encontrada'); }
