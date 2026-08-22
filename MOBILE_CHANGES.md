# SismoGlobe — Modifiche Mobile

**Data**: 2026-08-22  
**Versione**: 1.0 mobile-responsive

## Modifiche Applicate

### 1. **CSS** (`style.css`)
- Aggiunto breakpoint **@media (max-width: 767px)** per layout mobile
- Panel laterale: da layout fisso a **drawer sidebar** con `transform: translateX(-100%)`
- Topbar: ridotta altezza da 66px → 56px, font più piccoli, padding ridotto
- Backdrop semi-trasparente (click-to-close)
- Pulsanti e font ottimizzati per touch
- Footer nascosto su mobile

### 2. **HTML** (`index.html`)
- Aggiunto **bottone hamburger** (3 linee) nella topbar
- Aggiunto **elemento backdrop** (div `#panel-backdrop`) per chiudere drawer al click esterno

### 3. **JavaScript** (`main.js`)
- Funzione `togglePanel()` per aprire/chiudere drawer
- Event listener sul hamburger button
- Click sul backdrop chiude il panel
- Click su link/button nel panel chiude automaticamente il drawer (UX mobile)
- Niente disabilitazione di Escape (mantiene chiusura della guida)

## Comportamento Mobile

✅ **< 768px** (smartphone, tablet piccoli)
- Globo occupa tutto lo schermo
- Panel diventa drawer sidebar che scivola da sinistra
- Hamburger menu visibile nella topbar
- Topbar compatta

✅ **≥ 768px** (tablet/desktop)
- Layout originale desktop: panel sempre visibile a sinistra
- Hamburger menu nascosto
- Topbar con tutte le informazioni

## Test Consigliati

1. Apri `index.html` in browser
2. Riduci la finestra a < 768px (DevTools F12 → Responsive mode)
3. Clicca hamburger → panel scivola da sinistra ✓
4. Clicca backdrop → panel si chiude ✓
5. Ruota il globo con il dito/mouse ✓
6. Ripassa a desktop (> 768px) → panel torna visibile ✓

## File Modificati

- ✏️ `style.css` — +70 righe media query
- ✏️ `index.html` — +2 elementi (button + div backdrop)
- ✏️ `main.js` — +20 righe JS per gestione drawer

## Deploy

Il repo è pronto su:  
`C:\Users\gimmy\Projects\coded\sismoglobe\`

Per fare il push a GitHub:
```bash
cd C:\Users\gimmy\Projects\coded\sismoglobe
git add -A
git commit -m "feat: mobile responsive — drawer sidebar, hamburger menu, ottimizzazione touch"
git push origin main
```

Alternativamente, per testare prima in locale:
```bash
cd C:\Users\gimmy\Projects\coded\sismoglobe
# Servire con un HTTP server (Python, Live Server, etc.)
python -m http.server 8000
# Apri http://localhost:8000 nel browser
```

---

**Prossime ottimizzazioni** (opzionali):
- Gesture per swipe (open/close drawer con swipe)
- Performance: lazy-load dati su mobile
- Portrait/landscape: gestire rotazione device
- Dark mode toggle mobile (se richiesto)
