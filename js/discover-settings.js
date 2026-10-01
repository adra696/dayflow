import { showToast, plural, settingsGroupHTML } from './utils.js';
import { curScreen } from './state.js';
import {
  FEED, TTSC, FEED_KEY_LS, FEED_PREFS_LS, FEED_AREAS, escFeed, feedKey, loadFeedPrefs, saveFeedCache, feedAreaLabel, loadFeedTopics,
  cloudOn, feedAIReady, feedFnFetch, feedHttpError, refreshFeedSettings
} from './discover-state.js';
import { GEMINI_API, GEMINI_MODEL_LS, GEMINI_MODEL_RE, FEED_SEEN_LS, feedModel, loadFeedSeen, feedErrorMessage } from './discover-gemini.js';
import {
  feedPoolLeft, feedEvQ, feedSetStore, saveFeedSetStore, feedSettings, feedPrefs, changeFeedSettings, syncFeedSettings, loadFeedFollows
} from './discover-cloud.js';
import {
  TTS_RATE, FEED_TTS_VOICE_LS, FEED_TTS_ENGINE_LS, FEED_TTS_CLOUD_VOICE_LS, TTS_CLOUD_VOICE_RE,
  ttsSupported, ttsItVoices, ttsVoice, ttsEngine, ttsCloudVoice, loadTtsCloudVoices, ttsUnlock, ttsSynth, ttsAudio, ttsApplyRate,
  stopArticleSpeech
} from './discover-tts.js';
import { closeFeedSheet } from './discover-article.js';
import { renderDiscover } from './discover.js';

// Discover — pagine Discover (#settings-discover-body) e Ascolta (#settings-tts-body) del pannello
// Impostazioni e tutte le loro azioni: argomenti, cloud (area, profilo dei gusti, preferenze, storie
// seguite), chiave API, modello Gemini, cache, cronologia, interessi; voce di "Ascolta" (renderTtsSettings).
const GEMINI_MODELS_LS = 'dayflow_gemini_models';  // elenco caricato dalla chiave { ts, models: [{ id, label }] }
const GEMINI_PRESETS = [
  { id: 'gemini-2.5-flash', label: 'Flash', note: 'bilanciato (default)' },
  { id: 'gemini-2.5-flash-lite', label: 'Flash-Lite', note: 'più veloce, quota più alta' },
  { id: 'gemini-2.5-pro', label: 'Pro', note: 'più qualità, più lento, quota bassa' }
];
const FEED_PROFILE_MAX = 1500;

// Impostazioni Discover: markup unico, renderizzabile in qualsiasi contenitore.
// Oggi l'unico contenitore è #settings-discover-body (pagina Discover del pannello Impostazioni);
// le azioni (chiave, modello, cache, cronologia, interessi) ri-renderizzano con refreshFeedSettings(),
// che ridisegna la pagina Discover o Ascolta se è quella visibile.
function renderFeedSettings(b) {
  if (!b) return;
  // Il profilo dei gusti in modifica sopravvive ai re-render (caricamenti in background, altre azioni)
  const prev = document.getElementById('set-feed-profile');
  const keep = prev && prev.dataset.dirty ? { value: prev.value, focus: document.activeElement === prev } : null;
  b.innerHTML = feedSettingsHTML();
  if (keep) {
    const ta = document.getElementById('set-feed-profile');
    if (ta) { ta.value = keep.value; ta.dataset.dirty = '1'; if (keep.focus) ta.focus({ preventScroll: true }); }
  }
  // Dati del cloud (area, profilo, preferenze, storie seguite): ricaricati all'apertura, al massimo ogni 30 s
  if (cloudOn() && Date.now() - FEED.setFetchedAt > 30000) {
    FEED.setFetchedAt = Date.now();
    Promise.allSettled([syncFeedSettings(), loadFeedFollows(true)]).then(refreshFeedSettings);
  }
}
function feedSettingsHTML() {
  const key = feedKey();
  const masked = key ? key.slice(0, 6) + '••••••••' + key.slice(-4) : '';
  const seen = loadFeedSeen();
  const prefs = loadFeedPrefs();
  const cloud = cloudOn();
  const left = FEED.pool ? feedPoolLeft(null).length : 0;
  if (!FEED.topics.length) loadFeedTopics();
  const nTopics = FEED.topics.length;
  const topicsG = settingsGroupHTML('Argomenti', `
    <button class="settings-nav" type="button" onclick="closeSettings(false); openFeedSheet('topics')">
      <span class="settings-nav-ico" aria-hidden="true">🏷️</span>
      <span class="settings-nav-lbl"><span class="settings-nav-name">Gestisci argomenti</span></span>
      <span class="settings-nav-val">${nTopics ? plural(nTopics, 'attivo', 'attivi') : ''}</span>
      <span class="settings-nav-chev" aria-hidden="true">›</span>
    </button>`, 'Aggiungi o togli argomenti; con ✎ scegli per ciascuno focus, esclusioni, area e livello.');
  const cloudRow = cloud ? `
    <div class="settings-row">
      <div class="settings-lbl">Notizie dal cloud</div>
      <div class="settings-val">${FEED.pool ? `${FEED.pool.length} nelle ultime 72 ore · ${left} ancora da vedere` : 'Non ancora caricate: apri Discover'}</div>
      <div class="feed-hint">Ogni mattina alle 6 il cloud cerca notizie vere sui tuoi argomenti; quando stanno per finire ne prepara altre. L'ordine segue quello che apri.${feedEvQ().length ? ` · ${feedEvQ().length} interazioni in attesa di invio` : ''}</div>
    </div>` : '';
  const aiG = settingsGroupHTML(cloud ? 'Modello AI' : 'Gemini', `
    <div class="settings-row">
      <div class="settings-lbl">${cloud ? 'Chiave API Gemini locale (facoltativa)' : 'Chiave API Gemini'}</div>
      <div class="settings-val">${key ? escFeed(masked) : cloud ? 'Nessuna · Discover usa la chiave nel cloud' : 'Nessuna chiave salvata'}</div>
      <div class="feed-key-wrap">
        <input class="form-input" id="settings-key-input" type="password" placeholder="${key ? 'Incolla una nuova chiave per sostituirla' : 'AIza…'}" autocomplete="off" spellcheck="false" onkeydown="if(event.key==='Enter') saveFeedKey('settings-key-input')">
        <button class="feed-eye" type="button" onclick="toggleFeedKeyVis('settings-key-input')" aria-label="Mostra chiave"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
      </div>
      <div class="form-btns" style="margin-top:10px">
        <button class="btn-pri" onclick="saveFeedKey('settings-key-input')">Salva chiave</button>
        ${key ? '<button class="btn-del" onclick="removeFeedKey()">Rimuovi</button>' : ''}
      </div>
      <div class="feed-hint" style="margin-top:10px">${cloud ? "Con l'account DayFlow notizie, approfondimenti e chat passano dal cloud (Supabase): la chiave Gemini resta nei suoi segreti e non arriva su questo dispositivo. Una chiave locale serve solo come riserva se il cloud non risponde: se non ti serve, rimuovila." : 'La chiave resta solo in questo browser (localStorage) e non viene mai inviata a DayFlow o Supabase.'} <a class="feed-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio →</a></div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Modello</div>
      ${renderFeedModelPicker(feedAIReady())}
    </div>`);
  const memG = settingsGroupHTML('Memoria e cache', `
    <div class="settings-row">
      <div class="settings-lbl">Cache</div>
      <div class="settings-val">${FEED.data ? `Feed di oggi generato alle ${new Date(FEED.data.generatedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} · ${FEED.data.cards.length} card` : 'Nessun feed in cache'}</div>
      <div class="form-btns" style="margin-top:0">
        <button class="btn-sec" onclick="clearFeedCache()" ${FEED.data ? '' : 'disabled'}>Svuota cache di oggi</button>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">${cloud ? 'Cronologia locale (72h, solo generazione di riserva)' : 'Cronologia (72h)'}</div>
      <div class="settings-val">${seen.length ? `${seen.length} notizie ricordate · Gemini evita di riproporle` : 'Nessuna notizia recente'}</div>
      <div class="form-btns" style="margin-top:0">
        <button class="btn-sec" onclick="clearFeedSeen()" ${seen.length ? '' : 'disabled'}>Dimentica tutto</button>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Interessi (14 giorni)</div>
      <div class="settings-val">${prefs.length ? `${prefs.length} notizie aperte o discusse · guidano i prossimi feed` : 'Ancora nessun segnale: apri un articolo o fai una domanda'}</div>
      <div class="form-btns" style="margin-top:0">
        <button class="btn-sec" onclick="clearFeedPrefs()" ${prefs.length ? '' : 'disabled'}>Azzera interessi</button>
      </div>
    </div>`, 'Trascina il feed verso il basso dalla prima card per aggiornarlo; arrivato in fondo, altre notizie si caricano da sole.');
  // Senza account la chiave è indispensabile: il gruppo Gemini sale subito dopo gli argomenti
  return cloud ? topicsG + feedCloudSettingsHTML(cloudRow) + aiG + memG : topicsG + aiG + memG;
}
// Gruppi cloud delle impostazioni Discover: notizie (cloudRow), area generale, profilo dei gusti,
// preferenze da 👍/👎, storie seguite.
function feedCloudSettingsHTML(cloudRow = '') {
  const fs = feedSettings();
  const area = FEED_AREAS.some(a => a.id === fs.area) ? fs.area : 'misto';
  const pr = feedPrefs();
  const when = fs.profileAt && !isNaN(Date.parse(fs.profileAt)) ? new Date(fs.profileAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }) : '';
  const profMeta = !fs.profile ? 'Ancora nessun profilo: si crea da solo quando avrai reagito ad almeno 5 notizie, oppure scrivilo tu.'
    : fs.profileManual ? `Scritto da te${when ? ' il ' + when : ''}: non viene rigenerato in automatico. "Rigenera" torna a quello automatico.`
      : `Generato automaticamente${when ? ' il ' + when : ''} dalle tue reazioni; si aggiorna ogni settimana finché non lo modifichi.`;
  const topicLbl = id => { const t = FEED.topics.find(x => x.id === id); return t ? t.label : id; };
  const subLbl = v => { const i = v.indexOf(':'); return i > 0 ? `${topicLbl(v.slice(0, i))} · ${v.slice(i + 1)}` : v; };
  const prefList = (list, key, fmt) => list.length
    ? `<div class="pref-list">${list.map((v, i) => `<div class="pref-row"><span class="pref-txt">${escFeed(fmt(v))}</span><button class="topic-del pref-del" onclick="removeFeedPref('${key}', ${i})" aria-label="Rimuovi ${escFeed(fmt(v))}">×</button></div>`).join('')}</div>`
    : '<div class="settings-val pref-empty">Nessuna</div>';
  const follows = FEED.follows || [];
  const followHTML = FEED.follows == null ? '<div class="settings-val">Caricamento…</div>'
    : FEED.followsErr && !follows.length ? '<div class="settings-val">Non disponibili (serve lo SQL 04 su Supabase).</div>'
      : !follows.length ? '<div class="settings-val">Nessuna storia seguita. Tocca 👍 su una notizia e scegli "Segui la storia".</div>'
        : follows.map((f, i) => {
          const until = f.until ? new Date(f.until).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';
          return `<div class="follow-row"><div class="follow-txt"><div class="follow-title">${escFeed(f.title)}</div><div class="feed-hint">${escFeed(topicLbl(f.topic_id))}${until ? ' · fino al ' + escFeed(until) : ''}${f.updates ? ' · ' + plural(f.updates, 'aggiornamento', 'aggiornamenti') : ''}</div></div><button class="btn-sec follow-stop" onclick="unfollowFeedStory(${i})">Smetti di seguire</button></div>`;
        }).join('');
  return settingsGroupHTML('Notizie e profilo', `${cloudRow}
    <div class="settings-row">
      <label class="settings-lbl" for="set-feed-area" style="display:block">Area geografica</label>
      <select class="form-select" id="set-feed-area" onchange="setFeedArea(this.value)">${FEED_AREAS.map(a => `<option value="${a.id}"${a.id === area ? ' selected' : ''}>${escFeed(a.label)}${a.note ? ' · ' + escFeed(a.note) : ''}</option>`).join('')}</select>
      <div class="feed-hint" style="margin-top:8px">Vale per tutti gli argomenti, tranne quelli con un'area propria (Argomenti → ✎).</div>
    </div>
    <div class="settings-row">
      <label class="settings-lbl" for="set-feed-profile" style="display:block">Profilo dei gusti</label>
      <textarea class="form-input feed-profile" id="set-feed-profile" rows="5" maxlength="${FEED_PROFILE_MAX}" placeholder="Es. Mi interessano le startup italiane e i chip; poco sport minore, niente gossip." oninput="this.dataset.dirty='1'">${escFeed(fs.profile || '')}</textarea>
      <div class="feed-hint" style="margin-top:8px">${escFeed(profMeta)}</div>
      <div class="form-btns" style="margin-top:10px">
        <button class="btn-pri" onclick="saveFeedProfile()">Salva</button>
        <button class="btn-sec" onclick="regenFeedProfile()" ${FEED.profileBusy ? 'disabled' : ''}>${FEED.profileBusy ? 'Rigenero…' : '↻ Rigenera'}</button>
      </div>
    </div>`)
    + settingsGroupHTML('Preferenze da 👍 / 👎', `
    <div class="settings-row">
      <div class="pref-h">Di più su</div>${prefList(pr.moreSub, 'moreSub', subLbl)}
      <div class="pref-h">Meno su</div>${prefList(pr.lessSub, 'lessSub', subLbl)}
      <div class="pref-h">Fonti bloccate</div>${prefList(pr.blockedSources, 'blockedSources', v => v)}
    </div>`, 'Si riempiono dalle scelte che compaiono dopo 👍 o 👎 su una notizia; tocca × per togliere una voce.')
    + settingsGroupHTML('Storie seguite', `
    <div class="settings-row">
      ${followHTML}
    </div>`, 'Per 14 giorni il cloud cerca ogni mattina le novità: arrivano nel feed col badge "↻ Aggiornamento".');
}
function setFeedArea(v) {
  if (!FEED_AREAS.some(a => a.id === v)) return;
  changeFeedSettings([{ k: 'area', v }]);
  showToast('Area: ' + feedAreaLabel(v) + ' · vale dalle prossime notizie', 'info', 2200);
  refreshFeedSettings();
}
function saveFeedProfile() {
  const ta = document.getElementById('set-feed-profile');
  const text = (ta ? ta.value : '').trim().slice(0, FEED_PROFILE_MAX);
  // Profilo svuotato = torna a quello automatico
  changeFeedSettings([{ k: 'profile', v: text }, { k: 'profileManual', v: !!text }, { k: 'profileAt', v: new Date().toISOString() }]);
  if (ta) delete ta.dataset.dirty;
  showToast(text ? 'Profilo salvato' : 'Profilo svuotato: tornerà quello automatico', 'info', 2200);
  refreshFeedSettings();
}
async function regenFeedProfile() {
  if (!cloudOn() || FEED.profileBusy) return;
  FEED.profileBusy = true;
  const ta = document.getElementById('set-feed-profile'); if (ta) delete ta.dataset.dirty;
  refreshFeedSettings();
  try {
    const res = await feedFnFetch({ mode: 'profile' });
    if (!res.ok) throw await feedHttpError(res);
    let j = null; try { j = await res.json(); } catch (e) { }
    if (!j || typeof j.profile !== 'string') throw Object.assign(new Error('parse'), { code: 'parse' });
    // La funzione ha già scritto il profilo in feed_settings: aggiorno solo la copia locale
    const st = feedSetStore();
    st.s = Object.assign({}, st.s, { profile: j.profile, profileAt: j.profileAt || new Date().toISOString(), profileManual: false });
    st.ops = st.ops.filter(op => !(op && ['profile', 'profileAt', 'profileManual'].includes(op.k)));
    saveFeedSetStore();
    showToast('Profilo rigenerato', 'info', 2000);
  } catch (e) {
    console.warn('regenFeedProfile', e);
    showToast(feedErrorMessage(e), e.detail === 'dayflow-few-signals' ? 'warn' : 'error');
  } finally {
    FEED.profileBusy = false;
    refreshFeedSettings();
  }
}
function removeFeedPref(list, i) {
  const v = feedPrefs()[list] && feedPrefs()[list][i];
  if (!v) return;
  changeFeedSettings([{ list, del: v }]);
  refreshFeedSettings();
}
function clearFeedCache() {
  FEED.data = null; FEED.error = null; saveFeedCache();
  if (FEED.sheet) closeFeedSheet();
  refreshFeedSettings();
  if (curScreen === 'recap') renderDiscover();
}

// ── Chiave API Gemini (anche dalla card "Collega Gemini" del feed) ──
function toggleFeedKeyVis(id) { const i = document.getElementById(id); if (i) i.type = i.type === 'password' ? 'text' : 'password'; }
function saveFeedKey(inputId = 'disc-key-input') {
  const i = document.getElementById(inputId); const v = (i ? i.value : '').trim();
  if (!v || v.length < 20) { showToast('Chiave API non valida', 'error'); return; }
  try { localStorage.setItem(FEED_KEY_LS, v); } catch (e) { showToast('Impossibile salvare la chiave', 'error'); return; }
  FEED.error = null;
  showToast('Chiave salvata', 'info');
  if (FEED.sheet) closeFeedSheet();
  refreshFeedSettings();
  // dalle Impostazioni si può essere su un'altra schermata: il feed si genera quando si apre Discover
  if (curScreen === 'recap') renderDiscover();
}
function removeFeedKey() {
  try { localStorage.removeItem(FEED_KEY_LS); } catch (e) { }
  FEED.error = null;
  if (FEED.sheet) closeFeedSheet();
  refreshFeedSettings();
  if (curScreen === 'recap') renderDiscover();
}

// ── Cronologia e interessi locali ──
function clearFeedSeen() {
  try { localStorage.removeItem(FEED_SEEN_LS); } catch (e) { }
  showToast('Cronologia svuotata', 'info');
  refreshFeedSettings();
}
function clearFeedPrefs() {
  try { localStorage.removeItem(FEED_PREFS_LS); } catch (e) { }
  showToast('Interessi azzerati', 'info');
  refreshFeedSettings();
}

// ── Ascolta: impostazioni (voce del cloud / del dispositivo) ──
// Pagina Ascolta del pannello Impostazioni (#settings-tts-body); refreshFeedSettings() la ridisegna
// quando è visibile (voci caricate, motore cambiato, elenco del dispositivo aggiornato).
function renderTtsSettings(b) {
  if (!b) return;
  const h = ttsSettingsHTML();
  b.innerHTML = h
    ? settingsGroupHTML('Lettura ad alta voce', h, 'Ascolta legge ad alta voce gli approfondimenti di Discover: tocca 🔊 Ascolta sotto il titolo di un articolo.')
    : settingsGroupHTML('Lettura ad alta voce', '<div class="settings-row"><div class="settings-val">Questo browser non ha una sintesi vocale e senza account non c\'è la voce del cloud.</div></div>');
}
function ttsSettingsHTML() {
  const cloud = cloudOn();
  if (!ttsSupported() && !cloud) return '';
  const engine = ttsEngine();
  const engineSel = cloud && ttsSupported() ? `
      <select class="form-select" id="set-tts-engine" aria-label="Motore della voce" onchange="setFeedTtsEngine(this.value)">
        <option value="cloud"${engine === 'cloud' ? ' selected' : ''}>Google Cloud · consigliata</option>
        <option value="device"${engine === 'device' ? ' selected' : ''}>Voce del dispositivo</option>
      </select>` : '';
  return `
    <div class="settings-row">
      <label class="settings-lbl" for="${engineSel ? 'set-tts-engine' : engine === 'cloud' ? 'set-tts-cloud-voice' : 'set-tts-voice'}" style="display:block">Voce di "Ascolta"</label>
      ${engineSel}${engine === 'cloud' ? ttsCloudSettingsHTML(!!engineSel) : ttsDeviceSettingsHTML(!!engineSel)}
    </div>`;
}
// Voci Chirp 3 HD dal cloud (mode 'tts-voices'): elenco + consumo del mese, ricaricati al più ogni minuto.
function ttsCloudSettingsHTML(spaced) {
  const v = TTSC.voices;
  if (!TTSC.voicesLoading && (!v || Date.now() - v.at > 60000)) loadTtsCloudVoices().then(refreshFeedSettings, () => refreshFeedSettings());
  const pick = ttsCloudVoice();
  const list = v && v.list ? v.list : [];
  const auto = v && v.def ? ttsCloudVoiceLabel({ name: v.def, gender: (list.find(x => x.name === v.def) || {}).gender }) : '';
  const mt = spaced ? ' style="margin-top:10px"' : '';
  let body;
  if (v && v.err) {
    body = `<div class="settings-val"${mt}>${escFeed(v.err === 'dayflow-tts-off' ? 'Voce del cloud non attiva (manca la chiave Text-to-Speech nel cloud): Ascolta usa la voce del dispositivo.' : 'Non riesco a leggere le voci del cloud: ' + feedErrorMessage(v.errObj))}</div>
      <div class="form-btns" style="margin-top:10px"><button class="btn-sec" onclick="refreshTtsCloudVoices()">↻ Riprova</button></div>`;
  } else if (!v) {
    body = `<div class="settings-val"${mt}>Carico le voci…</div>`;
  } else {
    const usage = v.monthChars == null ? '' : `<div class="settings-val" style="margin-top:8px">Questo mese: ${escFeed(ttsThousands(v.monthChars))} di 1 milione di caratteri gratuiti</div>`;
    body = `<select class="form-select" id="set-tts-cloud-voice"${mt} onchange="setFeedTtsCloudVoice(this.value)">
        <option value=""${pick ? '' : ' selected'}>Automatica${auto ? ' · ' + escFeed(auto) : ''}</option>
        ${list.map(x => `<option value="${escFeed(x.name)}"${x.name === pick ? ' selected' : ''}>${escFeed(ttsCloudVoiceLabel(x))}</option>`).join('')}
      </select>${usage}
      <div class="form-btns" style="margin-top:10px"><button class="btn-sec" onclick="testFeedTtsCloud()">▶ Prova</button></div>
      <div class="feed-hint" style="margin-top:8px">Voci Google Chirp 3 HD, generate nel cloud: suonano molto più naturali di quelle del telefono. Il primo milione di caratteri al mese è gratis (un articolo ne usa circa 3-5 mila); se finiscono, Ascolta passa da solo alla voce del dispositivo.</div>`;
  }
  return body;
}
function ttsDeviceSettingsHTML(spaced) {
  if (!ttsSupported()) return '<div class="settings-val">Questo browser non ha una sintesi vocale.</div>';
  const list = ttsItVoices();
  let pick = '';
  try { pick = localStorage.getItem(FEED_TTS_VOICE_LS) || ''; } catch (e) { }
  // l'elenco può arrivare o cambiare dopo (voce scaricata): ridisegna ogni volta che il sistema lo aggiorna
  if (!FEED.ttsListen) { FEED.ttsListen = true; speechSynthesis.addEventListener('voiceschanged', () => refreshFeedSettings()); }
  const auto = list[0];
  return `
      ${list.length ? `<select class="form-select" id="set-tts-voice"${spaced ? ' aria-label="Voce del dispositivo" style="margin-top:10px"' : ''} onchange="setFeedTtsVoice(this.value)">
        <option value=""${pick ? '' : ' selected'}>Automatica${auto ? ' · ' + escFeed(auto.name) : ''}</option>
        ${list.map(v => `<option value="${escFeed(v.voiceURI)}"${v.voiceURI === pick ? ' selected' : ''}>${escFeed(v.name)}</option>`).join('')}
      </select>
      <div class="settings-val" style="margin-top:8px">${plural(list.length, 'voce italiana', 'voci italiane')} su questo dispositivo</div>` : '<div class="settings-val">Nessuna voce italiana trovata su questo dispositivo.</div>'}
      <div class="form-btns" style="margin-top:10px">${list.length ? '<button class="btn-sec" onclick="testFeedTtsVoice()">▶ Prova</button>' : ''}<button class="btn-sec" onclick="refreshTtsVoices()">↻ Aggiorna elenco</button></div>
      <div class="feed-hint" style="margin-top:8px">Le voci migliori vanno scaricate: su iPhone Impostazioni → Accessibilità → Contenuti letti → Voci → Italiano → scegli una voce "Migliorata" o "Premium" (es. Alice, Federica, Luca). Poi riapri DayFlow e selezionala qui.</div>`;
}
function ttsCloudVoiceLabel(x) {
  const short = String(x.name || '').replace(/^.*Chirp3-HD-/, '');
  const g = x.gender === 'FEMALE' ? 'femminile' : x.gender === 'MALE' ? 'maschile' : '';
  return g ? short + ' · ' + g : short;
}
function ttsThousands(n) {
  if (n < 1000) return n === 0 ? '0' : 'meno di mille';
  return (n / 1000).toLocaleString('it-IT', { maximumFractionDigits: n < 10000 ? 1 : 0 }) + ' mila';
}
function setFeedTtsEngine(v) {
  try { localStorage.setItem(FEED_TTS_ENGINE_LS, v === 'device' ? 'device' : 'cloud'); } catch (e) { }
  TTSC.skipUntil = 0; // scelta esplicita: si riprova subito il cloud
  stopArticleSpeech();
  refreshFeedSettings();
}
function refreshTtsCloudVoices() { TTSC.voices = null; refreshFeedSettings(); }
function setFeedTtsCloudVoice(name) {
  try { if (name && TTS_CLOUD_VOICE_RE.test(name)) localStorage.setItem(FEED_TTS_CLOUD_VOICE_LS, name); else localStorage.removeItem(FEED_TTS_CLOUD_VOICE_LS); } catch (e) { }
  testFeedTtsCloud();
}
function setFeedTtsVoice(uri) {
  try { if (uri) localStorage.setItem(FEED_TTS_VOICE_LS, uri); else localStorage.removeItem(FEED_TTS_VOICE_LS); } catch (e) { }
  testFeedTtsVoice();
}
function testFeedTtsVoice() {
  if (!ttsSupported()) return;
  stopArticleSpeech();
  try { speechSynthesis.cancel(); } catch (e) { }
  const u = new SpeechSynthesisUtterance('Ciao, questa è la voce che leggerà i tuoi approfondimenti.');
  u.lang = 'it-IT';
  u.rate = TTS_RATE;
  const v = ttsVoice(); if (v) u.voice = v;
  speechSynthesis.speak(u);
}
function refreshTtsVoices() {
  if (!ttsSupported()) return;
  speechSynthesis.getVoices(); // chiede al sistema di ricaricare l'elenco
  setTimeout(() => { refreshFeedSettings(); showToast(plural(ttsItVoices().length, 'voce italiana', 'voci italiane'), 'info', 1800); }, 400);
}
// "Prova" nelle impostazioni: una frase con la voce del cloud scelta (in cache per voce).
async function testFeedTtsCloud() {
  if (!cloudOn()) return;
  stopArticleSpeech();
  ttsUnlock();
  const voice = ttsCloudVoice();
  const seq = ++TTSC.testSeq;
  let blob = TTSC.samples.get(voice);
  if (!blob) {
    try { blob = await ttsSynth('Ciao, questa è la voce che leggerà i tuoi approfondimenti.', voice); }
    catch (e) {
      if (seq !== TTSC.testSeq) return;
      showToast(e.detail === 'dayflow-tts-quota' ? 'Quota voce del mese finita.' : e.detail === 'dayflow-tts-off' ? 'Voce del cloud non attiva.' : feedErrorMessage(e), 'error', 3500);
      return;
    }
    TTSC.samples.set(voice, blob);
  }
  if (seq !== TTSC.testSeq || FEED.tts) return;
  const el = ttsAudio();
  const url = URL.createObjectURL(blob);
  const done = () => { try { URL.revokeObjectURL(url); } catch (e) { } };
  el.onended = done; el.onerror = done;
  el.src = url;
  ttsApplyRate(el);
  const p = el.play(); if (p && p.catch) p.catch(() => { });
  if (TTSC.voices && TTSC.voices.monthChars != null) TTSC.voices.at = 0; // consumo da rileggere
}

// Selettore modello Gemini (impostazioni feed). Il cambio non invalida feed né articoli in cache.
function loadGeminiModels() {
  try {
    const o = JSON.parse(localStorage.getItem(GEMINI_MODELS_LS) || 'null');
    if (!o || !Array.isArray(o.models)) return { ts: 0, models: [] };
    return { ts: +o.ts || 0, models: o.models.filter(m => m && GEMINI_MODEL_RE.test(m.id || '')).map(m => ({ id: m.id, label: String(m.label || m.id) })) };
  } catch (e) { return { ts: 0, models: [] }; }
}
function renderFeedModelPicker(ready) {
  const cur = feedModel();
  const loaded = loadGeminiModels();
  const presetIds = new Set(GEMINI_PRESETS.map(p => p.id));
  const extra = loaded.models.filter(m => !presetIds.has(m.id));
  const known = new Set([...presetIds, ...extra.map(m => m.id)]);
  const opt = (id, label, note) => `<button type="button" class="topic-row model-opt${id === cur ? ' on' : ''}" onclick="setFeedModel('${escFeed(id)}')" aria-pressed="${id === cur}">
        <div class="t-name"><div>${escFeed(label)}</div><div class="model-id">${escFeed(id)}${note ? ' · ' + escFeed(note) : ''}</div></div>
        <span class="model-check" aria-hidden="true">${id === cur ? '✓' : ''}</span>
      </button>`;
  let h = GEMINI_PRESETS.map(p => opt(p.id, p.label, p.note)).join('');
  if (!known.has(cur)) h += opt(cur, 'Personalizzato', '');
  if (extra.length) {
    const when = loaded.ts ? new Date(loaded.ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';
    h += `<div class="settings-lbl" style="margin-top:14px">Dalla tua chiave${when ? ' · ' + escFeed(when) : ''}</div>`;
    h += extra.map(m => opt(m.id, m.label, '')).join('');
  }
  h += `<div class="form-btns" style="margin-top:6px">
        <button class="btn-sec" onclick="fetchGeminiModels()" ${ready && !FEED.modelsLoading ? '' : 'disabled'}>${FEED.modelsLoading ? 'Caricamento…' : 'Carica modelli dalla chiave'}</button>
      </div>
      <div class="topic-form">
        <input class="form-input" id="settings-model-input" type="text" placeholder="Altro modello (es. gemini-2.5-flash)" autocomplete="off" autocapitalize="off" spellcheck="false" onkeydown="if(event.key==='Enter') setFeedModelFromInput()">
        <button class="btn-pri" onclick="setFeedModelFromInput()">Usa</button>
      </div>
      <div class="feed-hint" style="margin-top:10px">${cloudOn() ? 'Vale per approfondimenti e chat. Le notizie del mattino usano il modello impostato nel cloud (segreto GEMINI_MODEL).' : 'Vale per feed, articoli e chat. Il feed attuale resta: trascinalo verso il basso per rigenerarlo col nuovo modello.'}</div>`;
  return h;
}
function setFeedModel(id) {
  id = String(id || '').trim().replace(/^models\//, '');
  if (!GEMINI_MODEL_RE.test(id)) { showToast('Nome modello non valido', 'error'); return false; }
  try { localStorage.setItem(GEMINI_MODEL_LS, id); } catch (e) { showToast('Impossibile salvare il modello', 'error'); return false; }
  showToast('Modello: ' + id, 'info', 2200);
  refreshFeedSettings();
  return true;
}
function setFeedModelFromInput() {
  const i = document.getElementById('settings-model-input');
  const v = (i ? i.value : '').trim();
  if (!v) return;
  setFeedModel(v);
}
const GEMINI_MODEL_EXCLUDE = /embed|tts|image|imagen|live|audio|veo|aqa|native|robotics|computer-use/i;
async function fetchGeminiModels() {
  const key = feedKey();
  if (!feedAIReady()) { showToast(feedErrorMessage({ code: 'nokey' }), 'error'); return; }
  if (FEED.modelsLoading) return;
  FEED.modelsLoading = true;
  refreshFeedSettings();
  try {
    const all = [];
    let token = '';
    if (cloudOn()) { // elenco dalla chiave del cloud
      const res = await feedFnFetch({ mode: 'models' });
      if (!res.ok) throw await feedHttpError(res);
      let j; try { j = await res.json(); } catch (e) { throw Object.assign(new Error('parse'), { code: 'parse' }); }
      all.push(...(j.models || []));
    }
    for (let page = 0; page < 5 && !cloudOn(); page++) { // la chiave va solo nell'header, mai nell'URL
      let res;
      try {
        res = await fetch(GEMINI_API + 'models?pageSize=200' + (token ? '&pageToken=' + encodeURIComponent(token) : ''), { headers: { 'x-goog-api-key': key } });
      } catch (e) { throw Object.assign(new Error('network'), { code: 'network' }); }
      if (!res.ok) {
        const err = Object.assign(new Error('http ' + res.status), { code: 'http', status: res.status });
        try { const j = await res.json(); err.detail = j?.error?.message || ''; } catch (e) { }
        throw err;
      }
      let json;
      try { json = await res.json(); } catch (e) { throw Object.assign(new Error('parse'), { code: 'parse' }); }
      all.push(...(json.models || []));
      token = json.nextPageToken || '';
      if (!token) break;
    }
    const seen = new Set();
    const models = all
      .filter(m => m && typeof m.name === 'string' && m.name.startsWith('models/gemini')
        && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({ id: m.name.slice(7), label: String(m.displayName || m.name.slice(7)) }))
      .filter(m => GEMINI_MODEL_RE.test(m.id) && !GEMINI_MODEL_EXCLUDE.test(m.id) && !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => b.id.localeCompare(a.id));
    if (!models.length) { showToast('Nessun modello compatibile per questa chiave', 'warn'); return; }
    try { localStorage.setItem(GEMINI_MODELS_LS, JSON.stringify({ ts: Date.now(), models })); } catch (e) { }
    showToast(models.length + ' modelli caricati', 'info', 2200);
  } catch (e) {
    console.error('fetchGeminiModels', e);
    showToast(feedErrorMessage(e), 'error');
  } finally {
    FEED.modelsLoading = false;
    refreshFeedSettings();
  }
}

export {
  renderFeedSettings, feedSettingsHTML, renderTtsSettings, ttsSettingsHTML,
  setFeedArea, saveFeedProfile, regenFeedProfile, removeFeedPref, clearFeedCache, clearFeedSeen, clearFeedPrefs,
  toggleFeedKeyVis, saveFeedKey, removeFeedKey,
  setFeedTtsEngine, setFeedTtsVoice, testFeedTtsVoice, refreshTtsVoices, setFeedTtsCloudVoice, testFeedTtsCloud, refreshTtsCloudVoices,
  setFeedModel, setFeedModelFromInput, fetchGeminiModels
};
