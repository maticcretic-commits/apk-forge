/* APK Forge Studio — front-end logic.
 * Talks only to https://api.github.com (with the user's token) and CDNs.
 * The token lives in localStorage and is never sent anywhere else. */
(function () {
  'use strict';
  const API = 'https://api.github.com';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- state ---------------- */
  const state = {
    step: 1,
    source: 'template',
    templateName: 'starter',
    zipFile: null,
    siteUrl: '',
    iconDataUrl: null, // null => auto-generate on the server
    orientation: 'portrait',
  };
  const gh = () => {
    let c = { owner: 'maticcretic-commits', repo: 'apk-forge', branch: 'main', token: '' };
    try { Object.assign(c, JSON.parse(localStorage.getItem('apkforge_gh') || '{}')); } catch (e) {}
    return c;
  };
  const ghSave = (c) => { try { localStorage.setItem('apkforge_gh', JSON.stringify(c)); } catch (e) {} };

  /* ---------------- helpers ---------------- */
  function b64encodeUnicode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function fileToDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  async function ghError(res) {
    let msg = '';
    try { const j = await res.json(); msg = j.message || ''; } catch (e) {}
    if (res.status === 401 || res.status === 403) return new Error('Token invalid or missing scopes (needs "repo" + "workflow"). ' + msg);
    if (res.status === 404) return new Error('Not found (404). Check the owner / repo / branch in Connect GitHub. ' + msg);
    if (res.status === 422) return new Error('GitHub rejected the request (422). ' + msg);
    return new Error('GitHub API error ' + res.status + '. ' + msg);
  }
  function authed() { return !!gh().token; }
  function h(path) { return { 'Authorization': 'Bearer ' + gh().token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }; }

  /* ---------------- wizard ---------------- */
  function goStep(n) {
    state.step = n;
    $$('.step').forEach((el) => el.classList.toggle('active', +el.dataset.step === n));
    $$('#stepsBar li').forEach((el) => {
      const s = +el.dataset.step;
      el.classList.toggle('active', s === n);
      el.classList.toggle('done', s < n);
    });
    if (n === 4) renderReview();
    $('#studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $$('#stepsBar li').forEach((li) => li.addEventListener('click', () => { if (+li.dataset.step < state.step) goStep(+li.dataset.step); }));
  $$('[data-next]').forEach((b) => b.addEventListener('click', () => { if (validateStep(state.step)) goStep(state.step + 1); }));
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => goStep(state.step - 1)));

  function validateStep(n) {
    if (n === 1) {
      if (state.source === 'zip' && !state.zipFile) return toast('Please choose a .zip file first.'), false;
      if (state.source === 'url') {
        const u = $('#siteUrl').value.trim();
        if (!/^https?:\/\/.+\..+/.test(u)) return toast('Please enter a valid website URL starting with http(s)://.'), false;
        state.siteUrl = u;
      }
      return true;
    }
    if (n === 2) {
      if (!validPackage($('#packageId').value.trim())) return toast('Package ID is invalid — fix it to continue.'), false;
      const vc = parseInt($('#versionCode').value, 10);
      if (!vc || vc < 1) return toast('Version code must be a positive number.'), false;
      if (!$('#appName').value.trim()) return toast('Please enter an app name.'), false;
      return true;
    }
    return true;
  }
  let toastT = null;
  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ---------------- source step ---------------- */
  $$('.source-card').forEach((c) => c.addEventListener('click', () => {
    $$('.source-card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    state.source = c.dataset.source;
    $$('.source-detail').forEach((d) => d.classList.add('hidden'));
    $('#detail-' + state.source).classList.remove('hidden');
    updatePreview();
  }));
  $$('.tpl-card').forEach((c) => c.addEventListener('click', () => {
    $$('.tpl-card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    state.templateName = c.dataset.template;
    updatePreview();
  }));

  const zipInput = $('#zipInput');
  $('#zipDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('#zipDrop').classList.add('drag'); });
  $('#zipDrop').addEventListener('dragleave', () => $('#zipDrop').classList.remove('drag'));
  $('#zipDrop').addEventListener('drop', (e) => { e.preventDefault(); $('#zipDrop').classList.remove('drag'); if (e.dataTransfer.files[0]) setZip(e.dataTransfer.files[0]); });
  zipInput.addEventListener('change', () => { if (zipInput.files[0]) setZip(zipInput.files[0]); });
  function setZip(f) {
    if (!/\.zip$/i.test(f.name)) return toast('Please choose a .zip file.');
    state.zipFile = f;
    $('#zipLabel').textContent = '📦 ' + f.name + ' (' + (f.size / 1024).toFixed(0) + ' KB)';
    updatePreview();
  }
  $('#siteUrl').addEventListener('input', () => { state.siteUrl = $('#siteUrl').value.trim(); if (state.source === 'url') updatePreview(); });

  /* ---------------- phone preview ---------------- */
  const frame = $('#previewFrame'), pLoad = $('#previewLoading'), pCap = $('#previewCaption'), pNote = $('#previewNote');
  let blobUrl = null, previewT = null;
  const CDN_TPL = 'https://cdn.jsdelivr.net/gh/maticcretic-commits/apk-forge@main/templates';
  const STARTER_HTML = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Hello Forge</title><style>*{margin:0;box-sizing:border-box}body{font-family:sans-serif;min-height:100vh;color:#fff;background:linear-gradient(160deg,#1a1033,#2b1a5e 50%,#101a3a);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;text-align:center}.orb{width:84px;height:84px;border-radius:26px;background:linear-gradient(135deg,#a06bff,#5b2ee5);display:flex;align-items:center;justify-content:center;font-size:42px;margin-bottom:24px}h1{font-size:30px;margin-bottom:10px}p{opacity:.75;line-height:1.6;margin-bottom:28px}button{border:0;font-size:17px;font-weight:700;color:#fff;padding:15px 38px;border-radius:999px;background:linear-gradient(90deg,#7c4dff,#4f9cf9)}</style></head><body><div class="orb">⚒️</div><h1>Hello from APK Forge</h1><p>Live preview of the Starter template.</p><button onclick="this.textContent=\'Tapped! 🎉\'">Tap me</button></body></html>';

  function showLoading() { pLoad.style.display = 'flex'; clearTimeout(previewT); previewT = setTimeout(() => { pLoad.style.display = 'none'; }, 12000); }
  frame.addEventListener('load', () => { pLoad.style.display = 'none'; });

  function updatePreview() {
    showLoading();
    pNote.classList.add('hidden');
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    if (state.source === 'template') {
      if (state.templateName === 'starter') {
        pCap.textContent = 'Live preview · Starter template';
        frame.removeAttribute('src');
        frame.srcdoc = STARTER_HTML;
      } else {
        pCap.textContent = 'Live preview · BPSC Current Affairs template';
        frame.removeAttribute('srcdoc');
        frame.src = CDN_TPL + '/current-affairs/index.html';
      }
    } else if (state.source === 'zip') {
      pCap.textContent = state.zipFile ? 'Live preview · ' + state.zipFile.name : 'Live preview';
      frame.removeAttribute('srcdoc');
      if (!state.zipFile || typeof JSZip === 'undefined') { frame.removeAttribute('src'); pLoad.style.display = 'none'; return; }
      JSZip.loadAsync(state.zipFile).then((zip) => {
        let f = null;
        zip.forEach((p, e) => { if (!e.dir && /(^|\/)index\.html$/i.test(p) && !/__MACOSX/.test(p) && !f) f = e; });
        if (!f) { pLoad.style.display = 'none'; pCap.textContent = 'No index.html found in this ZIP'; return; }
        return f.async('blob').then((b) => { blobUrl = URL.createObjectURL(b); frame.src = blobUrl; });
      }).catch(() => { pLoad.style.display = 'none'; pCap.textContent = 'Could not read this ZIP'; });
    } else {
      pCap.textContent = 'Live preview · Website';
      frame.removeAttribute('srcdoc');
      if (state.siteUrl && /^https?:\/\//.test(state.siteUrl)) {
        frame.src = state.siteUrl;
        pNote.classList.remove('hidden');
      } else { frame.removeAttribute('src'); pLoad.style.display = 'none'; }
    }
  }

  /* ---------------- branding ---------------- */
  function validPackage(v) { return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(v); }
  const pkgInput = $('#packageId'), pkgMsg = $('#packageMsg');
  function checkPackage() {
    const v = pkgInput.value.trim();
    if (validPackage(v)) { pkgMsg.textContent = '✓ Looks good'; pkgMsg.className = 'field-msg good'; }
    else { pkgMsg.textContent = '✕ lowercase letters/digits, 2+ segments, each starting with a letter'; pkgMsg.className = 'field-msg bad'; }
  }
  pkgInput.addEventListener('input', checkPackage); checkPackage();

  function defaultIcon(name, color) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 256, 256); g.addColorStop(0, color); g.addColorStop(1, '#1a1033');
    x.fillStyle = g;
    x.beginPath(); x.roundRect(0, 0, 256, 256, 56); x.fill();
    x.fillStyle = '#fff'; x.font = 'bold 120px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText((name.trim()[0] || 'A').toUpperCase(), 128, 140);
    return c.toDataURL('image/png');
  }
  function refreshIcon() {
    const url = state.iconDataUrl || defaultIcon($('#appName').value, $('#themeColor').value);
    $('#iconPreview').src = url; $('#hsIcon').src = url;
    $('#iconDrop').classList.toggle('has-img', !!state.iconDataUrl);
  }
  $('#iconInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    state.iconDataUrl = await fileToDataURL(f);
    refreshIcon();
  });
  $('#appName').addEventListener('input', () => { $('#hsName').textContent = $('#appName').value.trim() || 'My Forge App'; if (!state.iconDataUrl) refreshIcon(); });
  $('#themeColor').addEventListener('input', () => { $('#themeHex').textContent = $('#themeColor').value; if (!state.iconDataUrl) refreshIcon(); });
  $('#splashColor').addEventListener('input', () => { $('#splashHex').textContent = $('#splashColor').value; });
  refreshIcon();

  /* ---------------- options ---------------- */
  $$('#orientationSeg button').forEach((b) => b.addEventListener('click', () => {
    $$('#orientationSeg button').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
    state.orientation = b.dataset.value;
  }));

  /* ---------------- review ---------------- */
  function config() {
    return {
      appName: $('#appName').value.trim(),
      packageId: $('#packageId').value.trim(),
      versionName: $('#versionName').value.trim() || '1.0.0',
      versionCode: parseInt($('#versionCode').value, 10) || 1,
      orientation: state.orientation,
      splashColor: $('#splashColor').value,
      themeColor: $('#themeColor').value,
      sourceType: state.source,
      templateName: state.templateName,
      includeAab: $('#includeAab').checked,
    };
  }
  function sourceLabel() {
    if (state.source === 'template') return state.templateName === 'starter' ? 'Template · Starter' : 'Template · BPSC Current Affairs';
    if (state.source === 'zip') return 'ZIP · ' + (state.zipFile ? state.zipFile.name : '—');
    return 'Website · ' + (state.siteUrl || '—');
  }
  function renderReview() {
    const c = config();
    $('#reviewList').innerHTML =
      row('App name', esc(c.appName)) + row('Package ID', esc(c.packageId), true) +
      row('Version', esc(c.versionName) + ' (' + c.versionCode + ')') +
      row('Source', esc(sourceLabel())) + row('Orientation', esc(c.orientation)) +
      row('Splash', '<span class="swatch" style="background:' + esc(c.splashColor) + '"></span>' + esc(c.splashColor)) +
      row('Theme', '<span class="swatch" style="background:' + esc(c.themeColor) + '"></span>' + esc(c.themeColor)) +
      row('AAB for Play', c.includeAab ? 'Yes' : 'No');
  }
  const row = (k, v, mono) => '<div><dt>' + k + '</dt><dd class="' + (mono ? 'mono' : '') + '">' + v + '</dd></div>';

  /* ---------------- connect modal ---------------- */
  const modal = $('#connectModal');
  function openModal() {
    const c = gh();
    $('#ghOwner').value = c.owner; $('#ghRepo').value = c.repo; $('#ghBranch').value = c.branch;
    $('#ghToken').value = c.token || '';
    $('#connectTest').classList.add('hidden');
    modal.classList.remove('hidden');
  }
  function closeModal() { modal.classList.add('hidden'); }
  $('#connectBtn').addEventListener('click', openModal);
  $('#connectCancel').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  $('#connectSave').addEventListener('click', async () => {
    const c = { owner: $('#ghOwner').value.trim(), repo: $('#ghRepo').value.trim(), branch: $('#ghBranch').value.trim(), token: $('#ghToken').value.trim() };
    const box = $('#connectTest');
    if (!c.token) { box.textContent = 'Please paste a token.'; box.classList.remove('hidden'); return; }
    const btn = $('#connectSave'); btn.disabled = true; btn.textContent = 'Testing…';
    try {
      const res = await fetch(API + '/user', { headers: { 'Authorization': 'Bearer ' + c.token, 'Accept': 'application/vnd.github+json' } });
      if (!res.ok) throw await ghError(res);
      const me = await res.json();
      const rr = await fetch(API + '/repos/' + c.owner + '/' + c.repo + '/actions/workflows/forge.yml', { headers: { 'Authorization': 'Bearer ' + c.token, 'Accept': 'application/vnd.github+json' } });
      if (!rr.ok) throw new Error('Token works, but the forge workflow was not found in ' + c.owner + '/' + c.repo + ' @ ' + c.branch + '.');
      ghSave(c);
      markConnected(me.login);
      closeModal();
      toast('Connected as @' + me.login + ' ✓');
    } catch (err) {
      box.textContent = err.message;
      box.classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = 'Test & save'; }
  });
  function markConnected(login) {
    const b = $('#connectBtn');
    b.classList.add('connected');
    b.textContent = '✓ @' + (login || gh().owner);
  }
  if (authed()) markConnected();

  /* ---------------- forge flow ---------------- */
  const forgeBtn = $('#forgeBtn'), forgeError = $('#forgeError');
  let watching = false, watchTimer = null;

  forgeBtn.addEventListener('click', async () => {
    forgeError.classList.add('hidden');
    if (!authed()) { openModal(); toast('Connect GitHub first — it takes 30 seconds.'); return; }
    if (!validateStep(1) || !validateStep(2)) { goStep(1); return; }
    forgeBtn.disabled = true; forgeBtn.textContent = '⏳ Uploading…';
    try {
      const buildId = 'b' + Date.now().toString(36);
      const cfg = config();
      const base = 'builds/' + buildId;
      await putFile(base + '/config.json', b64encodeUnicode(JSON.stringify(cfg, null, 2)), 'forge: add build ' + buildId);
      if (state.iconDataUrl) {
        await putFile(base + '/icon.png', state.iconDataUrl.split(',')[1], 'forge: add icon for ' + buildId);
      }
      if (state.source === 'zip') {
        forgeBtn.textContent = '⏳ Uploading ZIP…';
        await putFile(base + '/source.zip', (await fileToDataURL(state.zipFile)).split(',')[1], 'forge: add source for ' + buildId);
      } else if (state.source === 'url') {
        await putFile(base + '/url.txt', b64encodeUnicode(state.siteUrl + '\n'), 'forge: add URL for ' + buildId);
      }
      forgeBtn.textContent = '⏳ Starting build…';
      await dispatchBuild(buildId);
      startWatching(buildId);
    } catch (err) {
      forgeError.textContent = '⚠️ ' + err.message;
      forgeError.classList.remove('hidden');
      forgeBtn.disabled = false; forgeBtn.textContent = '⚒️ FORGE MY APK';
    }
  });

  async function putFile(repoPath, b64, message) {
    const c = gh();
    const enc = repoPath.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(API + '/repos/' + c.owner + '/' + c.repo + '/contents/' + enc, {
      method: 'PUT', headers: h(),
      body: JSON.stringify({ message: message, content: b64, branch: c.branch }),
    });
    if (!res.ok) throw await ghError(res);
  }
  async function dispatchBuild(buildId) {
    const c = gh();
    const res = await fetch(API + '/repos/' + c.owner + '/' + c.repo + '/actions/workflows/forge.yml/dispatches', {
      method: 'POST', headers: h(),
      body: JSON.stringify({ ref: c.branch, inputs: { build_id: buildId } }),
    });
    if (res.status === 204) return;
    throw await ghError(res);
  }

  /* ---------------- build watcher ---------------- */
  const STAGES = ['queued', 'preparing', 'building', 'signing', 'publishing'];
  const STAGE_PATTERNS = [
    [/checkout/i, 'preparing'], [/set up|install android/i, 'preparing'],
    [/scaffold/i, 'preparing'], [/build release/i, 'building'],
    [/sign|verify/i, 'signing'], [/upload build artifacts|publish/i, 'publishing'],
  ];
  function startWatching(buildId) {
    stopWatching();
    watching = true;
    $('#progress').classList.remove('hidden');
    $('#success').classList.add('hidden');
    $('#progressBuildId').textContent = buildId;
    $('#progress').scrollIntoView({ behavior: 'smooth' });
    forgeBtn.disabled = false; forgeBtn.textContent = '⚒️ FORGE MY APK';
    const t0 = Date.now();
    const tick = async () => {
      if (!watching) return;
      try {
        const run = await findRun(buildId);
        $('#runLink').href = run.html_url;
        $('#keystoreRunLink').href = run.html_url;
        const mins = Math.floor((Date.now() - t0) / 60000);
        $('#progressSub').innerHTML = 'Build <code>' + esc(buildId) + '</code> · running ' + mins + ' min · <a href="#history">find it later under Builds</a>';
        await renderTimeline(run);
        if (run.status === 'completed') {
          watching = false;
          if (run.conclusion === 'success') await onBuildSuccess(buildId);
          else onBuildFailure(run);
          return;
        }
      } catch (err) {
        $('#progressSub').textContent = '⚠️ ' + err.message;
        watching = false;
        return;
      }
      watchTimer = setTimeout(tick, 15000);
    };
    tick();
  }
  function stopWatching() { watching = false; clearTimeout(watchTimer); }
  $('#cancelWatch').addEventListener('click', () => { stopWatching(); $('#progress').classList.add('hidden'); $('#studio').scrollIntoView({ behavior: 'smooth' }); });
  $('#forgeAnother').addEventListener('click', () => { $('#success').classList.add('hidden'); goStep(1); });

  let cachedRun = null;
  async function findRun(buildId) {
    if (cachedRun && cachedRun.name === 'Forge ' + buildId) return cachedRun;
    const c = gh();
    for (let i = 0; i < 18; i++) {
      const res = await fetch(API + '/repos/' + c.owner + '/' + c.repo + '/actions/workflows/forge.yml/runs?event=workflow_dispatch&per_page=10', { headers: h() });
      if (!res.ok) throw await ghError(res);
      const data = await res.json();
      const run = (data.workflow_runs || []).find((r) => r.name === 'Forge ' + buildId);
      if (run) { cachedRun = run; return run; }
      await sleep(10000);
    }
    throw new Error('The build was dispatched but its run is not showing yet — check the Actions tab in your repo.');
  }
  async function renderTimeline(run) {
    const c = gh();
    const jr = await fetch(run.jobs_url + '?per_page=5', { headers: h() });
    const jobs = jr.ok ? (await jr.json()).jobs : [];
    const steps = jobs.length ? jobs[0].steps || [] : [];
    const stageOf = (name) => { for (const [re, s] of STAGE_PATTERNS) if (re.test(name)) return s; return null; };
    const info = {};
    STAGES.forEach((s) => info[s] = { steps: [] });
    steps.forEach((st) => { const s = stageOf(st.name); if (s) info[s].steps.push(st); });

    const liState = {};
    if (run.status === 'queued') liState.queued = 'active';
    else {
      liState.queued = 'done';
      STAGES.slice(1).forEach((s) => {
        const ss = info[s].steps;
        if (!ss.length) liState[s] = '';
        else if (ss.some((x) => x.conclusion === 'failure' || x.conclusion === 'cancelled')) liState[s] = 'failed';
        else if (ss.some((x) => x.status === 'in_progress')) liState[s] = 'active';
        else if (ss.every((x) => x.status === 'completed')) liState[s] = 'done';
        else liState[s] = '';
      });
      // light up the first pending stage once earlier ones are done
      let seenActive = false;
      for (const s of STAGES.slice(1)) {
        if (liState[s] === 'active') { seenActive = true; break; }
      }
      if (!seenActive && run.status !== 'completed') {
        for (const s of STAGES.slice(1)) {
          if (liState[s] === 'done') continue;
          if (liState[s] !== 'failed') { liState[s] = 'active'; break; }
          break;
        }
      }
      if (run.status === 'completed') {
        STAGES.forEach((s) => { if (!liState[s] || liState[s] === 'active') liState[s] = run.conclusion === 'success' ? 'done' : liState[s]; });
      }
    }
    $$('#timeline li').forEach((li) => {
      li.className = liState[li.dataset.stage] || '';
    });
  }

  async function onBuildSuccess(buildId) {
    const c = gh();
    $$('#timeline li').forEach((li) => li.className = 'done');
    $('#progressSub').textContent = 'Build finished — fetching your downloads…';
    await sleep(4000); // give the release a moment to appear
    let rel = null;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(API + '/repos/' + c.owner + '/' + c.repo + '/releases/tags/forge-' + buildId);
      if (res.ok) { rel = await res.json(); break; }
      await sleep(10000);
    }
    $('#progress').classList.add('hidden');
    const box = $('#success');
    box.classList.remove('hidden');
    const cfg = config();
    $('#successName').textContent = cfg.appName + ' v' + cfg.versionName + ' is signed and ready to install.';
    const dl = $('#dlButtons');
    dl.innerHTML = '';
    if (rel) {
      (rel.assets || []).forEach((a) => {
        const isApk = /\.apk$/i.test(a.name), isAab = /\.aab$/i.test(a.name);
        if (!isApk && !isAab) return;
        const b = document.createElement('a');
        b.className = 'btn btn-lg ' + (isApk ? 'btn-primary' : 'btn-ghost');
        b.href = a.browser_download_url;
        b.textContent = isApk ? '⬇ Download APK (' + fmtSize(a.size) + ')' : '⬇ Download AAB (' + fmtSize(a.size) + ')';
        dl.appendChild(b);
      });
    }
    if (!dl.children.length) {
      dl.innerHTML = '<p class="hint">Release is publishing — <a href="#history">check Build history</a> in a minute.</p>';
    }
    box.scrollIntoView({ behavior: 'smooth' });
    if (typeof confetti === 'function') {
      confetti({ particleCount: 170, spread: 80, origin: { y: 0.6 } });
      setTimeout(() => confetti({ particleCount: 90, angle: 60, spread: 60, origin: { x: 0 } }), 350);
      setTimeout(() => confetti({ particleCount: 90, angle: 120, spread: 60, origin: { x: 1 } }), 550);
    }
    loadHistory();
  }
  function onBuildFailure(run) {
    $$('#timeline li').forEach((li) => { if (!li.className) li.className = ''; });
    $('#progressSub').innerHTML = '⚠️ Build failed. <a href="' + run.html_url + '" target="_blank" rel="noopener">Open the run logs</a> to see which step failed, fix the input, and forge again.';
  }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  /* ---------------- build history ---------------- */
  async function loadHistory() {
    const list = $('#historyList');
    const c = gh();
    try {
      const res = await fetch(API + '/repos/' + c.owner + '/' + c.repo + '/releases?per_page=20');
      if (!res.ok) throw new Error('status ' + res.status);
      const rels = (await res.json()).filter((r) => (r.tag_name || '').indexOf('forge-') === 0);
      if (!rels.length) { list.innerHTML = '<p class="hint">No builds yet — forge your first APK above! ⚒️</p>'; return; }
      list.innerHTML = '';
      rels.forEach((r) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'build-row';
        const d = new Date(r.published_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        let btns = '';
        (r.assets || []).forEach((a) => {
          if (/\.apk$/i.test(a.name)) btns += '<a class="btn btn-primary" href="' + a.browser_download_url + '">⬇ APK</a>';
          else if (/\.aab$/i.test(a.name)) btns += '<a class="btn btn-ghost" href="' + a.browser_download_url + '">⬇ AAB</a>';
        });
        rowEl.innerHTML = '<span class="build-icon">📱</span><div class="build-meta"><b>' + esc(r.name || r.tag_name) + '</b><span>' + d + ' · ' + esc(r.tag_name) + '</span></div><div class="build-dl">' + (btns || '<span class="hint">publishing…</span>') + '</div>';
        list.appendChild(rowEl);
      });
    } catch (e) {
      list.innerHTML = '<p class="hint">Could not load builds. Check your connection and refresh.</p>';
    }
  }

  /* ---------------- init ---------------- */
  updatePreview();
  loadHistory();
})();
