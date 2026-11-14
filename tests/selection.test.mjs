import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function load(extra = {}) {
  let plugin;
  const sandbox = { window: { __ModuleLoader__: { load: d => { plugin = d.factory(extra.moduleRequire || (() => ({}))); } } }, URL, console, ...extra };
  vm.runInNewContext(source, sandbox); return plugin;
}
const p = load();
test('原文完整交给原生引用，保留长文本，不改写已有草稿', () => {
  const text = '中文\r\n<script>文字</script>\n' + '长'.repeat(110000), calls = [];
  const actions = { insertQuote: value => { calls.push(value); return true; }, setDraft: () => assert.fail('不能覆盖草稿') };
  assert.equal(p.insertNativeQuote(actions, text), true);
  assert.equal(calls[0], text);
  assert.equal(p.insertNativeQuote(actions, ' \n'), false);
  assert.equal(p.insertNativeQuote({ insertQuote: () => false }, '引用'), false);
  assert.equal(calls.length, 1);
});
test('引用可用状态与原生普通会话和可继续子代理一致', () => {
  assert.equal(p.canQuote({ removed: false, subagent: null }), true);
  assert.equal(p.canQuote({ removed: false, subagent: { address: { mode: 'continuable' } } }), true);
  assert.equal(p.canQuote({ removed: false, subagent: { address: { mode: 'readonly' } } }), false);
  assert.equal(p.canQuote({ removed: true, subagent: null }), false);
});
test('侧栏引用在宿主接纳后移交一次，拒绝时保留以便重试', () => {
  const store = p.createPendingQuotes(), calls = [];
  store.add('a', '第一条'); store.add('a', '第二条'); store.add('b', '另一侧栏');
  const blocked = { insertQuote: () => false };
  assert.equal(store.deliver('a', blocked), false);
  const actions = { insertQuote: text => { calls.push(text); return true; } };
  assert.equal(store.deliver('a', actions), true);
  assert.equal(store.deliver('a', actions), true);
  assert.deepEqual(calls, ['第一条', '第二条']);
  assert.equal(store.list('b')[0].text, '另一侧栏');
});
test('待交接引用可恢复；旧卡片及发送不明的引用只在用户确认后恢复', () => {
  const data = new Map([['dsh-selection-chat.cards.v2', JSON.stringify([['a', [{ text: '旧引用', state: 'ready' }, { text: '可能已发出', state: 'sending' }]]])],
    ['dsh-selection-chat.pending.v1', JSON.stringify([['b', '旧侧栏引用']])]]);
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  let store = p.createPendingQuotes(storage); store.add('c', '新侧栏引用');
  store = p.createPendingQuotes(storage); const calls = [];
  const actions = { insertQuote: text => { calls.push(text); return true; } };
  store.deliver('a', actions); assert.equal(calls.length, 0);
  assert.equal(store.list('a')[1].uncertain, true);
  assert.equal(data.has('dsh-selection-chat.cards.v2'), false);
  store.deliver('c', actions); store.deliver('a', actions, true);
  assert.deepEqual(calls, ['新侧栏引用', '旧引用', '可能已发出']);
  assert.equal(store.list('a').length, 0); store.clear('b');
  assert.equal(store.list('b').length, 0);
});
test('保存前识别文字、原生引用、文件芯片、附件及提交中的草稿', () => {
  assert.equal(p.hasUnsentDraft({ draftSnapshot: { text: ' ' } }), false);
  for (const shell of [{ draftSnapshot: { text: '问题' } }, { draftSnapshot: { quotes: [{}] } }, { draftSnapshot: { references: [{}] } },
    { attachmentIds: ['file'] }, { draftInitializationBlocked: () => true }]) assert.equal(p.hasUnsentDraft(shell), true);
});
test('原生引用菜单只注册一个扩展面板，引用按钮委托宿主插入并关闭选区', () => {
  const registered = [], effects = [];
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect: fn => effects.push(fn) };
  const plugin = load({ moduleRequire: () => React, document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } } });
  plugin.apply({ effect: fn => fn(), slots: { inject: (_, fn) => fn(), register: (options, component) => { registered.push({ options, component }); return () => {}; } },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }, sidebarRight: { registerCloseHandler: () => () => {} },
    resources: { register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
  const action = registered.find(r => r.options.name === 'conversation.chat.text-interaction');
  assert.equal(action.options.key, 'quote'); assert.equal(action.options.priority, 100);
  const calls = [], tree = action.component({ sessionId: 'a', readText: () => '选中文字', clearSelection: () => calls.push('clear'), dismiss: () => calls.push('dismiss'),
    useSession: fn => fn({ removed: false, subagent: null }), inputActions: { insertQuote: text => { calls.push(text); return true; } } });
  effects.forEach(fn => fn());
  const bar = tree.children[0]; assert.equal(bar.props.role, 'toolbar');
  bar.children[0].props.onClick(); assert.deepEqual(calls, ['选中文字', 'clear', 'dismiss']);
  assert.equal(bar.children[2].children[1], '侧边提问');
  assert.ok(!source.includes('attachQuoteSender')); assert.ok(!source.includes('createPortal'));
});
test('只接受插件自己的合法会话地址', () => {
  assert.equal(p.parseAddress(p.resourceAddress('session-123')), 'session-123');
  for (const address of ['https://example.com/session/a', 'dsh-resource://selectionchat/session/a?x=1', 'dsh-resource://selectionchat/session/a%2Fb']) assert.equal(p.parseAddress(address), undefined);
});

test('资源释放只移除会话引用，关闭侧栏不会取消模型或删除历史', async () => {
  const controller = new AbortController(); let retained = 0, released = 0;
  const sessions = { retain: (id, opts) => { assert.equal(id, 'session-a'); assert.equal(opts.source, 'selectionChat'); retained++; return { release: () => released++ }; } };
  const iterator = p.resourceProvider(sessions).open(p.resourceAddress('session-a'), { signal: controller.signal });
  assert.equal((await iterator.next()).value.value.id, 'session-a');
  const waiting = iterator.next(); controller.abort(); assert.equal((await waiting).done, true);
  assert.equal(retained, 1); assert.equal(released, 1);
  const cancelled = p.resourceProvider(sessions).open(p.resourceAddress('session-a'), { signal: controller.signal });
  assert.equal((await cancelled.next()).done, true); assert.equal(retained, 1);
});
test('快速重复点击只创建一次，打开失败后重试复用既有分支', async () => {
  let forks = 0, opens = 0, remembered = 0;
  const op = p.createBranchOp(async (action, opts) => { forks++; assert.equal(action, 'create'); assert.equal(opts.sourceId, 'main'); return { id: 'child' }; }, async () => { if (++opens === 1) throw Error('暂不可打开'); }, () => remembered++, () => 'request-1');
  const input = { sessionId: 'main', text: '引文', isCurrent: () => true };
  const first = op(input), duplicate = op(input); assert.equal(first, duplicate);
  await assert.rejects(first, /暂不可打开/); assert.equal(await op(input), 'child');
  assert.equal(forks, 1); assert.equal(opens, 2); assert.equal(remembered, 1);
});
test('切换会话或卸载后不会抢开侧栏，未展示的临时会话自动清理', async () => {
  let remembered, closed;
  const op = p.createBranchOp(async (action, input) => { if (action === 'close') closed = input.id; return { id: 'child' }; }, () => assert.fail('不应打开'), (...args) => { remembered = args; }, () => 'request-2');
  assert.equal(await op({ sessionId: 'main', text: '引文', isCurrent: () => false }), 'child');
  assert.equal(remembered, undefined); assert.equal(closed, 'child');
});
test('网络结果不明时用同一个请求标识重试，由后端复用同一会话', async () => {
  const keys = [];
  const unknown = p.createBranchOp(async (_action, input) => { keys.push(input.requestId); if (keys.length === 1) throw Error('网络断开'); return { id: 'child' }; }, () => {}, () => {}, () => 'request-3');
  const input = { sessionId: 'main', text: '引文', isCurrent: () => true };
  await assert.rejects(unknown(input), /网络断开/); assert.equal(await unknown(input), 'child');
  assert.deepEqual(keys, ['request-3', 'request-3']);
});
test('没有已完成轮次时保留宿主拒绝，不偷偷创建无上下文会话', async () => {
  const op = p.createBranchOp(async () => { throw Error('没有已完成轮次'); }, () => assert.fail(), () => assert.fail(), () => 'request-4');
  await assert.rejects(op({ sessionId: 'main', text: '引文', isCurrent: () => true }), /没有已完成轮次/);
});
test('插件独立注册与卸载，未调用 Codex、模型或修改主会话', () => {
  const effects = [], registrations = [], removed = [], storage = new Map();
  const plugin = load({ document: { createElement: () => ({ dataset: {}, remove: () => removed.push('style') }), head: { append() {} } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  plugin.apply({ effect: fn => { const dispose = fn(); effects.push(dispose); return dispose; },
    slots: { inject: (_, fn) => fn(), register: (options, Component) => { registrations.push({ options, Component }); return () => removed.push(options.name); } },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }, sidebarRight: { registerCloseHandler: () => () => removed.push('close') },
    resources: { register: provider => { assert.equal(provider.protocol, 'selectionchat'); return () => removed.push('resource'); } },
    sidebarRightTabs: { register: definition => { assert.equal(definition.kind, 'selectionchat'); return () => removed.push('tab'); } } });
  assert.equal(registrations.length, 4);
  assert.ok(registrations.some(r => r.options.name === 'conversation.input.dock'));
  effects.reverse().forEach(f => f?.()); assert.equal(removed.length, 8);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.name, '@local/dsh-selection-chat');
  assert.ok(!JSON.stringify(pkg).includes('codex-dots'));
});

test('临时会话不进入左侧目录，保存后的普通会话仍可见且保留 cwd 元数据', () => {
  const snapshot = { ids: ['main', 'selectionchat-temp-123', 'session-saved'], byId: { 'selectionchat-temp-123': { cwd: '/project' } } };
  const source = { getSnapshot: () => snapshot }, original = source.getSnapshot;
  const dispose = p.hideTemporarySessions(source);
  assert.deepEqual([...source.getSnapshot().ids], ['main', 'session-saved']);
  assert.equal(source.getSnapshot(), source.getSnapshot());
  assert.equal(source.getSnapshot().byId['selectionchat-temp-123'].cwd, '/project');
  dispose(); assert.equal(source.getSnapshot, original);
});

test('历史隐藏只作用于当前侧栏及继承轮次，不隐藏新轮次或主对话', () => {
  const css = p.inheritedHistoryCss('selectionchat-temp-123', [0, 1, '2', -1, '<script>']);
  assert.ok(css.includes('[data-selection-chat-session="selectionchat-temp-123"] [data-chat-turn="0"]'));
  assert.ok(!css.includes('turn="2"')); assert.ok(!css.includes('<script>'));
  assert.equal(p.inheritedHistoryCss('" onclick=', [0]), '');
  assert.ok(!source.includes('侧边分支已准备，填写问题后手动发送。'));
});
