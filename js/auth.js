// ── AUTH ───────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  document.getElementById('auth-login-form').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('auth-signup-form').style.display = tab === 'signup' ? 'block' : 'none';
}
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pwd = document.getElementById('login-pwd').value;
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-err');
  if (!email || !pwd) { err.textContent = 'Compila tutti i campi'; return; }
  btn.disabled = true; btn.textContent = '...'; err.textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pwd });
  if (error) { btn.disabled = false; btn.textContent = 'Accedi'; err.textContent = translateAuthError(error.message); return; }
  if (!data.session) { btn.disabled = false; btn.textContent = 'Accedi'; err.textContent = 'Sessione non ricevuta, riprova.'; return; }
  btn.textContent = 'caricamento...';
  try { await initApp(data.session.user); }
  catch (e) { btn.disabled = false; btn.textContent = 'Accedi'; err.textContent = 'Errore di caricamento, riprova.'; }
}
async function doSignup() {
  const email = document.getElementById('signup-email').value.trim();
  const pwd = document.getElementById('signup-pwd').value;
  const btn = document.getElementById('signup-btn');
  const err = document.getElementById('signup-err');
  const ok = document.getElementById('signup-ok');
  if (!email || !pwd) { err.textContent = 'Compila tutti i campi'; return; }
  if (pwd.length < 6) { err.textContent = 'Password minimo 6 caratteri'; return; }
  btn.disabled = true; btn.textContent = '...'; err.textContent = ''; ok.textContent = '';
  const { error } = await sb.auth.signUp({ email, password: pwd });
  btn.disabled = false; btn.textContent = 'Crea account';
  if (error) { err.textContent = translateAuthError(error.message); }
  else { ok.textContent = 'Account creato! Controlla la tua email per confermare.'; err.textContent = ''; }
}
// Logout effettivo: da chiamare solo dopo requestLogout() (conferma + flush delle sync in coda).
async function doLogout() {
  clearTimeout(syncDebounce); syncDebounce = null;
  // chiude l'epoca: upload/load ancora in volo della sessione vengono ignorati al loro ritorno
  syncEpoch++; dayInflight.clear(); habitsInflight = null; RETRY.running = false;
  closeAppDialog(false);
  closeSettings(false);
  try { await sb.auth.signOut(); } catch (e) { console.error('signOut', e); }
  pendingSync.clear(); dirtyGen.clear(); restoredPending.clear(); habitsDirty = false;
  RETRY.until = 0; RETRY.delay = 0;
  try { localStorage.removeItem(PENDING_LS); } catch (e) { }
  SYNC_INFO.status = 'offline'; SYNC_INFO.msg = 'non ancora sincronizzato';
  S = { habits: [], days: {}, impegniRicorrenti: [] };
  allDaysLoaded = false;
  localStorage.removeItem(SK);
  curUser = null;
  document.getElementById('shell').style.display = 'none';
  document.getElementById('auth-screen').classList.remove('hidden');
}
function translateAuthError(msg) {
  if (msg.includes('Invalid login')) return 'Email o password errati';
  if (msg.includes('Email not confirmed')) return 'Conferma prima la tua email';
  if (msg.includes('already registered')) return 'Email già registrata';
  if (msg.includes('Password should')) return 'Password troppo corta (min. 6 caratteri)';
  return msg;
}
async function doResetPwd() {
  const email = document.getElementById('login-email').value.trim();
  const err = document.getElementById('login-err');
  const ok = document.getElementById('login-ok');
  if (!email) { err.textContent = 'Inserisci la tua email prima'; ok.textContent = ''; return; }
  err.textContent = ''; ok.textContent = '';
  const { error } = await sb.auth.resetPasswordForEmail(email);
  if (error) { err.textContent = translateAuthError(error.message); }
  else { ok.textContent = 'Email di recupero inviata! Controlla la tua casella.'; }
}
