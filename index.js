// prompt-toggle-manager  (+ preset-profile-check, merged)

const extensionName   = 'prompt-deck';
const GLOBAL_DUMMY_ID = 100001;
const TG_KEY          = extensionName;

let getRequestHeaders, openai_setting_names, openai_settings,
    extension_settings, saveSettingsDebounced, oai_settings,
    eventSource, event_types, setupChatCompletionPromptManager,
    callGenericPopup, POPUP_TYPE;

async function initImports() {
    const scriptPath   = import.meta.url;
    const isThirdParty = scriptPath.includes('/third-party/');
    const base  = isThirdParty ? '../../../../' : '../../../';
    const base2 = isThirdParty ? '../../../'    : '../../';

    const sm = await import(base + 'script.js');
    getRequestHeaders     = sm.getRequestHeaders;
    saveSettingsDebounced = sm.saveSettingsDebounced;
    eventSource           = sm.eventSource;
    event_types           = sm.event_types;

    const om = await import(base2 + 'openai.js');
    openai_setting_names             = om.openai_setting_names;
    openai_settings                  = om.openai_settings;
    oai_settings                     = om.oai_settings;
    setupChatCompletionPromptManager = om.setupChatCompletionPromptManager;

    const em = await import(base2 + 'extensions.js');
    extension_settings = em.extension_settings;

    const pm = await import(base2 + 'popup.js');
    callGenericPopup = pm.callGenericPopup;
    POPUP_TYPE       = pm.POPUP_TYPE;
}

// ══════════════════════════════════════════
// A. Toggle Group Data
// ══════════════════════════════════════════

const collapsedGroups = new Set();
let groupReorderMode  = false;
let toggleReorderMode = null;
let dragState         = null;

function getTGStore() {
    if (!extension_settings[TG_KEY]) extension_settings[TG_KEY] = { presets: {} };
    return extension_settings[TG_KEY];
}
function getGroupsForPreset(pn) {
    const s = getTGStore();
    if (!s.presets[pn]) s.presets[pn] = [];
    return s.presets[pn];
}
function saveGroups(pn, groups) {
    getTGStore().presets[pn] = groups;
    saveSettingsDebounced();
}
function getCurrentPreset() {
    return oai_settings?.preset_settings_openai || '';
}

// ══════════════════════════════════════════
// B. Apply group
// ══════════════════════════════════════════

function applyGroup(pn, gi) {
    const groups = getGroupsForPreset(pn);
    const g      = groups[gi];
    if (!g) return;
    try {
        const pm = setupChatCompletionPromptManager(oai_settings);
        for (const t of g.toggles) {
            const entry = pm.getPromptOrderEntry(pm.activeCharacter, t.target);
            if (!entry) continue;
            const ovr = t.override ?? null;
            entry.enabled = ovr !== null ? ovr : (t.behavior === 'invert') ? !g.isOn : g.isOn;
            if (pm.tokenHandler?.getCounts) {
                const counts = pm.tokenHandler.getCounts();
                counts[t.target] = null;
            }
        }
        pm.render();
        pm.saveServiceSettings();
    } catch (e) {
        console.warn('[PTM] applyGroup error', e);
    }
}

// ══════════════════════════════════════════
// C. Toggle Group UI
// ══════════════════════════════════════════

function renderTGGroups() {
    const area = document.getElementById('ptm-tg-area');
    if (!area) return;
    const pn = getCurrentPreset();
    if (!pn) { area.innerHTML = '<div class="ptm-ph">프리셋이 선택되지 않았습니다</div>'; return; }

    let validIds = null;
    try {
        const pm = setupChatCompletionPromptManager(oai_settings);
        const order = (pm.serviceSettings?.prompt_order || [])
            .find(o => String(o.character_id) === String(GLOBAL_DUMMY_ID));
        validIds = new Set((order?.order || []).map(e => e.identifier));
    } catch(e) {
        try {
            const livePreset = getLivePresetData(pn) || openai_settings[openai_setting_names[pn]];
            const order = (livePreset?.prompt_order || [])
                .find(o => String(o.character_id) === String(GLOBAL_DUMMY_ID));
            validIds = new Set((order?.order || []).map(e => e.identifier));
        } catch(e2) {
            console.warn('[PromptDeck] Could not get valid prompt IDs, skipping cleanup:', e2);
        }
    }
    const groups = getGroupsForPreset(pn);
    // Only filter stale toggles if we successfully retrieved valid IDs
    if (validIds !== null && validIds.size > 0) {
        let changed = false;
        groups.forEach(g => {
            const before = g.toggles.length;
            g.toggles = g.toggles.filter(t => validIds.has(t.target));
            if (g.toggles.length !== before) changed = true;
        });
        if (changed) saveGroups(pn, groups);
    }

    if (!groups.length) { area.innerHTML = '<div class="ptm-ph">그룹이 없습니다</div>'; return; }
    area.innerHTML = groups.map((g, gi) => buildGroupCard(g, gi, pn)).join('');
    wireGroupCards(area);
}

function buildGroupCard(g, gi, pn) {
    let allPrompts;
    try {
        const pm = setupChatCompletionPromptManager(oai_settings);
        allPrompts = pm.serviceSettings?.prompts || [];
    } catch(e) {
        const preset = getLivePresetData(pn) || openai_settings[openai_setting_names[pn]];
        allPrompts = preset?.prompts || [];
    }
    const inToggleReorder = toggleReorderMode === gi;

    const rows = g.toggles.map((t, ti) => {
        // Bug fix: use ?? so empty-string names aren't replaced with identifier
        const name     = allPrompts.find(p => p.identifier === t.target)?.name ?? '';
        const isDirect = t.behavior === 'direct';
        const ovr      = t.override ?? null;
        const effectiveOn = ovr !== null ? ovr : (isDirect ? g.isOn : !g.isOn);

        let ovrLabel, ovrCls;
        if (ovr === null)      { ovrLabel = '고정'; ovrCls = 'ptm-tovr-lock'; }
        else if (ovr === true) { ovrLabel = 'On';  ovrCls = 'ptm-tovr-on';  }
        else                   { ovrLabel = 'Off'; ovrCls = 'ptm-tovr-off'; }

        return `
        <div class="ptm-trow" data-gi="${gi}" data-ti="${ti}">
            ${inToggleReorder
                ? `<span class="ptm-drag-handle" data-gi="${gi}" data-ti="${ti}" title="드래그">⠿</span>`
                : `<span class="ptm-tstate ${effectiveOn ? 'ptm-ts-on' : 'ptm-ts-off'}">${effectiveOn ? 'On' : 'Off'}</span>`}
            <button class="ptm-ibtn ptm-tovr ${ovrCls}" data-gi="${gi}" data-ti="${ti}">${ovrLabel}</button>
            <span class="ptm-tname">${name}</span>
            ${!inToggleReorder ? `<button class="ptm-ibtn ptm-bsel ${isDirect ? 'ptm-bsel-dir' : 'ptm-bsel-inv'}" data-gi="${gi}" data-ti="${ti}">${isDirect ? '동일' : '반전'}</button>` : ''}
            <button class="ptm-ibtn ptm-danger ptm-del-toggle" data-gi="${gi}" data-ti="${ti}">✕</button>
        </div>`;
    }).join('');

    const collapseKey = `${pn}__${gi}`;
    const isCollapsed = collapsedGroups.has(collapseKey);
    const toggleCount = g.toggles.length;
    const groups      = getGroupsForPreset(pn);
    const isFirst     = gi === 0;
    const isLast      = gi === groups.length - 1;

    return `
    <div class="ptm-card" data-gi="${gi}">
        <div class="ptm-card-head">
            ${groupReorderMode ? `
                <button class="ptm-ibtn ptm-grp-up${isFirst ? ' ptm-arr-disabled' : ''}" data-gi="${gi}" ${isFirst ? 'disabled' : ''}>▲</button>
                <button class="ptm-ibtn ptm-grp-dn${isLast  ? ' ptm-arr-disabled' : ''}" data-gi="${gi}" ${isLast  ? 'disabled' : ''}>▼</button>
            ` : `<button class="ptm-onoff ${g.isOn ? 'ptm-onoff-on' : 'ptm-onoff-off'}" data-gi="${gi}">${g.isOn ? 'On' : 'Off'}</button>`}
            <span class="ptm-gname">${g.name} <span class="ptm-gcnt">(${toggleCount})</span></span>
            <div class="ptm-gbtns">
                ${!groupReorderMode && !inToggleReorder ? `<button class="ptm-ibtn ptm-ren-grp" data-gi="${gi}">✏️</button>` : ''}
                ${!groupReorderMode && !inToggleReorder && !isCollapsed ? `<button class="ptm-ibtn ptm-reorder-grp-btn" data-gi="${gi}" title="토글 순서 변경">⠿</button>` : ''}
                ${!groupReorderMode && !inToggleReorder ? `<button class="ptm-ibtn ptm-danger ptm-del-grp" data-gi="${gi}">✕</button>` : ''}
                ${inToggleReorder ? `<button class="ptm-ibtn ptm-toggle-reorder-done" data-gi="${gi}" style="color:#6ddb9e">✓</button>` : ''}
                ${!groupReorderMode && !inToggleReorder ? `<button class="ptm-ibtn ptm-popup-btn${g.showInPopup ? ' ptm-popup-btn-on' : ''}" data-gi="${gi}" title="팝업에 표시">팝업</button>` : ''}
                <button class="ptm-ibtn ptm-collapse-grp" data-gi="${gi}" data-cpkey="${collapseKey}" title="${isCollapsed ? '펼치기' : '접기'}">${isCollapsed ? '▸' : '▾'}</button>
            </div>
        </div>
        <div class="ptm-tlist${isCollapsed ? ' ptm-hidden' : ''}">
            ${rows || '<div class="ptm-ph" style="padding:6px;font-size:11px">토글 없음</div>'}
        </div>
        ${!groupReorderMode ? `<button class="ptm-sm ptm-sm-full ptm-add-toggle${isCollapsed ? ' ptm-hidden' : ''}" data-gi="${gi}">+ 토글 추가</button>` : ''}
    </div>`;
}

function wireGroupCards(area) {
    area.querySelectorAll('.ptm-grp-up').forEach(btn => btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        if (gi === 0) return;
        [gs[gi-1], gs[gi]] = [gs[gi], gs[gi-1]];
        saveGroups(pn, gs); renderTGGroups();
    }));
    area.querySelectorAll('.ptm-grp-dn').forEach(btn => btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        if (gi >= gs.length - 1) return;
        [gs[gi], gs[gi+1]] = [gs[gi+1], gs[gi]];
        saveGroups(pn, gs); renderTGGroups();
    }));
    area.querySelectorAll('.ptm-reorder-grp-btn').forEach(btn => btn.addEventListener('click', () => {
        toggleReorderMode = +btn.dataset.gi;
        renderTGGroups();
    }));
    area.querySelectorAll('.ptm-toggle-reorder-done').forEach(btn => btn.addEventListener('click', () => {
        toggleReorderMode = null;
        renderTGGroups();
    }));
    area.querySelectorAll('.ptm-collapse-grp').forEach(btn => btn.addEventListener('click', () => {
        const cpkey = btn.dataset.cpkey;
        if (collapsedGroups.has(cpkey)) collapsedGroups.delete(cpkey);
        else collapsedGroups.add(cpkey);
        renderTGGroups();
    }));
    area.querySelectorAll('.ptm-onoff').forEach(btn => btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        gs[gi].isOn = !gs[gi].isOn;
        applyGroup(pn, gi);
        saveGroups(pn, gs);
        renderTGGroups();
        refreshPpcPopup();
    }));
    area.querySelectorAll('.ptm-tovr').forEach(btn => btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi, ti = +btn.dataset.ti, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        const cur = gs[gi].toggles[ti].override ?? null;
        gs[gi].toggles[ti].override = cur === null ? true : cur === true ? false : null;
        applyGroup(pn, gi);
        saveGroups(pn, gs);
        renderTGGroups();
    }));
    area.querySelectorAll('.ptm-ren-grp').forEach(btn => btn.addEventListener('click', async () => {
        const gi = +btn.dataset.gi, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        const n = await callGenericPopup('그룹 이름 변경:', POPUP_TYPE.INPUT, gs[gi].name);
        if (!n?.trim()) return;
        gs[gi].name = n.trim(); saveGroups(pn, gs); renderTGGroups(); refreshPpcPopup();
    }));
    area.querySelectorAll('.ptm-del-grp').forEach(btn => btn.addEventListener('click', async () => {
        const gi = +btn.dataset.gi, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        const ok = await callGenericPopup(`"${gs[gi].name}" 그룹을 삭제할까요?`, POPUP_TYPE.CONFIRM);
        if (!ok) return;
        gs.splice(gi, 1); saveGroups(pn, gs); renderTGGroups(); refreshPpcPopup();
    }));
    area.querySelectorAll('.ptm-bsel').forEach(btn => btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi, ti = +btn.dataset.ti, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        gs[gi].toggles[ti].behavior = gs[gi].toggles[ti].behavior === 'direct' ? 'invert' : 'direct';
        saveGroups(pn, gs); renderTGGroups();
    }));
    area.querySelectorAll('.ptm-del-toggle').forEach(btn => btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi, ti = +btn.dataset.ti, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        gs[gi].toggles.splice(ti, 1); saveGroups(pn, gs); renderTGGroups();
    }));
    area.querySelectorAll('.ptm-add-toggle').forEach(btn => btn.addEventListener('click', () => {
        showAddToggleModal(+btn.dataset.gi);
    }));
    // "팝업" toggle button
    area.querySelectorAll('.ptm-popup-btn').forEach(btn => btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi, pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
        gs[gi].showInPopup = !gs[gi].showInPopup;
        saveGroups(pn, gs);
        refreshPpcPopup();
        // update button appearance without full re-render
        btn.classList.toggle('ptm-popup-btn-on', gs[gi].showInPopup);
    }));
}

// ── Add toggle modal ──────────────────────────────────────────────────────────
async function showAddToggleModal(gi) {
    const pn = getCurrentPreset(), preset = openai_settings[openai_setting_names[pn]];
    if (!preset) return;
    const gs = getGroupsForPreset(pn), exists = new Set(gs[gi].toggles.map(t => t.target));
    const prompts = preset.prompts || [];
    const selectedMap = new Map();

    const listHtml = prompts.map((p, idx) => {
        const ex = exists.has(p.identifier);
        // Bug fix: use ?? for name
        return `<label style="display:flex;align-items:center;gap:8px;padding:7px 4px;cursor:${ex ? 'default' : 'pointer'};opacity:${ex ? '0.45' : '1'}">
            <input type="checkbox" class="ptm-add-cb" data-i="${idx}" data-id="${p.identifier}" ${ex ? 'disabled checked' : ''}
                style="width:16px;height:16px;accent-color:#7a6fff;flex-shrink:0;cursor:pointer">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name ?? ''}</span>
            ${ex ? '<span style="font-size:10px;padding:1px 5px;border-radius:8px;background:rgba(120,100,255,.25);color:#a89fff;flex-shrink:0">추가됨</span>' : ''}
        </label>`;
    }).join('');

    const html = `
        <input type="text" id="ptm-msearch" placeholder="검색..."
            style="width:100%;margin-bottom:6px;padding:6px 8px;border-radius:5px;border:1px solid #555;background:#222;color:#eee;box-sizing:border-box">
        <div style="display:flex;gap:6px;margin-bottom:8px">
            <button id="ptm-mall"   class="ptm-sm" style="margin:0">전체</button>
            <button id="ptm-mnone"  class="ptm-sm" style="margin:0">해제</button>
            <button id="ptm-mrange" class="ptm-sm" style="margin:0">연속</button>
        </div>
        <div id="ptm-mlist" style="max-height:45vh;overflow-y:auto">${listHtml}</div>`;

    const observer = new MutationObserver(() => {
        const search = document.getElementById('ptm-msearch');
        if (search && !search._ptmWired) {
            search._ptmWired = true;
            search.addEventListener('input', e => {
                const q = e.target.value.toLowerCase();
                document.querySelectorAll('#ptm-mlist label').forEach(el => {
                    el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
                });
            });
        }
        document.querySelectorAll('.ptm-add-cb:not(:disabled)').forEach(cb => {
            if (cb._ptmWired) return;
            cb._ptmWired = true;
            cb.addEventListener('change', () => {
                if (cb.checked) selectedMap.set(+cb.dataset.i, cb.dataset.id);
                else selectedMap.delete(+cb.dataset.i);
            });
        });
        const mallBtn = document.getElementById('ptm-mall');
        if (mallBtn && !mallBtn._ptmWired) {
            mallBtn._ptmWired = true;
            mallBtn.addEventListener('click', () => {
                document.querySelectorAll('.ptm-add-cb:not(:disabled)').forEach(cb => {
                    cb.checked = true; selectedMap.set(+cb.dataset.i, cb.dataset.id);
                });
            });
        }
        const mnoneBtn = document.getElementById('ptm-mnone');
        if (mnoneBtn && !mnoneBtn._ptmWired) {
            mnoneBtn._ptmWired = true;
            mnoneBtn.addEventListener('click', () => {
                document.querySelectorAll('.ptm-add-cb:not(:disabled)').forEach(cb => {
                    cb.checked = false; selectedMap.delete(+cb.dataset.i);
                });
            });
        }
        const mrangeBtn = document.getElementById('ptm-mrange');
        if (mrangeBtn && !mrangeBtn._ptmWired) {
            mrangeBtn._ptmWired = true;
            mrangeBtn.addEventListener('click', () => {
                if (selectedMap.size < 2) { toastr.warning('시작과 끝 항목 2개를 선택하세요'); return; }
                const idxs = [...selectedMap.keys()].sort((a, b) => a - b);
                const mn = idxs[0], mx = idxs[idxs.length - 1];
                document.querySelectorAll('.ptm-add-cb:not(:disabled)').forEach(cb => {
                    const i = +cb.dataset.i;
                    if (i >= mn && i <= mx) { cb.checked = true; selectedMap.set(i, cb.dataset.id); }
                });
            });
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const ok = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { okButton: '추가', cancelButton: '취소' });
    observer.disconnect();

    if (!ok) return;
    if (!selectedMap.size) { toastr.warning('추가할 항목을 선택하세요'); return; }
    const gs2 = getGroupsForPreset(pn);
    selectedMap.forEach(id => gs2[gi].toggles.push({ target: id, behavior: 'direct', override: null }));
    saveGroups(pn, gs2); renderTGGroups();
    toastr.success(`${selectedMap.size}개 추가됨`);
}

// ══════════════════════════════════════════
// D. Mover helpers
// ══════════════════════════════════════════

let sourcePresetName = '', targetPresetName = '', sourceOrderedPrompts = [],
    targetOrderedPrompts = [], selectedSourceIndices = new Set(), insertPosition = -1;

function getPromptOrder(preset) {
    if (!preset?.prompt_order) return [];
    return preset.prompt_order.find(o => String(o.character_id) === String(GLOBAL_DUMMY_ID))?.order || [];
}
function getOrderedPrompts(preset) {
    return getPromptOrder(preset).map(e => {
        const def = (preset?.prompts || []).find(p => p.identifier === e.identifier);
        return { identifier: e.identifier, enabled: e.enabled, prompt: def || { identifier: e.identifier, name: e.identifier } };
    });
}
function getLivePresetData(presetName) {
    if (!presetName) return null;
    if (presetName === getCurrentPreset()) return oai_settings;
    return openai_settings[openai_setting_names[presetName]];
}
async function savePreset(name, preset) {
    const r = await fetch('/api/presets/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ apiId: 'openai', name, preset }) });
    if (!r.ok) throw new Error('프리셋 저장 실패');
    return r.json();
}
function getPresetOptions() {
    if (!openai_settings || !openai_setting_names) return '<option value="">-- 프리셋 없음 --</option>';
    return '<option value="">-- 선택 --</option>'
        + Object.keys(openai_setting_names).filter(n => openai_settings[openai_setting_names[n]])
            .map(n => `<option value="${n}">${n}</option>`).join('');
}

// ══════════════════════════════════════════
// E. Build drawers
// ══════════════════════════════════════════

function buildMoverDrawer() {
    const presets = getPresetOptions();
    const el = document.createElement('div');
    el.id = 'ptm-mover-drawer';
    el.innerHTML = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>토글 복사/이동</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="ptm-block">
                <label class="ptm-label">① 출발 프리셋</label>
                <select id="ptm-src" class="ptm-sel">${presets}</select>
            </div>
            <div class="ptm-block">
                <div class="ptm-lrow">
                    <label class="ptm-label">② 이동할 항목</label>
                    <div>
                        <button class="ptm-sm" id="ptm-all">전체</button>
                        <button class="ptm-sm" id="ptm-none">해제</button>
                        <button class="ptm-sm" id="ptm-range">연속</button>
                    </div>
                </div>
                <div id="ptm-src-list" class="ptm-list"><div class="ptm-ph">출발 프리셋을 선택하세요</div></div>
            </div>
            <div class="ptm-block">
                <label class="ptm-label">③ 도착 프리셋</label>
                <select id="ptm-dst" class="ptm-sel">${presets}</select>
            </div>
            <div class="ptm-block">
                <label class="ptm-label">④ 삽입 위치 (+ 클릭)</label>
                <div id="ptm-dst-list" class="ptm-list"><div class="ptm-ph">도착 프리셋을 선택하세요</div></div>
            </div>
            <div class="ptm-block ptm-gblock">
                <label class="ptm-grow">
                    <input type="checkbox" id="ptm-make-group">
                    <span>복사/이동 후 토글 그룹으로 묶기</span>
                </label>
                <div id="ptm-gname-row" class="ptm-hidden">
                    <input type="text" id="ptm-gname" class="ptm-tinput" style="margin-top:6px" placeholder="그룹 이름 입력...">
                </div>
            </div>
            <div id="ptm-info" class="ptm-info">항목과 위치를 선택하면 버튼이 활성화됩니다</div>
            <div class="ptm-brow">
                <button id="ptm-copy" class="ptm-btn ptm-btn-copy" disabled>복사</button>
                <button id="ptm-move" class="ptm-btn ptm-btn-move" disabled>이동</button>
            </div>
        </div>
    </div>`;
    return el;
}

function buildTGDrawer() {
    const el = document.createElement('div');
    el.id = 'ptm-tg-drawer';
    el.innerHTML = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>토글 그룹 관리</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="ptm-tg-area"><div class="ptm-ph">로딩 중...</div></div>
            <div style="display:flex;gap:6px;margin-top:0;align-items:center">
                <button class="ptm-sm ptm-sm-full" id="ptm-add-group" style="flex:1;margin:0">+ 그룹 추가</button>
                <button class="ptm-sm" id="ptm-reorder-btn" style="margin:0;padding:3px 10px;min-width:36px;text-align:center" title="그룹 순서 변경">⠿</button>
            </div>
        </div>
    </div>`;
    return el;
}

// ══════════════════════════════════════════
// F. Render mover
// ══════════════════════════════════════════

function renderSrcList() {
    if (sourcePresetName) sourceOrderedPrompts = getOrderedPrompts(getLivePresetData(sourcePresetName));
    const el = document.getElementById('ptm-src-list'); if (!el) return;
    if (!sourceOrderedPrompts.length) { el.innerHTML = '<div class="ptm-ph">프롬프트 없음</div>'; return; }
    el.innerHTML = sourceOrderedPrompts.map((e, i) => {
        // Bug fix: use ?? for name
        const name = e.prompt.name ?? '', chk = selectedSourceIndices.has(i);
        return `<label class="ptm-item${!e.enabled ? ' ptm-item-off' : ''}${chk ? ' ptm-chked' : ''}">
            <input type="checkbox" class="ptm-chk" data-i="${i}"${chk ? ' checked' : ''}><span class="ptm-num">#${i + 1}</span>
            <span class="ptm-name">${e.prompt.marker ? '[고정] ' : ''}${name}</span></label>`;
    }).join('');
    el.querySelectorAll('.ptm-chk').forEach(cb => cb.addEventListener('change', ev => {
        const i = +ev.target.dataset.i;
        if (ev.target.checked) { selectedSourceIndices.add(i); ev.target.closest('.ptm-item').classList.add('ptm-chked'); }
        else { selectedSourceIndices.delete(i); ev.target.closest('.ptm-item').classList.remove('ptm-chked'); }
        updateButtons();
    }));
}

function renderDstList() {
    if (targetPresetName) targetOrderedPrompts = getOrderedPrompts(getLivePresetData(targetPresetName));
    const el = document.getElementById('ptm-dst-list'); if (!el) return;
    const slot = i => `<div class="ptm-slot${insertPosition === i ? ' ptm-slot-on' : ''}" data-slot="${i}">+</div>`;
    if (!targetOrderedPrompts.length) {
        el.innerHTML = slot(0);
        el.querySelector('.ptm-slot').addEventListener('click', () => selectSlot(0));
        return;
    }
    el.innerHTML = slot(0) + targetOrderedPrompts.map((e, i) => {
        // Bug fix: use ?? for name
        const name = e.prompt.name ?? '';
        return `<div class="ptm-ditem${!e.enabled ? ' ptm-item-off' : ''}"><span class="ptm-num">#${i + 1}</span>
            <span class="ptm-name">${e.prompt.marker ? '[고정] ' : ''}${name}</span></div>${slot(i + 1)}`;
    }).join('');
    el.querySelectorAll('.ptm-slot').forEach(s => s.addEventListener('click', () => selectSlot(+s.dataset.slot)));
}

function selectSlot(s) { insertPosition = s; renderDstList(); updateButtons(); }

function updateButtons() {
    const n = selectedSourceIndices.size, ok = sourcePresetName && targetPresetName && n > 0 && insertPosition >= 0;
    document.getElementById('ptm-copy').disabled = !ok;
    document.getElementById('ptm-move').disabled = !ok;
    const info = document.getElementById('ptm-info'); if (!info) return;
    if (!sourcePresetName) info.textContent = '출발 프리셋을 선택하세요';
    else if (!n) info.textContent = '이동할 항목을 체크하세요';
    else if (!targetPresetName) info.textContent = `${n}개 선택됨 · 도착 프리셋을 선택하세요`;
    else if (insertPosition < 0) info.textContent = `${n}개 선택됨 · 삽입 위치(+)를 클릭하세요`;
    else if (sourcePresetName === targetPresetName) info.textContent = `${n}개 선택 · 같은 프리셋 내 순서 변경`;
    else info.textContent = `${n}개 선택 · 복사 또는 이동 클릭`;
}

// ══════════════════════════════════════════
// G. Perform copy/move
// ══════════════════════════════════════════

async function performOperation(isMove) {
    const n = selectedSourceIndices.size;
    if (!sourcePresetName || !targetPresetName || !n || insertPosition < 0) return;
    const makeGroup = document.getElementById('ptm-make-group')?.checked;
    const groupName = document.getElementById('ptm-gname')?.value.trim();
    if (makeGroup && !groupName) { toastr.warning('그룹 이름을 입력해주세요'); document.getElementById('ptm-gname')?.focus(); return; }

    if (isMove && sourcePresetName === targetPresetName) { await performSamePresetMove(n, makeGroup, groupName); return; }

    const srcIdx = openai_setting_names[sourcePresetName], dstIdx = openai_setting_names[targetPresetName];
    const selected = [...selectedSourceIndices].sort((a, b) => a - b).map(i => sourceOrderedPrompts[i]).filter(Boolean);
    const tp = JSON.parse(JSON.stringify(openai_settings[dstIdx]));
    tp.prompts = tp.prompts || []; tp.prompt_order = tp.prompt_order || [];
    const existingIds = new Set(tp.prompts.map(p => p.identifier)), newIds = [];
    selected.forEach((entry, offset) => {
        const pd = JSON.parse(JSON.stringify(entry.prompt));
        let id = pd.identifier;
        if (existingIds.has(id)) { let c = 1, base = id.replace(/_\d+$/, ''); while (existingIds.has(`${base}_${c}`)) c++; id = `${base}_${c}`; pd.identifier = id; pd.name = `${pd.name || entry.identifier} (${c})`; }
        existingIds.add(id); newIds.push(id); tp.prompts.push(pd);
        const go = tp.prompt_order.find(o => String(o.character_id) === String(GLOBAL_DUMMY_ID));
        if (go?.order) go.order.splice(insertPosition + offset, 0, { identifier: id, enabled: true });
        else tp.prompt_order.push({ character_id: GLOBAL_DUMMY_ID, order: [{ identifier: id, enabled: true }] });
        for (const oe of tp.prompt_order) if (String(oe.character_id) !== String(GLOBAL_DUMMY_ID) && oe.order) oe.order.push({ identifier: id, enabled: true });
    });
    try {
        await savePreset(targetPresetName, tp); openai_settings[dstIdx] = tp;
        if (isMove && sourcePresetName !== targetPresetName) {
            const sp = JSON.parse(JSON.stringify(openai_settings[srcIdx])), rem = new Set(selected.map(e => e.identifier));
            sp.prompts = sp.prompts.filter(p => !rem.has(p.identifier));
            if (sp.prompt_order) for (const o of sp.prompt_order) if (o.order) o.order = o.order.filter(e => !rem.has(e.identifier));
            await savePreset(sourcePresetName, sp); openai_settings[srcIdx] = sp;
            if (sourcePresetName === getCurrentPreset()) { oai_settings.prompts = sp.prompts; oai_settings.prompt_order = sp.prompt_order; }
        }
        if (targetPresetName === getCurrentPreset()) { oai_settings.prompts = tp.prompts; oai_settings.prompt_order = tp.prompt_order; }
        if (makeGroup && groupName) {
            const gs = getGroupsForPreset(targetPresetName); let fn = groupName, c = 1;
            while (gs.some(g => g.name === fn)) fn = `${groupName} (${c++})`;
            gs.push({ name: fn, isOn: false, toggles: newIds.map(id => ({ target: id, behavior: 'direct', override: null })) });
            saveGroups(targetPresetName, gs);
            renderTGGroups();
            toastr.success(`${n}개 ${isMove ? '이동' : '복사'} 완료 + 그룹 "${fn}" 생성!`);
        } else toastr.success(`${n}개 ${isMove ? '이동' : '복사'} 완료`);
        selectedSourceIndices.clear(); insertPosition = -1;
        const cb = document.getElementById('ptm-make-group'); if (cb) cb.checked = false;
        document.getElementById('ptm-gname-row')?.classList.add('ptm-hidden');
        const gi = document.getElementById('ptm-gname'); if (gi) gi.value = '';
        renderSrcList(); renderDstList(); updateButtons();
        try { setupChatCompletionPromptManager(oai_settings).render(); } catch(e) { console.warn('[PTM] PM refresh failed', e); }
    } catch(err) { console.error('[PTM]', err); toastr.error('실패: ' + err.message); }
}

async function performSamePresetMove(n, makeGroup, groupName) {
    const srcIdx = openai_setting_names[sourcePresetName];
    const selected = [...selectedSourceIndices].sort((a, b) => a - b).map(i => sourceOrderedPrompts[i]).filter(Boolean);
    const selectedSet = new Set(selected.map(e => e.identifier));
    const sp = JSON.parse(JSON.stringify(openai_settings[srcIdx]));

    for (const oe of (sp.prompt_order || [])) {
        if (!oe.order) continue;
        const isGlobal = String(oe.character_id) === String(GLOBAL_DUMMY_ID);
        let removedBefore = 0;
        for (let i = 0; i < insertPosition && i < oe.order.length; i++) {
            if (selectedSet.has(oe.order[i].identifier)) removedBefore++;
        }
        const filtered = oe.order.filter(e => !selectedSet.has(e.identifier));
        const adjPos = Math.max(0, Math.min(insertPosition - removedBefore, filtered.length));
        const toInsert = isGlobal
            ? selected.map(e => ({ identifier: e.identifier, enabled: e.enabled }))
            : selected.map(e => ({ identifier: e.identifier, enabled: true }));
        filtered.splice(adjPos, 0, ...toInsert);
        oe.order = filtered;
    }

    try {
        await savePreset(sourcePresetName, sp);
        openai_settings[srcIdx] = sp;
        if (sourcePresetName === getCurrentPreset()) { oai_settings.prompts = sp.prompts; oai_settings.prompt_order = sp.prompt_order; }
        if (makeGroup && groupName) {
            const newIds = selected.map(e => e.identifier);
            const gs = getGroupsForPreset(sourcePresetName); let fn = groupName, c = 1;
            while (gs.some(g => g.name === fn)) fn = `${groupName} (${c++})`;
            gs.push({ name: fn, isOn: false, toggles: newIds.map(id => ({ target: id, behavior: 'direct', override: null })) });
            saveGroups(sourcePresetName, gs);
            renderTGGroups();
            toastr.success(`${n}개 순서 변경 완료 + 그룹 "${fn}" 생성!`);
        } else {
            toastr.success(`${n}개 순서 변경 완료`);
        }
        sourceOrderedPrompts = getOrderedPrompts(openai_settings[srcIdx]);
        targetOrderedPrompts = getOrderedPrompts(openai_settings[srcIdx]);
        selectedSourceIndices.clear(); insertPosition = -1;
        const cb = document.getElementById('ptm-make-group'); if (cb) cb.checked = false;
        document.getElementById('ptm-gname-row')?.classList.add('ptm-hidden');
        const gi = document.getElementById('ptm-gname'); if (gi) gi.value = '';
        renderSrcList(); renderDstList(); updateButtons();
        try { setupChatCompletionPromptManager(oai_settings).render(); } catch(e) { console.warn('[PTM] PM refresh failed', e); }
    } catch(err) { console.error('[PTM]', err); toastr.error('실패: ' + err.message); }
}

// ══════════════════════════════════════════
// H. Wire mover + TG events
// ══════════════════════════════════════════

function refreshPresetSelects() {
    const opts = getPresetOptions();
    const src = document.getElementById('ptm-src');
    const dst = document.getElementById('ptm-dst');
    if (!src || !dst) return;
    const prevSrc = src.value, prevDst = dst.value;
    src.innerHTML = opts;
    dst.innerHTML = opts;
    if ([...src.options].some(o => o.value === prevSrc)) src.value = prevSrc;
    if ([...dst.options].some(o => o.value === prevDst)) dst.value = prevDst;
}

function wireMover() {
    document.querySelector('#ptm-mover-drawer .inline-drawer-toggle')?.addEventListener('click', () => {
        setTimeout(() => { refreshPresetSelects(); renderSrcList(); renderDstList(); updateButtons(); }, 0);
    });
    document.getElementById('ptm-src')?.addEventListener('change', e => {
        sourcePresetName = e.target.value; selectedSourceIndices.clear(); sourceOrderedPrompts = [];
        renderSrcList(); updateButtons();
    });
    document.getElementById('ptm-dst')?.addEventListener('change', e => {
        targetPresetName = e.target.value; insertPosition = -1; targetOrderedPrompts = [];
        renderDstList(); updateButtons();
    });
    document.getElementById('ptm-all')?.addEventListener('click', () => {
        document.querySelectorAll('#ptm-src-list .ptm-chk').forEach(cb => { cb.checked = true; selectedSourceIndices.add(+cb.dataset.i); cb.closest('.ptm-item').classList.add('ptm-chked'); }); updateButtons();
    });
    document.getElementById('ptm-none')?.addEventListener('click', () => {
        document.querySelectorAll('#ptm-src-list .ptm-chk').forEach(cb => { cb.checked = false; cb.closest('.ptm-item').classList.remove('ptm-chked'); }); selectedSourceIndices.clear(); updateButtons();
    });
    document.getElementById('ptm-range')?.addEventListener('click', () => {
        if (selectedSourceIndices.size < 2) { toastr.warning('시작과 끝 항목 2개를 선택하세요'); return; }
        const s = [...selectedSourceIndices].sort((a, b) => a - b), mn = s[0], mx = s[s.length - 1];
        for (let i = mn; i <= mx; i++) selectedSourceIndices.add(i);
        document.querySelectorAll('#ptm-src-list .ptm-chk').forEach(cb => { const i = +cb.dataset.i; if (i >= mn && i <= mx) { cb.checked = true; cb.closest('.ptm-item').classList.add('ptm-chked'); } }); updateButtons();
    });
    document.getElementById('ptm-make-group')?.addEventListener('change', e => {
        document.getElementById('ptm-gname-row')?.classList[e.target.checked ? 'remove' : 'add']('ptm-hidden');
        if (e.target.checked) document.getElementById('ptm-gname')?.focus();
    });
    document.getElementById('ptm-copy')?.addEventListener('click', () => performOperation(false));
    document.getElementById('ptm-move')?.addEventListener('click', () => performOperation(true));
}

function wireTG() {
    document.querySelector('#ptm-tg-drawer .inline-drawer-toggle')?.addEventListener('click', () => {
        setTimeout(renderTGGroups, 0);
    });
    document.getElementById('ptm-add-group')?.addEventListener('click', async () => {
        const pn = getCurrentPreset(); if (!pn) { toastr.warning('프리셋을 먼저 선택하세요'); return; }
        const name = await callGenericPopup('새 그룹 이름:', POPUP_TYPE.INPUT, '');
        if (!name?.trim()) return;
        const gs = getGroupsForPreset(pn); if (gs.some(g => g.name === name.trim())) { toastr.warning('같은 이름이 이미 있습니다'); return; }
        gs.push({ name: name.trim(), isOn: false, showInPopup: false, toggles: [] }); saveGroups(pn, gs); renderTGGroups();
    });
    document.getElementById('ptm-reorder-btn')?.addEventListener('click', () => {
        groupReorderMode = !groupReorderMode;
        if (groupReorderMode) toggleReorderMode = null;
        const btn = document.getElementById('ptm-reorder-btn');
        if (btn) { btn.textContent = groupReorderMode ? '✓' : '⠿'; btn.style.color = groupReorderMode ? '#6ddb9e' : ''; }
        renderTGGroups();
    });
    wireTGReorder();
}

function wireTGReorder() {
    const area = document.getElementById('ptm-tg-area');
    if (!area) return;

    // Pointer-event based drag (no HTML5 drag API: no delay, no screen-dim)
    area.addEventListener('pointerdown', e => {
        if (toggleReorderMode === null) return;
        const handle = e.target.closest('.ptm-drag-handle');
        if (!handle) return;
        const gi = +handle.dataset.gi, ti = +handle.dataset.ti;
        if (gi !== toggleReorderMode) return;

        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        dragState = { gi, ti, pointerId: e.pointerId };

        const srcRow = area.querySelector(`.ptm-trow[data-gi="${gi}"][data-ti="${ti}"]`);
        if (srcRow) srcRow.classList.add('ptm-dragging');
    });

    area.addEventListener('pointermove', e => {
        if (!dragState) return;
        e.preventDefault();
        // Clear previous highlight
        area.querySelectorAll('.ptm-drag-over').forEach(el => el.classList.remove('ptm-drag-over'));
        // Find row under pointer (temporarily hide dragging row to hit-test correctly)
        const srcRow = area.querySelector(`.ptm-trow[data-gi="${dragState.gi}"][data-ti="${dragState.ti}"]`);
        if (srcRow) srcRow.style.pointerEvents = 'none';
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (srcRow) srcRow.style.pointerEvents = '';
        const row = target?.closest('.ptm-trow');
        if (row && +row.dataset.gi === dragState.gi && +row.dataset.ti !== dragState.ti) {
            row.classList.add('ptm-drag-over');
        }
    });

    area.addEventListener('pointerup', e => {
        if (!dragState) return;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const row = target?.closest('.ptm-trow');
        if (row && +row.dataset.gi === dragState.gi && +row.dataset.ti !== dragState.ti) {
            const pn = getCurrentPreset(), gs = getGroupsForPreset(pn);
            const toggles = gs[dragState.gi].toggles;
            const [moved] = toggles.splice(dragState.ti, 1);
            toggles.splice(+row.dataset.ti, 0, moved);
            saveGroups(pn, gs);
        }
        // Clean up
        area.querySelectorAll('.ptm-drag-over, .ptm-dragging').forEach(el => {
            el.classList.remove('ptm-drag-over', 'ptm-dragging');
        });
        dragState = null;
        renderTGGroups();
    });

    area.addEventListener('pointercancel', () => {
        area.querySelectorAll('.ptm-drag-over, .ptm-dragging').forEach(el => {
            el.classList.remove('ptm-drag-over', 'ptm-dragging');
        });
        dragState = null;
    });
}

// ══════════════════════════════════════════
// J. PPC — Popup (two-tone, no hard border)
// ══════════════════════════════════════════

let ppcIsOpen         = false;
let ppcGroupsExpanded = false;
let ppcBtn            = null;

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getCurrentPresetName() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getPresetManager === 'function') {
            const pm = ctx.getPresetManager();
            if (typeof pm?.getSelectedPresetName === 'function') {
                const name = pm.getSelectedPresetName();
                if (name) return name;
            }
        }
    } catch {}
    for (const sel of ['#settings_preset', '#preset_name_select', 'select[name="preset_name"]']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = el.options[el.selectedIndex]?.text?.trim();
        if (txt && txt !== '—') return txt;
    }
    return '—';
}

async function getCurrentProfileName() {
    try {
        const ctx = SillyTavern.getContext();
        const execFn = ctx.executeSlashCommandsWithOptions
                    ?? window.executeSlashCommandsWithOptions
                    ?? ctx.executeSlashCommands
                    ?? window.executeSlashCommands;
        if (typeof execFn === 'function') {
            const result = await execFn('/profile', { showOutput: false, handleReturn: false });
            const name = (typeof result === 'string' ? result : result?.pipe)?.trim();
            if (name && name !== 'null') return name;
        }
    } catch {}
    const el = document.querySelector('#connection-profile-select');
    if (el) {
        const txt = el.options[el.selectedIndex]?.text?.trim();
        if (txt && txt !== '—') return txt;
    }
    return '—';
}

// Create or reuse the main popup element (two-tone: upper / lower div)
function getOrCreatePpcPopup() {
    let popup = document.getElementById('ppc-popup');
    if (popup) return popup;
    popup = document.createElement('div');
    popup.id = 'ppc-popup';
    popup.style.cssText = `
        display:none;
        position:fixed;
        z-index:2147483647;
        border:1px solid #d6cfc3;
        border-radius:8px;
        font-size:14px;
        line-height:1.6;
        color:#2a2a2a;
        box-shadow:0 4px 16px rgba(0,0,0,0.18);
        overflow:hidden;
        min-width:200px;
    `;
    popup.innerHTML = `
        <div id="ppc-upper" style="background:#f5f0e8;padding:10px 15px;white-space:nowrap;"></div>
        <div id="ppc-lower" style="background:#e8e2d8;padding:8px 14px;"></div>
    `;
    document.body.appendChild(popup);
    return popup;
}

function positionPpcPopup(popup, btn) {
    const rect   = btn.getBoundingClientRect();
    const popupW = popup.offsetWidth  || 220;
    const popupH = popup.offsetHeight || 80;
    let left = rect.left + rect.width / 2 - popupW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8));
    let top = rect.top - popupH - 8;
    if (top < 8) top = rect.bottom + 8;
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
}

async function openPpcPopup() {
    const popup = getOrCreatePpcPopup();
    // Upper: profile + preset (static until refreshed)
    const preset  = escapeHtml(getCurrentPresetName());
    const profile = escapeHtml(await getCurrentProfileName());
    popup.querySelector('#ppc-upper').innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
            <span>🤖</span><span style="font-weight:500">${profile}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
            <span>📋</span><span style="font-weight:500">${preset}</span>
        </div>`;
    // Lower: groups section
    renderPpcLower();
    popup.style.display = 'block';
    ppcIsOpen = true;
    requestAnimationFrame(() => positionPpcPopup(popup, ppcBtn));
}

function closePpcPopup() {
    const popup = document.getElementById('ppc-popup');
    if (popup) popup.style.display = 'none';
    closePpcSub();
    ppcIsOpen = false;
}

// Call this whenever PTM group state changes while popup is open
function refreshPpcPopup() {
    if (!ppcIsOpen) return;
    renderPpcLower();
    const popup = document.getElementById('ppc-popup');
    if (popup && ppcBtn) requestAnimationFrame(() => positionPpcPopup(popup, ppcBtn));
}

function renderPpcLower() {
    const lower = document.getElementById('ppc-lower');
    if (!lower) return;

    const pn      = getCurrentPreset();
    const allGs   = pn ? getGroupsForPreset(pn) : [];
    const visible = allGs.reduce((acc, g, gi) => { if (g.showInPopup) acc.push({ g, gi }); return acc; }, []);
    const arrow   = ppcGroupsExpanded ? '▾' : '▸';

    let rowsHtml = '';
    if (ppcGroupsExpanded) {
        if (!visible.length) {
            rowsHtml = `<div style="font-size:12px;opacity:0.55;padding:3px 0 1px;">표시할 그룹 없음</div>`;
        } else {
            rowsHtml = visible.map(({ g, gi }) => {
                const bg  = g.isOn ? '#6ddb9e' : '#555';
                const clr = g.isOn ? '#1a1a1a' : '#ccc';
                return `
                <div style="display:flex;align-items:center;gap:7px;padding:3px 0;">
                    <button class="ppc-grp-toggle" data-gi="${gi}"
                        style="flex-shrink:0;border:none;border-radius:4px;padding:1px 9px;font-size:12px;font-weight:600;cursor:pointer;background:${bg};color:${clr};">
                        ${g.isOn ? 'On' : 'Off'}
                    </button>
                    <span class="ppc-grp-name" data-gi="${gi}"
                        style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;cursor:pointer;"
                        title="${escapeHtml(g.name)}">
                        ${escapeHtml(g.name)}
                    </span>
                </div>`;
            }).join('');
        }
    }

    lower.innerHTML = `
        <div id="ppc-grp-head" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;opacity:0.7;">
            <span>그룹</span><span>${arrow}</span>
        </div>
        ${ppcGroupsExpanded ? `<div style="margin-top:4px;">${rowsHtml}</div>` : ''}`;

    // Wire header toggle
    lower.querySelector('#ppc-grp-head').addEventListener('click', e => {
        e.stopPropagation(); // prevent document click from closing the popup
        ppcGroupsExpanded = !ppcGroupsExpanded;
        renderPpcLower();
        const popup = document.getElementById('ppc-popup');
        if (popup && ppcBtn) requestAnimationFrame(() => positionPpcPopup(popup, ppcBtn));
    });

    // Wire On/Off buttons
    lower.querySelectorAll('.ppc-grp-toggle').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const gi = +btn.dataset.gi, pn2 = getCurrentPreset(), gs = getGroupsForPreset(pn2);
            gs[gi].isOn = !gs[gi].isOn;
            applyGroup(pn2, gi);
            saveGroups(pn2, gs);
            renderPpcLower();
            renderTGGroups();
            const popup = document.getElementById('ppc-popup');
            if (popup && ppcBtn) requestAnimationFrame(() => positionPpcPopup(popup, ppcBtn));
        });
    });

    // Wire group name → sub-popup
    lower.querySelectorAll('.ppc-grp-name').forEach(span => {
        span.addEventListener('click', e => {
            e.stopPropagation();
            openPpcSub(+span.dataset.gi);
        });
    });
}

// ══════════════════════════════════════════
// K. PPC — Sub-popup (group detail)
// ══════════════════════════════════════════

function getOrCreatePpcSub() {
    let sub = document.getElementById('ppc-sub');
    if (sub) return sub;
    sub = document.createElement('div');
    sub.id = 'ppc-sub';
    sub.style.cssText = `
        display:none;
        position:fixed;
        z-index:2147483648;
        background:#f5f0e8;
        border:1px solid #d6cfc3;
        border-radius:8px;
        font-size:13px;
        color:#2a2a2a;
        box-shadow:0 4px 20px rgba(0,0,0,0.2);
        min-width:240px;
        max-width:320px;
        max-height:70vh;
        overflow-y:auto;
    `;
    document.body.appendChild(sub);
    return sub;
}

function positionPpcSub(sub) {
    const popup = document.getElementById('ppc-popup');
    const vw = window.innerWidth, vh = window.innerHeight;
    const subW = sub.offsetWidth  || 280;
    const subH = sub.offsetHeight || 200;
    // Center horizontally
    const left = Math.max(8, Math.min((vw - subW) / 2, vw - subW - 8));
    // Above main popup if space, else below, else center vertically
    let top;
    if (popup) {
        const pr = popup.getBoundingClientRect();
        top = pr.top - subH - 10;
        if (top < 8) top = pr.bottom + 10;
        if (top + subH > vh - 8) top = Math.max(8, (vh - subH) / 2);
    } else {
        top = Math.max(8, (vh - subH) / 2);
    }
    sub.style.left = left + 'px';
    sub.style.top  = top  + 'px';
}

function openPpcSub(gi) {
    const sub = getOrCreatePpcSub();
    sub.innerHTML = buildPpcSubHtml(gi);
    sub.style.display = 'block';
    requestAnimationFrame(() => { positionPpcSub(sub); wirePpcSub(sub, gi); });
}

function closePpcSub() {
    const sub = document.getElementById('ppc-sub');
    if (sub) sub.style.display = 'none';
}

function buildPpcSubHtml(gi) {
    const pn = getCurrentPreset(), gs = getGroupsForPreset(pn), g = gs[gi];
    if (!g) return '<div style="padding:12px;opacity:0.6;">그룹을 찾을 수 없습니다</div>';

    let allPrompts;
    try {
        allPrompts = setupChatCompletionPromptManager(oai_settings).serviceSettings?.prompts || [];
    } catch(e) {
        const preset = getLivePresetData(pn) || openai_settings[openai_setting_names[pn]];
        allPrompts = preset?.prompts || [];
    }

    const grpBg  = g.isOn ? '#6ddb9e' : '#555';
    const grpClr = g.isOn ? '#1a1a1a' : '#ccc';

    const rows = g.toggles.map((t, ti) => {
        const name     = allPrompts.find(p => p.identifier === t.target)?.name ?? '';
        const isDirect = t.behavior === 'direct';
        const ovr      = t.override ?? null;
        const effectOn = ovr !== null ? ovr : (isDirect ? g.isOn : !g.isOn);

        let ovrBg, ovrClr, ovrLabel;
        if (ovr === null)      { ovrLabel = '고정'; ovrBg = '#999';    ovrClr = '#eee'; }
        else if (ovr === true) { ovrLabel = 'On';  ovrBg = '#6ddb9e'; ovrClr = '#1a1a1a'; }
        else                   { ovrLabel = 'Off'; ovrBg = '#e07070'; ovrClr = '#fff'; }

        const bBg = isDirect ? '#7a7ae0' : '#c07830';

        return `
        <div style="display:flex;align-items:center;gap:5px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.08);">
            <span style="font-size:11px;min-width:24px;text-align:center;color:${effectOn ? '#4a9e6e' : '#aaa'};">${effectOn ? 'On' : 'Off'}</span>
            <button class="ppc-sub-ovr" data-ti="${ti}"
                style="border:none;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;flex-shrink:0;width:38px;text-align:center;background:${ovrBg};color:${ovrClr};">
                ${ovrLabel}
            </button>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <button class="ppc-sub-bsel" data-ti="${ti}"
                style="border:none;border-radius:3px;padding:2px 7px;font-size:11px;cursor:pointer;flex-shrink:0;background:${bBg};color:#eee;">
                ${isDirect ? '동일' : '반전'}
            </button>
            <button class="ppc-sub-del" data-ti="${ti}"
                style="border:none;background:transparent;color:#c06060;cursor:pointer;font-size:14px;padding:0 3px;flex-shrink:0;line-height:1;">
                ✕
            </button>
        </div>`;
    }).join('');

    return `
    <div style="padding:12px 14px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <button class="ppc-sub-grp-toggle"
                style="border:none;border-radius:5px;padding:3px 12px;cursor:pointer;font-size:13px;font-weight:600;flex-shrink:0;background:${grpBg};color:${grpClr};">
                ${g.isOn ? 'On' : 'Off'}
            </button>
            <strong style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(g.name)}</strong>
            <button class="ppc-sub-close"
                style="border:none;background:transparent;color:#999;cursor:pointer;font-size:17px;padding:0 2px;flex-shrink:0;line-height:1;">✕</button>
        </div>
        <div class="ppc-sub-rows">
            ${rows || '<div style="opacity:0.5;font-size:12px;padding:4px 0;">토글 없음</div>'}
        </div>
        <button class="ppc-sub-add"
            style="margin-top:10px;width:100%;border:1px dashed #b0a898;background:transparent;border-radius:5px;padding:6px;cursor:pointer;color:#5a5450;font-size:12px;">
            + 토글 추가
        </button>
    </div>`;
}

function wirePpcSub(sub, gi) {
    const pn = getCurrentPreset();

    sub.querySelector('.ppc-sub-close')?.addEventListener('click', e => {
        e.stopPropagation(); closePpcSub();
    });

    sub.querySelector('.ppc-sub-grp-toggle')?.addEventListener('click', e => {
        e.stopPropagation();
        const gs = getGroupsForPreset(pn);
        gs[gi].isOn = !gs[gi].isOn;
        applyGroup(pn, gi); saveGroups(pn, gs);
        // Re-render sub
        sub.innerHTML = buildPpcSubHtml(gi);
        wirePpcSub(sub, gi);
        renderPpcLower();
        renderTGGroups();
    });

    sub.querySelectorAll('.ppc-sub-ovr').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const ti = +btn.dataset.ti, gs = getGroupsForPreset(pn);
        const cur = gs[gi].toggles[ti].override ?? null;
        gs[gi].toggles[ti].override = cur === null ? true : cur === true ? false : null;
        applyGroup(pn, gi); saveGroups(pn, gs);
        sub.innerHTML = buildPpcSubHtml(gi);
        wirePpcSub(sub, gi);
        renderTGGroups();
    }));

    sub.querySelectorAll('.ppc-sub-bsel').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const ti = +btn.dataset.ti, gs = getGroupsForPreset(pn);
        gs[gi].toggles[ti].behavior = gs[gi].toggles[ti].behavior === 'direct' ? 'invert' : 'direct';
        saveGroups(pn, gs);
        sub.innerHTML = buildPpcSubHtml(gi);
        wirePpcSub(sub, gi);
        renderTGGroups();
    }));

    sub.querySelectorAll('.ppc-sub-del').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const ti = +btn.dataset.ti, gs = getGroupsForPreset(pn);
        gs[gi].toggles.splice(ti, 1);
        saveGroups(pn, gs);
        sub.innerHTML = buildPpcSubHtml(gi);
        wirePpcSub(sub, gi);
        renderPpcLower();
        renderTGGroups();
    }));

    sub.querySelector('.ppc-sub-add')?.addEventListener('click', async e => {
        e.stopPropagation();
        await showAddToggleModal(gi);
        // showAddToggleModal calls renderTGGroups & saveGroups internally
        sub.innerHTML = buildPpcSubHtml(gi);
        wirePpcSub(sub, gi);
        renderPpcLower();
        const popup = document.getElementById('ppc-popup');
        if (popup && ppcBtn) requestAnimationFrame(() => positionPpcPopup(popup, ppcBtn));
    });
}

// ══════════════════════════════════════════
// L. PPC — Button injection & events
// ══════════════════════════════════════════

function injectPpcButton() {
    if (document.getElementById('ppc-btn')) return;
    getOrCreatePpcPopup(); // ensure DOM element exists
    getOrCreatePpcSub();

    const btn = document.createElement('div');
    btn.id = 'ppc-btn';
    btn.title = 'Preset & Profile';
    btn.classList.add('interactable');
    btn.setAttribute('tabindex', '0');
    btn.textContent = '🔌';
    Object.assign(btn.style, {
        fontSize: '1rem', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    ppcBtn = btn;

    // Re-position on viewport resize (e.g. mobile keyboard)
    (window.visualViewport ?? window).addEventListener('resize', () => {
        if (!ppcIsOpen) return;
        const popup = document.getElementById('ppc-popup');
        if (popup) requestAnimationFrame(() => positionPpcPopup(popup, ppcBtn));
    });

    btn.addEventListener('click', e => {
        e.stopPropagation();
        ppcIsOpen ? closePpcPopup() : openPpcPopup();
    });

    // Close on outside click
    document.addEventListener('click', e => {
        if (!ppcIsOpen) return;
        const popup = document.getElementById('ppc-popup');
        const sub   = document.getElementById('ppc-sub');
        if (!btn.contains(e.target) && !popup?.contains(e.target) && !sub?.contains(e.target)) {
            closePpcPopup();
        }
    });

    // Insert after wand / options button
    const wandSelectors = ['#options_button', '#extensionsMenuButton', '#extensionOptionsButton', '.fa-wand-magic-sparkles', '.fa-magic'];
    let inserted = false;
    for (const sel of wandSelectors) {
        let target = document.querySelector(sel);
        if (!target) continue;
        if (sel.startsWith('.fa-')) target = target.closest('.interactable, [tabindex]') || target.parentElement;
        if (target?.parentElement) { target.parentElement.insertBefore(btn, target.nextSibling); inserted = true; break; }
    }
    if (!inserted) {
        for (const sel of ['#leftSendForm', '#send_form > div.flex-container', '#send_form']) {
            const el = document.querySelector(sel);
            if (el) { el.appendChild(btn); inserted = true; break; }
        }
    }
    if (!inserted) {
        const sendBtn = document.getElementById('send_but');
        if (sendBtn?.parentElement) sendBtn.parentElement.insertBefore(btn, sendBtn);
    }
}

function setupPpcEvents() {
    const UPDATE_EVENTS = [
        'preset_changed', 'mainApiChanged',
        'connection_profile_loaded', event_types.CHAT_CHANGED,
    ];
    for (const evt of UPDATE_EVENTS) {
        eventSource.on(evt, async () => {
            if (!ppcIsOpen) return;
            const popup = document.getElementById('ppc-popup');
            if (!popup) return;
            // Refresh upper section
            const preset  = escapeHtml(getCurrentPresetName());
            const profile = escapeHtml(await getCurrentProfileName());
            const upper = popup.querySelector('#ppc-upper');
            if (upper) upper.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;">
                    <span>🤖</span><span style="font-weight:500">${profile}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
                    <span>📋</span><span style="font-weight:500">${preset}</span>
                </div>`;
            renderPpcLower();
            if (ppcBtn) requestAnimationFrame(() => positionPpcPopup(popup, ppcBtn));
        });
    }
}


// ══════════════════════════════════════════
// Migration — PTM → QPM 자동 데이터 이전
// ══════════════════════════════════════════

function migrateFromLegacy() {
    // 구버전 확장의 저장 키 목록 (현재 키는 자동 제외)
    const LEGACY_KEYS = ['prompt-toggle-manager', 'prompt-deck'].filter(k => k !== TG_KEY);

    for (const oldKey of LEGACY_KEYS) {
        const old = extension_settings[oldKey];
        if (!old?.presets) continue;

        const cur = getTGStore();
        let migrated = 0;

        for (const [presetName, groups] of Object.entries(old.presets)) {
            if (!Array.isArray(groups) || !groups.length) continue;

            if (!cur.presets[presetName]) {
                // 해당 프리셋 데이터가 없으면 그대로 복사
                cur.presets[presetName] = JSON.parse(JSON.stringify(groups));
                migrated += groups.length;
            } else {
                // 이미 데이터 있으면 이름 중복 없는 그룹만 추가
                const existingNames = new Set(cur.presets[presetName].map(g => g.name));
                const toAdd = groups.filter(g => !existingNames.has(g.name));
                cur.presets[presetName].push(...JSON.parse(JSON.stringify(toAdd)));
                migrated += toAdd.length;
            }
        }

        if (migrated > 0) {
            saveSettingsDebounced();
            console.log(`[${extensionName}] '${oldKey}' 에서 그룹 ${migrated}개 마이그레이션 완료`);
            toastr.success(
                `기존 확장(${oldKey})에서 그룹 ${migrated}개를 자동으로 가져왔습니다.`,
                '📋 데이터 마이그레이션 완료'
            );
        }
    }
}

// ══════════════════════════════════════════
// I. Mount & Init
// ══════════════════════════════════════════

function mount() {
    if (document.getElementById('ptm-mover-drawer')) return true;
    const target = document.querySelector('.range-block.m-b-1');
    if (!target) return false;
    const tg = buildTGDrawer(), mover = buildMoverDrawer();
    target.before(tg); tg.before(mover);
    wireMover(); wireTG(); renderTGGroups();
    return true;
}

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);
    try {
        await initImports();
        migrateFromLegacy();
        let c = 0;
        const t = setInterval(() => { if (mount() || ++c > 50) clearInterval(t); }, 200);
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => renderTGGroups());
        eventSource.on(event_types.APP_READY, () => injectPpcButton());
        setupPpcEvents();
        console.log(`[${extensionName}] Loaded`);
    } catch(err) { console.error(`[${extensionName}] Failed:`, err); }
});
