# Implementation Plan — Desktop Sidebar Collapsibile (Icon-Only → Expanded)

## Obiettivo

Sostituire l'attuale sidebar desktop (240px, sempre espansa con icona + testo) con una sidebar **collassata di default a 64px** che mostra solo le icone. Al click su un'icona (o su un toggle) la sidebar si espande a 220px mostrando anche le label. Il contenuto principale occupa tutto lo spazio rimanente.

---

## Contesto attuale

Il file da modificare è **`dayflow1_0.html`** (file unico, nessun build step).

La struttura HTML rilevante è:

```
#shell                          ← flex-row su desktop
  <nav id="nav">                ← sidebar sinistra
    <button class="nav-btn" id="nav-plan">   <svg>…</svg>Pianifica</button>
    <button class="nav-btn" id="nav-oggi">   <svg>…</svg>Oggi</button>
    <button class="nav-btn" id="nav-recap">  <svg>…</svg>Riepilogo</button>
    <button class="nav-btn" id="nav-analytics"><svg>…</svg>Storico</button>
  </nav>
  <div id="screen-area">        ← contenuto principale, flex:1
    …
  </div>
```

Il CSS desktop corrente è dentro `@media (min-width: 768px)` a partire dalla riga ~1633.

---

## Modifiche richieste

### 1. HTML — aggiungere logo e toggle alla sidebar

Dentro `<nav id="nav">`, **prima dei quattro `.nav-btn`**, aggiungere:

```html
<!-- Logo DayFlow (visibile sempre) -->
<div class="nav-logo">DF</div>

<!-- Toggle expand/collapse (visibile sempre) -->
<button class="nav-toggle" id="nav-toggle" onclick="toggleSidebar()" aria-label="Espandi menu">
  <!-- Icona freccia destra (SVG 20x20, stroke, no fill) -->
  <svg viewBox="0 0 24 24"><polyline points="9,6 15,12 9,18"/></svg>
</button>
```

Dentro ogni `.nav-btn`, il testo della label (es. "Pianifica", "Oggi", ecc.) deve essere wrappato in un `<span class="nav-label">`:

```html
<button class="nav-btn" onclick="goScreen('plan')" id="nav-plan">
  <svg viewBox="0 0 24 24">…</svg>
  <span class="nav-label">Pianifica</span>
</button>
```

Fare lo stesso per tutti e 4 i bottoni.

---

### 2. CSS — ridefinire la sidebar dentro `@media (min-width: 768px)`

Sostituire il blocco `#nav { … }` e `.nav-btn { … }` dentro la media query con quanto segue.

**Variabile CSS da aggiungere in `:root`:**
```css
--sidebar-w: 64px;
--sidebar-expanded-w: 220px;
```

**Sidebar:**
```css
#nav {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  padding-top: 24px;
  padding-bottom: 32px;
  width: var(--sidebar-w);
  min-width: var(--sidebar-w);
  border-top: none;
  border-right: 1px solid var(--border);
  gap: 4px;
  order: -1;
  overflow: hidden;
  transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1),
              min-width 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Stato espanso: classe .expanded aggiunta via JS */
#nav.expanded {
  width: var(--sidebar-expanded-w);
  min-width: var(--sidebar-expanded-w);
  align-items: flex-start;
}
```

**Logo:**
```css
.nav-logo {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .08em;
  color: var(--text3);
  padding: 0 0 16px;
  width: 100%;
  text-align: center;
  flex-shrink: 0;
}

#nav.expanded .nav-logo {
  text-align: left;
  padding-left: 20px;
  font-size: 16px;
  color: var(--text);
}
```

**Toggle button:**
```css
.nav-toggle {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text3);
  padding: 8px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  transition: color 0.15s, transform 0.22s;
  width: 40px;
  height: 40px;
}

.nav-toggle:hover {
  color: var(--text);
  background: rgba(255,255,255,0.05);
}

.nav-toggle svg {
  width: 18px;
  height: 18px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Ruota la freccia quando espanso */
#nav.expanded .nav-toggle svg {
  transform: rotate(180deg);
}
```

**Bottoni nav:**
```css
.nav-btn {
  flex-direction: row;
  padding: 13px 20px;
  border-top: none;
  border-left: 3px solid transparent;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .1em;
  gap: 14px;
  width: 100%;
  align-items: center;
  justify-content: center;    /* centrato quando collassato */
  white-space: nowrap;
  overflow: hidden;
  border-radius: 0;
  transition: background 0.15s, border-color 0.15s;
}

#nav.expanded .nav-btn {
  justify-content: flex-start;
  padding-left: 20px;
}

.nav-btn svg {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}

/* Label nascosta quando collassato, visibile quando espanso */
.nav-label {
  opacity: 0;
  width: 0;
  overflow: hidden;
  transition: opacity 0.15s 0s, width 0s 0.22s;
  pointer-events: none;
}

#nav.expanded .nav-label {
  opacity: 1;
  width: auto;
  transition: opacity 0.18s 0.1s, width 0s 0s;
  pointer-events: auto;
}

.nav-btn.active {
  border-top-color: transparent;
  border-left-color: var(--green);
  background: linear-gradient(90deg, rgba(16, 185, 129, 0.1), transparent);
}

.nav-btn.active svg {
  transform: none;   /* rimuovere translateX(4px) che era per la versione espansa fissa */
}
```

**Tooltip al hover (sidebar collassata):**

Aggiungere in CSS (dentro o fuori la media query):
```css
.nav-btn {
  position: relative;
}

/* Tooltip visibile solo quando la sidebar è collassata */
.nav-btn::after {
  content: attr(data-tooltip);
  position: absolute;
  left: calc(var(--sidebar-w) - 8px);
  top: 50%;
  transform: translateY(-50%);
  background: var(--bg2);
  border: 1px solid var(--border);
  color: var(--text);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .08em;
  padding: 6px 10px;
  border-radius: 6px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
  z-index: 100;
}

/* Solo quando nav è collassato e si fa hover */
#nav:not(.expanded) .nav-btn:hover::after {
  opacity: 1;
}
```

Per far funzionare i tooltip, aggiungere `data-tooltip="Pianifica"` (ecc.) a ogni `.nav-btn` nell'HTML.

---

### 3. JavaScript — funzione `toggleSidebar()`

Aggiungere questa funzione nel blocco `<script>`:

```javascript
function toggleSidebar() {
  const nav = document.getElementById('nav');
  nav.classList.toggle('expanded');
  // Salva preferenza utente
  localStorage.setItem('sidebarExpanded', nav.classList.contains('expanded'));
}
```

E all'init dell'app (nella funzione di avvio, dopo che `#shell` viene mostrato), ripristinare lo stato salvato:

```javascript
// Ripristina stato sidebar desktop
if (window.innerWidth >= 768) {
  const saved = localStorage.getItem('sidebarExpanded');
  if (saved === 'true') {
    document.getElementById('nav').classList.add('expanded');
  }
}
```

---

### 4. CSS — `#screen-area` invariato

Nessuna modifica necessaria a `#screen-area`. Con `flex: 1` occupa automaticamente lo spazio residuo dopo la sidebar.

---

## Riepilogo delle modifiche per file

| Area | Tipo di modifica |
|------|-----------------|
| `:root` | Aggiungere `--sidebar-w` e `--sidebar-expanded-w` |
| `<nav id="nav">` HTML | Aggiungere `.nav-logo`, `.nav-toggle`, wrappare testi in `.nav-label`, aggiungere `data-tooltip` |
| CSS `@media (min-width: 768px)` | Riscrivere `#nav`, `.nav-btn`, aggiungere `.nav-logo`, `.nav-toggle`, `.nav-label`, tooltip |
| `<script>` | Aggiungere `toggleSidebar()` + init ripristino stato |

---

## Comportamento atteso

| Stato | Larghezza sidebar | Icone | Label | Tooltip |
|-------|-------------------|-------|-------|---------|
| Collassata (default) | 64px | Visibili | Nascoste | Al hover |
| Espansa (click toggle) | 220px | Visibili | Visibili | No |

La transizione di espansione/collasso deve essere animata (~220ms, ease-in-out).  
Lo stato (espanso/collassato) viene persistito in `localStorage` con la chiave `sidebarExpanded`.

---

## Note importanti

- **Non toccare il layout mobile** (`@media (max-width: 767px)`): la navbar rimane in basso come bottom bar.
- La classe `.expanded` va aggiunta/rimossa solo su `#nav`, non su `#shell`.
- Il toggle button NON deve avere `class="nav-btn"` per evitare di ricevere lo stile attivo della navigazione.
- Il file è un monolite HTML/CSS/JS: tutte le modifiche vanno in `dayflow1_0.html`.
