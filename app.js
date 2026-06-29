/* ADM Refeitório Offline - MVP v1 */

let sb = null;
let currentUser = null;
let currentProfile = null;
let db = null;
let videoStream = null;
let scanLoopActive = false;
let detector = null;
let lastQr = "";
let lastQrAt = 0;
let pendingQrToBind = null;
let deviceLocalId = null;

const DB_NAME = "adm_refeitorio_offline_v1";
const DB_VERSION = 1;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupSupabase();
  db = await openDb();
  await initDevice();

  bindUi();
  updateOnlineStatus();
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  const today = toISODate(new Date());
  $("dateFrom").value = today;
  $("dateTo").value = today;

  await refreshLocalMetrics();
  await refreshPendingCount();
}

function setupSupabase() {
  if (!window.supabase || !SUPABASE_URL || SUPABASE_URL.includes("SEU-PROJETO")) {
    console.warn("Supabase ainda não configurado em config.js");
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function bindUi() {
  $("btnLogin").addEventListener("click", login);
  $("btnLogout").addEventListener("click", logout);
  $("btnSync").addEventListener("click", syncAll);
  $("btnDownloadBase").addEventListener("click", downloadBase);
  $("btnLoadMeals").addEventListener("click", renderMealsAdmin);
  $("btnSaveMeals").addEventListener("click", saveMealsAdmin);

  $("btnStartCamera").addEventListener("click", startCamera);
  $("btnStopCamera").addEventListener("click", stopCamera);
  $("btnManualQr").addEventListener("click", () => {
    const value = $("manualQr").value.trim();
    if (value) processQr(value);
    $("manualQr").value = "";
  });

  $("manualQr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnManualQr").click();
  });

  $("btnBindMatricula").addEventListener("click", bindQrWithMatricula);
  $("btnCancelBind").addEventListener("click", cancelBind);

  $("btnGuestAdm").addEventListener("click", () => openGuestDialog("convidado_adm"));
  $("btnTerceiro").addEventListener("click", () => openGuestDialog("terceiro"));
  $("btnRegisterGuest").addEventListener("click", registerGuest);

  $("btnExportLocal").addEventListener("click", exportLocalCsv);
  $("btnExportSupabase").addEventListener("click", exportSupabaseCsv);

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
}

async function login() {
  if (!sb) {
    showToast("Configure o Supabase no arquivo config.js.", "bad");
    return;
  }

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  if (!email || !password) {
    showToast("Informe e-mail e senha.", "bad");
    return;
  }

  setButtonLoading("btnLogin", true, "Entrando...");

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;

    currentUser = data.user;
    await loadProfile();
    document.body.classList.remove("role-admin", "role-refeitorio", "role-consulta");
    document.body.classList.add(`role-${currentProfile.perfil}`);
    if ($("sideProfile")) $("sideProfile").textContent = currentProfile.perfil === "admin" ? "Administrador" : "Leitura";
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    if ($("userInfo")) $("userInfo").textContent = `${currentProfile.nome} • ${currentProfile.perfil}`;

    await downloadBase(false);
    await renderAll();
    showToast("Login realizado.", "ok");
  } catch (err) {
    showToast("Falha no login: " + cleanError(err.message), "bad");
  } finally {
    setButtonLoading("btnLogin", false, "Entrar");
  }
}

async function loadProfile() {
  const { data, error } = await sb
    .from("usuarios_app")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error) throw new Error("Usuário não cadastrado em usuarios_app.");
  if (!data.ativo) throw new Error("Usuário inativo.");
  currentProfile = data;
}

async function logout() {
  stopCamera();
  if (sb) await sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  document.body.classList.remove("role-admin", "role-refeitorio", "role-consulta");
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
}

async function renderAll() {
  await refreshCurrentMeal();
  await refreshLocalMetrics();
  await refreshPendingCount();
  await renderMealsAdmin();
  await renderTodaySummary();
  await renderLastRecords();
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add("active");
  $(`tab-${name}`).classList.add("active");
  renderAll();
}

/* ===========================
   IndexedDB
=========================== */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("colaboradores")) {
        const s = db.createObjectStore("colaboradores", { keyPath: "id" });
        s.createIndex("matricula", "matricula", { unique: true });
        s.createIndex("nome_completo", "nome_completo", { unique: false });
      }

      if (!db.objectStoreNames.contains("qr_vinculos")) {
        const s = db.createObjectStore("qr_vinculos", { keyPath: "qr_token" });
        s.createIndex("matricula", "matricula", { unique: false });
      }

      if (!db.objectStoreNames.contains("refeicoes")) {
        db.createObjectStore("refeicoes", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("registros")) {
        const s = db.createObjectStore("registros", { keyPath: "local_id" });
        s.createIndex("data_refeicao", "data_refeicao", { unique: false });
        s.createIndex("matricula", "matricula", { unique: false });
      }

      if (!db.objectStoreNames.contains("pendentes")) {
        db.createObjectStore("pendentes", { keyPath: "local_id" });
      }

      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = txStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function idbGetByIndex(store, indexName, value) {
  return new Promise((resolve, reject) => {
    const req = txStore(store).index(indexName).get(value);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = txStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, "readwrite").put(value);
    req.onsuccess = () => resolve(value);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, "readwrite").delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

function idbClear(store) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, "readwrite").clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function replaceStore(store, rows) {
  await idbClear(store);
  for (const row of rows) await idbPut(store, row);
}

/* ===========================
   Base e sync
=========================== */

async function downloadBase(showMessage = true) {
  if (!sb || !navigator.onLine || !currentUser) {
    if (showMessage) showToast("Sem conexão ou sem login. Usando base local.", "warn");
    return;
  }

  try {
    if (showMessage) showToast("Baixando base...", "warn");

    const [colabs, qrs, meals] = await Promise.all([
      sb.from("colaboradores").select("*").limit(5000),
      sb.from("qr_vinculos").select("*").eq("ativo", true).limit(5000),
      sb.from("refeicoes").select("*").order("hora_inicio", { ascending: true }).limit(100)
    ]);

    if (colabs.error) throw colabs.error;
    if (qrs.error) throw qrs.error;
    if (meals.error) throw meals.error;

    await replaceStore("colaboradores", colabs.data || []);
    await replaceStore("qr_vinculos", qrs.data || []);
    await replaceStore("refeicoes", meals.data || []);

    await renderAll();
    if (showMessage) showToast("Base baixada para uso offline.", "ok");
  } catch (err) {
    showToast("Erro ao baixar base: " + cleanError(err.message), "bad");
  }
}

async function syncAll() {
  if (!sb || !navigator.onLine || !currentUser) {
    showToast("Sem internet. Os registros continuam salvos localmente.", "warn");
    return;
  }

  const pendentes = await idbGetAll("pendentes");
  if (!pendentes.length) {
    showToast("Nada pendente para sincronizar.", "ok");
    return;
  }

  let ok = 0;
  let fail = 0;

  for (const item of pendentes) {
    try {
      if (item.tipo === "qr_vinculo") {
        await syncQrVinculo(item);
      } else if (item.tipo === "registro") {
        await syncRegistro(item.registro);
      }
      await idbDelete("pendentes", item.local_id);
      ok++;
    } catch (err) {
      console.warn("Falha sync", item, err);
      fail++;
    }
  }

  await refreshPendingCount();
  await refreshLocalMetrics();
  await renderTodaySummary();
  await renderLastRecords();

  if (fail === 0) {
    showToast(`Sincronização concluída: ${ok} item(ns).`, "ok");
    await downloadBase(false);
  } else {
    showToast(`Sincronizou ${ok}, falhou ${fail}. Verifique conexão/permissão.`, "warn");
  }
}

async function syncQrVinculo(item) {
  const payload = { ...item.vinculo };
  delete payload.local_id;

  const { error } = await sb.from("qr_vinculos").insert(payload);
  if (error) throw error;
}

async function syncRegistro(record) {
  const payload = supabaseRegistroPayload(record);
  const { error } = await sb.from("registros_refeicao").insert(payload);
  if (error) throw error;

  record.sincronizado = true;
  await idbPut("registros", record);
}

function supabaseRegistroPayload(record) {
  const clone = { ...record };
  delete clone.local_id;
  delete clone.tipo_pendente;
  return clone;
}

async function refreshPendingCount() {
  const rows = await idbGetAll("pendentes");
  $("pendingStatus").textContent = `Pendentes: ${rows.length}`;
  $("pendingStatus").className = rows.length ? "pill warn" : "pill ok";
}

/* ===========================
   Dispositivo
=========================== */

async function initDevice() {
  let meta = await idbGet("meta", "device");
  if (!meta) {
    meta = {
      key: "device",
      id: crypto.randomUUID(),
      nome: APP_DEVICE_NAME || "Dispositivo Refeitório",
      tipo: APP_DEVICE_TYPE || "tablet",
      local: APP_LOCAL_USO || "Refeitório"
    };
    await idbPut("meta", meta);
  }
  deviceLocalId = meta.id;
}

/* ===========================
   Scanner
=========================== */

// Canvas oculto reutilizado para leitura de frames
let _scanCanvas = null;
let _scanCtx = null;

function getScanCanvas(width, height) {
  if (!_scanCanvas) {
    _scanCanvas = document.createElement("canvas");
    _scanCtx = _scanCanvas.getContext("2d", { willReadFrequently: true });
  }
  _scanCanvas.width = width;
  _scanCanvas.height = height;
  return { canvas: _scanCanvas, ctx: _scanCtx };
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast("Este navegador não liberou câmera. Use entrada manual/leitor USB.", "warn");
      return;
    }

    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    $("video").srcObject = videoStream;
    await $("video").play();

    // jsQR funciona em qualquer navegador — sem dependência de BarcodeDetector
    if (typeof jsQR === "function") {
      detector = true; // flag apenas para indicar que está ativo
      scanLoopActive = true;
      $("scanMode").textContent = "Lendo QR";
      $("scanMode").className = "pill ok";
      $("scanMode").classList.remove("hidden");
      scanLoop();
      showToast("Câmera aberta.", "ok");
    } else {
      $("scanMode").textContent = "Biblioteca QR não carregou";
      $("scanMode").className = "pill warn";
      $("scanMode").classList.remove("hidden");
      showToast("jsQR não carregou. Verifique conexão ou use entrada manual.", "warn");
    }
  } catch (err) {
    showToast("Não consegui abrir a câmera: " + cleanError(err.message), "bad");
  }
}

function stopCamera() {
  scanLoopActive = false;
  detector = null;
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }
  $("video").srcObject = null;
  $("scanMode").textContent = "Parado";
  $("scanMode").className = "pill";
}

function scanLoop() {
  if (!scanLoopActive) return;

  try {
    const video = $("video");
    if (video.readyState >= 2 && video.videoWidth > 0) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const { canvas, ctx } = getScanCanvas(w, h);
      ctx.drawImage(video, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const result = jsQR(imageData.data, w, h, { inversionAttempts: "dontInvert" });
      if (result) {
        const qr = (result.data || "").trim();
        const now = Date.now();
        if (qr && (qr !== lastQr || now - lastQrAt > 2500)) {
          lastQr = qr;
          lastQrAt = now;
          processQr(qr);
        }
      }
    }
  } catch (err) {
    console.warn("scanLoop erro:", err);
  }

  // ~15 fps é mais que suficiente para QR Code e não aquece o aparelho
  setTimeout(() => requestAnimationFrame(scanLoop), 66);
}

async function processQr(qrToken) {
  hideBindBox();
  pendingQrToBind = null;

  const meal = await getCurrentMeal();
  if (!meal) {
    failResult("Fora de horário", "Nenhuma refeição ativa agora.", true);
    return;
  }

  const vinculo = await idbGet("qr_vinculos", qrToken);
  if (!vinculo || !vinculo.ativo) {
    pendingQrToBind = qrToken;
    warnResult("QR não vinculado", "Digite a matrícula ADM para vincular este QR ao colaborador.");
    $("bindBox").classList.remove("hidden");
    $("bindMatricula").focus();
    playFail();
    return;
  }

  const colab = await idbGet("colaboradores", vinculo.colaborador_id);
  if (!colab) {
    failResult("Vínculo inválido", "QR vinculado, mas colaborador não existe na base local.");
    return;
  }

  await registerColaboradorMeal(colab, qrToken, meal);
}

async function bindQrWithMatricula() {
  const matricula = $("bindMatricula").value.trim();
  if (!pendingQrToBind) {
    showToast("Nenhum QR pendente.", "bad");
    return;
  }
  if (!matricula) {
    showToast("Informe a matrícula.", "bad");
    return;
  }

  const colab = await idbGetByIndex("colaboradores", "matricula", matricula);
  if (!colab) {
    failResult("Matrícula não encontrada", "Essa matrícula não está na base ADM local.");
    return;
  }

  if (!isColabLiberado(colab)) {
    failResult("Colaborador bloqueado", `${colab.nome_completo} está com situação ${colab.situacao || "N/I"}.`);
    return;
  }

  const qrs = await idbGetAll("qr_vinculos");
  const existingByMatricula = qrs.find((q) => q.matricula === matricula && q.ativo && q.qr_token !== pendingQrToBind);
  if (existingByMatricula) {
    failResult("Matrícula já tem QR", "Somente admin deve trocar o QR de um colaborador.");
    return;
  }

  const vinculo = {
    qr_token: pendingQrToBind,
    colaborador_id: colab.id,
    matricula: colab.matricula,
    ativo: true,
    vinculado_em: new Date().toISOString(),
    vinculado_por: currentUser?.id || null,
    observacao: "Vinculado no primeiro uso pelo app offline"
  };

  await idbPut("qr_vinculos", vinculo);

  if (navigator.onLine && sb && currentUser) {
    try {
      await syncQrVinculo({ local_id: crypto.randomUUID(), tipo: "qr_vinculo", vinculo });
    } catch (err) {
      await idbPut("pendentes", {
        local_id: crypto.randomUUID(),
        tipo: "qr_vinculo",
        vinculo,
        criado_em: new Date().toISOString()
      });
    }
  } else {
    await idbPut("pendentes", {
      local_id: crypto.randomUUID(),
      tipo: "qr_vinculo",
      vinculo,
      criado_em: new Date().toISOString()
    });
  }

  hideBindBox();
  const meal = await getCurrentMeal();
  await registerColaboradorMeal(colab, pendingQrToBind, meal);
  pendingQrToBind = null;
  $("bindMatricula").value = "";
  await refreshPendingCount();
  await refreshLocalMetrics();
}

function cancelBind() {
  pendingQrToBind = null;
  hideBindBox();
  neutralResult("Aguardando leitura", "Passe o crachá ou escaneie o QR.");
}

function hideBindBox() {
  $("bindBox").classList.add("hidden");
}

/* ===========================
   Refeição e registro
=========================== */

async function getCurrentMeal(now = new Date()) {
  const refeicoes = (await idbGetAll("refeicoes")).filter((r) => r.ativo);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const meal of refeicoes) {
    const start = timeToMinutes(meal.hora_inicio);
    const end = timeToMinutes(meal.hora_fim);
    let active = false;
    let dataRef = toISODate(now);

    if (start <= end) {
      active = nowMinutes >= start && nowMinutes <= end;
    } else {
      active = nowMinutes >= start || nowMinutes <= end;
      if (active && nowMinutes <= end) {
        const d = new Date(now);
        d.setDate(d.getDate() - 1);
        dataRef = toISODate(d);
      }
    }

    if (active) {
      return { ...meal, data_refeicao: dataRef };
    }
  }

  return null;
}

async function refreshCurrentMeal() {
  const meal = await getCurrentMeal();
  if (meal) {
    if (currentProfile && currentProfile.perfil !== "admin") {
      $("currentMeal").textContent = `Refeição atual: ${meal.nome}`;
    } else {
      $("currentMeal").textContent = `Refeição atual: ${meal.nome} • R$ ${money(meal.custo)} • dia ${formatDateBR(meal.data_refeicao)}`;
    }
  } else {
    $("currentMeal").textContent = "Refeição atual: nenhuma refeição ativa";
  }
}

function isColabLiberado(colab) {
  const situacao = (colab.situacao || "").toUpperCase();
  return colab.ativo_refeitorio !== false && situacao === "ATIVO";
}

async function registerColaboradorMeal(colab, qrToken, meal) {
  if (!isColabLiberado(colab)) {
    failResult("Colaborador bloqueado", `${colab.nome_completo} está com situação ${colab.situacao || "N/I"}.`);
    return;
  }

  const duplicate = await hasDuplicate({
    tipo_pessoa: "colaborador_adm",
    matricula: colab.matricula,
    cpf: "",
    data_refeicao: meal.data_refeicao,
    refeicao_nome: meal.nome
  });

  if (duplicate) {
    warnResult(
      "Já registrado",
      `${colab.nome_completo} já registrou ${meal.nome} hoje às ${formatTime(duplicate.hora_registro)}.`
    );
    playFail();
    return;
  }

  const record = makeRecord({
    tipo_pessoa: "colaborador_adm",
    colaborador_id: colab.id,
    matricula: colab.matricula,
    nome_completo: colab.nome_completo,
    cpf: null,
    empresa: null,
    unidade_origem: colab.localidade || null,
    qr_token: qrToken,
    meal
  });

  await saveRegistro(record);
  if (currentProfile && currentProfile.perfil !== "admin") {
    okResult("Liberado", `${colab.nome_completo}`);
  } else {
    okResult(`${meal.nome} registrado`, `${colab.nome_completo} • Matrícula ${colab.matricula} • R$ ${money(meal.custo)}`);
  }
}

async function registerGuest(e) {
  e.preventDefault();

  const tipo = $("guestType").value;
  const nome = $("guestName").value.trim();
  const cpf = onlyDigits($("guestCpf").value);
  const matricula = $("guestMatricula").value.trim();
  const unidade = $("guestUnidade").value.trim();
  const empresa = $("guestEmpresa").value.trim();

  if (!nome || !cpf) {
    showToast("Nome completo e CPF são obrigatórios.", "bad");
    return;
  }

  if (tipo === "convidado_adm" && !matricula) {
    showToast("Matrícula é obrigatória para convidado ADM.", "bad");
    return;
  }

  if (tipo === "terceiro" && !empresa) {
    showToast("Empresa é obrigatória para terceiro.", "bad");
    return;
  }

  const meal = await getCurrentMeal();
  if (!meal) {
    failResult("Fora de horário", "Nenhuma refeição ativa agora.", true);
    return;
  }

  const duplicate = await hasDuplicate({
    tipo_pessoa: tipo,
    matricula,
    cpf,
    data_refeicao: meal.data_refeicao,
    refeicao_nome: meal.nome
  });

  if (duplicate) {
    warnResult("Já registrado", `${nome} já registrou ${meal.nome} hoje às ${formatTime(duplicate.hora_registro)}.`);
    playFail();
    return;
  }

  const record = makeRecord({
    tipo_pessoa: tipo,
    colaborador_id: null,
    matricula: tipo === "convidado_adm" ? matricula : null,
    nome_completo: nome,
    cpf,
    empresa: tipo === "terceiro" ? empresa : null,
    unidade_origem: tipo === "convidado_adm" ? unidade : null,
    qr_token: null,
    meal
  });

  await saveRegistro(record);
  $("guestDialog").close();
  if (currentProfile && currentProfile.perfil !== "admin") {
    okResult("Liberado", nome);
  } else {
    okResult(`${meal.nome} registrado`, `${nome} • ${tipo === "terceiro" ? empresa : "Convidado ADM"} • R$ ${money(meal.custo)}`);
  }
  clearGuestForm();
}

function makeRecord({ tipo_pessoa, colaborador_id, matricula, nome_completo, cpf, empresa, unidade_origem, qr_token, meal }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  return {
    local_id: id,
    id,
    tipo_pessoa,
    colaborador_id,
    matricula,
    nome_completo,
    cpf,
    cpf_mascarado: cpf ? maskCpf(cpf) : null,
    empresa,
    unidade_origem,
    refeicao_id: meal.id,
    refeicao_nome: meal.nome,
    data_refeicao: meal.data_refeicao,
    hora_registro: now,
    custo_refeicao: Number(meal.custo || 0),
    qr_token,
    dispositivo_id: null,
    dispositivo_nome: APP_DEVICE_NAME || "Dispositivo Refeitório",
    origem: navigator.onLine ? "online" : "offline",
    sincronizado: false,
    criado_por: currentUser?.id || null,
    criado_em: now
  };
}

async function saveRegistro(record) {
  await idbPut("registros", record);

  let synced = false;
  if (navigator.onLine && sb && currentUser) {
    try {
      await syncRegistro(record);
      synced = true;
    } catch (err) {
      console.warn("Registro salvo local, pendente por erro online:", err.message);
    }
  }

  if (!synced) {
    await idbPut("pendentes", {
      local_id: record.local_id,
      tipo: "registro",
      registro: record,
      criado_em: new Date().toISOString()
    });
  }

  await refreshPendingCount();
  await refreshLocalMetrics();
  await renderTodaySummary();
  await renderLastRecords();
}

async function hasDuplicate({ tipo_pessoa, matricula, cpf, data_refeicao, refeicao_nome }) {
  const regs = await idbGetAll("registros");

  return regs.find((r) => {
    if (r.data_refeicao !== data_refeicao || r.refeicao_nome !== refeicao_nome) return false;

    if (tipo_pessoa === "colaborador_adm") {
      return r.tipo_pessoa === "colaborador_adm" && r.matricula && r.matricula === matricula;
    }

    if (cpf) {
      return r.tipo_pessoa === tipo_pessoa && onlyDigits(r.cpf || "") === cpf;
    }

    return false;
  });
}

/* ===========================
   Admin
=========================== */

async function renderMealsAdmin() {
  const meals = await idbGetAll("refeicoes");
  meals.sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));

  if (!meals.length) {
    $("mealsTableWrap").innerHTML = `<p class="hint">Nenhuma refeição local. Clique em "Baixar base do Supabase".</p>`;
    return;
  }

  const rows = meals.map((m) => `
    <tr data-id="${escapeHtml(m.id)}">
      <td><input data-field="nome" value="${escapeAttr(m.nome)}" /></td>
      <td><input data-field="hora_inicio" type="time" value="${safeTime(m.hora_inicio)}" /></td>
      <td><input data-field="hora_fim" type="time" value="${safeTime(m.hora_fim)}" /></td>
      <td><input data-field="custo" type="number" min="0" step="0.01" value="${Number(m.custo || 0)}" /></td>
      <td><input data-field="ativo" type="checkbox" ${m.ativo ? "checked" : ""} /></td>
    </tr>
  `).join("");

  $("mealsTableWrap").innerHTML = `
    <table class="meals-table">
      <thead>
        <tr>
          <th>Refeição</th>
          <th>Início</th>
          <th>Fim</th>
          <th>Custo</th>
          <th>Ativa</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function saveMealsAdmin() {
  if (!currentProfile || currentProfile.perfil !== "admin") {
    showToast("Somente admin pode alterar horários/custos.", "bad");
    return;
  }

  const trs = [...document.querySelectorAll(".meals-table tbody tr")];
  const updated = [];

  for (const tr of trs) {
    const current = await idbGet("refeicoes", tr.dataset.id);
    if (!current) continue;

    const row = { ...current };
    tr.querySelectorAll("input").forEach((inp) => {
      const field = inp.dataset.field;
      row[field] = inp.type === "checkbox" ? inp.checked : inp.value;
    });
    row.custo = Number(row.custo || 0);
    row.atualizado_em = new Date().toISOString();
    updated.push(row);
  }

  for (const meal of updated) await idbPut("refeicoes", meal);

  if (navigator.onLine && sb) {
    for (const meal of updated) {
      const { error } = await sb
        .from("refeicoes")
        .update({
          nome: meal.nome,
          hora_inicio: meal.hora_inicio,
          hora_fim: meal.hora_fim,
          custo: meal.custo,
          ativo: meal.ativo,
          atualizado_em: meal.atualizado_em
        })
        .eq("id", meal.id);

      if (error) {
        showToast("Falha ao salvar no Supabase: " + cleanError(error.message), "bad");
        return;
      }
    }
  } else {
    showToast("Salvo localmente. Conecte para salvar no Supabase.", "warn");
  }

  showToast("Horários e custos salvos.", "ok");
  await renderAll();
}

async function refreshLocalMetrics() {
  $("metricColabs").textContent = (await idbGetAll("colaboradores")).length;
  $("metricQr").textContent = (await idbGetAll("qr_vinculos")).length;
  $("metricMeals").textContent = (await idbGetAll("refeicoes")).length;
  $("metricRegs").textContent = (await idbGetAll("registros")).length;
}

/* ===========================
   Relatórios
=========================== */

async function renderTodaySummary() {
  const today = toISODate(new Date());
  const regs = (await idbGetAll("registros")).filter((r) => r.data_refeicao === today);

  const byMeal = {};
  let totalQtd = 0;
  let totalCost = 0;

  for (const r of regs) {
    if (!byMeal[r.refeicao_nome]) byMeal[r.refeicao_nome] = { qtd: 0, custo: 0 };
    byMeal[r.refeicao_nome].qtd++;
    byMeal[r.refeicao_nome].custo += Number(r.custo_refeicao || 0);
    totalQtd++;
    totalCost += Number(r.custo_refeicao || 0);
  }

  const cards = Object.entries(byMeal).map(([meal, v]) => `
    <div class="summary-card">
      <span>${escapeHtml(meal)}</span>
      <strong>${v.qtd}</strong>
      <span>R$ ${money(v.custo)}</span>
    </div>
  `).join("");

  $("todaySummary").innerHTML = `
    ${cards || `<div class="summary-card"><span>Sem registros</span><strong>0</strong><span>Hoje</span></div>`}
    <div class="summary-card">
      <span>Total dia</span>
      <strong>${totalQtd}</strong>
      <span>R$ ${money(totalCost)}</span>
    </div>
  `;
}

async function renderLastRecords() {
  const regs = await idbGetAll("registros");
  regs.sort((a, b) => new Date(b.hora_registro) - new Date(a.hora_registro));
  const top = regs.slice(0, 12);

  if (!top.length) {
    $("lastRecords").innerHTML = `<p class="hint">Nenhum registro local.</p>`;
    return;
  }

  $("lastRecords").innerHTML = `
    <table class="records-table">
      <thead>
        <tr>
          <th>Hora</th><th>Nome</th><th>Refeição</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${top.map((r) => `
          <tr>
            <td>${formatTime(r.hora_registro)}</td>
            <td>${escapeHtml(r.nome_completo)}</td>
            <td>${escapeHtml(r.refeicao_nome)}</td>
            <td>${r.sincronizado ? "OK" : "Pendente"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function exportLocalCsv() {
  const from = $("dateFrom").value;
  const to = $("dateTo").value;
  const regs = filterByDate(await idbGetAll("registros"), from, to);
  downloadCsv("registros_refeitorio_local.csv", regsToCsv(regs));
}

async function exportSupabaseCsv() {
  if (!sb || !navigator.onLine) {
    showToast("Precisa de internet para extrair do Supabase.", "bad");
    return;
  }

  const from = $("dateFrom").value;
  const to = $("dateTo").value;

  let query = sb.from("registros_refeicao").select("*").order("hora_registro", { ascending: true }).limit(10000);
  if (from) query = query.gte("data_refeicao", from);
  if (to) query = query.lte("data_refeicao", to);

  const { data, error } = await query;
  if (error) {
    showToast("Erro ao extrair: " + cleanError(error.message), "bad");
    return;
  }

  downloadCsv("registros_refeitorio_supabase.csv", regsToCsv(data || []));
}

/* ===========================
   Convidados
=========================== */

function openGuestDialog(tipo) {
  $("guestType").value = tipo;

  const isAdm = tipo === "convidado_adm";
  $("guestTitle").textContent = isAdm ? "Convidado ADM" : "Terceiro / Visitante";
  $("guestMatriculaBox").classList.toggle("hidden", !isAdm);
  $("guestUnidadeBox").classList.toggle("hidden", !isAdm);
  $("guestEmpresaBox").classList.toggle("hidden", isAdm);

  clearGuestForm();
  $("guestType").value = tipo;
  $("guestDialog").showModal();
}

function clearGuestForm() {
  ["guestName", "guestMatricula", "guestCpf", "guestUnidade", "guestEmpresa"].forEach((id) => $(id).value = "");
}

/* ===========================
   UI resultado e som
=========================== */

function okResult(title, msg) {
  $("resultBox").className = "result ok big-result";
  $("resultBox").innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`;
  playOk();
}

function failResult(title, msg, noMeal = false) {
  $("resultBox").className = "result bad big-result";
  $("resultBox").innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`;
  playFail();
}

function warnResult(title, msg) {
  $("resultBox").className = "result warn big-result";
  $("resultBox").innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`;
}

function neutralResult(title, msg) {
  $("resultBox").className = "result neutral big-result";
  $("resultBox").innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`;
}

function playOk() {
  beep(880, 0.08);
  setTimeout(() => beep(1175, 0.08), 90);
}

function playFail() {
  beep(180, 0.18);
}

function beep(freq = 800, duration = 0.1) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, duration * 1000);
  } catch (_) {}
}

function showToast(msg, type = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3800);
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  $("onlineStatus").textContent = online ? "Online" : "Offline";
  $("onlineStatus").className = online ? "pill ok" : "pill bad";
}

function setButtonLoading(id, loading, text) {
  const btn = $(id);
  btn.disabled = loading;
  btn.textContent = text;
}

/* ===========================
   Utils
=========================== */

function timeToMinutes(time) {
  const [h, m] = String(time).slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function safeTime(time) {
  return String(time || "00:00").slice(0, 5);
}

function toISODate(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDateBR(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function money(v) {
  return Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function maskCpf(cpf) {
  const d = onlyDigits(cpf);
  if (d.length < 4) return "***";
  return `***.***.***-${d.slice(-2)}`;
}

function filterByDate(rows, from, to) {
  return rows.filter((r) => {
    if (from && r.data_refeicao < from) return false;
    if (to && r.data_refeicao > to) return false;
    return true;
  });
}

function regsToCsv(rows) {
  const headers = [
    "data_refeicao","hora_registro","refeicao_nome","tipo_pessoa","matricula",
    "nome_completo","cpf_mascarado","empresa","unidade_origem","custo_refeicao",
    "qr_token","dispositivo_nome","origem","sincronizado"
  ];

  const lines = [headers.join(";")];

  for (const r of rows) {
    lines.push(headers.map((h) => csvCell(r[h])).join(";"));
  }

  return "\ufeff" + lines.join("\n");
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function downloadCsv(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#096;");
}

function cleanError(msg) {
  return String(msg || "erro desconhecido").replace(/JWT|token/gi, "autenticação");
}
