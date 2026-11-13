// GeneCodex: Character Companion. Shows a finished GenPrint character (a .genecodex.json file made by
// "Make GeneCodex Files") and keeps the few things that change during play. The character itself is read-only.
(() => {
  "use strict";

  // ---------------------------------------------------------------- storage (IndexedDB, kept on the device)
  const DB = (() => {
    let dbp = null, memory = new Map();
    const open = () => dbp ||= new Promise(res => {
      try {
        const rq = indexedDB.open("genecodex", 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      } catch { res(null); }
    });
    const tx = async (mode, fn) => {
      const db = await open();
      if (!db) return fn(null);
      return new Promise((res, rej) => {
        const t = db.transaction("kv", mode), s = t.objectStore("kv");
        const out = fn(s);
        t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: k => tx("readonly", s => s ? s.get(k) : { result: memory.get(k) }),
      set: (k, v) => tx("readwrite", s => s ? s.put(v, k) : void memory.set(k, v)),
      del: k => tx("readwrite", s => s ? s.delete(k) : void memory.delete(k)),
      keys: () => tx("readonly", s => s ? s.getAllKeys() : { result: [...memory.keys()] }),
    };
  })();

  // ---------------------------------------------------------------- state
  const S = { chars: new Map(), play: new Map(), current: null, tab: "abilities", open: new Set() };
  const app = document.getElementById("app");
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const signed = n => (n >= 0 ? "+" : "−") + Math.abs(n);
  const ord = n => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
  const is2024 = c => c.edition === "2024" || c.edition === "both";
  const editionName = c => c.edition === "2024" ? "5e 2024" : c.edition === "both" ? "5e 2014 + 2024" : "5e 2014";

  const CONDITIONS = ["Blinded", "Charmed", "Deafened", "Frightened", "Grappled", "Incapacitated", "Invisible", "Paralyzed", "Petrified", "Poisoned", "Prone", "Restrained", "Stunned", "Unconscious"];
  const COINS = ["cp", "sp", "ep", "gp", "pp"];

  const fresh = c => ({
    hp: c.hp.max, temp: 0, maxAdj: 0, hdUsed: {}, death: { s: 0, f: 0 }, slots: [], pact: 0, uses: {},
    conditions: [], exhaustion: 0, inspiration: false, conc: "", prepared: {}, money: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0, ...c.money }, notes: "",
  });
  const char = () => S.chars.get(S.current);
  const play = () => S.play.get(S.current);
  // Spells switched on in play (owner 2026-11-09: Mage Armor, Shield of Faith, Longstrider...). The file gives the
  // numbers with no spells cast (noSpells); these are the same sums as GenPrint's GP.spellEffects.
  const spellsOn = (c, p) => (c.spellToggles || []).filter(t => p?.spellsOn?.[t.id]);
  function effects(c, p) {
    const base = c.noSpells || { ac: c.ac, speed: c.speed, hp: c.hp.max, bare: null };
    let ac = base.ac, speed = base.speed, hp = base.hp;
    const list = spellsOn(c, p);
    for (const t of list.filter(t => t.ac?.set != null)) if (base.bare != null && t.ac.set > base.bare) ac += t.ac.set - base.bare;
    for (const t of list.filter(t => t.ac?.add)) ac += t.ac.add;
    for (const t of list.filter(t => t.ac?.min)) ac = Math.max(ac, t.ac.min);
    for (const t of list) { speed += t.speed || 0; if (t.speedTimes > 1) speed *= t.speedTimes; hp += t.hpMax || 0; }
    return { ac, speed, hp };
  }
  // The character as it stands with today's spells on.
  const withSpells = (c, p) => {
    const list = spellsOn(c, p);
    if (!list.length) return c;
    const e = effects(c, p);
    const add = name => list.reduce((n, t) => n + (t.skills?.[name] || 0), 0);
    return { ...c, ac: e.ac, speed: e.speed, hp: { ...c.hp, max: e.hp }, skills: c.skills.map(s => add(s.name) ? { ...s, bonus: s.bonus + add(s.name) } : s) };
  };
  const maxHp = (c, p) => Math.max(1, effects(c, p).hp + (p.maxAdj || 0));
  // The switches, at the top of the Abilities page.
  const spellSwitches = (c, p) => c.spellToggles?.length ? `<section class="box spellson"><h2><span>Spells in use</span><small>tap to switch on or off · a long rest switches them off</small></h2><div class="switches">${c.spellToggles.map(t =>
    `<button class="sw${p.spellsOn?.[t.id] ? " on" : ""}" data-act="spell-on" data-id="${esc(t.id)}"><b>${esc(t.name)}</b>${t.note ? `<small>${esc(t.note)}</small>` : ""}${t.concentration ? `<span class="tag blue">Conc.</span>` : ""}</button>`).join("")}</div></section>` : "";
  const save = () => DB.set("play:" + S.current, play());

  // ---------------------------------------------------------------- small pieces
  let toastTimer;
  function toast(msg) {
    document.querySelector(".toast")?.remove();
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3500);
  }

  // A pop-up: a message, optionally a number to type. Resolves with the number (or true), or null on Cancel.
  function ask({ title, text = "", number = false, value = "", ok = "OK", danger = false, allowNegative = false }) {
    return new Promise(res => {
      const back = document.createElement("div");
      back.className = "modal-back";
      back.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>${esc(title)}</h2>${text ? `<p>${text}</p>` : ""}
        ${number ? `<input type="number" inputmode="${allowNegative ? "text" : "numeric"}" pattern="${allowNegative ? "" : "[0-9]*"}" value="${esc(value)}">` : ""}
        <div class="btns"><button class="btn plain" data-x="no">Cancel</button><button class="btn ${danger ? "red" : ""}" data-x="ok">${esc(ok)}</button></div></div>`;
      document.body.appendChild(back);
      const input = back.querySelector("input");
      const done = v => { back.remove(); res(v); };
      const accept = () => {
        if (!number) return done(true);
        const n = parseInt(input.value, 10);
        if (Number.isNaN(n) || (!allowNegative && n < 0)) { input.focus(); return; }
        done(n);
      };
      back.addEventListener("click", e => {
        if (e.target === back || e.target.dataset.x === "no") done(null);
        if (e.target.dataset.x === "ok") accept();
      });
      input?.addEventListener("keydown", e => { if (e.key === "Enter") accept(); });
      setTimeout(() => (input || back.querySelector("[data-x=ok]")).focus(), 30);
    });
  }

  const pips = (count, used, act, extra = "", cls = "") =>
    `<div class="pips">${Array.from({ length: count }, (_, i) => `<button class="pip ${cls} ${i < used ? "used" : ""}" aria-label="${i + 1} of ${count}" data-act="${act}" data-i="${i}" ${extra}></button>`).join("")}</div>`;
  const tick = (used, i) => (i < used ? i : i + 1);   // tap a filled box to clear from there, an empty one to fill up to it

  // The bottom tabs are the printed character sheet's pages, in its order (owner 2026-11-09).
  const ICONS = {
    abilities: "M12 2.5a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zM4 21c0-4.6 3.6-8 8-8s8 3.4 8 8z",
    companions: "M12 12.5c2.6 0 6 3.4 6 6 0 1.6-1.2 2.5-2.6 2.5-1.5 0-2.1-.8-3.4-.8s-1.9.8-3.4.8C7.2 21 6 20.1 6 18.5c0-2.6 3.4-6 6-6zM5.3 7.8c1.2 0 2.3 1.4 2.3 3s-.9 2.6-2.1 2.6S3.2 12 3.2 10.4s.9-2.6 2.1-2.6zm13.4 0c1.2 0 2.1 1 2.1 2.6s-1.1 3-2.3 3-2.1-1-2.1-2.6 1.1-3 2.3-3zM9.2 2.8c1.3 0 2.2 1.5 2.2 3.2s-.9 3-2.2 3-2.3-1.4-2.3-3.1.9-3.1 2.3-3.1zm5.6 0c1.4 0 2.3 1.4 2.3 3.1S16.1 9 14.8 9s-2.2-1.3-2.2-3 .9-3.2 2.2-3.2z",
    skills: "M3.5 4h4v4h-4zm6 1h11v2h-11zM3.5 10h4v4h-4zm6 1h11v2h-11zM3.5 16h4v4h-4zm6 1h11v2h-11z",
    origins: "M12 2c5 2.5 9 7 9 13-3.5 0-7-1.3-9-4.7C10 13.7 6.5 15 3 15c0-6 4-10.5 9-13zm-.9 8h1.8v12h-1.8z",
    actions: "M19.8 2.2 22 2l-.2 2.2-9.3 9.3 1.6 1.6-1.4 1.4-1.4-1.4-3.6 3.6.9.9-1.4 1.4-3.5-3.5 1.4-1.4.9.9 3.6-3.6-1.4-1.4 1.4-1.4 1.6 1.6z",
    features: "M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7.1L12 17.3 5.8 21l1.6-7.1L2 9.2l7.1-.6z",
    log: "M7 2.5h10.5A2.5 2.5 0 0 1 20 5v14.5a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 19V5.5a3 3 0 0 1 3-3zm1 4.5v1.8h8V7zm0 4v1.8h8V11zm0 4v1.8h5.5V15z",
    equipment: "M9 2.5h6V5h.5A4.5 4.5 0 0 1 20 9.5V20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20V9.5A4.5 4.5 0 0 1 8.5 5H9zm1.8 0V5h2.4V2.5zM7.5 12.5v5h9v-5z",
    spells: "M2 5.2c3.2-1.4 6.4-1.2 9.2.9v14.3c-2.8-2-6-2.3-9.2-1zM12.8 6.1c2.8-2.1 6-2.3 9.2-.9v14.2c-3.2-1.3-6.4-1-9.2 1z",
  };
  // [tab id, tab label, page title as on the printed sheet]
  const TABS = [["abilities", "Abilities", "Abilities and attacks"], ["companions", "Companions", "Companions"], ["skills", "Skills", "Skills and defense"], ["origins", "Origins", "Species, background and feats"],
    ["actions", "Actions", "Actions"], ["features", "Features", "Class features"], ["equipment", "Equipment", "Equipment"], ["spells", "Spells", "Spell list"], ["log", "Log", "Character log"]];
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

  // A tap-to-open row (spell, magic item). The open ones stay open when the page redraws.
  const openable = (key, summary, body) => `<details class="x" data-key="${esc(key)}" ${S.open.has(key) ? "open" : ""}><summary>${summary}</summary><div class="body">${body}</div></details>`;
  // A box as on the sheet: a titled frame, with a note on the right of the title.
  const box = (title, right, content, cls = "") => `<section class="box ${cls}"><h2><span>${title}</span>${right ? `<small>${right}</small>` : ""}</h2>${content}</section>`;
  // A feature as the sheet prints it: bold name, a small tag, then the text.
  const feat = (name, tag, text) => `<div class="feat"><b>${esc(name)}.</b>${tag ? ` <span class="ftag">${esc(tag)}</span>` : ""} ${esc(text || "")}</div>`;
  const none = (t = "None.") => `<p class="key">${t}</p>`;
  const abbr = id => String(id || "").slice(0, 3).toUpperCase();

  // ---------------------------------------------------------------- home: the character list
  function renderHome() {
    const list = [...S.chars.values()].sort((a, b) => a.name.localeCompare(b.name));
    app.innerHTML = `<div class="home">
      <img class="logo" src="img/logo.png" alt="EuGenius GeneCodex: Character Companion">
      <p class="lead">Your GenPrint characters, ready for the table.</p>
      ${list.length ? `<div class="charlist">${list.map(c => {
        const p = S.play.get(c.id) || fresh(c);
        return `<button class="charrow" data-act="open" data-id="${esc(c.id)}">
          <span class="badge">${esc(c.name.trim().charAt(0).toUpperCase())}</span>
          <span class="grow"><h3>${esc(c.name)}</h3><span class="meta">Level ${c.level} · ${esc(c.classLine)}<br>${esc(c.species)} · ${esc(editionName(c))}</span></span>
          <span class="hpmini">${p.hp} / ${maxHp(c, p)} HP</span></button>`;
      }).join("")}</div>`
      : `<div class="empty"><h2>No characters yet</h2><p>In GenPrint, open the <b>GeneCodex</b> tab, tick your characters and press <b>Upload characters</b>. Email yourself the file it makes, save it to the iPad, then tap <b>Add character</b> here and pick it.</p></div>`}
      <div class="btns"><button class="btn" data-act="add">Add character</button>
        ${list.length ? `<button class="btn plain" data-act="backup">Back up</button>` : ""}
        <button class="btn plain" data-act="restore">Restore</button></div>
      <p class="foot">EuGenius GeneCodex · Character Companion</p></div>`;
  }

  // ---------------------------------------------------------------- the character: one tab per sheet page
  const hasSpells = c => c.spells.length || c.slots?.some(Boolean) || c.pact;
  function render() {
    if (!S.current || !char()) { S.current = null; return renderHome(); }
    const p = play(), c = withSpells(char(), p);
    const tabs = TABS.filter(([id]) => (id !== "spells" || hasSpells(c)) && (id !== "companions" || c.companions?.length));
    if (!tabs.some(([id]) => id === S.tab)) S.tab = "abilities";
    const [, , title] = TABS.find(([id]) => id === S.tab);
    const body = (S.tab === "abilities" ? spellSwitches(c, p) : "") + { abilities, companions, skills, origins, actions, features, equipment, spells, log: logPage }[S.tab](c, p);
    app.innerHTML = `<header class="top"><img src="img/icon-180.png" alt="">
        <div class="who"><h1>${esc(c.name)}</h1><div class="sub">Level ${c.level} ${esc(c.classLine)} · ${esc(c.species)}</div></div>
        <button data-act="home">Characters</button></header>
      <main>${wildNow(c, p) ? `<div class="banner green"><span class="grow">Wild Shape: <b>${esc(wildNow(c, p).b.name)}</b></span>${S.tab !== "companions" ? `<button data-act="tab" data-tab="companions">Show</button>` : ""}<button data-act="wild-out">Change back</button></div>` : ""}${p.conc ? `<div class="banner"><span class="grow">Concentrating on <b>${esc(p.conc)}</b></span><button data-act="conc-end">End</button></div>` : ""}
        <header class="phead">${svg(ICONS[S.tab])}<h2>${title}</h2></header>${body}</main>
      <nav class="tabs">${tabs.map(([id, label]) => `<button class="${S.tab === id ? "on" : ""}" data-act="tab" data-tab="${id}">${svg(ICONS[id])}<span>${label}</span></button>`).join("")}</nav>`;
  }

  // ---------- page 1: Abilities and attacks (and everything that changes in play, owner 2026-11-09)
  function abilities(c, p) {
    const max = maxHp(c, p), pct = Math.min(100, Math.round(p.hp / max * 100));
    const hdTotal = c.hitDice.reduce((n, d) => n + d.count, 0);
    const con = c.abilities.find(a => a.id === "con")?.mod ?? 0;
    const facts = c.facts || [["Background", c.background], ["Species", c.species], ["Alignment", c.alignment]].filter(([, v]) => v);
    const who = `<section class="box sheettop span-all"><div class="ring"><b>${c.level}</b><span>Level</span></div>
      <div class="grow"><div class="rv">${esc(c.rulesVersion || editionName(c))}</div><div class="cl">Level ${c.level} · ${esc(c.classLine)}</div>
      <div class="facts">${facts.map(([k, v]) => `<div><span>${esc(k)}</span> <b>${esc(v)}</b></div>`).join("")}</div></div></section>`;

    const hpBody = `
      <div class="hp"><div class="hp-num">${p.hp}<small> / ${max}</small></div>${p.temp ? `<div class="hp-temp">+${p.temp} temporary</div>` : ""}</div>
      <div class="hp-bar"><i class="${pct <= 25 ? "low" : ""}" style="width:${pct}%"></i></div>
      <div class="btns"><button class="btn red" data-act="damage">Damage</button><button class="btn" data-act="heal">Heal</button>
        <button class="btn blue" data-act="temp">Temp HP</button><button class="btn plain" data-act="maxadj">Max HP</button></div>
      ${p.hp === 0 ? `<div style="margin-top:14px"><div class="lvl-head">Death saves ${p.death.s >= 3 ? `<span class="tag green">Stable</span>` : p.death.f >= 3 ? `<span class="tag red">Dead</span>` : ""}</div>
        <div class="rowline"><span class="grow">Successes</span>${pips(3, p.death.s, "death", 'data-k="s"', "ok")}</div>
        <div class="rowline"><span class="grow">Failures</span>${pips(3, p.death.f, "death", 'data-k="f"', "fail")}</div></div>` : ""}`;

    const glance = `<section class="box span-all"><div class="stats">
      <div class="stat big"><b>${c.ac}</b><span>Armor class</span></div>
      <div class="stat big"><b>${max}</b><span>Max HP</span></div>
      <div class="stat"><b>${signed(c.initiative)}</b><span>Initiative</span></div>
      <div class="stat"><b>${c.speed} ft</b><span>Speed</span></div>
      <div class="stat"><b>${signed(c.pb)}</b><span>Proficiency</span></div>
      <div class="stat"><b>${c.passive.perception}</b><span>Passive Perception</span></div>
      <button class="stat tap ${p.inspiration ? "on" : ""}" data-act="insp"><b>${p.inspiration ? "★" : "☆"}</b><span>${is2024(c) ? "Heroic Inspiration" : "Inspiration"}</span></button>
    </div>${c.darkvision ? `<p class="key center">Darkvision ${c.darkvision} ft</p>` : ""}</section>`;

    const restBody = `<p class="key" style="margin-top:0">${hdTotal - Object.values(p.hdUsed).reduce((a, b) => a + b, 0)} of ${hdTotal} Hit Dice left</p>
      ${c.hitDice.map(d => {
        const used = p.hdUsed[d.die] || 0;
        return `<div class="rowline"><span class="grow"><span class="name">d${d.die}</span> <span class="note">${d.count - used} of ${d.count} left</span></span>
          <button class="btn plain" data-act="hd" data-die="${d.die}" ${used >= d.count || p.hp >= max ? "disabled" : ""}>Spend 1d${d.die}</button></div>`;
      }).join("")}
      <p class="key">Spending a Hit Die: roll it and add ${signed(con)} (Constitution).</p>
      <div class="btns"><button class="btn blue" data-act="short">Short rest</button><button class="btn" data-act="long">Long rest</button></div>`;
    // Owner 2026-11-09: hit points and resting share one box, split by a thin line.
    const vitals = box("Hit points", p.maxAdj ? `max ${signed(p.maxAdj)} (now ${max})` : "", `${hpBody}<div class="split"></div><h3 class="sub">Rest and Hit Dice</h3>${restBody}`);

    const cond = box("Conditions", "", `
      <div class="chips">${CONDITIONS.map(n => `<button class="chip ${p.conditions.includes(n) ? "on" : ""}" data-act="cond" data-n="${n}">${n}</button>`).join("")}</div>
      <div class="rowline" style="margin-top:10px"><span class="grow"><span class="name">Exhaustion</span><div class="note">${esc(exhaustionText(c, p.exhaustion))}</div></span>
        <span class="counter"><button data-act="exh" data-d="-1" aria-label="less">−</button><b>${p.exhaustion}</b><button data-act="exh" data-d="1" aria-label="more">+</button></span></div>`);

    const skillsFor = id => c.skills.filter(s => s.ability === id).map(s => `<span class="${s.prof ? "pr" : ""}">${s.expertise ? "★ " : s.prof ? "● " : ""}${esc(s.name)} <b>${signed(s.bonus)}</b></span>`).join(" · ");
    const abil = box("Abilities", "", `${c.abilities.map(a => `<div class="abrow"><div class="sq">${a.score}</div><div class="nm"><b>${abbr(a.id || a.name)}</b><span>${esc(a.name)}</span></div>
      <div class="ci">${signed(a.mod)}</div><div class="sv"><b>${a.saveProf ? "● " : ""}${signed(a.save)}</b><span>Save</span></div><div class="sk">${skillsFor(a.id)}</div></div>`).join("")}
      <p class="key">● proficient (skills and saves) · ★ expertise (double proficiency) · no mark: not proficient</p>`, "span-all");

    const adj = c.adjustments || {};
    const adjRows = [[`Initiative ${signed(c.initiative)}`, adj.initiative], [`Speed ${c.speed} ft`, adj.speed], [`Passive Perception ${c.passive.perception}`, adj.passive]].filter(([, l]) => l?.length);
    const cast = c.casting.length
      ? box("Spellcasting", "", c.casting.map(k => `<p class="line"><b>${esc(k.className)}</b> Save DC <b>${k.dc}</b> · Attack <b>${signed(k.attack)}</b> · ${esc(k.ability)}</p>`).join(""), "span-all")
      : adjRows.length ? box("Notes", "", adjRows.map(([k, l]) => `<p class="line"><b>${k}:</b> ${esc(l.join(" · "))}</p>`).join(""), "span-all") : "";

    const att = c.attacks.length ? box("Attacks", `${c.attacksPer} per Attack action`, `
      <div class="tscroll"><table class="t"><thead><tr><th>Weapon</th><th>Ability</th><th>Range</th><th class="c">To hit</th><th>Damage</th><th>Type</th></tr></thead><tbody>
      ${c.attacks.map(a => `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.ability ?? "")}</td><td>${esc(a.range)}</td><td class="c num">${a.hitText ? esc(a.hitText) : signed(a.hit)}</td><td class="num">${esc(a.damage)}</td><td>${esc(a.type)}</td></tr>
        ${a.notes ? `<tr class="n"><td colspan="6">${esc(a.notes)}</td></tr>` : ""}`).join("")}</tbody></table></div>
      ${(c.attackMods || []).map(m => `<div class="feat"><b>${esc(m.name)}${m.value ? ` (${esc(m.value)})` : ""}.</b> ${esc(m.note)}</div>`).join("")}`, "span-all") : "";

    const notes = box("Session notes", "", `<textarea class="notes" data-notes placeholder="Names, clues, loot, who owes whom…">${esc(p.notes)}</textarea>`, "span-all");
    const made = c.made ? new Date(c.made).toLocaleString() : "";
    const file = box("This character", "", `
      <p class="key">From GenPrint file <b>${esc(c.source)}</b>, made ${esc(made)}. To update it, use GenPrint's <b>GeneCodex</b> tab again and add the new file here: your play changes are kept.</p>
      ${c.warnings?.length ? `<p class="key"><b>Still open in GenPrint's build check:</b> ${esc(c.warnings.join(" · "))}</p>` : ""}
      <div class="btns"><button class="btn" data-act="add">Add or update characters</button><button class="btn gold" data-act="fresh">Start fresh</button><button class="btn plain" data-act="backup">Back up</button><button class="btn plain" data-act="restore">Restore</button><button class="btn red" data-act="remove">Remove</button></div>
      ${c.credits?.length ? `<p class="key">${esc(c.credits.join(" "))}</p>` : ""}`, "span-all");

    // Owner 2026-11-09: the AC band under the heading, then Hit points, Rest and Conditions side by side, then Attacks.
    // The third box explains the conditions ticked in the middle one (owner 2026-11-09).
    const on = CONDITIONS.filter(n => p.conditions.includes(n));
    const explain = box("Your conditions", on.length ? `${on.length} active` : "", on.length || p.exhaustion
      ? on.map(n => feat(n, "", conditionText(c, n))).join("") + (p.exhaustion ? feat(`Exhaustion ${p.exhaustion}`, "", exhaustionText(c, p.exhaustion)) : "")
      : `<p class="key">No conditions.</p>`);
    return `<div class="grid">${who}${glance}<div class="trio span-all">${vitals}${cond}${explain}</div>${att}${abil}${cast}${notes}${file}</div>`;
  }

  // What each condition does, in GeneCodex's own words (mechanics only). [2014 rules, 2024 rules where they differ]
  const CONDITION_TEXT = {
    Blinded: ["You can't see, and automatically fail any check that needs sight. Attacks against you have advantage; your attacks have disadvantage."],
    Charmed: ["You can't attack the charmer or target it with harmful abilities or magic. The charmer has advantage on checks to interact socially with you."],
    Deafened: ["You can't hear, and automatically fail any check that needs hearing."],
    Frightened: ["Disadvantage on ability checks and attacks while the source of your fear is in sight. You can't willingly move closer to it."],
    Grappled: ["Your speed is 0 and can't be increased. It ends if the grappler is incapacitated, or if you're moved out of its reach.",
      "Your speed is 0 and can't be increased. Disadvantage on attacks against anyone but the grappler. The grappler can drag or carry you as it moves (at extra cost to it). It ends if the grappler is incapacitated or you're moved out of its reach."],
    Incapacitated: ["You can't take actions or reactions.",
      "You can't take actions, bonus actions or reactions, and can't speak. Your concentration breaks. If you're incapacitated when you roll initiative, you roll with disadvantage."],
    Invisible: ["You can't be seen without magic or a special sense; for hiding you count as heavily obscured, though noise or tracks can give you away. Attacks against you have disadvantage; your attacks have advantage.",
      "Advantage on initiative. Effects that need to see you don't affect you unless the creature can see you, and neither does what you wear or carry. Attacks against you have disadvantage and your attacks have advantage, unless the creature can see you."],
    Paralyzed: ["You're incapacitated and can't move or speak. You automatically fail Strength and Dexterity saves. Attacks against you have advantage, and a hit from within 5 ft is a critical hit.",
      "You're incapacitated and your speed is 0. You automatically fail Strength and Dexterity saves. Attacks against you have advantage, and a hit from within 5 ft is a critical hit."],
    Petrified: ["You and what you carry turn to stone (weight ×10, no aging). You're incapacitated, can't move or speak, and are unaware of your surroundings. Attacks against you have advantage. You automatically fail Strength and Dexterity saves, resist all damage, and are immune to poison and disease (any already in you is suspended).",
      "You and what you carry turn to stone (weight ×10, no aging). You're incapacitated and your speed is 0. Attacks against you have advantage. You automatically fail Strength and Dexterity saves, resist all damage, and are immune to being poisoned."],
    Poisoned: ["Disadvantage on attack rolls and ability checks."],
    Prone: ["You can only crawl (each foot costs an extra foot) unless you stand up, which costs half your speed. Disadvantage on your attacks. Attacks against you have advantage from within 5 ft, disadvantage from farther away."],
    Restrained: ["Your speed is 0 and can't be increased. Attacks against you have advantage; your attacks have disadvantage. Disadvantage on Dexterity saves."],
    Stunned: ["You're incapacitated, can't move, and can speak only falteringly. You automatically fail Strength and Dexterity saves. Attacks against you have advantage.",
      "You're incapacitated. You automatically fail Strength and Dexterity saves. Attacks against you have advantage."],
    Unconscious: ["You're incapacitated, can't move or speak, and are unaware of your surroundings. You drop what you're holding and fall prone. You automatically fail Strength and Dexterity saves. Attacks against you have advantage, and a hit from within 5 ft is a critical hit.",
      "You're incapacitated and prone, your speed is 0, and you're unaware of your surroundings. You drop what you're holding (and stay prone when it ends). You automatically fail Strength and Dexterity saves. Attacks against you have advantage, and a hit from within 5 ft is a critical hit."],
  };
  const conditionText = (c, n) => { const t = CONDITION_TEXT[n] || [""]; return is2024(c) && t[1] ? t[1] : t[0]; };

  function exhaustionText(c, n) {
    if (!n) return "None.";
    if (n >= 6) return "Level 6: death.";
    if (is2024(c)) return `−${n * 2} to every d20 test, speed −${n * 5} ft.`;
    return ["Disadvantage on ability checks", "speed halved", "disadvantage on attacks and saves", "HP max halved", "speed 0"].slice(0, n).join("; ") + ".";
  }

  // ---------- page 2: Skills and defense
  function skills(c) {
    const rows = c.skills.map(s => {
      const og = [(s.origins || []).map(o => `<i>${esc(o)}</i>`).join(", "), (s.expertiseOrigins || []).length ? `<b>${esc(s.expertiseOrigins.join(", "))}</b>` : "", (s.items || []).length ? `Item ${esc(s.items.join(", "))}` : ""].filter(Boolean).join(" · ");
      return `<tr class="${s.prof ? "pr" : ""}"><td class="c mark">${s.expertise ? "★" : s.prof ? "●" : ""}</td><td class="c num">${signed(s.bonus)}</td><td>${esc(s.name)} <span class="sab">(${abbr(s.ability)})</span></td><td class="og">${og}</td></tr>`;
    }).join("");
    const sk = box("Skills", "● proficient · ★ expertise", `<table class="t skills"><tbody>${rows}</tbody></table>
      <p class="key">Where it came from: <i>proficiency</i>, <b>expertise</b>. Cls class, Sub subclass, Race, Bkg background, Feat, Item (a magic item's bonus).</p>`);
    const pr = c.proficiencies;
    const right = [
      box("Armor class", `AC ${c.ac}`, `${c.acLabel ? `<p class="line">${esc(c.acLabel)}.</p>` : ""}${c.acNote ? `<p class="line">${esc(c.acNote)}</p>` : ""}`),
      box("Saves and resistances", "", `${c.defenses?.length ? c.defenses.map(x => `<p class="line"><b>${esc(x.name)}:</b> ${esc(x.text)}.</p>`).join("") : `<p class="line">None from your features.</p>`}
        ${c.magicNotes?.length ? `<p class="line"><b>Magic items:</b> ${esc(c.magicNotes.join("; "))}.</p>` : ""}`),
      box("Health", "", `<p class="line"><b>Max HP ${c.hp.max}.</b> ${esc(c.hp.formula)}.</p><p class="line"><b>Hit dice:</b> ${esc(c.hitDiceText || c.hitDice.map(d => `${d.count}d${d.die}`).join(" + "))}.</p>
        <p class="line"><b>Death saves:</b> at 0 HP, roll d20 each turn: 10+ succeeds; 3 successes stabilize you, 3 failures kill you; a 1 is 2 failures, a 20 restores 1 HP.</p>`),
      c.speedNotes?.length ? box("Speed", `${c.speed} ft`, `<p class="line">${esc(c.speedNotes.join("; "))}.</p>`) : "",
      box("Senses", "", `<p class="line"><b>Passive Perception ${c.passive.perception}</b> · Investigation ${c.passive.investigation} · Insight ${c.passive.insight}</p>${c.darkvision ? `<p class="line">Darkvision ${c.darkvision} ft.</p>` : ""}`),
      box("Proficiencies", "", `<dl class="dl">${[["Armor", pr.armor], ["Weapons", pr.weapons], ["Tools", pr.tools], ["Languages", pr.languages]].map(([k, v]) => `<dt>${k}</dt><dd>${v.length ? esc(v.join(", ")) : "None"}</dd>`).join("")}</dl>`),
    ].join("");
    return `<div class="grid two"><div>${sk}</div><div class="stack">${right}</div></div>`;
  }

  // ---------- page 3: Species, background and feats
  function origins(c) {
    const old = kind => c.features.filter(f => f.kind === kind);
    const si = c.speciesInfo;
    const species = box("Species traits", esc(si ? si.head : c.species), si
      ? `${si.notes.map(n => `<div class="feat"><b>${esc(n.label)}:</b> ${esc(n.value)}</div>`).join("")}${si.traits.map(t => feat(t.name, "", t.text)).join("") || none()}`
      : old("species").map(f => feat(f.name, "", f.text)).join("") || none());
    const bi = c.backgroundInfo;
    const background = box("Background", esc(bi ? bi.name : c.background), bi
      ? `${bi.flavor ? bi.flavor.split(/\n+/).map(t => `<p class="flavor">${esc(t)}</p>`).join("") : ""}<dl class="dl">${bi.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${bi.feature ? feat(bi.feature.name, "Feature", bi.feature.text) : ""}`
      : old("background").map(f => feat(f.name, "Feature", f.text)).join("") || none("None chosen."));
    const feats = box("Feats and ability score improvements", "", (c.featList
      ? c.featList.map(f => feat(f.name, f.tag, f.text)).join("") : old("feat").map(f => feat(f.name, "", f.text)).join("")) || none());
    return `<div class="stack">${species}${background}${feats}</div>`;
  }

  // ---------- page 4: Actions, then the limited use features (with tick boxes)
  function actions(c, p) {
    const lines = rows => rows?.length ? rows.map(x => `<div class="feat${x.own ? " own" : ""}"><b>${esc(x.name)}.</b> ${esc(x.note)}</div>`).join("") : none();
    const lim = c.limited.length ? box("Limited use features", "tap a box to use it", `<table class="t lim"><thead><tr><th>Feature</th><th>Uses</th><th>Recovery</th></tr></thead><tbody>${c.limited.map(l => {
      const used = p.uses[l.id] || 0, left = l.uses - used;
      const control = l.uses > 10
        ? `<span class="counter"><button data-act="use-n" data-id="${esc(l.id)}" data-d="1" aria-label="use">−</button><b>${left}</b><button data-act="use-n" data-id="${esc(l.id)}" data-d="-1" aria-label="regain">+</button></span>`
        : pips(l.uses, used, "use", `data-id="${esc(l.id)}"`);
      return `<tr><td><b>${esc(l.name)}.</b> ${esc(l.note)}</td><td>${control}<div class="note">${left} of ${l.uses}${l.unit ? ` ${esc(l.unit)}` : ""} left</div></td><td>${esc(l.recovery || "—")}</td></tr>`;
    }).join("")}</tbody></table>`) : box("Limited use features", "", none());
    return `<div class="stack">${box("Actions", "Each turn, 1 move, 1 action, 1 bonus action", lines(c.actions))}${box("Bonus actions", "", lines(c.bonus))}${box("Reactions", "", lines(c.reactions))}
      ${c.untagged?.length ? `<p class="key">Not sorted onto the actions yet (their full text is on the Features page): ${esc(c.untagged.join(", "))}.</p>` : ""}${lim}</div>`;
  }

  // ---------- page 5: Class features
  function features(c) {
    let groups = c.classFeatures;
    if (!groups) {   // a file made before the sheet-style pages: group its class features by name
      const m = new Map();
      for (const f of c.features.filter(f => f.kind === "class" || f.kind === "pick")) { if (!m.has(f.group)) m.set(f.group, []); m.get(f.group).push({ name: f.name, tag: f.level ? `Level ${f.level}` : "", text: f.text }); }
      groups = [...m].map(([g, list]) => ({ className: g, level: "", subclass: "", features: list }));
    }
    return `<div class="stack">${groups.map(g => box(`${esc(g.className)} ${g.level}`, esc(g.subclass), g.features.map(f => feat(f.name, f.tag, f.text)).join("") || none("None yet."))).join("")}</div>`;
  }

  // ---------- Log (owner 2026-11-10): sessions, story rewards, gold and treasure, XP. Kept with the play changes
  // (play.log, newest last; play.xpStart; play.lastDm). Coins in an entry go into your money when it's saved;
  // items show on the Equipment page under "Items found".
  const XP_AT = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
  const coinText = m => COINS.filter(k => +m?.[k]).map(k => `${+m[k]} ${k}`).join(", ");
  const todayIso = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const niceDate = iso => { if (!iso) return ""; const d = new Date(iso + "T12:00:00"); return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };
  const lines = t => String(t || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
  const xpStartOf = (c, p) => p.xpStart ?? XP_AT[c.level - 1] ?? 0;
  // Coins as gold pieces (owner 2026-11-10: the log has a starting gold amount, the GenPrint money by default).
  const GP_VALUE = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
  const inGp = m => Math.round(COINS.reduce((n, k) => n + (+m?.[k] || 0) * GP_VALUE[k], 0) * 100) / 100;
  const goldStartOf = (c, p) => p.goldStart ?? inGp(c.money);

  // Campaigns (owner 2026-11-10): the log follows the character's campaign (sent by GenPrint as c.campaign):
  // "tokens" (Badgers Den: Hero Tokens buy levels, spare tokens become downtime days), "dm" (home games: the DM grants
  // levels), or "xp" (no campaign). Entry kinds: a session (default), "level" (a level bought), "downtime".
  const progKind = c => c.campaign?.progression?.kind || "xp";
  const TOKENS = c => c.campaign?.progression?.tokens || [];
  const tokenFor = (c, level) => TOKENS(c).find(t => level >= t.levels[0] && level <= t.levels[1]) || null;
  const tokenText = (c, m) => TOKENS(c).filter(t => +m?.[t.id]).map(t => `${+m[t.id]} ${t.name}`).join(", ");
  function logTally(c, p) {
    const log = p.log || [];
    const tokens = Object.fromEntries(TOKENS(c).map(t => [t.id, 0]));
    let days = 0, perm = 0, cons = 0;
    for (const e of log) {
      for (const t of TOKENS(c)) tokens[t.id] += (+e.tokens?.[t.id] || 0) - (+e.convert?.[t.id] || 0) - (e.kind === "level" && e.token === t.id ? 1 : 0);
      days += TOKENS(c).reduce((n, t) => n + (+e.convert?.[t.id] || 0) * t.downtime, 0) - (+e.dtSpent || 0);
      perm += +e.perm || 0; cons += +e.cons || 0;
    }
    const levels = log.filter(e => e.toLevel).map(e => +e.toLevel);
    const target = Math.min(20, Math.max(c.level, ...levels));
    return { tokens, days, perm, cons, target, sessions: log.filter(e => !e.kind).length };
  }
  const rankAt = (c, level) => { const r = (c.campaign?.faction?.ranks || []).filter(k => level >= k.level); return r[r.length - 1] || null; };
  // What the campaign's log asks for (set on GenPrint's Campaigns page); Badgers Den's tokens bring their own fields.
  const logWants = (c, k) => !!c.campaign?.log?.[k] || (k !== "itemCap" && progKind(c) === "tokens" && ["code", "venue", "certs", "magicCounts", "downtime"].includes(k));
  // Wardens-style levelling: how many adventures each level takes, and how many since the last level-up.
  const advNeeded = (c, level) => (c.campaign?.progression?.adventures || []).find(a => level >= a.from && level <= a.to)?.count || 1;
  function advCount(c, p) {
    let since = 0;
    for (const e of [...(p.log || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id)) {
      if (e.kind) continue;
      since++;
      if (e.levelUp) since = 0;
    }
    return since;
  }
  // The faction or alliance line: name, title at this level and its reward; the next one.
  function factionLine(c, level) {
    const f = c.campaign?.faction;
    if (!f) return "";
    const r = rankAt(c, level), next = (f.ranks || []).find(k => level < k.level);
    return `${esc(f.name)}${r ? `: <b>${esc(r.name)}</b>${r.reward ? ` (${esc(r.reward)})` : ""}` : ""}${next ? ` · next: ${esc(next.name)} at level ${next.level}${next.reward ? ` (${esc(next.reward)})` : ""}` : ""}`;
  }
  // Wardens: magic item certificates allowed (3 at levels 1-3, then one per level).
  const itemCap = level => level <= 3 ? 3 : level;

  function logForm(c, d) {
    const f = (label, name, type = "text", extra = "") => `<label class="lf"><span>${label}</span><input type="${type}" data-lf="${name}" value="${esc(d[name] ?? "")}" ${extra}></label>`;
    const t = (label, name, hint) => `<label class="lf wide"><span>${label}</span><textarea data-lf="${name}" placeholder="${esc(hint)}">${esc(d[name] ?? "")}</textarea></label>`;
    const num = 'inputmode="numeric" min="0"';
    const tokenInputs = (label, key, hint) => `<div class="lf wide"><span>${label}${hint ? ` <small>(${hint})</small>` : ""}</span><div class="money">${TOKENS(c).map(k =>
      `<label class="coin tok-${k.id}"><input type="number" ${num} data-lf="${key}-${k.id}" value="${esc(d[key + "-" + k.id] || "")}" placeholder="0"><span>${k.name}</span></label>`).join("")}</div></div>`;
    const kind = progKind(c), btns = `<div class="btns"><button class="btn" data-act="log-save">Save entry</button><button class="btn plain" data-act="log-cancel">Cancel</button></div>`;
    if (d.kind === "downtime") return box(d.id ? "Edit downtime" : "Downtime", "", `<div class="lfgrid">${f("Date", "date", "date")}${f("DM or organizer", "dm")}${f("Days spent", "dtSpent", "number", num)}</div>
      ${tokenInputs("Hero Tokens turned into downtime days", "convert", TOKENS(c).map(k => `${k.name} ${k.downtime} days`).join(", "))}
      ${t("Activity", "notes", "Crafting, copying spells, scribing scrolls, a Bastion turn (7 days)…")}${btns}`, "span-all logform");
    return box(d.id ? "Edit entry" : "New entry", "", `<div class="lfgrid">
        ${f("Date", "date", "date")}${f(kind === "tokens" || kind === "adventures" ? "Adventure" : "Session title", "title", "text", 'placeholder="e.g. The Sunken Shrine"')}${logWants(c, "code") ? f("Adventure code", "code", "text", 'placeholder="e.g. BDEN-01"') : ""}
        ${f(logWants(c, "venue") ? "Venue" : "Location", "location", "text", 'placeholder="e.g. Game Haven, a friend&#39;s house, online"')}${f("DM", "dm")}${kind === "xp" ? f("XP earned", "xp", "number", num) : ""}
      </div>
      ${kind === "tokens" ? tokenInputs("Hero Tokens earned", "tokens") : ""}
      ${kind === "dm" ? `<label class="lf wide check"><input type="checkbox" data-lf="levelUp"${d.levelUp ? " checked" : ""}> The DM granted a level this session</label>` : ""}
      ${kind === "adventures" ? `<label class="lf wide check"><input type="checkbox" data-lf="levelUp"${d.levelUp ? " checked" : ""}> I levelled up after this adventure</label>` : ""}
      <div class="lf wide"><span>Coins found <small>(added to your money when you save)</small></span><div class="money">${COINS.map(k =>
        `<label class="coin ${k}"><input type="number" ${num} data-lf="coin-${k}" value="${esc(d["coin-" + k] || "")}" placeholder="0"><span>${k}</span></label>`).join("")}</div></div>
      ${t(logWants(c, "certs") ? "Story awards and certificates" : "Story rewards", "rewards", "Boons, titles, favors, blessings, lore… one per line")}
      ${t("Treasure and items found", "items", "One item per line, e.g. Potion of Healing ×2")}
      ${logWants(c, "magicCounts") ? `<div class="lfgrid">${f("Permanent magic items gained", "perm", "number", num)}${f("Consumable magic items gained", "cons", "number", num)}</div>` : ""}
      ${t("Session notes", "notes", "What happened, who you met, what's next…")}${btns}`, "span-all logform");
  }

  function logPage(c, p) {
    const log = p.log || [], kind = progKind(c), camp = c.campaign;
    const tally = logTally(c, p);
    const found = Object.fromEntries(COINS.map(k => [k, log.reduce((n, e) => n + (+e.coins?.[k] || 0), 0)]));
    const goldStart = goldStartOf(c, p), goldAll = Math.round((goldStart + inGp(found)) * 100) / 100;
    const goldStat = `<div class="stat"><b>${goldAll.toLocaleString()} gp</b><span>Gold, start + found</span></div>`;
    const goldLine = `<p class="key center">Gold = starting gold <input class="xpstart" type="number" inputmode="decimal" min="0" step="any" data-goldstart value="${goldStart}"> gp + ${coinText(found) || "nothing yet"} found in the log. (Your money to spend is on the Equipment tab.)</p>`;
    const pending = tally.target > c.level ? `<p class="levelup">Level ${tally.target} is yours: level the character up in GenPrint, then send it to GeneCodex again (your log and play changes stay).</p>` : "";
    let stats, extra = "", buttons = `<button class="btn" data-act="log-new">New entry</button>`;
    if (kind === "tokens") {
      const need = tally.target < 20 ? tokenFor(c, tally.target) : null, have = need ? tally.tokens[need.id] : 0;
      const rank = rankAt(c, tally.target);
      stats = `<div class="stat"><b>${tally.sessions}</b><span>Adventures</span></div>
        <div class="stat big"><b>${tokenText(c, tally.tokens) || "none"}</b><span>Hero Tokens</span></div>
        <div class="stat"><b>${tally.days}</b><span>Downtime days</span></div>${goldStat}`;
      extra = `<p class="key center">Level ${tally.target} · tier ${tally.target >= 17 ? 4 : tally.target >= 11 ? 3 : tally.target >= 5 ? 2 : 1}${need ? ` · level ${tally.target + 1} costs 1 ${need.name} token` : ""}.${camp.faction ? `<br>${factionLine(c, tally.target)}` : ""}
        Magic items from the log: ${tally.perm} permanent, ${tally.cons} consumable (for tie-breakers).</p>`;
      if (need) buttons += `<button class="btn gold" data-act="log-level"${have ? "" : " disabled"}>Buy level ${tally.target + 1} (1 ${need.name})</button>`;
      buttons += `<button class="btn plain" data-act="log-downtime">Downtime</button>`;
    } else if (kind === "adventures") {
      const need = advNeeded(c, tally.target), since = advCount(c, p), ready = tally.target < 20 && since >= need;
      stats = `<div class="stat"><b>${tally.sessions}</b><span>Adventures</span></div><div class="stat big"><b>${tally.target}</b><span>Level</span></div>
        <div class="stat"><b>${Math.min(since, need)} of ${need}</b><span>Toward level ${Math.min(20, tally.target + 1)}</span></div>${goldStat}`;
      const certs = (c.magicItems || []).length + tally.perm + tally.cons;
      extra = `${ready ? `<p class="levelup">Your last adventure was enough for level ${tally.target + 1}. If you levelled up at its end, tick "I levelled up" on that entry (levels can't be saved for later).</p>` : ""}
        <p class="key center">${esc(camp.progression.text)}${camp.faction ? `<br>${factionLine(c, tally.target)}` : camp.factionRequired ? `<br>Choose your ${esc((camp.factionLabel || "faction").toLowerCase())} in GenPrint.` : ""}
        ${logWants(c, "itemCap") ? `<br>Magic item certificates: ${certs} of ${itemCap(tally.target)} (on the sheet plus the log's).` : ""}</p>`;
    } else if (kind === "dm") {
      stats = `<div class="stat"><b>${tally.sessions}</b><span>Sessions</span></div><div class="stat big"><b>${tally.target}</b><span>Level</span></div>
        <div class="stat"><b>${log.filter(e => e.levelUp).length}</b><span>Levels granted</span></div>${goldStat}`;
      extra = `<p class="key center">${esc(camp.progression.text)}${camp.faction ? `<br>${factionLine(c, tally.target)}` : ""}</p>`;
    } else {
      const start = xpStartOf(c, p), earned = log.reduce((n, e) => n + (+e.xp || 0), 0), xp = start + earned;
      const reach = Math.min(20, XP_AT.filter(t => xp >= t).length), next = c.level < 20 ? XP_AT[c.level] : null;
      stats = `<div class="stat"><b>${log.length}</b><span>Sessions</span></div><div class="stat big"><b>${xp.toLocaleString()}</b><span>XP total</span></div>
        <div class="stat"><b>${next != null ? next.toLocaleString() : "—"}</b><span>Next level at</span></div>${goldStat}`;
      extra = `${reach > c.level ? `<p class="levelup">Enough XP for level ${reach}! Level the character up in GenPrint, then send it to GeneCodex again (your log and play changes stay).</p>` : ""}
        <p class="key center">XP total = starting XP <input class="xpstart" type="number" inputmode="numeric" min="0" data-xpstart value="${start}"> + ${earned.toLocaleString()} from the log.</p>`;
    }
    const summary = `<section class="box span-all">${camp ? `<p class="key center camp">${esc(camp.name)}</p>` : ""}<div class="stats four">${stats}</div>
      ${pending}${extra}${goldLine}${S.logDraft ? "" : `<div class="btns center">${buttons}</div>`}</section>`;
    const entries = [...log].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id).map(e => {
      const edit = `<div class="btns">${e.kind === "level" ? "" : `<button class="btn plain small" data-act="log-edit" data-id="${e.id}">Edit</button>`}<button class="btn plain small" data-act="log-del" data-id="${e.id}">Delete</button></div>`;
      if (e.kind === "level") return box(`${esc(niceDate(e.date))} · Level ${e.toLevel}`, "", `<p class="line">Bought with 1 ${esc(TOKENS(c).find(t => t.id === e.token)?.name || "")} Hero Token.</p>${edit}`, "logmini");
      if (e.kind === "downtime") return box(`${esc(niceDate(e.date))} · Downtime`, e.dm ? `DM ${esc(e.dm)}` : "", `
        ${tokenText(c, e.convert) ? `<p class="line"><b>Turned into downtime:</b> ${esc(tokenText(c, e.convert))} (${TOKENS(c).reduce((n, t) => n + (+e.convert?.[t.id] || 0) * t.downtime, 0)} days)</p>` : ""}
        ${+e.dtSpent ? `<p class="line"><b>Days spent:</b> ${+e.dtSpent}</p>` : ""}${e.notes ? `<p class="feat">${esc(e.notes)}</p>` : ""}${edit}`, "logmini");
      return box(`${esc(niceDate(e.date))}${e.title ? ` · ${esc(e.title)}` : ""}${e.code ? ` (${esc(e.code)})` : ""}`, [e.location && esc(e.location), e.dm && `DM ${esc(e.dm)}`, +e.xp && `${(+e.xp).toLocaleString()} XP`].filter(Boolean).join(" · "), `
        ${tokenText(c, e.tokens) ? `<p class="line"><b>Hero Tokens:</b> ${esc(tokenText(c, e.tokens))}</p>` : ""}
        ${e.levelUp ? `<p class="line"><b>${kind === "adventures" ? "Levelled up" : "The DM granted a level"}</b>${e.toLevel ? ` (to level ${e.toLevel})` : ""}.</p>` : ""}
        ${coinText(e.coins) ? `<p class="line"><b>Coins:</b> ${esc(coinText(e.coins))}</p>` : ""}
        ${+e.perm || +e.cons ? `<p class="line"><b>Magic items:</b> ${+e.perm || 0} permanent, ${+e.cons || 0} consumable</p>` : ""}
        ${lines(e.rewards).length ? `<div class="lvl-head">${logWants(c, "certs") ? "Story awards and certificates" : "Story rewards"}</div><ul class="loglist">${lines(e.rewards).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${lines(e.items).length ? `<div class="lvl-head">Treasure and items</div><ul class="loglist">${lines(e.items).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${e.notes ? `<div class="lvl-head">Notes</div><p class="feat">${esc(e.notes)}</p>` : ""}${edit}`);
    }).join("");
    return `<div class="grid">${summary}${S.logDraft ? logForm(c, S.logDraft) : ""}<div class="span-all stack">${entries || (S.logDraft ? "" : box("No entries yet", "", none("Tap <b>New entry</b> after a session to record what happened, what you earned and what you found.")))}</div></div>`;
  }

  // ---------- page 6: Equipment
  function equipment(c, p) {
    const money = `<section class="box span-all"><div class="money">${COINS.map(k =>
      `<label class="coin ${k}"><input type="number" inputmode="numeric" pattern="[0-9]*" min="0" data-coin="${k}" value="${p.money[k] || 0}"><span>${k}</span></label>`).join("")}</div>
      <div class="stats" style="margin-top:10px"><div class="stat"><b>${c.weight != null ? esc(c.weight) + " lb" : "—"}</b><span>Carrying</span></div><div class="stat"><b>${c.capacity != null ? esc(c.capacity) + " lb" : "—"}</b><span>Capacity</span></div></div>
      <p class="key center">Tap a coin to change it.</p></section>`;
    const gearRows = [...c.equipment].sort((a, b) => a.name.localeCompare(b.name)).map(g => `<tr><td>${esc(g.name)}${g.from ? ` <span class="ftag">from ${esc(g.from)}</span>` : ""}</td><td class="c">${g.qty}</td><td class="r">${g.carried === false ? "stored" : g.lb != null ? esc(Math.round(g.lb * g.qty * 100) / 100) + " lb" : "—"}</td></tr>`).join("");
    const gear = box("Adventuring gear", "", gearRows ? `<table class="t gear"><thead><tr><th>Item</th><th class="c">#</th><th class="r">Weight</th></tr></thead><tbody>${gearRows}</tbody></table>` : none());
    const tickMark = on => `<span class="tickbox">${on ? "✓" : ""}</span>`;
    const magic = box("Magic items", `${c.attuned} of ${c.attuneMax} attuned`, c.magicItems.length ? `<table class="t magic"><thead><tr><th>Item</th><th class="c">Equipped</th><th class="c">Attuned</th></tr></thead><tbody>${c.magicItems.map((m, i) =>
      `<tr><td>${openable("mi:" + i, `<span class="grow"><span class="name">${esc(m.name)}${m.qty > 1 ? ` × ${m.qty}` : ""}</span><div class="meta">${esc([m.type, m.rarity].filter(Boolean).join(", "))}</div></span>`, esc(m.text || "No description."))}</td>
        <td class="c">${m.equippable === false ? "—" : tickMark(m.equipped)}</td><td class="c">${m.attune ? tickMark(m.attuned) : "—"}</td></tr>`).join("")}</tbody></table>` : none());
    // Treasure from the log (owner 2026-11-10), newest session first.
    const foundRows = [...(p.log || [])].sort((a, b) => String(b.date).localeCompare(String(a.date))).flatMap(e => lines(e.items).map(x => `<tr><td>${esc(x)}</td><td>${esc([niceDate(e.date), e.title].filter(Boolean).join(" · "))}</td></tr>`)).join("");
    const found = foundRows ? box("Items found", "from your log", `<table class="t"><thead><tr><th>Item</th><th>Session</th></tr></thead><tbody>${foundRows}</tbody></table>`) : "";
    return `<div class="grid">${money}<div class="span-all stack">${gear}${magic}${found}</div></div>`;
  }

  // ---------- page 7: Spell list (slots to tick, every spell's full text a tap away)
  function spells(c, p) {
    const casting = c.casting.length ? box("Spellcasting", "", c.casting.map(k => `<p class="line"><b>${esc(k.className)}</b> Save DC <b>${k.dc}</b> · Attack <b>${signed(k.attack)}</b> · ${esc(k.ability)}</p>`).join("")) : "";
    const slotRows = (c.slots || []).map((n, i) => n ? `<div class="rowline"><span class="grow"><span class="name">${ord(i + 1)} level</span> <span class="note">${n - (p.slots[i] || 0)} of ${n} left</span></span>${pips(n, p.slots[i] || 0, "slot", `data-l="${i}"`)}</div>` : "").join("");
    const pact = c.pact ? `<div class="rowline"><span class="grow"><span class="name">Pact Magic</span> <span class="tag blue">${ord(c.pact.level)} level</span> <span class="note">${c.pact.count - p.pact} of ${c.pact.count} left · back on a short rest</span></span>${pips(c.pact.count, p.pact, "pact")}</div>` : "";
    const slots = slotRows || pact ? box("Spell slots", "tap a box to use a slot", slotRows + pact) : "";
    // Prepared spells (owner 2026-11-09): a caster who prepares (Cleric from the class list, Wizard from the spellbook...)
    // ticks today's spells; they sit at the top of the group under "Prepared today". Cantrips and always-prepared spells aren't counted.
    const groups = c.spells.map((g, gi) => {
      const byLevel = rows => {
        const out = []; let last;
        for (const s of [...rows].sort((x, y) => (x.level ?? 99) - (y.level ?? 99))) {
          if (s.level !== last) { out.push(`<div class="lvl-head">${s.level === 0 ? "Cantrips" : s.level == null ? "Other" : ord(s.level) + " level"}</div>`); last = s.level; }
          out.push(spellRow(s, `${gi}:${s.id}`, p, canPrep(s) ? { group: g.title, on: chosen.has(s.id) } : null));
        }
        return out.join("");
      };
      const canPrep = s => g.prepared != null && s.level > 0 && !/always prepared/i.test(s.how || "");
      // GenPrint's usual daily spells (`planned`) are today's spells until the owner changes them here (owner 2026-11-09).
      const planned = plannedIds(g);
      const chosen = new Set(todaysIds(p, g).filter(id => g.spells.some(s => s.id === id && canPrep(s))));
      const differs = planned.length && (planned.length !== chosen.size || planned.some(id => !chosen.has(id)));
      const today = g.spells.filter(s => chosen.has(s.id));
      const mine = g.spells.filter(s => !s.fromList && !chosen.has(s.id)), list = g.spells.filter(s => s.fromList && !chosen.has(s.id));
      const over = g.prepared != null && chosen.size > g.prepared;
      const head = [g.ability, g.dc != null && `DC ${g.dc}`, g.attack != null && `attack ${signed(g.attack)}`].filter(Boolean).join(" · ");
      const prepLine = g.prepared != null ? `<p class="key prepcount${over ? " over" : ""}">${chosen.size} of ${g.prepared} spells prepared today${over ? ": more than you can prepare" : ""}. Tap <b>Prepare</b> beside a spell to add or remove it.</p>`
        + (differs ? `<div class="btns"><button class="btn plain" data-act="prep-reset" data-g="${esc(g.title)}">Back to GenPrint's list</button></div>` : "") : "";
      return box(esc(g.title), esc(head), `${prepLine}
        ${today.length ? `<div class="today"><div class="lvl-head big">Prepared today</div>${byLevel(today)}</div>` : ""}
        ${mine.length ? (today.length && g.style === "book" ? `<div class="lvl-head big">Rest of your spellbook</div>` : "") + byLevel(mine) : list.length && !today.length ? none("Prepared from the whole class list below.") : ""}
        ${list.length ? openable(`list:${gi}`, `<span class="grow name">Whole class list <span class="note">(${list.length} more spells you can prepare)</span></span>`, byLevel(list)) : ""}`);
    }).join("");
    return `<div class="stack">${casting}${slots}${groups || box("Spells", "", none("No spells."))}</div>`;
  }

  // ---------- page 2: Companions (owner 2026-11-09: right after the first page; familiars, steeds, summons...)
  // Each creature has its own hit points to track. A summon spell has a slot picker that redoes its numbers.
  const firstNumber = v => parseInt(String(v).match(/\d+/)?.[0] || "1", 10);
  function statBlock(b, hpKey, p) {
    const line = (k, v) => v ? `<div><b>${k}</b> ${esc(v)}</div>` : "";
    const list = (title, rows) => rows?.length ? `${title ? `<div class="lvl-head">${title}</div>` : ""}${rows.map(t => feat(t.name, "", t.text)).join("")}` : "";
    const max = firstNumber(b.hp) + (b.tempHp || 0);
    const now = (p.compHp || {})[hpKey] ?? max;
    const attacks = b.attacks?.length ? `<div class="tscroll"><table class="t"><thead><tr><th>Attack</th><th class="c">To hit</th><th>Range</th><th>Damage</th><th>Type</th></tr></thead><tbody>${b.attacks.map(a =>
      `<tr><td><b>${esc(a.name)}</b></td><td class="c num">${a.hit == null ? "save" : signed(a.hit)}</td><td>${esc(a.range)}</td><td><b>${esc(a.damage)}</b></td><td>${esc(a.type)}</td></tr>${a.notes ? `<tr class="n"><td colspan="5">${esc(a.notes)}</td></tr>` : ""}`).join("")}</tbody></table></div>` : "";
    return `<div class="sb">
      <div class="sb-name"><b>${esc(b.name)}</b> <i>${esc(b.line)}</i></div>
      ${b.ownHp ? `<p class="key">Uses your own hit points${b.tempHp ? `, plus ${b.tempHp} temporary hit points when you change (Change into gives them to you)` : ""}.</p>` : `<div class="sb-hp"><div class="sb-hpnum"><b>${now}</b><span>of ${esc(b.hp)} HP${b.tempHp ? ` (+${b.tempHp} temporary)` : ""}</span></div>
        <button class="btn red" data-act="comp-dmg" data-k="${esc(hpKey)}" data-max="${max}">Damage</button><button class="btn" data-act="comp-heal" data-k="${esc(hpKey)}" data-max="${max}">Heal</button><button class="btn plain" data-act="comp-full" data-k="${esc(hpKey)}">Full</button></div>`}
      <div class="sb-top"><div><span>AC</span> <b>${esc(b.ac)}</b>${b.acNote ? ` <small>${esc(b.acNote)}</small>` : ""}</div><div><span>HP</span> <b>${esc(b.hp)}</b>${b.hd ? ` <small>(${esc(b.hd)})</small>` : ""}${b.hpNote ? ` <small>${esc(b.hpNote)}</small>` : ""}</div><div><span>Speed</span> ${esc(b.speed)}</div></div>
      ${b.abilities ? `<div class="sb-ab">${b.abilities.map(a => `<div><span>${a.id.toUpperCase()}</span><b>${a.score}</b><small>${signed(a.mod)}</small></div>`).join("")}</div>` : ""}
      <div class="sb-facts">${line("Saves", b.saves)}${line("Skills", b.skills)}${line("Vulnerable", b.vuln)}${line("Resistant", b.resist)}${line("Immune", b.immune)}${line("Condition immunities", b.condImmune)}${line("Senses", b.senses)}${line("Languages", b.languages)}${line("Challenge", String(b.cr || "").replace(/^CR /, ""))}</div>
      ${b.pbNote ? `<p class="key">${esc(b.pbNote)}</p>` : ""}${b.notes ? `<p class="key">${esc(b.notes)}</p>` : ""}
      ${list("", b.traits)}
      ${b.actions?.length || b.attacks?.length ? `<div class="lvl-head">Actions${b.attacksPer ? ` · ${b.attacksPer} attacks per Attack action` : ""}</div>${list("", b.actions)}${attacks}` : ""}
      ${list("Bonus actions", b.bonus)}${list("Reactions", b.reactions)}</div>`;
  }
  // Wild Shape (owner 2026-11-10): tap Change into on a known form; it opens at the top of this page with its numbers
  // worked out for you (GenPrint does the sums), and a bar on every tab says which form you're in.
  const isWild = k => /^wild-shape/.test(k.key);
  const wildNow = (c, p) => {
    const w = p.wildForm, k = w && (c.companions || []).find(x => x.key === w.key);
    const b = k && k.blocks[w.i];
    return b && b.name === w.name ? { k, b, i: w.i } : null;
  };
  function wildBox(c, p) {
    const now = wildNow(c, p);
    if (!now) return "";
    const max = maxHp(c, p);
    const mine = now.b.ownHp ? `<div class="sb-hp"><div class="sb-hpnum"><b>${p.hp}</b><span>of ${max} HP (yours)${p.temp ? ` + ${p.temp} temporary` : ""}</span></div>
      <button class="btn red" data-act="damage">Damage</button><button class="btn" data-act="heal">Heal</button></div>` : "";
    return box(`Wild Shape: ${esc(now.b.name)}`, `<button class="btn plain small" data-act="wild-out">Change back</button>`, mine + statBlock(now.b, `${now.k.key}:${now.i}`, p), "wildnow");
  }
  function companions(c, p) {
    return `<div class="stack">${wildBox(c, p)}${(c.companions || []).map(k => {
      if (isWild(k)) {
        const now = wildNow(c, p);
        const l = c.limited.find(x => x.id === "wild-shape"), left = l ? +l.uses - (p.uses[l.id] || 0) : null;
        return box(esc(k.title), esc(k.from), `<p class="feat">${esc(k.about)}</p>
          ${l ? `<p class="key">${left} of ${l.uses} Wild Shape uses left.</p>` : ""}
          ${k.needsPick ? none(`No ${esc(k.pickLabel.toLowerCase())} chosen yet. Pick them in GenPrint's Companions section and send the character again.`) : ""}
          ${k.blocks.map((b, i) => openable(`ws:${k.key}:${i}`, `<span class="grow"><span class="name">${esc(b.name)}</span><div class="meta">${esc(b.line)} · AC ${esc(b.ac)} · ${esc(b.speed)}</div></span>${now && now.i === i ? `<span class="tag green">Now</span>` : `<button class="prep" data-act="wild-in" data-k="${esc(k.key)}" data-i="${i}">Change into</button>`}`,
            statBlock(b, `${k.key}:${i}`, p))).join("")}`);
      }
      const L = (p.compSlot || {})[k.key] || k.slot;
      const blocks = (k.bySlot && k.bySlot[L]) || k.blocks;
      const picker = k.bySlot ? `<div class="slotpick"><span class="note">Cast with a slot of level</span>${Object.keys(k.bySlot).map(Number).map(l =>
        `<button class="${l === L ? "on" : ""}" data-act="comp-slot" data-k="${esc(k.key)}" data-l="${l}">${ord(l)}</button>`).join("")}</div>` : "";
      return box(esc(k.title), esc(k.from), `<p class="feat">${esc(k.about)}</p>${picker}
        ${k.upgrades.map(u => feat(`Level ${u.level}`, "", u.text)).join("")}
        ${k.needsPick ? none(`No ${esc(k.pickLabel.toLowerCase())} chosen yet. Pick one in GenPrint's Companions section and send the character again.`) : ""}
        ${blocks.map((b, i) => statBlock(b, `${k.key}:${i}`, p)).join("")}`);
    }).join("")}</div>`;
  }

  const plannedIds = g => g.spells.filter(s => s.planned).map(s => s.id);
  // Today's prepared spells: what was ticked here, or GenPrint's usual ones before anything was ticked.
  const todaysIds = (p, g) => (p.prepared || {})[g.title] ?? plannedIds(g);

  function spellRow(s, key, p, prep) {
    const tags = `${s.ritual ? `<span class="tag">Ritual</span>` : ""}${s.concentration ? `<span class="tag blue">Conc.</span>` : ""}`;
    const facts = [["Casting time", s.time], ["Range", s.range], ["Components", s.components], ["Duration", s.duration], ["School", s.school]].filter(([, v]) => v)
      .map(([k, v]) => `<div><b>${k}:</b> ${esc(v)}</div>`).join("");
    const concBtn = s.concentration ? `<div class="btns" style="margin-top:10px">${p.conc === s.name ? `<button class="btn plain" data-act="conc-end">Stop concentrating</button>` : `<button class="btn blue" data-act="conc" data-n="${esc(s.name)}">Concentrate on it</button>`}</div>` : "";
    const prepBtn = prep ? `<button class="prep${prep.on ? " on" : ""}" data-act="prep" data-g="${esc(prep.group)}" data-id="${esc(s.id)}">${prep.on ? "✓ Prepared" : "Prepare"}</button>` : "";
    return openable("sp:" + key, `<span class="grow"><span class="name">${esc(s.name)}</span>${tags}<div class="meta">${esc([s.time, s.range, String(s.how || "").replace(/^Prepared$/, "Usual daily spell").replace(/ · prepared$/, " · usual daily spell")].filter(Boolean).join(" · "))}</div></span>${prepBtn}`,
      `<div class="facts">${facts}</div>${esc(s.full || s.text)}${concBtn}`);
  }

  // ---------------------------------------------------------------- play rules
  function heal(c, p, n) {
    if (p.hp === 0 && n > 0) p.death = { s: 0, f: 0 };
    p.hp = Math.min(maxHp(c, p), p.hp + n);
  }
  function damage(c, p, n) {
    const fromTemp = Math.min(p.temp, n);
    p.temp -= fromTemp; n -= fromTemp;
    if (n > 0 && p.hp === 0) p.death.f = Math.min(3, p.death.f + 1);   // hit while at 0: a failed death save
    p.hp = Math.max(0, p.hp - n);
  }
  function shortRest(c, p) {
    p.pact = 0;
    for (const l of c.limited) if (l.rest === "short") p.uses[l.id] = l.id === "wild-shape" && is2024(c) ? Math.max(0, (p.uses[l.id] || 0) - 1) : 0;
  }
  function longRest(c, p) {
    shortRest(c, p);
    p.maxAdj = 0; p.hp = maxHp(c, p); p.temp = 0; p.death = { s: 0, f: 0 }; p.slots = []; p.uses = {}; p.compHp = {}; p.spellsOn = {}; p.wildForm = null;
    if (p.exhaustion > 0) p.exhaustion--;
    if (is2024(c)) p.hdUsed = {};
    else {   // 2014: regain up to half your Hit Dice (at least one), biggest dice first
      let back = Math.max(1, Math.floor(c.hitDice.reduce((n, d) => n + d.count, 0) / 2));
      for (const d of c.hitDice) { const r = Math.min(back, p.hdUsed[d.die] || 0); p.hdUsed[d.die] = (p.hdUsed[d.die] || 0) - r; back -= r; }
    }
  }

  // ---------------------------------------------------------------- adding characters, backup, restore
  async function addFiles(files) {
    // A file holds one character, or (the "All characters" file) every character at once.
    const list = [];
    for (const f of files) {
      let data;
      try { data = JSON.parse(await f.text()); } catch { toast(`${f.name} isn't a GeneCodex file. Pick the file GenPrint's GeneCodex tab made (it ends in .genecodex.json).`); continue; }
      if (data?.format === "genecodex-character") list.push(data);
      else if (data?.format === "genecodex-bundle" && Array.isArray(data.characters)) list.push(...data.characters.filter(c => c?.format === "genecodex-character"));
      else if (data?.format === "genecodex-backup") toast(`${f.name} is a backup. Use Restore (on the Details tab) to bring it back.`);
      else toast(data && (data.classId || data.d35 || data.species) ? `${f.name} is a GenPrint save. In GenPrint, use the GeneCodex tab's Upload characters button and add the file it makes.` : `${f.name} isn't a GeneCodex file. Pick the file GenPrint's GeneCodex tab made (it ends in .genecodex.json).`);
    }
    let added = 0, updated = 0;
    for (const data of list) {
      const old = S.chars.get(data.id);
      let p = S.play.get(data.id);
      if (!p) p = fresh(data);
      else if (old) {   // an updated character keeps its play changes; full health stays full
        if (p.hp >= maxHp(old, p)) p.hp = maxHp(data, p);
        p.hp = Math.min(p.hp, maxHp(data, p));
      }
      S.chars.set(data.id, data); S.play.set(data.id, p);
      await DB.set("char:" + data.id, data); await DB.set("play:" + data.id, p);
      if (old) updated++; else added++;
      if (list.length === 1) {
        S.current = data.id; S.tab = "abilities";
        toast(old ? `${data.name} updated. Play changes kept.` : `${data.name} added.`);
      }
    }
    if (list.length > 1) {
      S.current = null;
      toast([added && `${added} character${added > 1 ? "s" : ""} added`, updated && `${updated} updated (play changes kept)`].filter(Boolean).join(", ") + ".");
    }
    if (list.length) render();
  }

  async function backup() {
    const out = { format: "genecodex-backup", made: new Date().toISOString(), characters: [...S.chars.values()], play: Object.fromEntries(S.play) };
    const name = `GeneCodex backup ${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    const file = new File([blob], name, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e.name === "AbortError") return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function restore(f) {
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast("That isn't a GeneCodex backup."); }
    // A character file picked with Restore is simply added (owner 2026-11-09: easy to mix the two up).
    if (data?.format === "genecodex-character" || data?.format === "genecodex-bundle") return addFiles([f]);
    if (data?.format !== "genecodex-backup") return toast(`${f.name} isn't a GeneCodex file. Pick the file GenPrint's GeneCodex tab made (it ends in .genecodex.json).`);
    if (!await ask({ title: "Restore this backup?", text: `It holds ${data.characters.length} character(s), saved ${esc(new Date(data.made).toLocaleString())}. Their play changes here are replaced by the backup's.`, ok: "Restore" })) return;
    for (const c of data.characters) {
      S.chars.set(c.id, c); await DB.set("char:" + c.id, c);
      const p = data.play[c.id] || fresh(c);
      S.play.set(c.id, p); await DB.set("play:" + c.id, p);
    }
    toast("Backup restored.");
    render();
  }

  // ---------------------------------------------------------------- taps
  app.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act, c = char(), p = play();
    const redraw = () => { save(); render(); };
    switch (act) {
      case "open": S.logDraft = null; S.current = b.dataset.id; S.tab = "abilities"; S.open.clear(); render(); scrollTo(0, 0); return;
      case "home": S.current = null; render(); scrollTo(0, 0); return;
      case "tab": S.tab = b.dataset.tab; render(); scrollTo(0, 0); return;
      case "add": document.getElementById("file-pick").click(); return;
      case "backup": return backup();
      case "restore": document.getElementById("restore-pick").click(); return;
    }
    if (!c) return;
    switch (act) {
      case "damage": { const n = await ask({ title: "Damage taken", text: p.temp ? `Temporary hit points (${p.temp}) go first.` : "", number: true, ok: "Take damage", danger: true }); if (n) { damage(c, p, n); redraw(); } return; }
      case "heal": { const n = await ask({ title: "Hit points regained", number: true, ok: "Heal" }); if (n) { heal(c, p, n); redraw(); } return; }
      case "temp": { const n = await ask({ title: "Temporary hit points", text: "Temporary hit points don't add up: the new amount replaces the old one.", number: true, value: p.temp || "", ok: "Set" }); if (n != null) { p.temp = n; redraw(); } return; }
      case "maxadj": {
        const n = await ask({ title: "Change to max HP", text: `Your max is ${c.hp.max}. Type a change for effects that lower (or raise) it, e.g. −5. 0 puts it back. A long rest puts it back too.`, number: true, value: p.maxAdj || 0, ok: "Set", allowNegative: true });
        if (n != null) { p.maxAdj = Math.max(1 - c.hp.max, n); p.hp = Math.min(p.hp, maxHp(c, p)); redraw(); } return;
      }
      case "hd": {
        const die = +b.dataset.die, con = c.abilities.find(a => a.id === "con")?.mod ?? 0;
        const n = await ask({ title: `Spend a d${die}`, text: `Roll 1d${die} and add ${signed(con)} (Constitution). Type the total.`, number: true, ok: "Heal" });
        if (n != null) { p.hdUsed[die] = (p.hdUsed[die] || 0) + 1; heal(c, p, Math.max(0, n)); redraw(); } return;
      }
      case "short": if (await ask({ title: "Short rest", text: `Brings back ${[c.pact && "Pact Magic slots", c.limited.some(l => l.rest === "short") && "short-rest features"].filter(Boolean).join(" and ") || "nothing on its own"}. Spend Hit Dice to heal with the Spend buttons.`, ok: "Take a short rest" })) { shortRest(c, p); redraw(); toast("Short rest taken."); } return;
      case "long": if (await ask({ title: "Long rest", text: `Full hit points, all spell slots and features back, ${is2024(c) ? "all Hit Dice back" : "half your Hit Dice back"}, and one less level of exhaustion.`, ok: "Take a long rest" })) { longRest(c, p); redraw(); toast("Long rest taken."); } return;
      case "death": { const k = b.dataset.k; p.death[k] = tick(p.death[k], +b.dataset.i); redraw(); return; }
      case "insp": p.inspiration = !p.inspiration; redraw(); return;
      case "cond": { const n = b.dataset.n; p.conditions = p.conditions.includes(n) ? p.conditions.filter(x => x !== n) : [...p.conditions, n]; redraw(); return; }
      case "exh": p.exhaustion = Math.max(0, Math.min(6, p.exhaustion + +b.dataset.d)); redraw(); return;
      case "use": { const id = b.dataset.id; p.uses[id] = tick(p.uses[id] || 0, +b.dataset.i); redraw(); return; }
      case "use-n": { const id = b.dataset.id, l = c.limited.find(x => x.id === id); p.uses[id] = Math.max(0, Math.min(l.uses, (p.uses[id] || 0) + +b.dataset.d)); redraw(); return; }
      case "slot": { const l = +b.dataset.l; p.slots[l] = tick(p.slots[l] || 0, +b.dataset.i); redraw(); return; }
      case "pact": p.pact = tick(p.pact, +b.dataset.i); redraw(); return;
      case "prep": {   // the button sits in the spell's tap-to-open line: toggle the spell, don't open it
        e.preventDefault();
        const g = b.dataset.g, id = b.dataset.id, grp = c.spells.find(x => x.title === g), list = grp ? todaysIds(p, grp) : (p.prepared || {})[g] || [];
        (p.prepared ||= {})[g] = list.includes(id) ? list.filter(x => x !== id) : [...list, id]; redraw(); return;
      }
      case "prep-reset": { const grp = c.spells.find(x => x.title === b.dataset.g); if (grp) { (p.prepared ||= {})[grp.title] = plannedIds(grp); redraw(); toast("Prepared spells set back to GenPrint's list."); } return; }
      case "wild-in": {   // the button sits in the form's tap-to-open line: change, don't open it
        e.preventDefault();
        const k = c.companions.find(x => x.key === b.dataset.k), i = +b.dataset.i, form = k?.blocks[i];
        if (!form) return;
        const l = c.limited.find(x => x.id === "wild-shape"), used = l ? p.uses[l.id] || 0 : 0;
        if (l && used >= +l.uses && !await ask({ title: "No Wild Shape uses left", text: "All your Wild Shape uses are spent. Change anyway?", ok: "Change anyway" })) return;
        const said = [];
        if (l && used < +l.uses) { p.uses[l.id] = used + 1; said.push("1 Wild Shape use spent"); }
        if (form.tempHp && form.tempHp > p.temp) { p.temp = form.tempHp; said.push(`${form.tempHp} temporary HP`); }
        if (!form.ownHp) delete (p.compHp ||= {})[`${k.key}:${i}`];   // a 2014 form starts at its full hit points
        p.wildForm = { key: k.key, i, name: form.name };
        S.tab = "companions"; redraw(); scrollTo(0, 0);
        toast(`You're a ${form.name}.${said.length ? " " + said.join(", ") + "." : ""}`); return;
      }
      case "log-new": S.logDraft = { date: todayIso(), dm: p.lastDm || "", location: p.lastLocation || "" }; render(); scrollTo(0, 0); return;
      case "log-edit": {
        const en = (p.log || []).find(x => x.id === +b.dataset.id);
        if (en) { S.logDraft = { ...en, ...Object.fromEntries(COINS.map(k => ["coin-" + k, en.coins?.[k] || ""])),
          ...Object.fromEntries(TOKENS(c).flatMap(t => [["tokens-" + t.id, en.tokens?.[t.id] || ""], ["convert-" + t.id, en.convert?.[t.id] || ""]])) }; render(); scrollTo(0, 0); }
        return;
      }
      case "log-cancel": S.logDraft = null; render(); return;
      case "log-downtime": S.logDraft = { kind: "downtime", date: todayIso(), dm: p.lastDm || "" }; render(); scrollTo(0, 0); return;
      case "log-level": {   // Badgers Den: spend a Hero Token on the next level
        const t = logTally(c, p), need = tokenFor(c, t.target);
        if (!need || !t.tokens[need.id]) return;
        if (!await ask({ title: `Buy level ${t.target + 1}?`, text: `Spends 1 ${need.name} Hero Token. Then level the character up in GenPrint and send it again.`, ok: "Buy the level" })) return;
        (p.log ||= []).push({ id: Date.now(), kind: "level", date: todayIso(), toLevel: t.target + 1, token: need.id });
        redraw(); toast(`Level ${t.target + 1} bought.`); return;
      }
      case "log-save": {
        const d = S.logDraft, coins = Object.fromEntries(COINS.map(k => [k, Math.max(0, parseInt(d["coin-" + k], 10) || 0)]));
        const n = v => Math.max(0, parseInt(v, 10) || 0);
        const toks = key => Object.fromEntries(TOKENS(c).map(t => [t.id, n(d[key + "-" + t.id])]).filter(([, v]) => v));
        p.log ||= [];
        const old = p.log.find(x => x.id === d.id);
        const en = d.kind === "downtime"
          ? { id: d.id || Date.now(), kind: "downtime", date: d.date || todayIso(), dm: (d.dm || "").trim(), convert: toks("convert"), dtSpent: n(d.dtSpent), notes: d.notes || "", coins: {} }
          : { id: d.id || Date.now(), date: d.date || todayIso(), title: (d.title || "").trim(), code: (d.code || "").trim(), location: (d.location || "").trim(), dm: (d.dm || "").trim(), xp: n(d.xp),
              tokens: toks("tokens"), perm: n(d.perm), cons: n(d.cons), coins, rewards: d.rewards || "", items: d.items || "", notes: d.notes || "" };
        // Home games: a level the DM granted counts from the level reached so far.
        if (d.levelUp && !d.kind && progKind(c) === "adventures" && !old?.levelUp) {
          const before = { ...p, log: p.log.filter(x => x.id !== d.id) }, lvl = logTally(c, before).target, need = advNeeded(c, lvl);
          if (advCount(c, before) + 1 < need && !await ask({ title: "Not enough adventures yet", text: `Level ${lvl + 1} takes ${need} adventures since your last level; this would be ${advCount(c, before) + 1}. Level up anyway?`, ok: "Level up anyway" })) return;
        }
        if (d.levelUp && !d.kind) { en.levelUp = true; en.toLevel = old?.toLevel || Math.min(20, logTally(c, { ...p, log: p.log.filter(x => x.id !== d.id) }).target + 1); }
        const after = logTally(c, { ...p, log: [...p.log.filter(x => x.id !== en.id), en] });
        const short = TOKENS(c).find(t => after.tokens[t.id] < 0);
        if (short && !await ask({ title: "More tokens than you have", text: `That uses more ${short.name} Hero Tokens than your log shows. Save anyway?`, ok: "Save anyway" })) return;
        if (d.kind === "downtime" && after.days < 0 && !await ask({ title: "More downtime than you have", text: `That spends ${-after.days} more downtime days than your log shows. Save anyway?`, ok: "Save anyway" })) return;
        // Coins go into your money; editing an entry adds or takes away only the difference.
        for (const k of COINS) p.money[k] = Math.max(0, (p.money[k] || 0) + coins[k] - (+old?.coins?.[k] || 0));
        p.log = old ? p.log.map(x => x.id === en.id ? en : x) : [...p.log, en];
        if (en.dm) p.lastDm = en.dm;
        if (en.location) p.lastLocation = en.location;
        S.logDraft = null; redraw();
        const added = coinText(Object.fromEntries(COINS.map(k => [k, coins[k] - (+old?.coins?.[k] || 0)]).filter(([, n]) => n > 0)));
        toast(`Entry saved.${added ? ` ${added} added to your money.` : ""}`); return;
      }
      case "log-del": {
        const en = (p.log || []).find(x => x.id === +b.dataset.id);
        if (!en || !await ask({ title: "Delete this entry?", text: `${esc([niceDate(en.date), en.title].filter(Boolean).join(" · "))}${coinText(en.coins) ? `. Its coins (${esc(coinText(en.coins))}) come off your money too.` : "."}`, ok: "Delete", danger: true })) return;
        for (const k of COINS) p.money[k] = Math.max(0, (p.money[k] || 0) - (+en.coins?.[k] || 0));
        p.log = p.log.filter(x => x !== en); redraw(); toast("Entry deleted."); return;
      }
      case "wild-out": p.wildForm = null; redraw(); toast("Back in your own form."); return;
      case "conc": p.conc = b.dataset.n; redraw(); toast(`Concentrating on ${p.conc}.`); return;
      case "conc-end": p.conc = ""; redraw(); return;
      // Companions: each creature keeps its own hit points; a new slot level for a summon starts its creatures fresh.
      case "comp-slot": { (p.compSlot ||= {})[b.dataset.k] = +b.dataset.l; for (const k of Object.keys(p.compHp || {})) if (k.startsWith(b.dataset.k + ":")) delete p.compHp[k]; redraw(); return; }
      case "comp-dmg": case "comp-heal": {
        const k = b.dataset.k, max = +b.dataset.max, now = (p.compHp || {})[k] ?? max;
        const n = await ask({ title: act === "comp-dmg" ? "Damage to the creature" : "Hit points it regains", number: true, ok: act === "comp-dmg" ? "Take damage" : "Heal", danger: act === "comp-dmg" });
        if (n) { (p.compHp ||= {})[k] = act === "comp-dmg" ? Math.max(0, now - n) : Math.min(max, now + n); redraw(); } return;
      }
      case "spell-on": {
        const id = b.dataset.id;
        (p.spellsOn ||= {})[id] = !p.spellsOn[id];
        if (!p.spellsOn[id]) delete p.spellsOn[id];
        p.hp = Math.min(p.hp, maxHp(c, p));
        redraw(); return;
      }
      case "comp-full": { if (p.compHp) delete p.compHp[b.dataset.k]; redraw(); return; }
      case "fresh": if (await ask({ title: "Start fresh?", text: `${esc(c.name)} goes back to full: hit points, slots, uses, money from GenPrint, no conditions. Session notes, prepared spells and the log are kept.`, ok: "Start fresh", danger: true })) { const { notes, prepared, log, xpStart, goldStart, lastDm, lastLocation } = p; S.play.set(c.id, { ...fresh(c), notes, prepared: prepared || {}, log: log || [], xpStart, goldStart, lastDm, lastLocation }); redraw(); toast("Fresh start."); } return;
      case "remove": if (await ask({ title: `Remove ${esc(c.name)}?`, text: "Removes the character and its play changes from this device. You can add the file again later.", ok: "Remove", danger: true })) {
        await DB.del("char:" + c.id); await DB.del("play:" + c.id); S.chars.delete(c.id); S.play.delete(c.id); S.current = null; render(); } return;
    }
  });

  // Keep tap-to-open rows open across redraws.
  app.addEventListener("toggle", e => {
    const k = e.target.dataset?.key;
    if (k) e.target.open ? S.open.add(k) : S.open.delete(k);
  }, true);

  let notesTimer;
  app.addEventListener("input", e => {
    const p = play();
    if (!p) return;
    if (e.target.dataset.lf && S.logDraft) { S.logDraft[e.target.dataset.lf] = e.target.type === "checkbox" ? e.target.checked : e.target.value; return; }
    if (e.target.matches("[data-goldstart]")) { const n = parseFloat(e.target.value); if (n >= 0) { p.goldStart = n; save(); } return; }
    if (e.target.matches("[data-xpstart]")) { const n = parseInt(e.target.value, 10); if (n >= 0) { p.xpStart = n; save(); } return; }
    if (e.target.matches("[data-notes]")) { p.notes = e.target.value; clearTimeout(notesTimer); notesTimer = setTimeout(save, 400); }
    if (e.target.dataset.coin) { p.money[e.target.dataset.coin] = Math.max(0, parseInt(e.target.value, 10) || 0); save(); }
  });
  app.addEventListener("change", e => { if (e.target.type === "checkbox" && e.target.dataset.lf && S.logDraft) S.logDraft[e.target.dataset.lf] = e.target.checked; });
  app.addEventListener("focusin", e => { if (e.target.dataset?.coin) e.target.select(); });

  document.getElementById("file-pick").addEventListener("change", e => { addFiles([...e.target.files]); e.target.value = ""; });
  document.getElementById("restore-pick").addEventListener("change", e => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ""; });
  addEventListener("pagehide", () => { if (play()) save(); });

  // ---------------------------------------------------------------- start
  (async () => {
    try { navigator.storage?.persist?.(); } catch { }
    for (const k of await DB.keys() || []) {
      const v = await DB.get(k);
      if (k.startsWith("char:")) S.chars.set(v.id, v);
      else if (k.startsWith("play:")) S.play.set(k.slice(5), v);
    }
    for (const c of S.chars.values()) if (!S.play.has(c.id)) S.play.set(c.id, fresh(c));
    if (S.chars.size === 1) S.current = [...S.chars.keys()][0];
    render();
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => { });
  })();
  window.GeneCodex = { S, render, longRest, shortRest };
})();
