// 无构建客户端模块：复用宿主 React、草稿编辑器、会话分支及侧栏。
window.__ModuleLoader__.load({ id: '@local/dsh-selection-chat', factory: require => {
  const React = require('react');
  const { createElement: h, useState, useRef, useEffect } = React;
  const ID = '@local/dsh-selection-chat', SLOT = 'selection-chat.conversation';
  const PREFIX = 'dsh-resource://selectionchat/session/';
  const TEMP_PREFIX = 'selectionchat-temp-';
  async function temporaryApi(operation, input) {
    const transport = globalThis.__DSH_TRANSPORT__;
    const send = transport?.fetch ? transport.fetch.bind(transport) : globalThis.fetch.bind(globalThis);
    const response = await send('/api/selection-chat/' + operation, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '侧边聊天操作失败。');
    return result;
  }
  // 只从左侧目录的可见 ID 序列排除临时会话；保留 byId，供原生文件路径、模型与权限解析。
  function hideTemporarySessions(source) {
    const original = source.getSnapshot, cache = new WeakMap();
    const read = () => {
      const snapshot = original.call(source);
      if (!cache.has(snapshot)) cache.set(snapshot, { ...snapshot, ids: snapshot.ids.filter(id => !id.startsWith(TEMP_PREFIX)) });
      return cache.get(snapshot);
    };
    source.getSnapshot = read;
    return () => { if (source.getSnapshot === read) source.getSnapshot = original; };
  }
  function inheritedHistoryCss(id, turns) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return '';
    // Turn 是宿主整数身份，只生成有边界的选择器，不把选中文本写进 CSS。
    const selectors = [...new Set(turns)].filter(n => Number.isSafeInteger(n) && n >= 0)
      .map(n => `[data-selection-chat-session="${id}"] [data-chat-turn="${n}"]`);
    if (!selectors.length) return '';
    selectors.push(`[data-selection-chat-session="${id}"] nav[aria-label="轮次导航"]`, `[data-selection-chat-session="${id}"] nav[aria-label="Turn navigation"]`);
    return selectors.join(',') + '{display:none!important}';
  }

  function resourceAddress(id) { return PREFIX + encodeURIComponent(id); }
  function parseAddress(address) {
    try {
      const url = new URL(address), parts = url.pathname.split('/');
      if (url.protocol !== 'dsh-resource:' || url.hostname !== 'selectionchat' || url.search || url.hash || parts.length !== 3 || parts[1] !== 'session') return;
      const id = decodeURIComponent(parts[2]);
      if (!id || /[\s/\\\x00-\x1f]/.test(id)) return;
      return id;
    } catch { return; }
  }
  // 引用的编辑、预览、撤销和发送都交给 DSH；本插件不再包装发送方法。
  function insertNativeQuote(actions, text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    return actions.insertQuote(text);
  }
  function canQuote(session) {
    return !session.removed && (session.subagent === null || session.subagent?.address.mode === 'continuable');
  }
  function hasUnsentDraft(shell) {
    const draft = shell?.draftSnapshot;
    return !!(shell?.draftInitializationBlocked?.() || draft?.text?.trim() || draft?.quotes?.length || draft?.references?.length || shell?.attachmentIds?.length);
  }
  // 只缓存尚未交给原生编辑器的侧栏引用。旧版卡片由用户显式恢复，避免误重发。
  function createPendingQuotes(storage) {
    const key = 'dsh-selection-chat.native-pending.v1', rows = new Map(), listeners = new Set();
    try {
      for (const [id, entries] of JSON.parse(storage?.getItem(key) || '[]')) rows.set(id, entries);
      for (const [id, entries] of JSON.parse(storage?.getItem('dsh-selection-chat.cards.v2') || '[]')) {
        const current = rows.get(id) || [];
        for (const entry of entries) if (!current.some(c => c.text === entry.text)) current.push({ text: entry.text, legacy: true, uncertain: entry.state !== 'ready' });
        if (current.length) rows.set(id, current);
      }
      for (const [id, text] of JSON.parse(storage?.getItem('dsh-selection-chat.pending.v1') || '[]')) {
        const current = rows.get(id) || [];
        if (!current.some(c => c.text === text)) current.push({ text, legacy: true });
        rows.set(id, current);
      }
      // 迁移成功落盘后才移除旧缓存；无存储权限时仍能在当前窗口使用。
      storage?.setItem(key, JSON.stringify([...rows]));
      storage?.removeItem('dsh-selection-chat.cards.v2'); storage?.removeItem('dsh-selection-chat.pending.v1');
    } catch { /* 存储受限时继续使用当前窗口内存。 */ }
    const publish = () => {
      try { storage?.setItem(key, JSON.stringify([...rows])); } catch {}
      for (const listener of listeners) listener();
    };
    return {
      list: id => rows.get(id) || [],
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      add(id, text) { if (!text?.trim()) return; const current = rows.get(id) || []; rows.set(id, [...current, { text }]); publish(); },
      clear(id) { rows.delete(id); publish(); },
      deliver(id, actions, legacy = false) {
        let changed = false;
        // 逐条接纳，宿主暂时拒绝时留下原条目，待编辑器就绪后再处理。
        const remaining = [];
        for (const entry of rows.get(id) || []) {
          if (!!entry.legacy === legacy && insertNativeQuote(actions, entry.text)) changed = true;
          else remaining.push(entry);
        }
        if (remaining.length) rows.set(id, remaining); else rows.delete(id);
        if (changed) publish();
        return !remaining.some(entry => !!entry.legacy === legacy);
      }
    };
  }
  function Icon({ kind = 'chat' }) {
    const paths = { chat: 'M4 4h16v12H9l-5 4V4Z M8 8h8 M8 12h5', save: 'M12 3v12 M8 11l4 4 4-4 M5 16v4h14v-4', check: 'm5 12 4 4L19 6' };
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[kind] }));
  }
  const CSS = `
    .dsh-sc-actions{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:999px;background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);font:var(--dsw-font-xs-13)}
    .dsh-sc-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;border-radius:6px;padding:5px 8px;white-space:nowrap}
    .dsh-sc-actions .dsh-sc-button{border-radius:999px;padding:5px 10px}
    .dsh-sc-button:hover,.dsh-sc-button:focus-visible{background:var(--dsw-alias-button-floating-hover)}
    .dsh-sc-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
    .dsh-sc-button:disabled{opacity:.45;cursor:default}
    .dsh-sc-separator{width:1px;height:14px;background:var(--dsw-alias-border-l3)}
    .dsh-sc-panel{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
    .dsh-sc-header{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l3);font:var(--dsw-font-xs-13)}
    .dsh-sc-title{font-weight:500}.dsh-sc-state{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-sc-save{margin-left:auto}
    .dsh-sc-content,.dsh-sc-panel [data-slot="selection-chat.conversation"]{display:flex;flex-direction:column;flex:1;min-height:0}
    .dsh-sc-notice,.dsh-sc-recover{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 10px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);overflow-wrap:anywhere}
    .dsh-sc-notice [role="alert"]{flex:1;min-width:120px;color:var(--dsw-alias-state-error-primary)}
    .dsh-sc-loading{display:flex;align-items:center;justify-content:center;flex:1;gap:8px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
    .dsh-sc-spinner{display:inline-block;width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dsh-sc-spin .8s linear infinite}
    @keyframes dsh-sc-spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.dsh-sc-spinner{animation:none}}
  `;

  function resourceProvider(sessions, metadata = async () => undefined) {
    return { protocol: 'selectionchat', async *open(address, { signal }) {
      const id = parseAddress(address);
      if (!id) throw Error('无效的侧边聊天地址。');
      if (signal.aborted) return;
      const meta = await metadata(id);
      if (signal.aborted) return;
      const reference = sessions.retain(id, { source: 'selectionChat', signal });
      try {
        yield { ok: true, value: { id, reference, meta } };
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      } finally { reference.release(); }
    } };
  }
  // 一次点击对应一个分支；打开侧栏失败后的重试复用已创建的会话，绝不重复派发。
  function createBranchOp(api, open, remember, mint = () => crypto.randomUUID()) {
    let task, child, requestId, remembered = false;
    return source => {
      if (task) return task;
      task = (async () => {
        if (!source.text?.trim()) throw Error('请先选中一段正文。');
        if (!child) {
          requestId ||= mint();
          child = await api('create', { sourceId: source.sessionId, requestId });
        }
        if (source.isCurrent()) {
          if (!remembered) { remember(child, source.text); remembered = true; }
          await open(resourceAddress(child.id));
        }
        else await api('close', { id: child.id });
        return child.id;
      })().finally(() => { task = undefined; });
      return task;
    };
  }

  function apply(ctx) {
    let storage;
    try { storage = sessionStorage; } catch {}
    const quotes = createPendingQuotes(storage), metadata = new Map(), listeners = new Set();
    const cleanupQueue = new Set(), cleanupErrors = new Map(), closing = new Set(), timers = new Set();
    let disposed = false;
    try {
      for (const [id, value] of JSON.parse(storage?.getItem('dsh-selection-chat.sessions.v1') || '[]')) metadata.set(id, value);
      for (const id of JSON.parse(storage?.getItem('dsh-selection-chat.cleanup.v1') || '[]')) if (id.startsWith(TEMP_PREFIX)) cleanupQueue.add(id);
    } catch {}
    const publish = () => {
      try { storage?.setItem('dsh-selection-chat.sessions.v1', JSON.stringify([...metadata])); } catch {}
      for (const fn of listeners) fn();
    };
    const saveCleanup = () => { try { storage?.setItem('dsh-selection-chat.cleanup.v1', JSON.stringify([...cleanupQueue])); } catch {} };
    const clean = async (id, attempt = 0) => {
      if (disposed || closing.has(id)) return;
      closing.add(id);
      try {
        await temporaryApi('close', { id });
        cleanupQueue.delete(id); cleanupErrors.delete(id); metadata.delete(id); quotes.clear(id); saveCleanup();
      } catch (e) {
        cleanupErrors.set(id, e.message);
        if (attempt < 2 && !disposed) {
          const timer = setTimeout(() => { timers.delete(timer); void clean(id, attempt + 1); }, 1000 * (attempt + 1)); timers.add(timer);
        }
      } finally { closing.delete(id); publish(); }
    };
    const queueClose = id => {
      if (!id?.startsWith(TEMP_PREFIX)) return;
      cleanupQueue.add(id); saveCleanup(); void clean(id);
    };
    const getMetadata = async id => {
      const info = id.startsWith(TEMP_PREFIX) || !metadata.has(id) ? await temporaryApi('info', { id }) : metadata.get(id);
      if (['closed', 'closing', 'close-failed'].includes(info.state)) throw Error('此临时聊天已关闭，请重新划词打开。');
      metadata.set(id, info); publish(); return info;
    };
    const bind = (name, options, Component) => ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, Component)));
    ctx.effect(() => {
      const style = document.createElement('style'); style.dataset.plugin = ID; style.textContent = CSS; document.head.append(style);
      return () => { disposed = true; style.remove(); for (const timer of timers) clearTimeout(timer); };
    });
    ctx.effect(() => hideTemporarySessions(ctx.sessions.list));
    ctx.effect(() => ctx.sidebarRight.registerCloseHandler('selectionchat', (_owner, tab) => queueClose(parseAddress(tab.contentId))));
    ctx.effect(() => { for (const id of cleanupQueue) void clean(id); });

    function Notice({ message, retry, dismiss }) {
      return h('div', { className: 'dsh-sc-notice' }, h('span', { role: 'alert' }, message),
        retry && h('button', { type: 'button', className: 'dsh-sc-button', onClick: retry }, '重试'),
        dismiss && h('button', { type: 'button', className: 'dsh-sc-button', onClick: dismiss, 'aria-label': '关闭提示' }, '×'));
    }
    // 复用原生划词事件与定位，替换 quote 槽位的表面；卸载后宿主原按钮自动恢复。
    function SelectionActions({ sessionId, readText, clearSelection, dismiss, inputActions, useSession }) {
      const enabled = useSession(canQuote), alive = useRef(false), busyRef = useRef(false), operation = useRef(null);
      const [busy, setBusy] = useState(false), [error, setError] = useState('');
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [sessionId]);
      useEffect(() => { if (!enabled) dismiss(); }, [enabled, dismiss]);
      if (!enabled) return null;
      const quote = () => {
        const text = readText();
        if (text === null) { dismiss(); return; }
        if (insertNativeQuote(inputActions, text)) { clearSelection(); dismiss(); }
      };
      const ask = async () => {
        if (busyRef.current) return;
        if (!operation.current) {
          const text = readText(); if (text === null) { dismiss(); return; }
          operation.current = { text, run: createBranchOp(temporaryApi, address => ctx.sidebarRight.openResource(address), (info, selected) => {
            metadata.set(info.id, info); quotes.add(info.id, selected); publish();
          }) };
        }
        busyRef.current = true; setBusy(true); setError('');
        try {
          await operation.current.run({ sessionId, text: operation.current.text, isCurrent: () => alive.current && !disposed });
          if (alive.current) { clearSelection(); dismiss(); }
        } catch (e) { if (alive.current) setError(e.message); }
        finally { busyRef.current = false; if (alive.current) setBusy(false); }
      };
      return h('div', null, h('div', { className: 'dsh-sc-actions', role: 'toolbar', 'aria-label': '选中文字', onPointerDown: e => e.preventDefault() },
        h('button', { type: 'button', className: 'dsh-sc-button', disabled: busy, onClick: quote }, '引用文本'),
        h('span', { className: 'dsh-sc-separator', 'aria-hidden': true }),
        h('button', { type: 'button', className: 'dsh-sc-button', disabled: busy, onClick: ask }, busy ? h('span', { className: 'dsh-sc-spinner' }) : h(Icon), busy ? '正在打开' : '侧边提问')),
        error && h(Notice, { message: error, retry: ask }));
    }
    function PendingDock({ sessionId, inputActions, useInput }) {
      const phase = useInput(s => s.phase), [, refresh] = useState(0), [error, setError] = useState('');
      useEffect(() => {
        const fn = () => refresh(n => n + 1), off = quotes.subscribe(fn); listeners.add(fn);
        return () => { off(); listeners.delete(fn); };
      }, [sessionId]);
      const deliver = (legacy = false) => {
        if (!quotes.deliver(sessionId, inputActions, legacy)) setError('输入框暂不可添加引用，请结束当前提交后重试。');
        else setError('');
      };
      useEffect(() => { if (phase === 'plain') deliver(); }, [sessionId, phase, inputActions]);
      const legacy = quotes.list(sessionId).filter(q => q.legacy);
      return h('div', { 'data-selection-chat-dock': sessionId },
        legacy.length > 0 && h('div', { className: 'dsh-sc-recover' },
          h('span', null, legacy.some(q => q.uncertain) ? '旧版引用发送结果未确认，请先检查聊天记录。' : `有 ${legacy.length} 条旧版引用待恢复`),
          h('button', { type: 'button', className: 'dsh-sc-button', onClick: () => deliver(true) }, '恢复到输入框'),
          h('button', { type: 'button', className: 'dsh-sc-button', onClick: () => quotes.clear(sessionId) }, '丢弃')),
        error && h(Notice, { message: error, retry: () => deliver(), dismiss: () => setError('') }),
        cleanupErrors.size > 0 && h(Notice, { message: '临时聊天清理失败：' + [...cleanupErrors.values()].join('；'), retry: () => { for (const id of cleanupErrors.keys()) void clean(id); } }));
    }
    function FixedChat(props) { return props.renderSlot('conversation.session', { view: 'chat' }); }
    function Conversation({ useSession, useConversation, renderFactorySlot }) {
      const session = useSession(s => s), conversation = useConversation(s => s);
      const active = conversation.activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
      const hero = !active && session.openState === 'open';
      if (session.openError) return h(Notice, { message: '会话加载失败：' + (session.openError.message || String(session.openError)) });
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase: active ? 'active' : hero ? 'hero' : 'settling', hero }, { slots: { views: FixedChat } });
    }
    function SideTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
      const { tab } = useTabInfo(), resource = useResource(tab.contentId), panel = useRef(null);
      const [saving, setSaving] = useState(false), [error, setError] = useState('');
      const id = resource.value?.id, meta = metadata.get(id) || resource.value?.meta, temporary = !!id?.startsWith(TEMP_PREFIX);
      useEffect(() => {
        const root = panel.current, hidden = new Set(meta?.hiddenTurns || []), owned = new Set();
        if (!root || hidden.size === 0) return;
        const update = () => {
          for (const row of root.querySelectorAll('[data-chat-turn]')) {
            const raw = row.getAttribute('data-chat-turn'), hide = raw !== '' && hidden.has(Number(raw));
            if (hide && !row.hidden) { row.hidden = true; owned.add(row); }
            else if (!hide && owned.delete(row)) row.hidden = false;
          }
        };
        const observer = new MutationObserver(update);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-turn', 'hidden'] }); update();
        return () => { observer.disconnect(); for (const row of owned) row.hidden = false; };
      }, [id, meta]);
      const save = async () => {
        if (saving || !id) return;
        setSaving(true); setError('');
        try {
          const binding = ctx.sessions.binding(id);
          // 保存后切换到长期会话，先处理未发送草稿，避免留在旧临时输入框中。
          if (quotes.list(id).length || binding && hasUnsentDraft(ctx.conversation.input.for(binding.ctx))) throw Error('请先发送或清空输入框中的草稿和引用，再保存会话。');
          const info = await temporaryApi('save', { id });
          metadata.set(id, info); metadata.set(info.savedId, { ...info, id: info.savedId, state: 'saved' }); publish();
          await tab.actions.openResource(resourceAddress(info.savedId), { replaceTab: true });
        } catch (e) { setError(e.message); } finally { setSaving(false); }
      };
      return h('section', { ref: panel, className: 'dsh-sc-panel', 'aria-label': '侧边对话', 'data-selection-chat-session': id },
        h('style', null, inheritedHistoryCss(id || '', meta?.hiddenTurns || [])),
        h('header', { className: 'dsh-sc-header' }, h(Icon), h('span', { className: 'dsh-sc-title' }, '侧边对话'),
          id && h('span', { className: 'dsh-sc-state' }, temporary ? '临时' : '已保存'),
          temporary && h('button', { type: 'button', className: 'dsh-sc-button dsh-sc-save', onClick: save, disabled: saving, title: '保存到来源会话的目录' },
            saving ? h('span', { className: 'dsh-sc-spinner' }) : h(Icon, { kind: 'save' }), saving ? '正在保存' : meta?.savedId ? '打开已保存' : '保存'),
          id && !temporary && h('span', { className: 'dsh-sc-state dsh-sc-save', title: '已保存到来源目录' }, h(Icon, { kind: 'check' }))),
        error && h(Notice, { message: error, dismiss: () => setError('') }),
        resource.error && h(Notice, { message: '侧边会话加载失败：' + (resource.error.message || String(resource.error)) }),
        h('div', { className: 'dsh-sc-content' }, resource.value ? h(SessionProvider, { session: resource.value.reference }, renderSlot(SLOT, {})) : h('div', { className: 'dsh-sc-loading', role: 'status' }, h('span', { className: 'dsh-sc-spinner' }), '正在打开侧边对话')));
    }
    ctx.effect(() => ctx.resources.register(resourceProvider(ctx.sessions, getMetadata)));
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: 'selectionchat', patterns: [PREFIX + '**'], priority: 'extension', canOpen: address => !!parseAddress(address), title: () => '侧边对话' }));
    bind('sidebar.right.pane.tab', { key: ID, children: { [SLOT]: { kind: 'single', scope: 'session' } } }, SideTab);
    bind(SLOT, {}, Conversation);
    bind('conversation.input.dock', { id: ID, order: 80 }, PendingDock);
    bind('conversation.chat.text-interaction', { key: 'quote', priority: 100 }, SelectionActions);
  }
  return { apply, inject: ['slots', 'sessions', 'resources', 'conversation', 'uiSession', 'uiConversation', 'sidebarRight', 'sidebarRightTabs'],
    insertNativeQuote, canQuote, hasUnsentDraft, createPendingQuotes, parseAddress, resourceAddress, resourceProvider, createBranchOp, hideTemporarySessions, inheritedHistoryCss };
} });
