// ==UserScript==
// @name         SZZ1 Sesame Gate - Slack Button
// @namespace    amazon-szz1-gate
// @version      11.33
// @description  Auto-fill multi-VRID + GH reguły solo/bobtail + bez cache + token + ↻
// @author       Radek
// @match        https://trans-logistics-eu.amazon.com/yms/sesameGateConsole*
// @match        https://track.relay.amazon.dev/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      hooks.slack.com
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      track.relay.amazon.dev
// @updateURL    https://raw.githubusercontent.com/szkolamuzyczna12-lgtm/szz1-gate-rules/main/scripts/sesame-gate-slack-button.user.js
// @downloadURL  https://raw.githubusercontent.com/szkolamuzyczna12-lgtm/szz1-gate-rules/main/scripts/sesame-gate-slack-button.user.js
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // AUTH TOKEN (skopiowane z działającego Raport ATS RTT)
  // ═══════════════════════════════════════════════════════════

  function extractJwt(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    return m ? m[0] : null;
  }

  function getBearerTokenFromPage() {
    try {
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const val = store.getItem(store.key(i)) || '';
          const j = extractJwt(val);
          if (j) return j;
          if (val.startsWith('{')) {
            try {
              const o = JSON.parse(val);
              for (const k of ['access_token', 'id_token', 'token', 'idToken', 'accessToken']) {
                if (o[k] && String(o[k]).startsWith('eyJ')) return o[k];
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    try {
      const j = extractJwt(document.cookie);
      if (j) return j;
    } catch (_) {}
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name || '';
        if (name.includes('id_token=') || name.includes('token=')) {
          const m = name.match(/(?:id_token|access_token|token)=([^&]+)/);
          if (m) {
            const j = extractJwt(decodeURIComponent(m[1]));
            if (j) return j;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function captureAuthFromHeaders(headers) {
    if (!headers) return;
    let auth = null;
    try {
      if (typeof headers.get === 'function') {
        auth = headers.get('Authorization') || headers.get('authorization');
      } else if (headers.Authorization) auth = headers.Authorization;
      else if (headers.authorization) auth = headers.authorization;
      else if (typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'authorization') { auth = headers[k]; break; }
        }
      }
    } catch (_) {}
    if (auth && /Bearer\s+eyJ/i.test(auth)) {
      const raw = auth.replace(/^Bearer\s+/i, '').trim();
      GM_setValue('rtt_bearer', 'Bearer ' + raw);
      console.log('[SZZ1 RTT] token zapisany (z headera)');
    } else if (auth && auth.startsWith('eyJ')) {
      GM_setValue('rtt_bearer', 'Bearer ' + auth);
      console.log('[SZZ1 RTT] token zapisany (z headera raw)');
    }
  }

  // Hook fetch + XHR (działa na RTT i pomaga złapać token)
  (function installAuthHooks() {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const init = args[1] || {};
        const req = args[0];
        captureAuthFromHeaders(init.headers);
        if (req && req.headers) captureAuthFromHeaders(req.headers);
        const url = typeof req === 'string' ? req : (req && req.url) || '';
        const j = extractJwt(url);
        if (j) {
          GM_setValue('rtt_bearer', 'Bearer ' + j);
          console.log('[SZZ1 RTT] token zapisany (z URL)');
        }
      } catch (_) {}
      return origFetch.apply(this, args);
    };

    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (name && name.toLowerCase() === 'authorization' && value && (value.includes('eyJ') || value.includes('Bearer'))) {
        const raw = String(value).replace(/^Bearer\s+/i, '').trim();
        GM_setValue('rtt_bearer', 'Bearer ' + raw);
        console.log('[SZZ1 RTT] token zapisany (z XHR)');
      }
      return origSetHeader.apply(this, arguments);
    };
  })();

  // Na RTT: ciągłe odświeżanie tokena w tle (bez UI gate'a)
  if (location.hostname.includes('track.relay.amazon.dev')) {
    function saveTokenRaw(jwtOrBearer) {
      if (!jwtOrBearer) return false;
      let raw = String(jwtOrBearer).replace(/^Bearer\s+/i, '').trim();
      if (!raw.startsWith('eyJ')) return false;
      const prev = (GM_getValue('rtt_bearer', '') || '').replace(/^Bearer\s+/i, '');
      GM_setValue('rtt_bearer', 'Bearer ' + raw);
      GM_setValue('rtt_bearer_ts', Date.now());
      if (prev !== raw) {
        console.warn('[SZZ1 RTT] token zapisany/odświeżony');
      }
      return true;
    }

    function refreshTokenFromPage() {
      const t = getBearerTokenFromPage();
      if (t) saveTokenRaw(t);
      return !!t;
    }

    // Od razu + po 2s (strona może dopiero wstawić token)
    if (!refreshTokenFromPage()) {
      console.warn('[SZZ1 RTT] brak tokena w storage – czekam na requesty / odświeżenie');
    }
    setTimeout(refreshTokenFromPage, 2000);
    setTimeout(refreshTokenFromPage, 5000);

    // Co 45 s ponownie czytaj storage (app czasem rotuje JWT)
    setInterval(refreshTokenFromPage, 45 * 1000);

    // Co ~3 min lekki request z aktualnym tokenem – sesja/app często odświeża Authorization,
    // a nasze hooki fetch/XHR wtedy zapiszą nowy token
    function keepalivePing() {
      let bearer = GM_getValue('rtt_bearer', '') || '';
      if (!bearer) {
        refreshTokenFromPage();
        bearer = GM_getValue('rtt_bearer', '') || '';
      }
      if (!bearer) return;
      if (!/^Bearer\s+/i.test(bearer)) bearer = 'Bearer ' + bearer;

      // Lekki endpoint (mały JSON) – wystarczy, by app/SSO odświeżyło sesję
      const pingUrl = 'https://track.relay.amazon.dev/api/v2/transport-views?type=vehicleRun&module=trip&region=eu&page=1&pageSize=1';
      try {
        fetch(pingUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Authorization': bearer
          }
        }).then((res) => {
          if (res.status === 401) {
            console.warn('[SZZ1 RTT] keepalive 401 – token wygasł, odśwież stronę RTT (F5)');
            GM_setValue('rtt_bearer', '');
            refreshTokenFromPage();
          } else {
            refreshTokenFromPage();
          }
        }).catch(() => {});
      } catch (_) {}
    }
    setTimeout(keepalivePing, 15000);
    setInterval(keepalivePing, 3 * 60 * 1000);

    console.warn('[SZZ1 RTT] tło: token co 45s + keepalive co 3 min (trzymaj kartę RTT otwartą)');
    return; // nie uruchamiamy logiki Sesame Gate na RTT
  }

  const _SLACK_WH_B64 = 'aHR0cHM6Ly9ob29rcy5zbGFjay5jb20vc2VydmljZXMvVDAxNk5FSlFXRTkvQjBCNjNRUTE5SEMvSklLdjdNbUxTUUxLZjVLajVSazBkMno2';
  const SLACK_WEBHOOK = atob(_SLACK_WH_B64);
  const WRAPPER_CLASS   = 'slack-vehicle-wrapper';
  const QUICKCOPY_CLASS = 'slack-quickcopy-bar';
  const BTN_CLASS       = 'slack-integrated-btn';

  const ATS_ACCOUNTS = [
    'ATSOutbound', 'ATSAirOutbound', 'ATSSeaShuttle',
    'ATSSeaWarehouseTransfersGround', 'ATSWarehouseTransfers',
    'InboundRedirects', 'OutboundCarrierManagedLinehaulTheyPay',
  ];
  const FLEET_ACCOUNTS = [
    'FleetManagementEquipmentRepositioning', 'TrailerWash', 'TrailerPoolAdjustment',
    'CustomerFacingEmptyTrailer',
  ];
  const TRANSFERS_ACCOUNTS = [
    'ATSWarehouseTransfers', 'ATSWarehouseTransfersIntermodal',
    'TransfersCarts', 'TransfersDamagedCarts', 'TransfersEmptyPalletsOB', 
    'TransfersInitialPlacement', 'TransfersCartsPalletsMixed'
  ];
  const SERVICE_ACCOUNTS = [
    'TrailerWash', 'FleetManagementEquipmentRepositioning', 'TrailerServices',
  ];
  const NON_VRID_VALUES = ['OTHER', 'MAINTENANCE', 'NON_INVENTORY'];

  if (!document.getElementById('slack-blink-style')) {
    const style = document.createElement('style');
    style.id = 'slack-blink-style';
    style.textContent = `@keyframes blink-red { 0% { opacity:1; } 50% { opacity:0; } 100% { opacity:1; } }`;
    document.head.appendChild(style);
  }

  function getLogin() {
    try {
      const el = document.querySelector('.a-color-secondary.a-text-bold');
      if (!el) return null;
      const email = el.innerText?.trim();
      if (!email || !email.includes('@')) return null;
      return email.split('@')[0];
    } catch (e) { return null; }
  }
  function loginSuffix() {
    const login = getLogin();
    return login ? ` _- ${login}_` : '';
  }

  function isDockPick(loc) { return loc && loc !== '---' && /^(IB|OB|DD|VIRTUAL)\d+/i.test(loc); }
  function isVSPick(loc)   { return loc && loc !== '---' && /^VS/i.test(loc); }

  function cleanLocation(location) {
    if (!location) return location;
    if (/^(IB|OB|DD)\d+$/i.test(location)) return location.replace(/^(IB|OB|DD)0*/i, '');
    if (/^VIRTUAL\d+$/i.test(location)) return location.replace(/^VIRTUAL0*/i, '');
    if (/^PS\d+/i.test(location)) return location.replace(/^PS0*/i, ''); 
    if (/^SB\d+/i.test(location)) {
      let loc = location.replace(/^SB0*/i, ''); 
      loc = loc.replace(/[A-Z]$/i, ''); 
      return loc;
    }
    if (/^OS\d+/i.test(location)) return location.replace(/^OS0*/i, 'OS'); 
    if (/^PRECHECK\d+/i.test(location)) return location.replace(/^PRECHECK0*/i, 'PRECHECK '); 
    if (/^HS\s*-\s*/i.test(location)) return location.replace(/^HS\s*-\s*/i, '').replace(/^0+/, '').replace(/\s*B\s*$/i, '').trim();
    return location;
  }

  function locLabel(location, grammaticalCase) {
    if (!location) return { word: '' };
    if (isDockPick(location)) { const w = { na: 'Bramę', z: 'Bramy', na_miejscu: 'Bramie' }; return { word: w[grammaticalCase] || 'Bramę' }; }
    if (isVSPick(location)) return { word: '' }; 
    const w = { na: 'Pole', z: 'Pola', na_miejscu: 'Polu' }; return { word: w[grammaticalCase] || 'Pole' };
  }
  
  function locStr(location, grammaticalCase, mode) {
    const { word } = locLabel(location, grammaticalCase);
    const loc    = cleanLocation(location) || '---';
    const val    = mode === 'slack' ? `*${loc}*` : `<strong>${loc}</strong>`;
    const prefix = word ? `${word} ` : '';
    return `${prefix}${val}`;
  }

  const GH_OWNER = 'szkolamuzyczna12-lgtm';
  const GH_REPO  = 'szz1-gate-rules';
  const GH_FILE  = 'rules.json';
  const GH_RAW   = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/main/${GH_FILE}`;
  const GH_API   = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;

  let ghRules = [];
  let ghRulesLoaded = false;

  function getGHToken(forcePrompt) {
    const stored = forcePrompt ? '' : GM_getValue('gh_token', '');
    if (stored) return stored;
    const token = window.prompt(
      '[SZZ1 Gate] Podaj GitHub Personal Access Token aby zapisać regułę.\n\n' +
      '• Classic PAT (ghp_...) — scope: repo\n' +
      '• Fine-grained (github_pat_...) — Contents: Read and write\n\n' +
      'Token zapisuje się lokalnie tylko na tym komputerze.\n' +
      (forcePrompt ? '(poprzedni token był nieprawidłowy – podaj nowy)\n' : '')
    );
    if (token && token.trim()) {
      GM_setValue('gh_token', token.trim());
      return token.trim();
    }
    return null;
  }

  function ghAuthHeader(token) {
    // Fine-grained PAT wymaga Bearer; classic działa z token i Bearer
    if (/^github_pat_/i.test(token) || /^gho_/i.test(token)) {
      return { Authorization: 'Bearer ' + token };
    }
    return { Authorization: 'token ' + token };
  }

  function ghFetch(url, opts, onSuccess, onError) {
    GM_xmlhttpRequest({
      method: opts.method || 'GET',
      url,
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {})
      },
      data: opts.body || undefined,
      onload: (r) => {
        try { onSuccess(JSON.parse(r.responseText), r.status, r); }
        catch (e) { onSuccess(r.responseText, r.status, r); }
      },
      onerror: () => onError('Błąd sieci GitHub'),
    });
  }

  function loadGHRules(onDone) {
    const done = () => {
      ghRulesLoaded = true;
      if (typeof onDone === 'function') onDone(ghRules);
    };

    // 1) Preferuj API (świeże dane, bez cache CDN) jeśli jest token
    const token = GM_getValue('gh_token', '');
    if (token) {
      ghFetch(GH_API, {
        method: 'GET',
        headers: { ...ghAuthHeader(token) }
      }, (fileData, status) => {
        if (status === 200 && fileData && fileData.content) {
          try {
            const decoded = decodeURIComponent(escape(atob(fileData.content.replace(/\n/g, ''))));
            const data = JSON.parse(decoded);
            if (Array.isArray(data)) {
              ghRules = data;
              console.log('[SZZ1 GH] reguły z API:', ghRules.length);
              done();
              return;
            }
          } catch (e) {
            console.warn('[SZZ1 GH] parse API content', e);
          }
        }
        // fallback raw
        loadGHRulesFromRaw(done);
      }, () => loadGHRulesFromRaw(done));
      return;
    }
    loadGHRulesFromRaw(done);
  }

  function loadGHRulesFromRaw(done) {
    // cache-bust – raw.githubusercontent.com bywa długo cache'owany
    const url = GH_RAW + (GH_RAW.includes('?') ? '&' : '?') + '_=' + Date.now();
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      onload: (r) => {
        try {
          const data = JSON.parse(r.responseText);
          if (Array.isArray(data)) {
            ghRules = data;
            console.log('[SZZ1 GH] reguły z RAW:', ghRules.length);
          }
        } catch (e) {
          console.warn('[SZZ1 GH] parse RAW', e);
        }
        done();
      },
      onerror: () => {
        console.warn('[SZZ1 GH] RAW error');
        done();
      }
    });
  }

  function buildRuleKey(parsed) {
    const tractor = parsed.find(r => r.type === 'TRACTOR');
    const trailer = parsed.find(r => r.type === 'TRAILER');
    const box     = parsed.find(r => r.type === 'BOX_TRUCK');
    const sprinter= parsed.find(r => r.type === 'SPRINTER_VAN');
    const veh = tractor || box || sprinter;
    const vridType = (v) => {
      if (!v) return 'none';
      const u = v.toUpperCase();
      if (u === 'EMPTY_PICKUP' || u === 'EMPTY_DROP') return u;
      if (['OTHER','MAINTENANCE','NON_INVENTORY'].includes(u)) return 'OTHER';
      if (u.startsWith('ISA ')) return 'ISA';
      if (u.startsWith('VRID ')) return 'VRID';
      return 'VRID';
    };
    const locType = (loc) => {
      if (!loc) return 'none';
      if (isVSPick(loc)) return 'VS';
      if (isDockPick(loc)) return 'DOCK';
      return 'POLE';
    };
    const sameLoc = veh && trailer ? (veh.location === trailer.location ? 'same' : 'diff') : 'solo';
    return JSON.stringify({
      tAcc:  veh?.account    || 'none',
      tRea:  veh?.reason     || 'none',
      tVrid: vridType(veh?.vrid),
      trAcc: trailer?.account || 'none',
      trRea: trailer?.reason  || 'none',
      trVrid:vridType(trailer?.vrid),
      loc:   sameLoc,
      tLoc:  locType(veh?.location),
      rLoc:  locType(trailer?.location),
    });
  }

  function matchGHRule(parsed) {
    if (!ghRulesLoaded || ghRules.length === 0) {
      console.log('[SZZ1 GH] match: brak reguł w pamięci (loaded=', ghRulesLoaded, 'len=', ghRules.length, ')');
      return null;
    }
    const key = buildRuleKey(parsed);
    const hit = ghRules.find(r => r.key === key) || null;
    if (!hit) {
      console.log('[SZZ1 GH] brak reguły dla klucza:', key, '| reguł w chmurze:', ghRules.length);
    } else {
      console.log('[SZZ1 GH] trafiono regułę:', hit.message?.slice?.(0, 60));
    }
    return hit;
  }

  /** Rozwija klucz bazowy o warianty lokalizacji + solo (sam ciągnik / sama naczepa). */
  function expandRuleKeys(baseKeyObj) {
    const keys = [];
    const locTypes = ['POLE', 'DOCK', 'VS'];
    // dokładny klucz bieżącej operacji
    keys.push(JSON.stringify({ ...baseKeyObj }));
    // ciągnik + naczepa
    locTypes.forEach(t => {
      locTypes.forEach(r => {
        if (t !== r) {
          keys.push(JSON.stringify({ ...baseKeyObj, tLoc: t, rLoc: r, loc: 'diff' }));
        } else {
          keys.push(JSON.stringify({ ...baseKeyObj, tLoc: t, rLoc: r, loc: 'diff' }));
          keys.push(JSON.stringify({ ...baseKeyObj, tLoc: t, rLoc: r, loc: 'same' }));
        }
      });
    });
    // solo: tylko ciągnik (brak naczepy) — to był brakujący przypadek bobtail
    locTypes.forEach(t => {
      keys.push(JSON.stringify({
        ...baseKeyObj,
        trAcc: 'none', trRea: 'none', trVrid: 'none',
        tLoc: t, rLoc: 'none', loc: 'solo'
      }));
    });
    // solo: tylko naczepa
    locTypes.forEach(r => {
      keys.push(JSON.stringify({
        ...baseKeyObj,
        tAcc: baseKeyObj.tAcc, tRea: baseKeyObj.tRea, tVrid: baseKeyObj.tVrid,
        tLoc: 'none', rLoc: r, loc: 'solo'
      }));
    });
    return [...new Set(keys)];
  }

  function applyGHRule(rule, parsed) {
    const tractor = parsed.find(r => r.type === 'TRACTOR');
    const trailer = parsed.find(r => r.type === 'TRAILER');
    const box     = parsed.find(r => r.type === 'BOX_TRUCK');
    const sprinter= parsed.find(r => r.type === 'SPRINTER_VAN');
    const veh = tractor || box || sprinter;
    const tp  = veh?.plate || '---';
    const tl  = veh?.location || '---';
    const rl  = trailer?.location || tl;
    
    const cleanLoc = (loc) => cleanLocation(loc);
    
    const locSlack = (loc, prep) => {
      if (!loc || loc === '---') return loc;
      const n = cleanLoc(loc);
      if (isDockPick(loc)) return prep === 'na' ? `Bramę *${n}*` : `Bramy *${n}*`;
      if (isVSPick(loc)) return `*${n}*`;
      return prep === 'na' ? `Pole *${n}*` : `Pola *${n}*`;
    };
    
    const locHtml = (loc, prep) => {
      if (!loc || loc === '---') return loc;
      const n = cleanLoc(loc);
      if (isDockPick(loc)) return prep === 'na' ? `Bramę <strong>${n}</strong>` : `Bramy <strong>${n}</strong>`;
      if (isVSPick(loc)) return `<strong>${n}</strong>`;
      return prep === 'na' ? `Pole <strong>${n}</strong>` : `Pola <strong>${n}</strong>`;
    };

    const replaceLocSmart = (msg, placeholder, loc, mode) => {
      if (!msg.includes(placeholder)) return msg;
      const fn = mode === 'slack' ? locSlack : locHtml;
      const regexNa = new RegExp(`na\\s+${placeholder}`, 'gi');
      const regexZ  = new RegExp(`z\\s+${placeholder}`, 'gi');

      let out = msg;
      if (regexNa.test(out)) { out = out.replace(regexNa, `na ${fn(loc, 'na')}`); }
      if (regexZ.test(out)) { out = out.replace(regexZ, `z ${fn(loc, 'z')}`); }
      out = out.replace(new RegExp(placeholder, 'g'), fn(loc, 'na'));
      return out;
    };
    
    let slack = rule.message.replace(/{tp}/g, `*${tp}*`);
    let html = rule.message.replace(/{tp}/g, `<strong>${tp}</strong>`);

    const hasTl = slack.includes('{tl}');
    const hasRl = slack.includes('{rl}');

    if (tl === rl && tl !== '---' && hasTl && hasRl) {
      const firstLocRegex = /(?:(?:na|z|w|wbity na|z pola|na polu|na pole)\s+)?\{[tr]l\}/i;
      slack = slack.replace(firstLocRegex, '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
      html  = html.replace(firstLocRegex, '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
    }

    slack = replaceLocSmart(slack, '{tl}', tl, 'slack');
    slack = replaceLocSmart(slack, '{rl}', rl, 'slack');
    html = replaceLocSmart(html, '{tl}', tl, 'html');
    html = replaceLocSmart(html, '{rl}', rl, 'html');

    const isVehEmpty = (v) => {
      if (!v) return true;
      const vrid = v.vrid ? v.vrid.toUpperCase() : '';
      if (vrid === 'EMPTY_DROP' || vrid === 'EMPTY_PICKUP') return true;
      if (v.account && (FLEET_ACCOUNTS.includes(v.account) || SERVICE_ACCOUNTS.includes(v.account))) return true;
      return false;
    };

    const getCartSfx = (acc) => {
      if (acc === 'TransfersCartsPalletsMixed') return ' (wózki/palety)';
      if (acc === 'TransfersCarts') return ' (wózki)';
      return '';
    };

    if (tl !== rl && tl !== '---' && rl !== '---') {
      if (hasTl && !hasRl) {
        const trSuf = trailer ? getCartSfx(trailer.account) : '';
        const state = isVehEmpty(trailer) ? 'pusta naczepa' : `pełna naczepa${trSuf}`;
        slack += `, a ${state} na ${locSlack(rl, 'na')}`;
        html += `, a ${state} na ${locHtml(rl, 'na')}`;
      } else if (hasRl && !hasTl) {
        if (tractor && tractor.reason === 'Pickup') {
          const tSuf = tractor ? getCartSfx(tractor.account) : '';
          const state = isVehEmpty(tractor) ? 'po pustą' : `po pełną${tSuf}`;
          slack += `, a ciągnik ${state} z ${locSlack(tl, 'z')}`;
          html += `, a ciągnik ${state} z ${locHtml(tl, 'z')}`;
        } else {
          slack += `, a sam ciągnik na ${locSlack(tl, 'na')}`;
          html += `, a sam ciągnik na ${locHtml(tl, 'na')}`;
        }
      }
    }
      
    return { slack, html };
  }

  function saveGHRule(keysArray, message, onDone, _retried) {
    const token = getGHToken(!!_retried);
    if (!token) { onDone(false); return; }

    const doPut = (sha, existingRules) => {
      // Zawsze bazuj na świeżej liście z API, nie na ewentualnie pustej pamięci
      const base = Array.isArray(existingRules) ? existingRules
                : (Array.isArray(ghRules) ? ghRules : []);
      const currentRules = base.filter(r => !keysArray.includes(r.key));
      const addedBy = getLogin() || 'unknown';
      const addedAt = new Date().toISOString();
      keysArray.forEach(key => {
        currentRules.push({ key, message, addedBy, addedAt });
      });
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(currentRules, null, 2))));
      const putBody = {
        message: `Add multi-rule combinations: ${addedBy}`,
        content,
        branch: 'main'
      };
      if (sha) putBody.sha = sha;
      console.log('[SZZ1 GH] zapisuję reguł:', currentRules.length, 'nowe klucze:', keysArray.length);
      ghFetch(GH_API, {
        method: 'PUT',
        headers: { ...ghAuthHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(putBody),
      }, (body, s) => {
        if (s === 200 || s === 201) {
          ghRules = currentRules;
          ghRulesLoaded = true;
          console.log('[SZZ1 GH] zapis OK, reguł w pamięci:', ghRules.length);
          onDone(true);
          return;
        }
        console.error('[SZZ1 GH] PUT status', s, body);
        if ((s === 401 || s === 403) && !_retried) {
          GM_setValue('gh_token', '');
          saveGHRule(keysArray, message, onDone, true);
          return;
        }
        const msg = (body && body.message) ? body.message : ('HTTP ' + s);
        alert('❌ GitHub: nie udało się zapisać reguły.\n\n' + msg +
          '\n\nSprawdź token (repo / Contents: Write) i właściciela repo: ' + GH_OWNER + '/' + GH_REPO);
        onDone(false);
      }, () => { onDone(false); });
    };

    // Zawsze najpierw świeży GET z API (lista + sha)
    ghFetch(GH_API, {
      method: 'GET',
      headers: { ...ghAuthHeader(token) }
    }, (fileData, status) => {
      if (status === 200 && fileData && fileData.sha) {
        let existing = [];
        try {
          if (fileData.content) {
            const decoded = decodeURIComponent(escape(atob(fileData.content.replace(/\n/g, ''))));
            const data = JSON.parse(decoded);
            if (Array.isArray(data)) existing = data;
          }
        } catch (e) {
          console.warn('[SZZ1 GH] decode przy zapisie', e);
          existing = Array.isArray(ghRules) ? ghRules : [];
        }
        doPut(fileData.sha, existing);
        return;
      }
      if (status === 404) {
        doPut(undefined, []);
        return;
      }
      console.error('[SZZ1 GH] GET status', status, fileData);
      if ((status === 401 || status === 403) && !_retried) {
        GM_setValue('gh_token', '');
        saveGHRule(keysArray, message, onDone, true);
        return;
      }
      const msg = (fileData && fileData.message) ? fileData.message : ('HTTP ' + status);
      alert('❌ GitHub: błąd odczytu rules.json.\n\n' + msg +
        '\n\nToken musi mieć dostęp do repo ' + GH_OWNER + '/' + GH_REPO);
      onDone(false);
    }, () => { onDone(false); });
  }

  loadGHRules();

  // === AUTO-FILL FIRMA + KIEROWCY Z RTT ===
  function fetchRttDriverAndCompany(vrid, callback) {
    if (!vrid || vrid === '---') {
      callback(null, 'brak VRID');
      return;
    }

    let cleanVrid = String(vrid).replace(/^(VRID|ISA)\s+/i, '').trim();
    // ISA to nie VR – nie wołamy API z numerem ISA
    if (/^ISA/i.test(String(vrid)) || (!/^[0-9A-Z]{6,14}$/i.test(cleanVrid))) {
      console.warn('[SZZ1 RTT] pomijam nie-VRID:', vrid);
      callback(null, 'to nie jest VRID (ISA/OTHER?)');
      return;
    }

    const detailUrl = `https://track.relay.amazon.dev/api/v2/transport-views/EU:VR:${cleanVrid}?view=detail`;
    let bearer = GM_getValue('rtt_bearer', '') || '';
    if (bearer && !/^Bearer\s+/i.test(bearer)) bearer = 'Bearer ' + bearer;

    console.log('[SZZ1 RTT] fetching', detailUrl, 'token?', !!bearer, 'len=', bearer.length);

    const headers = {
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    if (bearer) headers['Authorization'] = bearer;

    GM_xmlhttpRequest({
      method: 'GET',
      url: detailUrl,
      anonymous: false,
      headers,
      onload: (r) => {
        console.log('[SZZ1 RTT] detail status', r.status, (r.responseText || '').slice(0, 200));
        if (r.status !== 200) {
          if (r.status === 401) {
            GM_setValue('rtt_bearer', ''); // wyczyść zły token
            console.warn('[SZZ1 RTT] 401 – token wyczyszczony. Odśwież RTT i kliknij ponownie.');
            callback(null, '401 Unauthorized – odśwież RTT (F5), wróć i kliknij 🔄 RTT');
          } else {
            callback(null, 'HTTP ' + r.status);
          }
          return;
        }
        try {
          const data = JSON.parse(r.responseText);
          const scac = data.carrier?.scac
                    || data.assignedDrivers?.[0]?.assetOwner?.scac
                    || null;

          const driversCount = Math.max(
            (data.drivers || []).length,
            (data.assignedDrivers || []).length,
            0
          );

          console.log('[SZZ1 RTT] scac=', scac, 'drivers=', driversCount);

          if (!scac) {
            callback({ companyName: '', driversCount: driversCount || 1 });
            return;
          }

          const carrierHeaders = { 'Accept': 'application/json' };
          if (bearer) carrierHeaders['Authorization'] = bearer;

          GM_xmlhttpRequest({
            method: 'GET',
            url: `https://track.relay.amazon.dev/api/carrier?qualifiedId=EU:VR:${cleanVrid}&scac=${encodeURIComponent(scac)}`,
            anonymous: false,
            headers: carrierHeaders,
            onload: (r2) => {
              let companyName = scac;
              try {
                if (r2.status === 200) {
                  const carrier = JSON.parse(r2.responseText);
                  if (carrier.companyName) companyName = carrier.companyName;
                }
              } catch (e) {}
              console.log('[SZZ1 RTT] company=', companyName);
              callback({
                companyName,
                driversCount: driversCount || 1
              });
            },
            onerror: () => callback({ companyName: scac, driversCount: driversCount || 1 })
          });
        } catch (e) {
          console.error('[SZZ1 RTT] parse error', e);
          callback(null, 'błąd parse JSON');
        }
      },
      onerror: (e) => {
        console.error('[SZZ1 RTT] network error', e);
        callback(null, 'błąd sieci');
      }
    });
  }

  const TEST_MODE = false; 

  function findCheckInBtn(summary) {
    const btns = Array.from(summary.querySelectorAll('button'));
    return btns.find(b => {
      const txt = b.innerText.trim().toLowerCase();
      return txt === 'check in' || txt === 'check-in'; 
    });
  }

  const PL_FIX = [
    [/\bciagnik\b/gi,'Ciągnik'], [/\bzestaw\b/gi,'Zestaw'], [/\bnaczepe\b/gi,'naczepę'],
    [/\bnaczepy\b/gi,'naczepy'], [/\bpelna\b/gi,'pełną'], [/\bpelnej\b/gi,'pełnej'],
    [/\bpusta\b/gi,'pustą'], [/\bpustej\b/gi,'pustej'], [/\bpusty\b/gi,'Pusty'],
    [/\bpelny\b/gi,'Pełny'], [/\bzrzuca\b/gi,'Zrzuca'], [/\bzabiera\b/gi,'zabiera'],
    [/\bbrame\b/gi,'bramę'], [/\bbramy\b/gi,'bramy'], [/\bbrama\b/gi,'Bramę'],
    [/\bpolu\b/gi,'Polu'], [/\bpola\b/gi,'Pola'], [/\bpole\b/gi,'Pole'],
    [/\bwyjazd\b/gi,'wyjazd'], [/\bpodstawia\b/gi,'podstawia'],
    [/\bdoladunek\b/gi,'doładunek'], [/\bkampol\b/gi,'kampol'],
  ];

  function formatCustomText(text, parsed, modes) {
    if (!text) return { slack: '', html: '', template: '' };
    let t = text;
    
    t = t.replace(/\bPS0*(\d+)\b/gi, '$1');
    t = t.replace(/\bSB0*(\d+)[A-Z]?\b/gi, '$1'); 
    t = t.replace(/\bOS0*(\d+)\b/gi, 'OS$1');
    t = t.replace(/\bPRECHECK0*(\d+)\b/gi, 'PRECHECK $1');

    PL_FIX.forEach(([rx, rep]) => { t = t.replace(rx, rep); });
    t = t.charAt(0).toUpperCase() + t.slice(1);
    
    if (parsed) {
      parsed.forEach(r => {
        if (r.plate && r.plate !== '---') {
          r.plate.split(/\s+/).forEach(word => {
            if (word.length < 2) return;
            const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            t = t.replace(new RegExp(`(?<![*])\\b(${esc})\\b(?![*])`, 'gi'),
              `*${word.toUpperCase()}*`);
          });
        }
      });
    }

    t = t.replace(/(bram[ęya]|pol[uae]{0,2})\s+(\d+[A-Z]?)/gi, (m, p1, p2) => `${p1} *${p2.toUpperCase()}*`);
    t = t.replace(/(\bVS\d+(?:\s+[a-zA-Z]+)?|\bOS\d+|\bPRECHECK\s*\d+)\b/gi, (m) => `*${m.toUpperCase()}*`);
    t = t.replace(/(?:na|z|wbity na)\s+(\d+[A-Z]?)\b/gi, (m, num) => m.replace(num, `*${num}*`));
    t = t.replace(/\*\*+/g, '*');

    let extraS = [];
    let extraH = [];

    if (modes?.driversCount?.trim()) {
      extraS.push(`kiero ${modes.driversCount.trim()}`);
      extraH.push(`kiero ${modes.driversCount.trim()}`);
    }
    if (modes?.companyName?.trim()) {
      extraS.push(`${modes.companyName.trim()}`);
      extraH.push(`${modes.companyName.trim()}`);
    }
    if (modes?.note?.trim()) {
      extraS.push(`*${modes.note.trim().toUpperCase()}*`);
      extraH.push(`<em style="color:#888">[${modes.note.trim().toUpperCase()}]</em>`);
    }

    const nSlack = extraS.length > 0 ? ` - ${extraS.join(' | ')}` : '';
    const nHtml  = extraH.length > 0 ? ` - ${extraH.join(' | ')}` : '';

    return {
      slack: t + nSlack,
      html: t.replace(/\*([^*]+)\*/g, '<strong>$1</strong>') + nHtml,
      template: t
    };
  }

  function sendToSlack(text, onSuccess, onError) {
    const payload = JSON.stringify({ text });
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'POST', url: SLACK_WEBHOOK,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        onload:  (r) => { if (r.status === 200 && r.responseText === 'ok') onSuccess(); else onError(`Status: ${r.status} - ${r.responseText}`); },
        onerror: () => onError('Błąd sieci'),
      });
    } else {
      fetch(SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
        .then(r => { if (r.ok) onSuccess(); else r.text().then(t => onError(`Status: ${r.status} - ${t}`)); })
        .catch(e => onError(e.message || 'Błąd sieci'));
    }
  }

  function isCESTNow() {
    const now = new Date();
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    return now.getTimezoneOffset() < Math.max(jan, jul);
  }
  function getPolandNow() {
    const now = new Date(); const offset = isCESTNow() ? 2 : 1;
    return new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (offset * 3600000));
  }
  function getShiftCategory(date) {
    const m = date.getHours() * 60 + date.getMinutes();
    if (m >= 271 && m <= 389)   return 'break';
    if (m >= 390 && m <= 1020)  return 'day';
    if (m >= 1021 && m <= 1079) return 'break';
    return 'night';
  }
  function parseArrivalDate(row) {
    const dateStr = row.querySelector('[data-testid="arrivalDate"]')?.innerText?.trim();
    const timeStr = row.querySelector('[data-testid="arrivalTime"]')?.innerText?.trim();
    if (!dateStr || !timeStr || dateStr === '---' || timeStr === '---' || timeStr === '') return null;
    const [month, day, year] = dateStr.split('/').map(Number);
    const [hour, minute]     = timeStr.split(':').map(Number);
    if ([month,day,year,hour,minute].some(isNaN)) return null;
    const fullYear = year < 100 ? 2000 + year : year;
    return new Date(Date.UTC(fullYear, month - 1, day, hour - (isCESTNow() ? 2 : 1), minute));
  }
  function getArrivalColor(arrivalDate) {
    if (!arrivalDate) return null;
    const pNow = getPolandNow(); const nowShift = getShiftCategory(pNow);
    const offset  = isCESTNow() ? 2 : 1;
    const aPoland = new Date(arrivalDate.getTime() + (arrivalDate.getTimezoneOffset() * 60000) + (offset * 3600000));
    const aShift  = getShiftCategory(aPoland);
    if (aShift === 'break') return 'yellow';
    const sameDay = pNow.getFullYear() === aPoland.getFullYear() && pNow.getMonth() === aPoland.getMonth() && pNow.getDate() === aPoland.getDate();
    if (aShift === nowShift) {
      if (aShift === 'night') {
        const prev = new Date(pNow); prev.setDate(prev.getDate() - 1);
        const next = new Date(pNow); next.setDate(next.getDate() + 1);
        const ps = prev.getFullYear() === aPoland.getFullYear() && prev.getMonth() === aPoland.getMonth() && prev.getDate() === aPoland.getDate();
        const ns = next.getFullYear() === aPoland.getFullYear() && next.getMonth() === aPoland.getMonth() && next.getDate() === aPoland.getDate();
        if (sameDay || ps || ns) return 'green';
        return 'red';
      }
      if (sameDay) return 'green';
    }
    return 'red';
  }
  function applyArrivalColors(summary) {
    try {
      summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]').forEach(row => {
        const vridContainer = row.querySelector('[data-testid="loadIdentifier"]');
        if (!vridContainer) return;
        vridContainer.querySelector('.arrival-color-overlay')?.remove();
        const ad = parseArrivalDate(row); if (!ad) return;
        const color = getArrivalColor(ad); if (!color) return;
        const cm = { green: 'rgba(34,197,94,0.35)', red: 'rgba(239,68,68,0.35)', yellow: 'rgba(234,179,8,0.35)' };
        const bm = { green: '2px solid rgba(34,197,94,0.8)', red: '2px solid rgba(239,68,68,0.8)', yellow: '2px solid rgba(234,179,8,0.8)' };
        vridContainer.style.position = 'relative'; vridContainer.style.borderRadius = '4px';
        const o = document.createElement('div');
        o.className = 'arrival-color-overlay';
        Object.assign(o.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', backgroundColor: cm[color], border: bm[color], borderRadius: '4px', pointerEvents: 'none', zIndex: '1' });
        vridContainer.appendChild(o);
      });
    } catch (e) { console.error("Arrival Colors Error:", e); }
  }

  function parseRow(row) {
    const typeImg = row.querySelector('img[data-testid="equipmentTypeImage"]');
    const rawType = typeImg ? typeImg.alt.toUpperCase() : 'UNKNOWN';
    let type = rawType;
    
    // Dodatkowe sprawdzenie, bo YMS potrafi dawać ikonkę Box Truck dla Sprinterów
    const rowText = row.innerText.toUpperCase();

    if      (rawType.includes('TRAILER'))   type = 'TRAILER';
    else if (rawType.includes('TRACTOR'))   type = 'TRACTOR';
    else if (rawType.includes('SWAP_BODY')) type = 'SWAP_BODY';
    else if (rawType.includes('BOX_TRUCK')) type = 'BOX_TRUCK';
    else if (rawType.includes('SPRINTER'))  type = 'SPRINTER_VAN';
    
    if (rowText.includes('SPRINTER')) type = 'SPRINTER_VAN';

    const plateNum = row.querySelector('[data-testid="licensePlateNumber"]')?.innerText?.trim();
    const plate    = (plateNum && plateNum !== '---' && plateNum !== 'undefined') ? plateNum : null;
    let idNumber = null;
    const idEl = row.querySelector('[data-testid="equipmentIdNumber"]')
              || row.querySelector('[data-testid="assetId"]')
              || row.querySelector('[data-testid="idNumber"]');
    if (idEl) {
      idNumber = idEl.innerText.trim();
    } else {
      const plateEl = row.querySelector('[data-testid="licensePlateNumber"]');
      if (plateEl) {
        let cell = plateEl;
        while (cell && cell.parentElement && cell.parentElement !== row) cell = cell.parentElement;
        const idCell = cell ? cell.nextElementSibling : null;
        if (idCell) idNumber = idCell.innerText.trim();
      }
    }
    if (idNumber) idNumber = idNumber.split('\n')[0].trim();
    if (!idNumber || idNumber === '---' || idNumber === 'undefined') idNumber = null;
    const idCellEl = (() => {
      const idEl2 = row.querySelector('[data-testid="equipmentIdNumber"]') || row.querySelector('[data-testid="assetId"]') || row.querySelector('[data-testid="idNumber"]');
      if (idEl2) return idEl2;
      const plateEl2 = row.querySelector('[data-testid="licensePlateNumber"]');
      if (plateEl2) { let c = plateEl2; while (c && c.parentElement && c.parentElement !== row) c = c.parentElement; return c ? c.nextElementSibling : null; }
      return null;
    })();
    const idFull = idCellEl ? idCellEl.innerText.trim().toUpperCase() : '';
    const locInput = row.querySelector('[data-testid="gateOperationSummaryLocationSelect"] input');
    const location = (locInput && locInput.value && locInput.value.trim() !== '' && locInput.value.trim() !== 'undefined') ? locInput.value.trim() : null;
    const vridP    = row.querySelector('[data-testid="displayableLoadIdentifier"] p');
    const vrid     = (vridP && vridP.innerText.trim() !== 'undefined' && vridP.innerText.trim() !== '---') ? vridP.innerText.trim() : null;
    const vridContainer = row.querySelector('[data-testid="displayableLoadIdentifier"]');
    const vridTitlesAll = vridContainer
      ? Array.from(vridContainer.querySelectorAll('[title]')).map(el => el.title?.trim()).filter(t => t && t !== '---' && t !== 'undefined')
      : [];
    const vridTitle = vridTitlesAll[0] || null;
    const accountEl = row.querySelector('.column.wrap-text.simple-sides-padding.selectable');
    const account   = (accountEl && accountEl.innerText.trim() !== '---' && accountEl.innerText.trim() !== 'undefined') ? accountEl.innerText.trim() : null;
    const reason    = row.querySelector('[data-testid="visitReason"]')?.innerText?.trim();
    const reasonClean = (reason && reason !== '---' && reason !== 'undefined') ? reason : null;
    const laneEl    = row.querySelector('[data-testid="routeInfo"]');
    const lane      = (laneEl && laneEl.innerText.trim() !== '---' && laneEl.innerText.trim() !== 'undefined') ? laneEl.innerText.trim() : null;
    return { type, plate, idNumber, idFull, location, vrid, vridTitle, vridTitlesAll, account, reason: reasonClean, lane };
  }

  function getQuickCopyData(summary) {
    const rows     = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
    const parsed   = Array.from(rows).map(parseRow);
    const tractor  = parsed.find(r => r.type === 'TRACTOR');
    const trailer  = parsed.find(r => r.type === 'TRAILER');
    const boxTruck = parsed.find(r => r.type === 'BOX_TRUCK');
    const sprinter = parsed.find(r => r.type === 'SPRINTER_VAN');
    const vehiclePlate = tractor?.plate || boxTruck?.plate || sprinter?.plate || null;
    const trailerPlate = trailer?.plate || null;
    const trailerId    = trailer?.idNumber || null;
    const allEntries = [];
    parsed.forEach(r => {
      if (r.vridTitlesAll && r.vridTitlesAll.length > 0) {
        r.vridTitlesAll.forEach(v => {
          if (!v) return;
          const matches = [...v.matchAll(/(ISA|VRID)\s+(\S+)/gi)];
          if (matches.length > 0) {
            matches.forEach(m => {
              const type  = m[1].toUpperCase();
              const value = m[2].trim();
              if (value && !allEntries.find(e => e.value === value)) allEntries.push({ type, value });
            });
          } else {
            const value = v.trim();
            if (value && !allEntries.find(e => e.value === value)) allEntries.push({ type: 'VRID', value });
          }
        });
      }
    });
    return { vehiclePlate, trailerPlate, trailerId, entries: allEntries };
  }

  function makeQuickBtn(label, value, color) {
    const btn = document.createElement('button');
    btn.innerText = label;
    const hasValue = !!value;
    Object.assign(btn.style, { padding: '5px 10px', backgroundColor: hasValue ? color : '#e0e0e0', color: hasValue ? '#fff' : '#aaa', border: 'none', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: hasValue ? 'pointer' : 'not-allowed', opacity: hasValue ? '1' : '0.6', transition: 'background-color 0.2s', whiteSpace: 'nowrap' });
    btn.disabled = !hasValue;
    if (hasValue) {
      btn.addEventListener('mouseenter', () => btn.style.filter = 'brightness(1.15)');
      btn.addEventListener('mouseleave', () => btn.style.filter = '');
      btn.addEventListener('click', () => {
        if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(value); }
        else { navigator.clipboard.writeText(value).catch(() => { const ta = document.createElement('textarea'); ta.value = value; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }); }
        const orig = btn.innerText; btn.innerText = '✅';
        setTimeout(() => btn.innerText = orig, 1500);
      });
    }
    return btn;
  }

  function refreshQuickCopyBar(summary, barId) {
    try {
      const data     = getQuickCopyData(summary);
      const buttons  = [];
      if (data.vehiclePlate) buttons.push({ label: '🪪 Pojazd LP',  value: data.vehiclePlate, color: '#1565c0' });
      if (data.trailerPlate) buttons.push({ label: '🪪 Naczepa LP', value: data.trailerPlate, color: '#6a1b9a' });
      if (data.trailerId)    buttons.push({ label: '🪪 Naczepa ID', value: data.trailerId,    color: '#00838f' });
      const counters  = { VRID: 0, ISA: 0 };
      const totalVrid = data.entries.filter(e => e.type === 'VRID').length;
      const totalIsa  = data.entries.filter(e => e.type === 'ISA').length;
      data.entries.forEach(entry => {
        counters[entry.type]++;
        let label;
        if (entry.type === 'ISA') {
          label = totalIsa > 1 ? `📦 ISA - ${counters.ISA}` : '📦 ISA';
        } else {
          label = (totalVrid === 1 && totalIsa === 0) ? '📦 VRID' : `📦 VRID - ${counters.VRID}`;
        }
        buttons.push({ label, value: entry.value, color: '#2e7d32' });
      });
      const existing = document.getElementById(barId);
      if (existing) {
        existing.innerHTML = '';
        buttons.forEach(b => existing.appendChild(makeQuickBtn(b.label, b.value, b.color)));
      } else {
        const bar = document.createElement('div');
        bar.id = barId; bar.className = QUICKCOPY_CLASS;
        Object.assign(bar.style, { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
        buttons.forEach(b => bar.appendChild(makeQuickBtn(b.label, b.value, b.color)));
        
        const footerEl = summary.querySelector('[data-testid="gateOperationSummaryFooter"]');
        if (footerEl && footerEl.parentNode) {
            footerEl.parentNode.insertBefore(bar, footerEl);
        } else {
            summary.appendChild(bar);
        }
      }
    } catch(e) { console.error("Quick Copy Bar Error:", e); }
  }

  function makeToggleBtn(label) {
    const btn = document.createElement('button');
    btn.innerText = label;
    Object.assign(btn.style, { padding: '6px 10px', borderRadius: '4px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', border: '1px solid #ccc', backgroundColor: '#f1f1f1', color: '#333' });
    const setActive = (a) => { btn.style.backgroundColor = a ? '#1a73e8' : '#f1f1f1'; btn.style.color = a ? '#fff' : '#333'; btn.style.border = a ? 'none' : '1px solid #ccc'; };
    setActive(false);
    btn._setActive = setActive;
    btn._chosen    = false;
    return btn;
  }

  function makeToggleGroup(btn1Label, btn2Label, toggleType, onChoose) {
    const container = document.createElement('div');
    container.dataset.toggleType = toggleType;
    Object.assign(container.style, { display: 'none', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' });
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '4px' });
    const btn1 = makeToggleBtn(btn1Label);
    const btn2 = makeToggleBtn(btn2Label);
    const warning = document.createElement('div');
    warning.innerText = '⚠️ Wybierz właściwy guzik';
    Object.assign(warning.style, { color: '#c62828', fontSize: '11px', fontWeight: '700', display: 'block', textAlign: 'center', width: '100%', animation: 'blink-red 1s step-start infinite' });
    btn1.addEventListener('click', () => { btn1._setActive(true); btn2._setActive(false); btn1._chosen = true; btn2._chosen = false; warning.style.display = 'none'; onChoose('btn1'); });
    btn2.addEventListener('click', () => { btn2._setActive(true); btn1._setActive(false); btn2._chosen = true; btn1._chosen = false; warning.style.display = 'none'; onChoose('btn2'); });
    btnRow.appendChild(btn1); btnRow.appendChild(btn2);
    container.appendChild(btnRow); container.appendChild(warning);
    container._isChosen = () => btn1._chosen || btn2._chosen;
    container._reset    = () => { btn1._setActive(false); btn2._setActive(false); btn1._chosen = false; btn2._chosen = false; warning.style.display = 'block'; };
    return { container, btn1, btn2 };
  }

  function makeToggleGroup4(labels, toggleType, onChoose) {
    const container = document.createElement('div');
    container.dataset.toggleType = toggleType;
    Object.assign(container.style, { display: 'none', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' });
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '4px', flexWrap: 'wrap' });
    const warning = document.createElement('div');
    warning.innerText = '⚠️ Wybierz właściwy guzik';
    Object.assign(warning.style, { color: '#c62828', fontSize: '11px', fontWeight: '700', display: 'block', textAlign: 'center', width: '100%', animation: 'blink-red 1s step-start infinite' });

    const btns = labels.map(label => makeToggleBtn(label));
    btns.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        btns.forEach(b => { b._setActive(false); b._chosen = false; });
        btn._setActive(true); btn._chosen = true;
        warning.style.display = 'none';
        onChoose(i);
      });
      btnRow.appendChild(btn);
    });

    container.appendChild(btnRow); container.appendChild(warning);
    container._isChosen = () => btns.some(b => b._chosen);
    container._reset    = () => { btns.forEach(b => { b._setActive(false); b._chosen = false; }); warning.style.display = 'block'; };
    container._getChosen = () => btns.findIndex(b => b._chosen);
    return { container, btns };
  }

  function formatVSPhrases(t, isHtml) {
    const tagOpen = isHtml ? '<strong>' : '\\*';
    const tagClose = isHtml ? '</strong>' : '\\*';
    const rep = isHtml ? '<strong>$1</strong>' : '*$1*';

    let r1 = new RegExp(`(?:Zrzuca (?:pust[aąę]|pełn[aąę]|puszk[ęi]|dwie puszki)|Zrzut \\([^)]+\\)|Pełn[aąy]|Pust[aąy])\\s+na\\s+${tagOpen}(VS[^<*]+)${tagClose}`, 'gi');
    t = t.replace(r1, `wbity na ${rep}`);

    let r2 = new RegExp(`na\\s+${tagOpen}(VS[^<*]+)${tagClose}`, 'gi');
    t = t.replace(r2, (match, vsLoc, offset, fullString) => {
       const before = fullString.slice(Math.max(0, offset - 6), offset).toLowerCase();
       if (before.includes('wbity ')) return match;
       return `wbity na ${isHtml ? `<strong>${vsLoc}</strong>` : `*${vsLoc}*`}`;
    });
    return t;
  }

  function buildMessages(summary, modes) {
    const resultObj = _buildMessages(summary, modes);
    if (resultObj && resultObj.result) {
      let s = resultObj.result.slack;
      let h = resultObj.result.html;
      
      s = formatVSPhrases(s, false);
      h = formatVSPhrases(h, true);

      resultObj.result.slack = s;
      resultObj.result.html = h;
    }
    return resultObj;
  }

  function _buildMessages(summary, modes) {
    const rows       = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
    const parsed     = Array.from(rows).map(parseRow);
    const tractor    = parsed.find(r => r.type === 'TRACTOR');
    const trailer    = parsed.find(r => r.type === 'TRAILER');
    const swapBodies = parsed.filter(r => r.type === 'SWAP_BODY');
    const swapBody   = swapBodies[0] || null;
    const boxTruck   = parsed.find(r => r.type === 'BOX_TRUCK');
    const sprinter   = parsed.find(r => r.type === 'SPRINTER_VAN');

    const tp = tractor?.plate    || '---';
    const tl = tractor?.location || '---';
    const rl = trailer?.location || '---';
    const sl = swapBody?.location || '---';

    const s   = (v) => `*${v}*`;
    const h   = (v) => `<strong>${v}</strong>`;
    
    const ls  = (loc, gc) => locStr(loc, gc, 'slack');
    const lh  = (loc, gc) => locStr(loc, gc, 'html');
    
    const sfx = loginSuffix();
    
    const safeNote    = (modes && typeof modes.note === 'string') ? modes.note.trim().toUpperCase() : '';
    const safeDrivers = (modes && modes.driversCount) ? modes.driversCount.trim() : '';
    const safeCompany = (modes && modes.companyName) ? modes.companyName.trim() : '';

    let extraS = [];
    let extraH = [];

    if (safeDrivers) { extraS.push(`kiero ${safeDrivers}`); extraH.push(`kiero ${safeDrivers}`); }
    if (safeCompany) { extraS.push(`${safeCompany}`); extraH.push(`${safeCompany}`); }
    if (safeNote)    { extraS.push(`*${safeNote}*`); extraH.push(`<strong style="color: #FF0000; font-weight: bold;">${safeNote}</strong>`); }

    const slackNote = extraS.length > 0 ? ` - ${extraS.join(' | ')}` : '';
    const htmlNote  = extraH.length > 0 ? ` - ${extraH.join(' | ')}` : '';

    // ==========================================
    // 1. NAJWYŻSZY PRIORYTET: Reguły z GitHuba
    // ==========================================
    const ghRule = matchGHRule(parsed);
    if (ghRule) {
      const applied = applyGHRule(ghRule, parsed);
      return { 
        result: { 
          slack: `${applied.slack}${slackNote}${sfx}`, 
          html: `☁️ ${applied.html}${htmlNote}` 
        }, 
        fromGH: true 
      };
    }

    // ==========================================
    // 2. WBUDOWANE REGUŁY
    // ==========================================
    const build = (slackTpl, htmlTpl) => ({ 
      result: { 
        slack: `${slackTpl}${slackNote}${sfx}`, 
        html: `${htmlTpl}${htmlNote}` 
      } 
    });

    const isDoladunekLane = (lane) => {
      if (!lane || !lane.includes('->')) return false;
      const afterArrow = lane.split('->').slice(1).join('->');
      return afterArrow.includes('-');
    };

    const getCartSuffix = (acc) => {
      if (acc === 'TransfersCartsPalletsMixed') return ' (wózki/palety)';
      if (acc === 'TransfersCarts') return ' (wózki)';
      return '';
    };
    const trSuf = trailer ? getCartSuffix(trailer.account) : '';

    const isKampol = trailer && trailer.idFull && trailer.idFull.includes('KAMP')
      && trailer.vridTitle && trailer.vridTitle.toUpperCase().startsWith('ISA')
      && trailer.reason === 'Live';
    const tractorIsEmpty = tractor && (
      (tractor.vrid && NON_VRID_VALUES.includes(tractor.vrid.toUpperCase()) && !tractor.reason)
      || (tractor.vrid === 'EMPTY_PICKUP' && tractor.reason === 'Pickup')
    );
    if (isKampol && tractor && tractorIsEmpty) {
      const sameLoc = tractor.location === trailer.location;
      if (sameLoc) {
        const loc = rl;
        if (isDockPick(loc)) {
          return build(`Zestaw ${s(tp)} Zrzuca pełną (kampol) na ${ls(loc,'na')} i zostaje`, `Zestaw ${h(tp)} Zrzuca pełną (kampol) na ${lh(loc,'na')} i zostaje`);
        }
        return build(`Zestaw ${s(tp)} Zrzuca pełną (kampol) na ${ls(loc,'na')}`, `Zestaw ${h(tp)} Zrzuca pełną (kampol) na ${lh(loc,'na')}`);
      }
      return build(
        `Zestaw ${s(tp)} Zrzuca pełną (kampol) na ${ls(rl,'na')} i zabiera pustą z ${ls(tl,'z')}`,
        `Zestaw ${h(tp)} Zrzuca pełną (kampol) na ${lh(rl,'na')} i zabiera pustą z ${lh(tl,'z')}`
      );
    }

    const isDoladunekActive = (lane) => isDoladunekLane(lane) && !lane.toUpperCase().startsWith('SZZ1->');
    const noISA = (r) => r && !(r.vridTitlesAll || []).some(v => v && v.toUpperCase().startsWith('ISA'));
    const l54 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.account && ATS_ACCOUNTS.includes(tractor.account)
      && trailer.account && ATS_ACCOUNTS.includes(trailer.account)
      && tractor.reason === 'Pickup' && trailer.reason === 'Pickup'
      && tractor.vridTitle && trailer.vridTitle
      && tractor.vridTitle === trailer.vridTitle
      && noISA(tractor) && noISA(trailer)
      && (isDoladunekActive(tractor.lane) || isDoladunekActive(trailer.lane));
    if (l54) {
      if (isDockPick(rl)) {
        return build(`Zestaw ${s(tp)} na ${ls(rl,'na')} - Pełny (doładunek)`, `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pełny (doładunek)`);
      }
      return build(`Zestaw ${s(tp)} Pełny (doładunek) na ${ls(rl,'na')}`, `Zestaw ${h(tp)} Pełny (doładunek) na ${lh(rl,'na')}`);
    }

    const l54b = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.account && ATS_ACCOUNTS.includes(tractor.account)
      && trailer.account && ATS_ACCOUNTS.includes(trailer.account)
      && tractor.reason === 'Pickup' && trailer.reason === 'Pickup'
      && tractor.vridTitle && trailer.vridTitle
      && tractor.vridTitle === trailer.vridTitle
      && noISA(tractor) && noISA(trailer)
      && ((isDoladunekLane(tractor.lane) && tractor.lane.toUpperCase().startsWith('SZZ1->'))
       || (isDoladunekLane(trailer.lane) && trailer.lane.toUpperCase().startsWith('SZZ1->')));
    if (l54b) {
      if (isDockPick(rl)) {
        return build(`Zestaw ${s(tp)} na ${ls(rl,'na')} - Pusty`, `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pusty`);
      }
      return build(`Zestaw ${s(tp)} Pusty na ${ls(rl,'na')}`, `Zestaw ${h(tp)} Pusty na ${lh(rl,'na')}`);
    }

    const sv = boxTruck || sprinter;
    const svp = sv?.plate || '---';
    if (sv && sv.location && sv.vridTitle && noISA(sv)) {
      const svLoc = sv.location;
      const prefix = sprinter ? 'Bus' : 'Box';
      if (isDoladunekActive(sv.lane)) {
        const tag = isDockPick(svLoc) ? ` na ${ls(svLoc,'na')} - Pełny (doładunek)` : ` Pełny (doładunek) na ${ls(svLoc,'na')}`;
        const tagH = isDockPick(svLoc) ? ` na ${lh(svLoc,'na')} - Pełny (doładunek)` : ` Pełny (doładunek) na ${lh(svLoc,'na')}`;
        return build(`${prefix} ${s(svp)}${tag}`, `${prefix} ${h(svp)}${tagH}`);
      }
      if (isDoladunekLane(sv.lane) && sv.lane.toUpperCase().startsWith('SZZ1->')) {
        const tag = isDockPick(svLoc) ? ` na ${ls(svLoc,'na')} - Pusty` : ` Pusty na ${ls(svLoc,'na')}`;
        const tagH = isDockPick(svLoc) ? ` na ${lh(svLoc,'na')} - Pusty` : ` Pusty na ${lh(svLoc,'na')}`;
        return build(`${prefix} ${s(svp)}${tag}`, `${prefix} ${h(svp)}${tagH}`);
      }
    }

    const l1 = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && trailer.vrid === 'EMPTY_DROP';
    if (l1) return build(`Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')} - wyjazd`, `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')} - wyjazd`);

    const l39 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && tractor.account === 'BobtailMovementAnnotation'
      && trailer.account && FLEET_ACCOUNTS.includes(trailer.account)
      && trailer.reason === 'Dropoff';
    if (l39) return build(
      `Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')}`,
      `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')}`
    );

    const l39b = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.account === 'BobtailMovementAnnotation'
      && trailer.account && FLEET_ACCOUNTS.includes(trailer.account)
      && trailer.reason === 'Dropoff';
    if (l39b) return build(
      `Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')}`,
      `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')}`
    );

    const parkVS = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && trailer.reason === 'Dropoff' && isVSPick(tractor.location);
    if (parkVS) {
      const cleanVS = cleanLocation(tractor.location);
      const isTrailerEmpty = trailer.vrid === 'EMPTY_DROP'
        || (trailer.account && FLEET_ACCOUNTS.includes(trailer.account))
        || (trailer.account && SERVICE_ACCOUNTS.includes(trailer.account) && !trailer.vridTitle);
      const dropWord = isTrailerEmpty ? 'pustą' : `pełną${trSuf}`;
      return build(`Ciągnik ${s(tp)} Zrzuca ${dropWord} na ${ls(rl,'na')}, wbity na ${s(cleanVS)}`, `Ciągnik ${h(tp)} Zrzuca ${dropWord} na ${lh(rl,'na')}, wbity na ${h(cleanVS)}`);
    }

    const l20 = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && trailer.vridTitle && trailer.reason === 'Dropoff' && !tractor.vrid && !tractor.reason && trailer.account && SERVICE_ACCOUNTS.includes(trailer.account);
    if (l20) {
      let sw = '';
      if (trailer.account === 'TrailerWash')     sw = ' po myjce';
      if (trailer.account === 'TrailerServices') sw = ' po serwisie';
      return build(`Ciągnik ${s(tp)} Zrzuca pustą${sw} na ${ls(rl,'na')} - wyjazd`, `Ciągnik ${h(tp)} Zrzuca pustą${sw} na ${lh(rl,'na')} - wyjazd`);
    }

    const l45 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && isDockPick(tractor.location)
      && tractor.vrid && tractor.vrid.toUpperCase() === 'OTHER'
      && trailer.vrid && trailer.vrid.toUpperCase() === 'OTHER'
      && !tractor.reason && !trailer.reason;
    if (l45) return build(
      `Zestaw ${s(tp)} na ${ls(rl,'na')} - Pełny (kurier)`,
      `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pełny (kurier)`
    );

    const l44 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && !isDockPick(tractor.location)
      && tractor.account && ATS_ACCOUNTS.includes(tractor.account)
      && tractor.reason === 'Pickup'
      && tractor.vridTitle
      && trailer.account && FLEET_ACCOUNTS.includes(trailer.account)
      && trailer.reason === 'Dropoff'
      && trailer.vridTitle;
    if (l44) return build(
      `Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')} i czeka na załadunek`,
      `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')} i czeka na załadunek`
    );

    const l41 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && isDockPick(tractor.location)
      && tractor.account && ATS_ACCOUNTS.includes(tractor.account)
      && tractor.reason === 'Pickup'
      && tractor.vridTitle
      && trailer.account && FLEET_ACCOUNTS.includes(trailer.account)
      && trailer.reason === 'Dropoff'
      && trailer.vridTitle;
    if (l41) return build(
      `Zestaw ${s(tp)} na ${ls(rl,'na')} - Pusty`,
      `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pusty`
    );

    const l37 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && isDockPick(tractor.location)
      && tractor.account === 'TransfersTote'
      && tractor.reason === 'Pickup'
      && tractor.vridTitle
      && trailer.account && FLEET_ACCOUNTS.includes(trailer.account)
      && trailer.reason === 'Dropoff'
      && trailer.vridTitle;
    if (l37) return build(
      `Zestaw ${s(tp)} podstawia się zestawem na ${ls(rl,'na')}`,
      `Zestaw ${h(tp)} podstawia się zestawem na ${lh(rl,'na')}`
    );

    const l38 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && isDockPick(tractor.location)
      && trailer.account && FLEET_ACCOUNTS.includes(trailer.account)
      && trailer.reason === 'Dropoff'
      && (
        tractor.vrid === 'EMPTY_PICKUP'
        || (!tractor.reason && (!tractor.vrid || tractor.vrid === 'EMPTY_DROP' || NON_VRID_VALUES.includes(tractor.vrid.toUpperCase())))
      );
    if (l38) return build(
      `Zestaw ${s(tp)} zrzuca pustą na ${ls(rl,'na')} i wyjazd`,
      `Zestaw ${h(tp)} zrzuca pustą na ${lh(rl,'na')} i wyjazd`
    );

    const l35 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && trailer.account === 'TrailerPoolAdjustment'
      && trailer.reason === 'Dropoff';
    if (l35) return build(
      `Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')}`,
      `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')}`
    );

    const l2base = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && trailer.vridTitle && trailer.reason === 'Dropoff' && !(trailer.account && SERVICE_ACCOUNTS.includes(trailer.account));
    if (l2base) {
      if (modes.l2 === null) return { needsChoice: true, showL2Toggle: true };
      const wyjMsg  = { slack: `Ciągnik ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} - wyjazd${slackNote}${sfx}`, html: `Ciągnik ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} - wyjazd${htmlNote}` };
      const zostMsg = { slack: `Zestaw ${s(tp)} Pełna${trSuf} na ${ls(rl,'na')}${slackNote}${sfx}`, html: `Zestaw ${h(tp)} Pełna${trSuf} na ${lh(rl,'na')}${htmlNote}` };
      return { result: modes.l2 === 'wyjazd' ? wyjMsg : zostMsg, showL2Toggle: true };
    }

    const l52 = parsed.length === 1 && tractor && tractor.location
      && tractor.vrid && NON_VRID_VALUES.includes(tractor.vrid.toUpperCase())
      && !tractor.reason && !tractor.account
      && !isVSPick(tractor.location);
    if (l52) return build(
      `Ciągnik ${s(tp)} na ${ls(tractor.location,'na')}`,
      `Ciągnik ${h(tp)} na ${lh(tractor.location,'na')}`
    );

    const l3base = parsed.length === 1 && tractor && tractor.location && tractor.vrid === 'EMPTY_PICKUP' && tractor.reason === 'Pickup';
    if (l3base) {
      if (modes.swap === null) return { needsChoice: true, showToggle: true };
      const wyjStr3 = isDockPick(tl) ? '' : ' - wyjazd';
      const trailerMsg = { slack: `Ciągnik ${s(tp)} po pustą z ${ls(tl,'z')}${wyjStr3}${slackNote}${sfx}`, html: `Ciągnik ${h(tp)} po pustą z ${lh(tl,'z')}${wyjStr3}${htmlNote}` };
      const swapMsg    = { slack: `Ciągnik ${s(tp)} ustawia się na ${ls(tl,'na_miejscu')}${slackNote}${sfx}`, html: `Ciągnik ${h(tp)} ustawia się na ${lh(tl,'na_miejscu')}${htmlNote}` };
      return { result: modes.swap === 'swap' ? swapMsg : trailerMsg, showToggle: true };
    }

    const l4 = parsed.length === 1 && tractor && tractor.location && tractor.vrid && tractor.reason === 'Pickup' && tractor.account && FLEET_ACCOUNTS.includes(tractor.account);
    if (l4) { const wyjStr4 = isDockPick(tl) ? '' : ' - wyjazd'; return build(`Ciągnik ${s(tp)} po pustą z ${ls(tl,'z')}${wyjStr4}`, `Ciągnik ${h(tp)} po pustą z ${lh(tl,'z')}${wyjStr4}`); }

    const l5base = parsed.length === 1 && tractor && tractor.location && tractor.vrid && tractor.reason === 'Pickup' && tractor.account && ATS_ACCOUNTS.includes(tractor.account);
    if (l5base) {
      if (modes.swap === null) return { needsChoice: true, showToggle: true };
      const wyjStr5 = isDockPick(tl) ? '' : ' - wyjazd';
      const trailerMsg = { slack: `Ciągnik ${s(tp)} po pełną z ${ls(tl,'z')}${wyjStr5}${slackNote}${sfx}`, html: `Ciągnik ${h(tp)} po pełną z ${lh(tl,'z')}${wyjStr5}${htmlNote}` };
      const swapMsg    = { slack: `Ciągnik ${s(tp)} ustawia się na ${ls(tl,'na_miejscu')}${slackNote}${sfx}`, html: `Ciągnik ${h(tp)} ustawia się na ${lh(tl,'na_miejscu')}${htmlNote}` };
      return { result: modes.swap === 'swap' ? swapMsg : trailerMsg, showToggle: true };
    }

    const l26 = parsed.length === 1 && tractor && tractor.location && tractor.vrid && tractor.reason === 'Pickup' && tractor.account === 'TransfersTote';
    if (l26) return build(`Ciągnik ${s(tp)} po Toty na ${ls(tl,'na')}`, `Ciągnik ${h(tp)} po Toty na ${lh(tl,'na')}`);

    const l30 = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && 
                tractor.account === 'TransfersTote' && tractor.reason === 'Pickup' && trailer.reason === 'Dropoff' &&
                (trailer.vrid === 'EMPTY_DROP' || (trailer.account && FLEET_ACCOUNTS.includes(trailer.account)));
    if (l30) return build(`Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')} i pobiera Toty z ${ls(tl,'z')}`, `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')} i pobiera Toty z ${lh(tl,'z')}`);

    const l31 = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && 
                tractor.account === 'TransfersTote' && tractor.reason === 'Pickup' && trailer.reason === 'Dropoff' &&
                trailer.vrid !== 'EMPTY_DROP' && (!trailer.account || !FLEET_ACCOUNTS.includes(trailer.account));
    if (l31) return build(`Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i pobiera Toty z ${ls(tl,'z')}`, `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i pobiera Toty z ${lh(tl,'z')}`);

    const l23a = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && tractor.vrid && trailer.vrid && tractor.reason === 'Pickup' && trailer.reason === 'Dropoff' && tractor.account === 'TrailerWash' && trailer.account === 'TrailerWash';
    if (l23a) return build(`Myjka ${s(tp)} Zrzuca pustą na ${ls(rl,'na')} i pobiera pustą z ${ls(tl,'z')}`, `Myjka ${h(tp)} Zrzuca pustą na ${lh(rl,'na')} i pobiera pustą z ${lh(tl,'z')}`);

    const l23b = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && tractor.vrid && trailer.vrid && tractor.reason === 'Pickup' && trailer.reason === 'Dropoff' && tractor.account === 'FleetManagementEquipmentRepositioning' && trailer.account === 'FleetManagementEquipmentRepositioning';
    if (l23b) return build(`Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')} i pobiera pustą z ${ls(tl,'z')}`, `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')} i pobiera pustą z ${lh(tl,'z')}`);

    const l50b = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && tractor.account === 'TrailerServices'
      && tractor.reason === 'Pickup'
      && trailer.account === 'ATSWarehouseTransfers'
      && trailer.reason === 'Dropoff'
      && trailer.vridTitle;
    if (l50b) return build(
      `Zestaw ${s(tp)} Zrzuca pełną (inbound) na ${ls(rl,'na')} i zabiera pustą (serwis) z ${ls(tl,'z')}`,
      `Zestaw ${h(tp)} Zrzuca pełną (inbound) na ${lh(rl,'na')} i zabiera pustą (serwis) z ${lh(tl,'z')}`
    );

    const l50 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && tractor.account === 'ATSWarehouseTransfers'
      && tractor.reason === 'Pickup'
      && tractor.vridTitle
      && trailer.account === 'TrailerServices'
      && trailer.reason === 'Dropoff';
    if (l50) return build(
      `Zestaw ${s(tp)} Zrzuca pełną (inbound) na ${ls(rl,'na')} i zabiera pustą (serwis) z ${ls(tl,'z')}`,
      `Zestaw ${h(tp)} Zrzuca pełną (inbound) na ${lh(rl,'na')} i zabiera pustą (serwis) z ${lh(tl,'z')}`
    );

    const l51 = tractor && tractor.location
      && tractor.account === 'TrailerServices'
      && (!trailer || trailer.account === 'TrailerServices');
    if (l51) {
      const loc = tractor.location;
      return build(
        `Zestaw ${s(tp)} zabiera pustą (serwis) z ${ls(loc,'z')}`,
        `Zestaw ${h(tp)} zabiera pustą (serwis) z ${lh(loc,'z')}`
      );
    }

    const l49 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.account === 'StemLegBobTail'
      && tractor.reason === 'Pickup'
      && trailer.account === 'TransfersCartsPalletsMixed'
      && trailer.reason === 'Live';
    if (l49) return build(
      `Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i wyjazd`,
      `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i wyjazd`
    );

    const l28 = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && tractor.account === 'StemLegBobTail' && trailer.account === 'FleetManagementEquipmentRepositioning' && tractor.reason === 'Pickup' && trailer.reason === 'Dropoff';
    if (l28) return build(`Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')}`, `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')}`);

    const l40 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && tractor.account && FLEET_ACCOUNTS.includes(tractor.account)
      && tractor.reason === 'Pickup'
      && trailer.account && TRANSFERS_ACCOUNTS.includes(trailer.account)
      && trailer.reason === 'Live'
      && trailer.vridTitle;
    if (l40) return build(
      `Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i zabiera pustą z ${ls(tl,'z')}`,
      `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i zabiera pustą z ${lh(tl,'z')}`
    );

    const l24 = tractor && trailer && tractor.location && trailer.location && 
                tractor.reason === 'Pickup' && 
                (trailer.reason === 'Dropoff' || trailer.reason === 'Live') && 
                tractor.account && ATS_ACCOUNTS.includes(tractor.account) && 
                trailer.account && TRANSFERS_ACCOUNTS.includes(trailer.account);
    if (l24) {
      if (tractor.location === trailer.location) {
        return build(`Zestaw ${s(tp)} Pełna${trSuf} na ${ls(rl,'na')} i ma załadunek`, `Zestaw ${h(tp)} Pełna${trSuf} na ${lh(rl,'na')} i ma załadunek`);
      } else {
        return build(`Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i pobiera pełną z ${ls(tl,'z')}`, `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i pobiera pełną z ${lh(tl,'z')}`);
      }
    }

    const l36 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && trailer.reason === 'Dropoff'
      && trailer.account === 'FBA_BLP_Inbound'
      && tractor.reason === 'Pickup';
    if (l36) return build(
      `Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i zabiera pełną z ${ls(tl,'z')}`,
      `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i zabiera pełną z ${lh(tl,'z')}`
    );

    const l6 = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && 
               tractor.reason === 'Pickup' && trailer.reason === 'Dropoff' && 
               (trailer.vrid === 'EMPTY_DROP' || (trailer.account && FLEET_ACCOUNTS.includes(trailer.account))) && 
               tractor.account && ATS_ACCOUNTS.includes(tractor.account);
    if (l6) return build(`Zestaw ${s(tp)} Zrzuca pustą na ${ls(rl,'na')} i pobiera pełną z ${ls(tl,'z')}`, `Zestaw ${h(tp)} Zrzuca pustą na ${lh(rl,'na')} i pobiera pełną z ${lh(tl,'z')}`);

    const l8 = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && 
               tractor.reason === 'Pickup' && trailer.reason === 'Dropoff' && 
               trailer.account && TRANSFERS_ACCOUNTS.includes(trailer.account) && 
               (tractor.vrid === 'EMPTY_PICKUP' || (tractor.account && FLEET_ACCOUNTS.includes(tractor.account)));
    if (l8) return build(`Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i pobiera pustą z ${ls(tl,'z')}`, `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i pobiera pustą z ${lh(tl,'z')}`);

    const l9 = tractor && trailer && tractor.location && trailer.location && tractor.location !== trailer.location && 
               tractor.reason === 'Pickup' && trailer.reason === 'Dropoff' && 
               trailer.account && ATS_ACCOUNTS.includes(trailer.account) && 
               (tractor.vrid === 'EMPTY_PICKUP' || (tractor.account && FLEET_ACCOUNTS.includes(tractor.account)));
    if (l9) return build(`Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i pobiera pustą z ${ls(tl,'z')}`, `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i pobiera pustą z ${lh(tl,'z')}`);

    const l10 = swapBodies.length === 1 && tractor && !trailer && tractor.location && swapBody.location && tractor.location === swapBody.location && !tractor.vrid && swapBody.vrid === 'EMPTY_DROP' && !tractor.reason && swapBody.reason === 'Dropoff' && !tractor.account && !swapBody.account;
    if (l10) return build(`Ciągnik ${s(tp)} Zrzuca puszkę na ${ls(sl,'na')} - wyjazd`, `Ciągnik ${h(tp)} Zrzuca puszkę na ${lh(sl,'na')} - wyjazd`);

    const l11 = swapBodies.length === 2 && tractor && !trailer && tractor.location
      && (!tractor.vrid || NON_VRID_VALUES.includes(tractor.vrid.toUpperCase()) || tractor.vrid === 'EMPTY_DROP')
      && (!tractor.reason || tractor.reason === 'Dropoff')
      && swapBodies.every(sb => sb.vrid === 'EMPTY_DROP')
      && swapBodies.every(sb => sb.reason === 'Dropoff');
    if (l11) {
      const sbLocsArr = [...new Set(swapBodies.map(sb => cleanLocation(sb.location)))];
      const sbLocs = sbLocsArr.join('/');
      const poleWord = sbLocsArr.length > 1 ? 'polach' : 'polu';
      return build(
        `Zestaw ${s(tp)} Zrzuca puszki na ${poleWord} ${s(sbLocs)} i wyjazd`, 
        `Zestaw ${h(tp)} Zrzuca puszki na ${poleWord} ${h(sbLocs)} i wyjazd`
      );
    }

    const l12 = swapBodies.length === 1 && tractor && !trailer && tractor.location && swapBody.location && tractor.location !== swapBody.location && tractor.vridTitle && swapBody.vrid === 'EMPTY_DROP' && tractor.reason === 'Pickup' && swapBody.reason === 'Dropoff' && tractor.account === 'OutboundCarrierManagedLinehaulTheyPay' && !swapBody.account;
    if (l12) return build(`Ciągnik ${s(tp)} Zrzuca puszkę na ${ls(sl,'na')} i ustawia się na ${ls(tl,'na_miejscu')}`, `Ciągnik ${h(tp)} Zrzuca puszkę na ${lh(sl,'na')} i ustawia się na ${lh(tl,'na_miejscu')}`);

    const l13 = swapBodies.length === 2 && tractor && !trailer && tractor.location
      && tractor.reason === 'Pickup'
      && swapBodies.every(sb => sb.vrid === 'EMPTY_DROP')
      && swapBodies.every(sb => sb.reason === 'Dropoff');
    if (l13) {
      const sbLocsArr = [...new Set(swapBodies.map(sb => cleanLocation(sb.location)))];
      const sbLocs = sbLocsArr.join('/');
      const poleWord = sbLocsArr.length > 1 ? 'polach' : 'polu';
      const tLocClean = cleanLocation(tractor.location);
      return build(
        `Zestaw ${s(tp)} Zrzuca puszki na ${poleWord} ${s(sbLocs)} i ustawia się na polu ${s(tLocClean)}`, 
        `Zestaw ${h(tp)} Zrzuca puszki na ${poleWord} ${h(sbLocs)} i ustawia się na polu ${h(tLocClean)}`
      );
    }

    const l18 = parsed.length === 1 && sprinter && sprinter.location && isVSPick(sprinter.location) && !NON_VRID_VALUES.includes(sprinter.vrid?.toUpperCase());
    if (l18) { const sp = sprinter.plate || '---'; return build(`Bus ${s(sp)} czeka na przeciwko 26/27`, `Bus ${h(sp)} czeka na przeciwko 26/27`); }

    const soloVehicleBase = boxTruck || sprinter;
    const l16base = parsed.length === 1 && soloVehicleBase && soloVehicleBase.location;
    if (l16base) {
      if (modes.l16 === null) return { needsChoice: true, showL16Toggle: true };
      const bp = soloVehicleBase.plate || '---'; 
      const bl = soloVehicleBase.location;
      const prefix = sprinter ? 'Bus' : 'Box';
      
      let locS = ls(bl,'na'); let locH = lh(bl,'na');
      let prep = "na";
      if (isVSPick(bl)) { prep = "wbity na"; }
      
      let pelnyMsg, pustyMsg;
      if (isDockPick(bl)) {
        pelnyMsg = { slack: `${prefix} ${s(bp)} ${prep} ${locS} - Pełny${slackNote}${sfx}`, html: `${prefix} ${h(bp)} ${prep} ${locH} - Pełny${htmlNote}` };
        pustyMsg = { slack: `${prefix} ${s(bp)} ${prep} ${locS} - Pusty${slackNote}${sfx}`,  html: `${prefix} ${h(bp)} ${prep} ${locH} - Pusty${htmlNote}`  };
      } else {
        pelnyMsg = { slack: `${prefix} ${s(bp)} Pełny ${prep} ${locS}${slackNote}${sfx}`, html: `${prefix} ${h(bp)} Pełny ${prep} ${locH}${htmlNote}` };
        pustyMsg = { slack: `${prefix} ${s(bp)} Pusty ${prep} ${locS}${slackNote}${sfx}`,  html: `${prefix} ${h(bp)} Pusty ${prep} ${locH}${htmlNote}`  };
      }
      return { result: modes.l16 === 'pusty' ? pustyMsg : pelnyMsg, showL16Toggle: true };
    }

    const l19 = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && trailer.vridTitle && trailer.reason === 'Pickup';
    if (l19) {
      if (isDockPick(rl)) {
        return build(`Zestaw ${s(tp)} na ${ls(rl,'na')} - Pusty`, `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pusty`);
      }
      return build(`Zestaw ${s(tp)} Pusta na ${ls(rl,'na')}`, `Zestaw ${h(tp)} Pusta na ${lh(rl,'na')}`);
    }

    const l22 = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && trailer.reason === 'Live' && trailer.vridTitle && tractor.vrid && tractor.reason === 'Live' && tractor.account === 'TransfersTote' && trailer.account === 'TransfersTote';
    if (l22) {
      if (isDockPick(rl)) {
        return build(`Zestaw ${s(tp)} na ${ls(rl,'na')} - załadunek totow`, `Zestaw ${h(tp)} na ${lh(rl,'na')} - załadunek totow`);
      }
      return build(`Zestaw ${s(tp)} po Toty na ${ls(rl,'na')}`, `Zestaw ${h(tp)} po Toty na ${lh(rl,'na')}`);
    }

    const l25 = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && trailer.reason === 'Live' && trailer.vridTitle && tractor.vrid && tractor.reason === 'Live' && tractor.vridTitle === trailer.vridTitle && tractor.account === 'OutboundCarrierManagedLinehaulTheyPay' && trailer.account === 'OutboundCarrierManagedLinehaulTheyPay';
    if (l25) {
      if (isDockPick(rl)) {
        return build(`Zestaw ${s(tp)} na ${ls(rl,'na')} - Pusty`, `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pusty`);
      }
      return build(`Zestaw ${s(tp)} Pusta na ${ls(rl,'na')}`, `Zestaw ${h(tp)} Pusta na ${lh(rl,'na')}`);
    }

    const l48 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.account === 'TransfersEmptyAmpal'
      && trailer.account === 'TransfersEmptyAmpal'
      && tractor.vridTitle && trailer.vridTitle
      && tractor.vridTitle === trailer.vridTitle;
    if (l48) {
      if (isDockPick(rl)) {
        return build(`Zestaw ${s(tp)} na ${ls(rl,'na')} - Pusty`, `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pusty`);
      }
      return build(`Zestaw ${s(tp)} Pusty na ${ls(rl,'na')}`, `Zestaw ${h(tp)} Pusty na ${lh(rl,'na')}`);
    }

    const l53 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.vrid && NON_VRID_VALUES.includes(tractor.vrid.toUpperCase())
      && !tractor.reason
      && trailer.account === 'TransfersInitialPlacement'
      && trailer.reason === 'Live'
      && trailer.vridTitle;
    if (l53) {
      const loc = rl;
      if (isVSPick(loc)) {
        return build(`Zestaw ${s(tp)} pełny wbity na ${ls(loc,'na')}`, `Zestaw ${h(tp)} pełny wbity na ${lh(loc,'na')}`);
      }
      return build(`Zestaw ${s(tp)} pełny na ${ls(loc,'na')}`, `Zestaw ${h(tp)} pełny na ${lh(loc,'na')}`);
    }

    const l46 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.account === 'TransfersTote'
      && tractor.reason === 'Pickup'
      && tractor.vridTitle
      && trailer.account === 'TransfersInitialPlacement'
      && trailer.reason === 'Live'
      && trailer.vridTitle;
    if (l46) return build(
      `Zestaw ${s(tp)} Zrzut (pełna) na ${ls(rl,'na')} i czeka na załadunek`,
      `Zestaw ${h(tp)} Zrzut (pełna) na ${lh(rl,'na')} i czeka na załadunek`
    );

    const l47 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && tractor.account === 'TransfersEmptyAmpal'
      && tractor.reason === 'Live'
      && tractor.vridTitle
      && trailer.account === 'TransfersInitialPlacement'
      && trailer.reason === 'Live'
      && trailer.vridTitle;
    if (l47) return build(
      `Zestaw ${s(tp)} Zrzut (pełna) na ${ls(rl,'na')} i czeka na załadunek`,
      `Zestaw ${h(tp)} Zrzut (pełna) na ${lh(rl,'na')} i czeka na załadunek`
    );

    const l42 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && isDockPick(tractor.location)
      && tractor.account === 'TransfersInventoryCorrection'
      && trailer.account === 'TransfersInventoryCorrection'
      && tractor.reason === 'Live'
      && trailer.reason === 'Live'
      && tractor.vridTitle && trailer.vridTitle
      && tractor.vridTitle === trailer.vridTitle;
    if (l42) return build(
      `Zestaw ${s(tp)} na ${ls(rl,'na')} - Pusty`,
      `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pusty`
    );

    const hasISAandVRID = (r) => {
      if (!r || !r.vridTitlesAll || r.vridTitlesAll.length === 0) return false;
      const combined = r.vridTitlesAll.join(' ').toUpperCase();
      return combined.includes('ISA') && combined.includes('VRID');
    };
    const l43 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location === trailer.location
      && isDockPick(tractor.location)
      && tractor.vrid && NON_VRID_VALUES.includes(tractor.vrid.toUpperCase())
      && !tractor.reason
      && hasISAandVRID(trailer)
      && trailer.reason === 'Live';
    if (l43) return build(
      `Zestaw ${s(tp)} na ${ls(rl,'na')} - Pełny (Inbound)`,
      `Zestaw ${h(tp)} na ${lh(rl,'na')} - Pełny (Inbound)`
    );

    const l21base = tractor && trailer && tractor.location && trailer.location && tractor.location === trailer.location && trailer.reason === 'Live' && trailer.vridTitle && !tractor.vrid && !tractor.reason && !tractor.lane;
    if (l21base) {
      if (modes.l21 === null) return { needsChoice: true, showL21Toggle: true };
      const zostMsg = { slack: `Zestaw ${s(tp)} Pełna${trSuf} na ${ls(rl,'na')}${slackNote}${sfx}`,                html: `Zestaw ${h(tp)} Pełna${trSuf} na ${lh(rl,'na')}${htmlNote}`                };
      const wyjMsg  = { slack: `Ciągnik ${s(tp)} Zrzuca Pełną${trSuf} na ${ls(rl,'na')} - wyjazd${slackNote}${sfx}`, html: `Ciągnik ${h(tp)} Zrzuca Pełną${trSuf} na ${lh(rl,'na')} - wyjazd${htmlNote}` };
      return { result: modes.l21 === 'wyjazd' ? wyjMsg : zostMsg, showL21Toggle: true };
    }

    const l27plate = tractor?.plate || boxTruck?.plate || sprinter?.plate || null;
    const l27loc   = tractor?.location || boxTruck?.location || sprinter?.location || null;
    const l27vrid  = tractor?.vrid || boxTruck?.vrid || sprinter?.vrid || null;
    const l27 = parsed.length >= 1
      && l27loc && isVSPick(l27loc)
      && l27vrid && NON_VRID_VALUES.includes(l27vrid.toUpperCase())
      && parsed.every(r => r.vridTitle === null);
    if (l27) {
      if (modes.l27 === null) return { needsChoice: true, showL27Toggle: true };
      const names   = ['Serwis', 'Remondis', 'Stena', 'Shunter'];
      const chosen  = modes.l27;
      const slackTxt = `${names[chosen]} ${s(l27plate || '---')} wjazd na Yard`;
      const htmlTxt  = `${names[chosen]} <strong>${l27plate || '---'}</strong> wjazd na Yard`;
      return { result: { slack: `${slackTxt}${slackNote}${sfx}`, html: `${htmlTxt}${htmlNote}` }, showL27Toggle: true };
    }

    const l29firstRow = parsed[0];
    const l29plate    = tractor?.plate || boxTruck?.plate || sprinter?.plate || null;
    const l29loc      = l29firstRow?.location || null;
    const l29 = l29firstRow
      && l29loc && isDockPick(l29loc)
      && parsed.every(r => r.vrid === 'NON_INVENTORY' && !r.vridTitle);
    if (l29) {
      const pl  = l29plate || '---';
      const isBox     = !!boxTruck;
      const isVan     = !!sprinter;
      let slackTxt, htmlTxt;
      if (isBox) {
        slackTxt = `Box ${s(pl)} rozładunek na ${ls(l29loc,'na')}`;
        htmlTxt  = `Box ${h(pl)} rozładunek na ${lh(l29loc,'na')}`;
      } else if (isVan) {
        slackTxt = `Bus ${s(pl)} rozładunek na ${ls(l29loc,'na')}`;
        htmlTxt  = `Bus ${h(pl)} rozładunek na ${lh(l29loc,'na')}`;
      } else {
        slackTxt = `Zestaw ${s(pl)} rozładunek na ${ls(l29loc,'na')}`;
        htmlTxt  = `Zestaw ${h(pl)} rozładunek na ${lh(l29loc,'na')}`;
      }
      return build(slackTxt, htmlTxt);
    }

    const l33 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && trailer.reason === 'Dropoff'
      && trailer.vridTitle
      && tractor.reason === 'Pickup'
      && tractor.account && FLEET_ACCOUNTS.includes(tractor.account)
      && tractor.vridTitle;
    if (l33) return build(
      `Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i zabiera pustą z ${ls(tl,'z')}`,
      `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i zabiera pustą z ${lh(tl,'z')}`
    );

    const l34 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && trailer.reason === 'Dropoff'
      && trailer.vridTitle
      && tractor.vrid === 'EMPTY_PICKUP'
      && tractor.reason === 'Pickup';
    if (l34) {
      const isTrailerFleet = trailer.account && FLEET_ACCOUNTS.includes(trailer.account);
      const dropWord = isTrailerFleet ? 'pustą' : `pełną${trSuf}`;
      return build(
        `Zestaw ${s(tp)} Zrzuca ${dropWord} na ${ls(rl,'na')} i zabiera pustą z ${ls(tl,'z')}`,
        `Zestaw ${h(tp)} Zrzuca ${dropWord} na ${lh(rl,'na')} i zabiera pustą z ${lh(tl,'z')}`
      );
    }

    const l32 = tractor && trailer
      && tractor.location && trailer.location
      && tractor.location !== trailer.location
      && trailer.reason === 'Dropoff'
      && trailer.vridTitle
      && tractor.vrid && NON_VRID_VALUES.includes(tractor.vrid.toUpperCase())
      && !tractor.vridTitle
      && !tractor.reason;
    if (l32) return build(
      `Zestaw ${s(tp)} Zrzuca pełną${trSuf} na ${ls(rl,'na')} i zabiera pełną z ${ls(tl,'z')}`,
      `Zestaw ${h(tp)} Zrzuca pełną${trSuf} na ${lh(rl,'na')} i zabiera pełną z ${lh(tl,'z')}`
    );

    return null;
  }

  function doRefresh(summary, modes, preview, sendBtn, wrapperEl, customContainer, customInput, barId) {
    if (customInput && customInput.value.trim().length > 0) return;

    let data;
    try {
      data = buildMessages(summary, modes);
    } catch (e) {
      preview.innerHTML = `<span style="color:#d32f2f; font-weight:bold;">❌ Błąd w skrypcie: ${e.message}</span>`;
      console.error("Slack Button Script Error:", e);
      return; 
    }

    wrapperEl.querySelectorAll('[data-toggle-type]').forEach(t => t.style.display = 'none');

    if (!data) {
      preview.innerHTML = '<em style="color:#bbb; font-style:italic;">Brak pasującej logiki</em>';
      const hasCustom = customInput?.value.trim().length > 0;
      sendBtn.disabled = !hasCustom; sendBtn.style.opacity = hasCustom ? '1' : '0.4'; sendBtn.style.cursor = hasCustom ? 'pointer' : 'not-allowed';
    } else if (data.needsChoice) {
      preview.innerHTML = '<em style="color:#888">Wybierz opcję poniżej</em>';
      sendBtn.disabled = true; sendBtn.style.opacity = '0.4'; sendBtn.style.cursor = 'not-allowed';
      if (data.showToggle)    { const t = wrapperEl.querySelector('[data-toggle-type="swap"]');  if (t) t.style.display = 'flex'; }
      if (data.showL2Toggle)  { const t = wrapperEl.querySelector('[data-toggle-type="l2"]');    if (t) t.style.display = 'flex'; }
      if (data.showL21Toggle) { const t = wrapperEl.querySelector('[data-toggle-type="l21"]');   if (t) t.style.display = 'flex'; }
      if (data.showL16Toggle) { const t = wrapperEl.querySelector('[data-toggle-type="l16"]');   if (t) t.style.display = 'flex'; }
      if (data.showL27Toggle) { const t = wrapperEl.querySelector('[data-toggle-type="l27"]');   if (t) t.style.display = 'flex'; }
    } else {
      preview.innerHTML = data.result.html; preview.style.color = '#1a1a1a';
      sendBtn.disabled = false; sendBtn.style.opacity = '1'; sendBtn.style.cursor = 'pointer';
      if (data.showToggle)    { const t = wrapperEl.querySelector('[data-toggle-type="swap"]');  if (t) t.style.display = 'flex'; }
      if (data.showL2Toggle)  { const t = wrapperEl.querySelector('[data-toggle-type="l2"]');    if (t) t.style.display = 'flex'; }
      if (data.showL21Toggle) { const t = wrapperEl.querySelector('[data-toggle-type="l21"]');   if (t) t.style.display = 'flex'; }
      if (data.showL16Toggle) { const t = wrapperEl.querySelector('[data-toggle-type="l16"]');   if (t) t.style.display = 'flex'; }
      if (data.showL27Toggle) { const t = wrapperEl.querySelector('[data-toggle-type="l27"]');   if (t) t.style.display = 'flex'; }
    }

    applyArrivalColors(summary);
    refreshQuickCopyBar(summary, barId);
  }

  function createVehicleUI(summary) {
    const checkInBtn = findCheckInBtn(summary);
    const addEquipBtn = summary.querySelector('[data-testid="addEquipmentButton"]');
    
    if (!checkInBtn || !addEquipBtn) return; 

    const opId      = summary.querySelector('[data-testid="gateOperationId"]')?.innerText?.trim() || Math.random();
    const safeId    = opId.replace(/[^a-z0-9]/gi, '_');
    const wrapperId = `slack-wrapper-${safeId}`;
    const previewId = `slack-preview-${safeId}`;
    const btnId     = `slack-btn-${safeId}`;
    const customId  = `slack-custom-${safeId}`;
    const barId     = `slack-quickcopy-${safeId}`;

    if (document.getElementById(wrapperId)) return;

    const modes = { swap: null, l2: null, l21: null, l16: null, l27: null, note: '', driversCount: '', companyName: '' };

    const wrapper = document.createElement('div');
    wrapper.id = wrapperId; wrapper.className = WRAPPER_CLASS;
    wrapper._modes = modes;
    Object.assign(wrapper.style, { display: 'inline-flex', alignItems: 'center', gap: '10px', marginRight: '10px', verticalAlign: 'middle', flexWrap: 'wrap', marginBottom: '10px' });

    const preview = document.createElement('span');
    preview.id = previewId;
    Object.assign(preview.style, { fontSize: '12px', maxWidth: '500px', whiteSpace: 'pre-line', lineHeight: '1.5', padding: '6px 10px', backgroundColor: '#f5f5f5', border: '1px solid #ddd', borderRadius: '4px' });

    const { container: tSwap  } = makeToggleGroup('🚛 Naczepa',  '🟨 Swap Body', 'swap', (c) => { modes.swap = c === 'btn1' ? 'naczepa' : 'swap';    refresh(); });
    const { container: tL2    } = makeToggleGroup('➡️ Wyjazd',   '🏭 Zostaje',   'l2',   (c) => { modes.l2   = c === 'btn1' ? 'wyjazd'  : 'zostaje'; refresh(); });
    const { container: tL21   } = makeToggleGroup('🏭 Zostaje',  '➡️ Wyjazd',    'l21',  (c) => { modes.l21  = c === 'btn1' ? 'zostaje' : 'wyjazd';  refresh(); });
    const { container: tL16   } = makeToggleGroup('🟫 Pełny',    '⬜ Pusty',     'l16',  (c) => { modes.l16  = c === 'btn1' ? 'pelny'   : 'pusty';   refresh(); });

    const { container: tL27 } = makeToggleGroup4(
      ['🔧 Serwis', '🗑️ Remondis', '♻️ Stena', '🚜 Shunter'],
      'l27',
      (i) => { modes.l27 = i; refresh(); }
    );

    const driversId = `slack-drivers-${safeId}`;
    const driversInput = document.createElement('input');
    driversInput.id = driversId; driversInput.type = 'number'; driversInput.min = '1'; driversInput.placeholder = 'Kierowcy';
    Object.assign(driversInput.style, { padding: '6px 10px', fontSize: '12px', border: '1px solid #4CAF50', backgroundColor: '#e8f5e9', borderRadius: '4px', width: '80px', outline: 'none' });
    
    const companyId = `slack-company-${safeId}`;
    const companyInput = document.createElement('input');
    companyInput.id = companyId; companyInput.type = 'text'; companyInput.placeholder = '🏢 Firma';
    Object.assign(companyInput.style, { padding: '6px 10px', fontSize: '12px', border: '1px solid #2196F3', backgroundColor: '#e3f2fd', borderRadius: '4px', width: '120px', outline: 'none' });

    // Skracanie nazwy firmy do schowka (bez form prawnych, max ~40 znaków)
    // Skrót firmy: marka bez imienia/nazwiska; samo imię+nazwisko zostaje
    // Tylko formy prawne – reszta bez zmian
    function shortenCompanyName(name) {
      let s = String(name || '').trim();
      if (!s) return '';
      const original = s;
      s = s
        .replace(/\bspółka\s+z\s+ograniczoną\s+odpowiedzialnością\b/gi, '')
        .replace(/\bsp\.?\s*z\.?\s*o\.?\s*o\.?\b/gi, '')
        .replace(/\bsp\s+z\s+oo\b/gi, '')
        .replace(/\bs\.?\s*a\.?\b/gi, '')
        .replace(/\bsp\.?\s*j\.?\b/gi, '')
        .replace(/\bsp\.?\s*k\.?\b/gi, '')
        .replace(/\bspółka\s+jawna\b/gi, '')
        .replace(/\bspółka\s+komandytowa\b/gi, '')
        .replace(/\bltd\.?\b/gi, '')
        .replace(/\bgmbh\b/gi, '')
        .replace(/\bllc\b/gi, '')
        .replace(/\binc\.?\b/gi, '')
        .replace(/[,\s.;]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return s || original;
    }

    function getFullCompanyName() {
      return (companyInput.dataset.fullName || companyInput.value || '').trim();
    }

    function setCompanyDisplay(fullName) {
      const full = String(fullName || '').trim();
      const short = shortenCompanyName(full);
      companyInput.dataset.fullName = full;
      companyInput.value = short;
      modes.companyName = short; // Slack / wiadomość = skrót
      updateCompanyTooltip();
    }

    function updateCompanyTooltip() {
      const full = getFullCompanyName();
      const short = (companyInput.value || '').trim() || shortenCompanyName(full);
      companyInput.title = full
        ? (full !== short ? full + '\n\n(w polu / Slack: ' + short + ')' : full) + '\n(klik = kopiuj)'
        : 'Firma — klik kopiuje nazwę';
    }
    updateCompanyTooltip();
    companyInput.addEventListener('input', () => {
      // ręczna edycja – to co w polu jest też „pełną” i idzie na Slacka
      companyInput.dataset.fullName = companyInput.value;
      modes.companyName = companyInput.value;
      updateCompanyTooltip();
    });
    companyInput.addEventListener('change', updateCompanyTooltip);

    function copyCompanyName() {
      const v = (companyInput.value || '').trim();
      if (!v) return;
      const done = () => {
        const prevBg = companyInput.style.backgroundColor;
        const prevBorder = companyInput.style.borderColor;
        companyInput.style.backgroundColor = '#c8e6c9';
        companyInput.style.borderColor = '#2e7d32';
        companyInput.title = '✓ Skopiowano: ' + v;
        setTimeout(() => {
          companyInput.style.backgroundColor = prevBg;
          companyInput.style.borderColor = prevBorder || '#2196F3';
          updateCompanyTooltip();
        }, 1200);
      };
      if (typeof GM_setClipboard !== 'undefined') {
        GM_setClipboard(v);
        done();
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(done).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = v;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        });
      } else {
        const ta = document.createElement('textarea');
        ta.value = v;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      }
    }

    companyInput.addEventListener('click', (e) => {
      if (!(companyInput.value || '').trim()) return;
      setTimeout(() => {
        try {
          const sel = companyInput.selectionEnd - companyInput.selectionStart;
          if (sel > 0 && sel < companyInput.value.length) return;
        } catch (_) {}
        copyCompanyName();
      }, 10);
    });

    let companyTipEl = null;
    companyInput.addEventListener('mouseenter', () => {
      const full = getFullCompanyName();
      if (!full) return;
      const short = (companyInput.value || '').trim();
      if (companyTipEl) companyTipEl.remove();
      companyTipEl = document.createElement('div');
      // Pełna nazwa w podglądzie
      let html = '<div style="margin-bottom:4px;font-weight:600">' + full.replace(/</g, '&lt;') + '</div>';
      if (short && short !== full) {
        html += '<div style="font-size:11px;opacity:0.85">W polu / Slack: ' + short.replace(/</g, '&lt;') + '</div>';
      }
      html += '<div style="font-size:11px;opacity:0.7;margin-top:4px">klik = kopiuj z pola</div>';
      companyTipEl.innerHTML = html;
      Object.assign(companyTipEl.style, {
        position: 'fixed',
        zIndex: '99999',
        maxWidth: '380px',
        padding: '8px 12px',
        background: '#263238',
        color: '#fff',
        fontSize: '13px',
        fontWeight: '500',
        borderRadius: '6px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
        pointerEvents: 'none',
        lineHeight: '1.35',
        wordBreak: 'break-word'
      });
      document.body.appendChild(companyTipEl);
      const rect = companyInput.getBoundingClientRect();
      const tipW = companyTipEl.offsetWidth;
      let left = rect.left;
      if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
      companyTipEl.style.left = left + 'px';
      companyTipEl.style.top = (rect.bottom + 6) + 'px';
    });
    companyInput.addEventListener('mouseleave', () => {
      if (companyTipEl) { companyTipEl.remove(); companyTipEl = null; }
    });

    const noteId = `slack-note-${safeId}`;
    const noteInput = document.createElement('input');
    noteInput.id = noteId; noteInput.type = 'text'; noteInput.placeholder = '📝 Notatka';
    Object.assign(noteInput.style, { padding: '6px 10px', fontSize: '12px', border: '1px solid #f0a500', backgroundColor: '#fff9c4', borderRadius: '4px', width: '120px', outline: 'none' });

    const customContainer = document.createElement('div');
    customContainer.id = customId;
    Object.assign(customContainer.style, { display: 'inline-flex', alignItems: 'center', gap: '6px' });
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = '✏️ Wpisz ręcznie gdy brakuje logiki...';
    Object.assign(customInput.style, { padding: '6px 10px', fontSize: '12px', border: '1px solid #e57373', backgroundColor: '#ffebee', borderRadius: '4px', width: '340px', outline: 'none' });

    const saveOnlyBtn = document.createElement('button');
    saveOnlyBtn.innerText = '☁️ Zapisz Regułę';
    Object.assign(saveOnlyBtn.style, {
      padding: '6px 10px', fontSize: '12px', backgroundColor: '#d32f2f', color: '#ffffff', 
      border: 'none', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer', 
      display: 'none', transition: 'background-color 0.2s', whiteSpace: 'nowrap'
    });
    saveOnlyBtn.addEventListener('mouseenter', () => { if(!saveOnlyBtn.disabled) saveOnlyBtn.style.backgroundColor = '#b71c1c'; });
    saveOnlyBtn.addEventListener('mouseleave', () => { if(!saveOnlyBtn.disabled) saveOnlyBtn.style.backgroundColor = '#d32f2f'; });

    saveOnlyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const rawCustom = customInput.value.trim();
      if (!rawCustom) return;

      const rows3   = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
      const parsed3 = Array.from(rows3).map(parseRow);
      const fmt = formatCustomText(rawCustom, parsed3, modes);
      const baseKeyObj = JSON.parse(buildRuleKey(parsed3));
      const uniqueKeys = expandRuleKeys(baseKeyObj);

      const vehP   = parsed3.find(r=>r.type==='TRACTOR'||r.type==='BOX_TRUCK'||r.type==='SPRINTER_VAN');
      const trP    = parsed3.find(r=>r.type==='TRAILER');
      const tLoc   = vehP?.location;
      const rLoc   = trP?.location;
      const platePat = (vehP?.plate || 'XXXXX').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

      const msgTemplate = fmt.template
        .replace(new RegExp(`\\*?(${platePat})\\*?`,'gi'), '{tp}')
        .replace(/(?:Pol[a-zęółśążźćń]*|Bram[a-zęółśążźćń]*)\s*\*?(\d+[A-Z]?)\*?|(VS[a-zA-Z0-9\s-]+|PS\d+|OS\d+|PRECHECK\s*\d+)/gi, (m, num, spec) => {
          const val = num || spec;
          if (tLoc && cleanLocation(tLoc) === cleanLocation(val)) return '{tl}';
          if (rLoc && cleanLocation(rLoc) === cleanLocation(val)) return '{rl}';
          return m;
        });

      const save = window.confirm(
        `Czy chcesz ZAPISAĆ logikę do chmury (BEZ robienia Check-In i powiadomień Slack)?\n\nZapisywany szablon:\n👉 "${msgTemplate}"`
      );
      
      if (save) {
        const origText = saveOnlyBtn.innerText;
        saveOnlyBtn.innerText = '⏳ Zapisywanie...';
        saveOnlyBtn.style.backgroundColor = '#888';
        saveOnlyBtn.disabled = true;

        saveGHRule(uniqueKeys, msgTemplate, (ok) => {
          if (ok) {
            saveOnlyBtn.innerText = '✅ Zapisano!';
            saveOnlyBtn.style.backgroundColor = '#2e7d32';
            setTimeout(() => {
              saveOnlyBtn.innerText = origText;
              saveOnlyBtn.style.backgroundColor = '#d32f2f';
              saveOnlyBtn.disabled = false;
              customInput.value = '';
              updateCustomPreview();
              refresh();
            }, 2000);
          } else {
            alert('❌ Nie udało się zapisać reguły (błąd tokena lub API).');
            saveOnlyBtn.innerText = origText;
            saveOnlyBtn.style.backgroundColor = '#d32f2f';
            saveOnlyBtn.disabled = false;
          }
        });
      }
    });

    function updateCustomPreview() {
      const hasCustom = customInput.value.trim().length > 0;
      if (hasCustom) {
        saveOnlyBtn.style.display = 'inline-flex';
        const rows3   = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
        const parsed3 = Array.from(rows3).map(parseRow);
        const fmt = formatCustomText(customInput.value.trim(), parsed3, modes);
        preview.innerHTML = `<span style="color:#555;font-style:italic;">✏️ ${fmt.html}</span>`;
        sendBtn.disabled = false; sendBtn.style.opacity = '1'; sendBtn.style.cursor = 'pointer';
      } else {
        saveOnlyBtn.style.display = 'none';
        preview.style.opacity = '1';
        refresh();
      }
    }

    noteInput.addEventListener('input', () => { modes.note = noteInput.value; updateCustomPreview(); });
    driversInput.addEventListener('input', () => { modes.driversCount = driversInput.value; updateCustomPreview(); });
    companyInput.addEventListener('input', () => { modes.companyName = companyInput.value; updateCustomPreview(); });
    customInput.addEventListener('input', updateCustomPreview);

    // === RTT: helper + auto + przycisk ręczny ===
    function getAllVridsFromSummary() {
      const rowsForVrid = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
      const parsedForVrid = Array.from(rowsForVrid).map(parseRow);
      const seen = new Set();
      const list = [];
      const add = (v) => {
        if (!v) return;
        const clean = String(v).replace(/^VRID\s+/i, '').trim().toUpperCase();
        if (!clean || seen.has(clean)) return;
        if (['OTHER','MAINTENANCE','NON_INVENTORY','EMPTY_PICKUP','EMPTY_DROP','---'].includes(clean)) return;
        if (/^ISA/i.test(clean)) return;
        if (!/^[0-9A-Z]{6,14}$/i.test(clean)) return;
        seen.add(clean);
        list.push(clean);
      };
      // 1) VRID z titles
      for (const r of parsedForVrid) {
        if (r.vridTitlesAll && r.vridTitlesAll.length) {
          for (const t of r.vridTitlesAll) {
            const m = String(t).match(/VRID\s+(\S+)/i);
            if (m) add(m[1]);
          }
        }
        if (r.vrid) add(r.vrid);
      }
      // 2) Fallback: numer bez ISA
      if (list.length === 0) {
        for (const r of parsedForVrid) {
          if (r.vridTitlesAll && r.vridTitlesAll.length) {
            for (const t of r.vridTitlesAll) {
              const raw = String(t).trim();
              if (/^ISA\b/i.test(raw)) continue;
              const m = raw.match(/([0-9A-Z]{6,14})/i);
              if (m) add(m[1]);
            }
          }
        }
      }
      return list;
    }

    function applyRttInfo(info, force) {
      if (!info) return;
      if ((force || !driversInput.value) && info.driversCount) {
        driversInput.value = info.driversCount;
        modes.driversCount = String(info.driversCount);
      }
      if ((force || !companyInput.value) && info.companyName) {
        if (typeof setCompanyDisplay === 'function') {
          setCompanyDisplay(info.companyName);
        } else {
          companyInput.value = info.companyName;
          modes.companyName = info.companyName;
        }
      }
      if (typeof updateCustomPreview === 'function') updateCustomPreview();
    }

    // Próbuj kolejne VRID-y, aż znajdzie firmę lub kierowców
    function fetchRttFromAnyVrid(vrids, callback) {
      if (!vrids || !vrids.length) {
        callback(null, 'brak VRID');
        return;
      }
      let i = 0;
      let lastErr = '';
      const tryNext = () => {
        if (i >= vrids.length) {
          callback(null, lastErr || 'żaden VRID nie zwrócił danych');
          return;
        }
        const v = vrids[i++];
        console.log('[SZZ1 RTT] próbuję VRID', v, '(' + i + '/' + vrids.length + ')');
        fetchRttDriverAndCompany(v, (info, errMsg) => {
          if (info && (info.companyName || info.driversCount)) {
            console.log('[SZZ1 RTT] OK z VRID', v, info);
            callback(info);
            return;
          }
          if (errMsg) lastErr = errMsg + ' (' + v + ')';
          // brak scac/kierowców – spróbuj następny
          tryNext();
        });
      };
      tryNext();
    }

    // Auto-fill (tylko gdy pola puste) – sprawdza wszystkie VRID-y
    (function autoFillFromRtt() {
      const vrids = getAllVridsFromSummary();
      if (!vrids.length) return;
      console.log('[SZZ1 RTT] auto VRIDy=', vrids);
      fetchRttFromAnyVrid(vrids, (info) => applyRttInfo(info, false));
    })();

    // Mała ikonka odświeżania przy polach Kierowcy / Firma
    const rttBtn = document.createElement('button');
    rttBtn.type = 'button';
    rttBtn.innerText = '↻';
    rttBtn.title = 'Pobierz firmę i kierowców z RTT';
    Object.assign(rttBtn.style, {
      padding: '2px 6px',
      fontSize: '13px',
      fontWeight: '600',
      lineHeight: '1',
      backgroundColor: 'transparent',
      color: '#78909c',
      border: '1px solid #cfd8dc',
      borderRadius: '3px',
      cursor: 'pointer',
      height: '26px',
      minWidth: '26px',
      alignSelf: 'center'
    });
    rttBtn.addEventListener('mouseenter', () => {
      if (!rttBtn.disabled) {
        rttBtn.style.color = '#1565c0';
        rttBtn.style.borderColor = '#90caf9';
        rttBtn.style.backgroundColor = '#e3f2fd';
      }
    });
    rttBtn.addEventListener('mouseleave', () => {
      if (!rttBtn.disabled) {
        rttBtn.style.color = '#78909c';
        rttBtn.style.borderColor = '#cfd8dc';
        rttBtn.style.backgroundColor = 'transparent';
      }
    });
    rttBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const vrids = getAllVridsFromSummary();
      if (!vrids.length) {
        alert('Brak VRID w tej operacji – nie da się pobrać z RTT.');
        return;
      }
      const orig = rttBtn.innerText;
      rttBtn.innerText = '…';
      rttBtn.disabled = true;
      rttBtn.style.color = '#999';
      console.log('[SZZ1 RTT] ręcznie pobieram VRIDy=', vrids);
      fetchRttFromAnyVrid(vrids, (info, errMsg) => {
        rttBtn.disabled = false;
        rttBtn.style.color = '#78909c';
        rttBtn.style.borderColor = '#cfd8dc';
        rttBtn.style.backgroundColor = 'transparent';
        if (!info) {
          rttBtn.innerText = '✕';
          rttBtn.style.color = '#c62828';
          setTimeout(() => { rttBtn.innerText = orig; rttBtn.style.color = '#78909c'; }, 2000);
          alert(
            'Nie udało się pobrać z RTT.\n\n' +
            'VRIDy: ' + vrids.join(', ') + '\n' +
            (errMsg ? ('Powód: ' + errMsg + '\n\n') : '') +
            '1) Otwórz RTT w tej przeglądarce i odśwież (F5)\n' +
            '2) W Console RTT szukaj: [SZZ1 RTT] token zapisany\n' +
            '3) Wróć tutaj i kliknij ↻ ponownie.'
          );
          return;
        }
        applyRttInfo(info, true);
        rttBtn.innerText = '✓';
        rttBtn.style.color = '#2e7d32';
        setTimeout(() => { rttBtn.innerText = orig; rttBtn.style.color = '#78909c'; }, 1500);
      });
    });

    // Grupka: Kierowcy + Firma + mała ikonka ↻
    const rttGroup = document.createElement('div');
    Object.assign(rttGroup.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 4px',
      borderRadius: '4px',
      border: '1px solid #e0e0e0',
      backgroundColor: '#fafafa'
    });
    rttGroup.appendChild(driversInput);
    rttGroup.appendChild(companyInput);
    rttGroup.appendChild(rttBtn);

    customContainer.appendChild(customInput);
    customContainer.appendChild(saveOnlyBtn);

    const leftCol = document.createElement('div');
    Object.assign(leftCol.style, { display: 'inline-flex', flexDirection: 'row', gap: '6px', verticalAlign: 'top', alignItems: 'flex-start' });
    leftCol.appendChild(customContainer);
    leftCol.appendChild(preview);

    wrapper.appendChild(leftCol);
    wrapper.appendChild(tSwap);
    wrapper.appendChild(tL2);
    wrapper.appendChild(tL21);
    wrapper.appendChild(tL16);
    wrapper.appendChild(tL27);
    wrapper.appendChild(rttGroup);
    wrapper.appendChild(noteInput);
    
    addEquipBtn.parentNode.insertBefore(wrapper, addEquipBtn);

    const sendBtn = document.createElement('button');
    sendBtn.id = btnId; 
    sendBtn.className = BTN_CLASS;
    sendBtn.innerText = '🚀 Check-In & Slack';
    Object.assign(sendBtn.style, { display: 'inline-flex', alignItems: 'center', padding: '8px 14px', backgroundColor: '#4A154B', color: '#ffffff', border: 'none', borderRadius: '4px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', verticalAlign: 'middle', transition: 'background-color 0.2s, opacity 0.2s', whiteSpace: 'nowrap', marginRight: '8px' });
    sendBtn.addEventListener('mouseenter', () => { if (!sendBtn.disabled) sendBtn.style.backgroundColor = '#611f69'; });
    sendBtn.addEventListener('mouseleave', () => { if (!sendBtn.disabled) sendBtn.style.backgroundColor = '#4A154B'; });
    
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      
      let data;
      try { data = buildMessages(summary, modes); } catch(err) { return; }
      
      const isCustom = !data || data.needsChoice;
      let text;
      
      const rawCustom = customInput.value.trim();
      const rows2   = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
      const parsed2 = Array.from(rows2).map(parseRow);
      const fmt = rawCustom ? formatCustomText(rawCustom, parsed2, modes) : null;
      const customText = fmt ? fmt.slack : '';

      if (customText) {
        text = `${customText}${loginSuffix()}`;
      } else if (isCustom) {
        return; 
      } else {
        text = data.result.slack;
      }
      
      if (!TEST_MODE) {
        try {
          checkInBtn.click();
        } catch (err) {
          console.error("Nie udało się kliknąć oryginalnego przycisku Check In:", err);
        }
      } else {
        console.log('🧪 TEST_MODE: pominięto check-in');
      }

      sendBtn.disabled = true; sendBtn.innerText = '⏳ Wysyłanie...'; sendBtn.style.backgroundColor = '#888';
      
      sendToSlack(text,
        () => {
          sendBtn.innerText = '✅ Wysłano!'; sendBtn.style.backgroundColor = '#2e7d32';
          console.log("=== WYSŁANO ===\n" + text);
          noteInput.value = ''; modes.note = '';
          driversInput.value = ''; modes.driversCount = '';
          companyInput.value = ''; modes.companyName = ''; companyInput.dataset.fullName = '';
          if (isCustom) customInput.value = '';
          tSwap._reset(); tL2._reset(); tL21._reset(); tL16._reset(); tL27._reset();
          modes.swap = null; modes.l2 = null; modes.l21 = null; modes.l16 = null; modes.l27 = null;

          if (customText && fmt) {
            const rows3   = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
            const parsed3 = Array.from(rows3).map(parseRow);
            const baseKeyObj = JSON.parse(buildRuleKey(parsed3));
            const uniqueKeys = expandRuleKeys(baseKeyObj);

            const vehP   = parsed3.find(r=>r.type==='TRACTOR'||r.type==='BOX_TRUCK'||r.type==='SPRINTER_VAN');
            const trP    = parsed3.find(r=>r.type==='TRAILER');
            const tLoc   = vehP?.location;
            const rLoc   = trP?.location;
            const platePat = (vehP?.plate || 'XXXXX').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            
            const msgTemplate = fmt.template
              .replace(new RegExp(`\\*?(${platePat})\\*?`,'gi'), '{tp}')
              .replace(/(?:Pol[a-zęółśążźćń]*|Bram[a-zęółśążźćń]*)\s*\*?(\d+[A-Z]?)\*?|(VS[a-zA-Z0-9\s-]+|PS\d+|OS\d+|PRECHECK\s*\d+)/gi, (m, num, spec) => {
                const val = num || spec;
                if (tLoc && cleanLocation(tLoc) === cleanLocation(val)) return '{tl}';
                if (rLoc && cleanLocation(rLoc) === cleanLocation(val)) return '{rl}';
                return m;
              });
              
            setTimeout(() => {
              const save = window.confirm(
                `Zapisać tę regułę dla WSZYSTKICH kombinacji plac/brama/VS?\n\nSkrypt automatycznie załapie od razu warianty: Brama->Pole, Pole->Brama, Brama->Brama itd.\n\nZapisywany szablon (bez notatek, kierowców i firmy):\n👉 "${msgTemplate}"`
              );
              if (save) {
                saveGHRule(uniqueKeys, msgTemplate, (ok) => {
                  if (ok) { alert('✅ Reguła zapisana dla wszystkich kombinacji!'); }
                  else    { alert('❌ Nie udało się zapisać reguły (błąd tokena lub API).'); }
                });
              }
            }, 500);
          }

          setTimeout(() => { sendBtn.innerText = '🚀 Check-In & Slack'; sendBtn.style.backgroundColor = '#4A154B'; sendBtn.disabled = false; refresh(); }, 3000);
        },
        (err) => {
          sendBtn.innerText = '❌ Błąd Slacka!'; sendBtn.style.backgroundColor = '#c62828';
          console.error(err);
          setTimeout(() => { sendBtn.innerText = '🚀 Check-In & Slack'; sendBtn.style.backgroundColor = '#4A154B'; sendBtn.disabled = false; }, 3000);
        }
      );
    });

    if (checkInBtn.parentNode) {
      checkInBtn.parentNode.insertBefore(sendBtn, checkInBtn);
    }

    function refresh() {
      doRefresh(summary, modes, preview, sendBtn, wrapper, customContainer, customInput, barId);
    }
    refresh();
  }

  setInterval(() => {
    const summaries = document.querySelectorAll('.gate-operation-summary-new');
    document.querySelectorAll(`.${WRAPPER_CLASS}`).forEach(w => { if (!document.body.contains(w)) w.remove(); });
    document.querySelectorAll(`.${BTN_CLASS}`).forEach(btn => { if (!document.body.contains(btn)) btn.remove(); });

    summaries.forEach(summary => {
      const checkInBtn = findCheckInBtn(summary);
      const addEquipBtn = summary.querySelector('[data-testid="addEquipmentButton"]');
      if (!checkInBtn || !addEquipBtn) return; 

      const opId      = summary.querySelector('[data-testid="gateOperationId"]')?.innerText?.trim() || '';
      const safeId    = opId.replace(/[^a-z0-9]/gi, '_');
      const wrapperId = `slack-wrapper-${safeId}`;
      const barId     = `slack-quickcopy-${safeId}`;

      if (!document.getElementById(wrapperId)) {
        createVehicleUI(summary);
      } else {
        const wrapperEl       = document.getElementById(wrapperId);
        const previewId       = `slack-preview-${safeId}`;
        const btnId           = `slack-btn-${safeId}`;
        const customId        = `slack-custom-${safeId}`;
        const preview         = document.getElementById(previewId);
        const sendBtn         = document.getElementById(btnId);
        const customContainer = document.getElementById(customId);
        const customInput     = customContainer?.querySelector('input');
        if (wrapperEl?._modes && preview && sendBtn) {
          doRefresh(summary, wrapperEl._modes, preview, sendBtn, wrapperEl, customContainer, customInput, barId);
        }
      }

      injectYardPassButtons(summary);
    });
  }, 3000);

  const yardTranslations = {
    pl: { title: "PRZEPUSTKA YARD", issued: "Wydano:", action: "🎯 CEL WIZYTY", tractor: "🚛 REJESTRACJA CIĄGNIKA (Tractor)", trailer: "📦 NACZEPA (Trailer LP)", vrid: "📝 NUMERY VRID / ISA", empty: "BRAK VRID (EMPTY / EMPTY RETURN)",
      safety1: "🚫 ZAKAZ ZAWRACANIA NA PLACU MANEWROWYM • DROGA JEDNOKIERUNKOWA",
      safety2: "👷 NA PLACU ZAWSZE NOS BUTY OCHRONNE ORAZ KAMIZELKĘ",
      safety3: "🚗 MAX PRĘDKOŚĆ 15 km/h • ZACHOWAJ BEZPIECZEŃSTWO" },
    en: { title: "YARD PASS", issued: "Issued:", action: "🎯 TARGET ACTION", tractor: "🚛 TRACTOR PLATE", trailer: "📦 TRAILER (LP)", vrid: "📝 VRID / ISA NUMBERS", empty: "NO VRID (EMPTY / EMPTY RETURN)",
      safety1: "🚫 NO U-TURNS IN THE MANOEUVRING AREA • ONE-WAY ROAD",
      safety2: "👷 ALWAYS WEAR SAFETY BOOTS AND HIGH-VIS VEST IN THE YARD",
      safety3: "🚗 MAX SPEED 15 km/h • STAY SAFE" },
    de: { title: "YARD PASS", issued: "Ausgestellt:", action: "🎯 ZIELAKTION", tractor: "🚛 ZUGMASCHINE (Tractor)", trailer: "📦 ANHÄNGER (Trailer LP)", vrid: "📝 VRID / ISA NUMMERN", empty: "KEIN VRID (EMPTY / EMPTY RETURN)",
      safety1: "🚫 WENDEN AUF DEM RANGIERPLATZ VERBOTEN • EINBAHNSTRASSE",
      safety2: "👷 AUF DEM GELÄNDE STETS SICHERHEITSSCHUHE UND WARNWESTE TRAGEN",
      safety3: "🚗 MAX GESCHWINDIGKEIT 15 km/h • SICHERHEIT GEHT VOR" },
    ua: { title: "ПЕРЕПУСТКА YARD", issued: "Видано:", action: "🎯 ЦІЛЬ ВІЗИТУ", tractor: "🚛 НОМЕР ТЯГАЧА", trailer: "📦 НАПІВПРИЧІП (LP)", vrid: "📝 НОМЕРИ VRID / ISA", empty: "НЕМАЄ VRID (ПОРОЖНЬО)",
      safety1: "🚫 РОЗВОРОТ НА МАНЕВРОВОМУ МАЙДАНЧИКУ ЗАБОРОНЕНО • ДОРОГА ОДНОСТОРОННЬОГО РУХУ",
      safety2: "👷 НА МАЙДАНЧИКУ ЗАВЖДИ НОСІТЬ ЗАХИСНЕ ВЗУТТЯ ТА ЖИЛЕТ",
      safety3: "🚗 МАКС. ШВИДКІСТЬ 15 км/год • БЕРЕЖІТЬ СЕБЕ" },
    ru: { title: "ПРОПУСК YARD", issued: "Выдано:", action: "🎯 ЦЕЛЬ ВИЗИТА", tractor: "🚛 НОМЕР ТЯГАЧА", trailer: "📦 ПОЛУПРИЦЕП (LP)", vrid: "📝 НОМЕРА VRID / ISA", empty: "НЕТ VRID (ПУСТО)",
      safety1: "🚫 РАЗВОРОТ НА МАНЁВРЕННОЙ ПЛОЩАДКЕ ЗАПРЕЩЁН • ДОРОГА С ОДНОСТОРОННИМ ДВИЖЕНИЕМ",
      safety2: "👷 НА ПЛОЩАДКЕ ВСЕГДА НОСИТЕ ЗАЩИТНУЮ ОБУВЬ И ЖИЛЕТ",
      safety3: "🚗 МАКС. СКОРОСТЬ 15 км/ч • СОБЛЮДАЙТЕ БЕЗОПАСНОСТЬ" },
    ro: { title: "PERMIS YARD", issued: "Eliberat:", action: "🎯 SCOPUL VIZITEI", tractor: "🚛 CAP TRACTOR", trailer: "📦 REMORCĂ (LP)", vrid: "📝 NUMERE VRID / ISA", empty: "FĂRĂ VRID (GOL)",
      safety1: "🚫 ÎNTOARCEREA ÎN ZONA DE MANEVRĂ ESTE INTERZISĂ • DRUM CU SENS UNIC",
      safety2: "👷 PE PLATFORMĂ PURTAȚI ÎNTOTDEAUNA BOCANCI DE PROTECȚIE ȘI VESTĂ",
      safety3: "🚗 VITEZĂ MAX 15 km/h • FIȚI ÎN SIGURANȚĂ" }
  };
  const yardCaptions = {
    pl: { drop: 'ZRZUT', pickup: 'POBÓR (CZEKAĆ)', wait: 'POBÓR (CZEKAĆ NAPRZECIWKO RAMPY)' },
    en: { drop: 'DROP-OFF', pickup: 'PICK-UP (WAIT)', wait: 'PICK-UP (WAIT OPPOSITE THE RAMP)' },
    de: { drop: 'ABLADEN', pickup: 'ABHOLEN (WARTEN)', wait: 'ABHOLEN (GEGENÜBER DER RAMPE WARTEN)' },
    ua: { drop: 'ЗАЛИШИТИ', pickup: 'ЗАБРАТИ (ЧЕКАТИ)', wait: 'ЗАБРАТИ (ЧЕКАТИ НАВПРОТИ РАМПИ)' },
    ru: { drop: 'СБРОС', pickup: 'ЗАБРАТЬ (ЖДАТЬ)', wait: 'ЗАБРАТЬ (ЖДАТЬ НАПРОТИВ РАМПЫ)' },
    ro: { drop: 'DESCĂRCARE', pickup: 'RIDICARE (AȘTEPTAȚI)', wait: 'RIDICARE (AȘTEPTAȚI VIZAVI DE RAMPĂ)' }
  };

  function parseAndTranslateSlackText(text, lang) {
    if (!text || text === '---' || text.includes('Brak pasującej logiki')) return [{ text: '---', caption: '' }];
    const locMatches = [];
    const tLoc = {
      brama: { pl: 'Rampa', en: 'Rampa', de: 'Rampa', ua: 'Рампа', ru: 'Рампа', ro: 'Rampa' }[lang] || 'Rampa',
      pole: { pl: 'Pole', en: 'Slot', de: 'Stellplatz', ua: 'Поле', ru: 'Поле', ro: 'Locul' }[lang] || 'Pole'
    };

    const allLocRegex = /(?:bram[a-zęółśążźćń]*\s*(\d+))|(?:(?:^|\s)(?:na|z|w|wbity na)\s+(?:pol[a-zęółśążźćń]*\s+)?((?:VS|OS|PS)\S+(?:\s+[a-zA-Z]+)?|PRECHECK\s*\d+|\d+[a-zA-Z]?))/gi;

    let match;
    while ((match = allLocRegex.exec(text)) !== null) {
      if (match[1]) {
        locMatches.push({ text: `${tLoc.brama.toUpperCase()} ${match[1]}`, type: 'brama' });
      } else if (match[2]) {
        let val = match[2].trim().toUpperCase();
        locMatches.push({ text: `${tLoc.pole.toUpperCase()} ${val}`, type: 'pole' });
      }
    }

    if (locMatches.length > 0) {
      const tCap = yardCaptions[lang] || yardCaptions.pl;
      if (locMatches.length === 1) return [{ text: locMatches[0].text, caption: '', type: locMatches[0].type }];
      return locMatches.map(item => ({ text: item.text, caption: item.type === 'pole' ? tCap.drop : tCap.pickup, type: item.type }));
    }
    
    let fallbackText = text.replace(/(?:Zestaw|Ciągnik|Box|Bus|Myjka)\s*[A-Z0-9]+/i, '').trim();
    fallbackText = fallbackText.replace(/^[-\/]+|[-\/]+$/g, '').trim();
    return fallbackText ? [{ text: fallbackText.toUpperCase(), caption: '', type: '' }] : [{ text: '---', caption: '', type: '' }];
  }

  function printPass(summary, lang) {
    const t = yardTranslations[lang];
    const rows = summary.querySelectorAll('[data-testid="gateOperationEquipmentRow"]');
    if (!rows.length) return;
    let tractorPlate = '---'; let trailerPlate = '---'; let vridList = [];
    rows.forEach(row => {
      const typeImg = row.querySelector('img[data-testid="equipmentTypeImage"]');
      const rawType = typeImg ? typeImg.alt.toUpperCase() : 'UNKNOWN';
      const plateNum = row.querySelector('[data-testid="licensePlateNumber"]')?.innerText?.trim();
      const cleanPlate = (plateNum && plateNum !== '---' && plateNum !== 'undefined') ? plateNum : null;
      if (rawType.includes('TRACTOR') || rawType.includes('BOX_TRUCK') || rawType.includes('SPRINTER')) { if (cleanPlate) tractorPlate = cleanPlate; }
      if (rawType.includes('TRAILER')) { if (cleanPlate) trailerPlate = cleanPlate; }
      const vridContainer = row.querySelector('[data-testid="displayableLoadIdentifier"]');
      if (vridContainer) {
        const titles = Array.from(vridContainer.querySelectorAll('[title]')).map(el => el.title?.trim());
        titles.forEach(titleText => { if (titleText && titleText !== '---' && !vridList.includes(titleText)) vridList.push(titleText); });
      }
    });
    const opId = summary.querySelector('[data-testid="gateOperationId"]')?.innerText?.trim() || '';
    const safeId = opId.replace(/[^a-z0-9]/gi, '_');
    const slackPreviewEl = document.getElementById(`slack-preview-${safeId}`);
    let rawActionText = '---';
    if (slackPreviewEl && slackPreviewEl.innerText.trim() !== '' && !slackPreviewEl.innerText.includes('Brak pasującej logiki')) {
      rawActionText = slackPreviewEl.innerText.trim();
    } else {
      const firstLocInput = summary.querySelector('[data-testid="gateOperationSummaryLocationSelect"] input');
      if (firstLocInput && firstLocInput.value) rawActionText = firstLocInput.value.trim();
    }
    const actionTexts = parseAndTranslateSlackText(rawActionText, lang);
    if (actionTexts.length === 1 && actionTexts[0].type === 'brama' && trailerPlate === '---') {
      const tCap = yardCaptions[lang] || yardCaptions.pl;
      actionTexts[0].caption = tCap.wait;
    }
    let actionHtml = '';
    const renderActionBox = (item) => {
      const captionHtml = item.caption ? `<div class="action-caption">${item.caption}</div>` : '';
      return `<div class="value-action">${captionHtml}${item.text}</div>`;
    };
    if (actionTexts.length > 1) {
      actionHtml += '<div class="value-action-row">';
      actionTexts.forEach(item => { actionHtml += renderActionBox(item); });
      actionHtml += '</div>';
    } else { actionTexts.forEach(item => { actionHtml += renderActionBox(item); }); }
    const currentPrintTime = new Date().toLocaleString('pl-PL');
    const printWindow = window.open('', '_blank');
    if (!printWindow) { alert('Zablokowano wyskakujące okienko!'); return; }
    printWindow.document.write(`<html><head><title>YARD PASS - ${tractorPlate}</title><style>@page{margin:0}html,body{width:100%;height:100%;margin:0;padding:0;color:#000;background-color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:'Arial',sans-serif}.ticket{box-sizing:border-box;width:100%;height:100%;border:3px solid #000;padding:3mm;display:flex;flex-direction:column;justify-content:space-between}.header{text-align:center;border-bottom:3px double #000;padding-bottom:1.5mm;margin-bottom:1.5mm}.header h1{margin:0;font-size:22px;text-transform:uppercase;letter-spacing:1px}.header .date{font-size:11px;margin-top:0.5mm;font-weight:bold}.section{margin-bottom:1.5mm}.label{font-size:10px;text-transform:uppercase;color:#444;font-weight:bold}.plate-box{font-size:18px;font-weight:bold;margin-top:1mm;padding:1mm;border:2px solid #000;border-radius:5px;text-align:center;letter-spacing:1px;background-color:#fafafa}.action-caption{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;opacity:0.7;margin-bottom:0.5mm}.value-action{font-size:28px;background-color:transparent;color:#000;text-align:center;padding:1.5mm;margin-top:1.5mm;font-weight:900;border:4px solid #000;border-radius:7px;line-height:1.1;letter-spacing:1px;text-transform:uppercase}.value-action-row{display:flex;flex-direction:row;gap:1.5mm;margin-top:1.5mm}.value-action-row .value-action{flex:1;min-width:0;margin-top:0;font-size:17px;padding:1mm;border-width:3px;word-break:break-word}.value-action-row .action-caption{font-size:7px;letter-spacing:0.3px}.vrid-box{font-size:12px;font-weight:bold;border:1px dashed #000;padding:1.5mm;margin-top:1mm;background-color:#f9f9f9}.safety-block{border:2px solid #000;border-radius:5px;padding:1.5mm 2mm;margin-top:1.5mm;background-color:#fff3cd}.safety-line{text-align:center;font-size:10px;font-weight:900;letter-spacing:0.3px;text-transform:uppercase;padding:0.8mm 0}.safety-line+.safety-line{border-top:1px solid #ccc}</style></head><body><div class="ticket"><div class="header"><h1>${t.title}</h1><div class="date">${t.issued} ${currentPrintTime}</div></div><div class="section"><div class="label">${t.tractor}</div><div class="plate-box">${tractorPlate}</div></div><div class="section"><div class="label">${t.trailer}</div><div class="plate-box">${trailerPlate}</div></div><div class="section" style="text-align:center;margin-top:2mm"><div class="label" style="font-size:13px">${t.action}</div>${actionHtml}</div><div class="section" style="margin-bottom:0"><div class="label">${t.vrid}</div><div class="vrid-box">${vridList.length>0?vridList.join('<br>'):t.empty}</div></div><div class="safety-block"><div class="safety-line">${t.safety1}</div><div class="safety-line">${t.safety2}</div><div class="safety-line">${t.safety3}</div></div></div><script>window.onload=function(){window.print();setTimeout(function(){window.close();},100);}<\/script></body></html>`);
    printWindow.document.close();
  }

  function injectYardPassButtons(summary) {
    const opId = summary.querySelector('[data-testid="gateOperationId"]')?.innerText?.trim() || '';
    if (!opId) return;
    const safeId = opId.replace(/[^a-z0-9]/gi, '_');
    const wrapperId = `zebra-yardpass-wrapper-${safeId}`;
    const slackPreviewEl = document.getElementById(`slack-preview-${safeId}`);
    const isLogicReady = slackPreviewEl && slackPreviewEl.innerText.trim() !== '' && !slackPreviewEl.innerText.includes('Brak pasującej logiki');
    let btnWrapper = document.getElementById(wrapperId);
    if (!btnWrapper) {
      btnWrapper = document.createElement('div');
      btnWrapper.id = wrapperId;
      Object.assign(btnWrapper.style, { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end', padding: '8px 12px', backgroundColor: '#f1f3f4', borderBottom: '1px solid #e0e0e0', marginBottom: '10px', borderRadius: '4px 4px 0 0', flexWrap: 'wrap' });
      const labelSpan = document.createElement('span');
      labelSpan.className = 'zebra-label-span';
      Object.assign(labelSpan.style, { fontSize: '11px', fontWeight: '800', marginRight: 'auto', letterSpacing: '0.5px', whiteSpace: 'nowrap' });
      btnWrapper.appendChild(labelSpan);
      [{ code:'pl',label:'🇵🇱 PL'},{ code:'en',label:'🇬🇧 EN'},{ code:'de',label:'🇩🇪 DE'},{ code:'ua',label:'🇺🇦 UA'},{ code:'ru',label:'🇷🇺 RU'},{ code:'ro',label:'🇷🇴 RO'}].forEach(langOpt => {
        const btn = document.createElement('button');
        btn.className = 'zebra-lang-btn'; btn.innerText = langOpt.label;
        btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.backgroundColor = '#fdd835'; });
        btn.addEventListener('mouseleave', () => { if (!btn.disabled) btn.style.backgroundColor = '#ffeb3b'; });
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (!btn.disabled) printPass(summary, langOpt.code); });
        btnWrapper.appendChild(btn);
      });
      if (summary.firstChild) { summary.insertBefore(btnWrapper, summary.firstChild); } else { summary.appendChild(btnWrapper); }
    }
    const buttons = btnWrapper.querySelectorAll('.zebra-lang-btn');
    const labelSpan = btnWrapper.querySelector('.zebra-label-span');
    buttons.forEach(btn => {
      if (!isLogicReady) {
        btn.disabled = true;
        Object.assign(btn.style, { padding: '6px 12px', backgroundColor: '#e0e0e0', color: '#888', border: '1px solid #ccc', borderRadius: '4px', fontSize: '11px', fontWeight: '700', cursor: 'not-allowed', opacity: '0.6', boxShadow: 'none' });
      } else {
        btn.disabled = false;
        Object.assign(btn.style, { padding: '6px 12px', backgroundColor: '#ffeb3b', color: '#000', border: '1px solid #cddc39', borderRadius: '4px', fontSize: '11px', fontWeight: '700', cursor: 'pointer', opacity: '1', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' });
      }
    });
    if (labelSpan) {
      if (!isLogicReady) { labelSpan.innerText = '⏳ OCZEKIWANIE...'; labelSpan.style.color = '#d32f2f'; }
      else { labelSpan.innerText = '🎫 DRUKUJ PRZEPUSTKĘ:'; labelSpan.style.color = '#444'; }
    }
  }

})();
