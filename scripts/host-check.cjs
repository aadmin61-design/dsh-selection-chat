// 用本机 DSH 自带 Electron Node 检查真实模块与接口；不打开窗口、不新建会话、不调用模型。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { parse } = require('internal/deps/acorn/acorn/dist/acorn');

// 使用 Electron 自带解析器读取真实方法，兼容压缩包，不再依赖空格、引号和换行。
function sourceParts(source) {
  const methods = new Map(), functions = new Map(), constants = new Map();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MethodDefinition' && (!methods.has(node.key.name) || node.key.name === 'insertQuote' && node.value.params.length === 2)) methods.set(node.key.name, source.slice(node.start, node.end));
    if (node.type === 'FunctionDeclaration') functions.set(node.id.name, source.slice(node.start, node.end));
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') constants.set(node.id.name, 'const ' + source.slice(node.start, node.end) + ';');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }));
  return { methods, functions, constants };
}

async function main() {
  const runtime = process.argv[2];
  if (!runtime) throw Error('用法：Electron --expose-internals host-check.cjs <resources/app.asar/dsh>');
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const hostPackage = name => path.join(runtime, 'node_modules/@deepseek-ai', name);
  const readClient = name => fs.readFileSync(path.join(hostPackage(name), 'lib/client.js'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(hostPackage('dsh-api-session-controller'), 'package.json'))).version;
  // 只接受逐一验证过的精确预发布版本，不能用宽泛范围放行未知宿主。
  const supported = pkg.peerDependencies['@deepseek-ai/dsh-api-session-controller'].split(' || ');
  assert.ok(supported.includes(version), '尚未验证的宿主版本：' + version);
  const sessionVersion = JSON.parse(fs.readFileSync(path.join(hostPackage('dsh-session'), 'package.json'))).version;
  assert.equal(sessionVersion, version, '宿主会话模块版本不一致');
  for (const dependency of pkg.dsh.client.inject) {
    const manifest = path.join(runtime, 'node_modules', dependency, 'package.json');
    assert.ok(fs.existsSync(manifest), '缺少宿主模块：' + dependency);
    assert.equal(JSON.parse(fs.readFileSync(manifest)).version, version, '宿主客户端模块版本混用：' + dependency);
  }
  const conversation = readClient('dsh-client-ui-conversation');
  for (const contract of ['conversation.input.dock', 'data-conversation-content', 'data-conversation-session', 'captureInsertion:', 'insertText:', 'persistDraft:', 'conversation.content']) assert.ok(conversation.includes(contract), '缺少输入/会话契约：' + contract);
  const parts = sourceParts(conversation);
  const quotePlugin = readClient('dsh-message-quotes');
  for (const contract of ['conversation.chat.text-interaction', 'inputActions.insertQuote(text)', 'interactions.register']) assert.ok(quotePlugin.includes(contract), '缺少原生引用契约：' + contract);
  assert.ok(parts.methods.has('insertQuote'));
  const nativeInsert = vm.runInNewContext('({' + parts.methods.get('insertQuote') + '}).insertQuote');
  let client;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: definition => { client = definition.factory(() => ({})); } } }, URL,
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } }
  });
  // 执行真实 Shell.insertQuote，编辑器的预览和发送仍完整由宿主处理。
  const inserted = []; let focused = 0, allowed = true;
  const shell = { disposed: false, snapshot: { phase: 'plain' }, deps: { quoteInsertionAllowed: () => allowed, quoteRemoveLabel: () => '移除' },
    draftEditor: { insertQuote: (...args) => { inserted.push(args); return true; } }, focus: () => focused++ };
  const actions = { insertQuote: text => nativeInsert.call(shell, text) };
  assert.equal(client.insertNativeQuote(actions, '原文\r\n' + '长'.repeat(110000)), true);
  assert.equal(inserted[0][0], '原文\n' + '长'.repeat(110000)); assert.equal(focused, 1);
  allowed = false; assert.equal(client.insertNativeQuote(actions, '权限拒绝'), false);
  allowed = true; shell.snapshot.phase = 'submitting'; assert.equal(client.insertNativeQuote(actions, '等待提交'), false);
  shell.snapshot.phase = 'plain'; shell.disposed = true; assert.equal(client.insertNativeQuote(actions, '已卸载'), false);
  assert.equal(inserted.length, 1);
  const sessions = readClient('dsh-api-session-controller');
  for (const contract of ['fork(opts)', 'retain(target', 'allowMigration', 'workspaceAttachSessionId']) assert.ok(sessions.includes(contract), '缺少会话契约：' + contract);
  const sidebar = readClient('dsh-client-ui-sidebar-right');
  assert.ok(sidebar.includes('sidebar.right.pane.tab'));
  assert.ok(sourceParts(sidebar).methods.has('registerCloseHandler'));
  assert.match(sidebar, /this\.closeHandlers\.get\(tab\.kind\)\?\.\(sessionId,\s*tab\)/);
  const renderer = readClient('dsh-client-ui-renderer');
  assert.ok(renderer.includes('SessionProvider'));
  assert.ok(readClient('dsh-client-ui-chat').includes('"data-chat-flow-kind"'));
  const hooks = registerHooks({ resolve(name, context, next) {
    return next(name, name.startsWith('@deepseek-ai/') ? { ...context, parentURL: pathToFileURL(path.join(runtime, 'package.json')).href } : context);
  } });
  const { Context } = await import('@deepseek-ai/cordis');
  // 此版本把纯前端注册表打进网页包，不能从后端 node_modules 直接导入。
  const assets = path.join(hostPackage('dsh-web-frontend'), 'dist/assets');
  const bundle = fs.readdirSync(assets).filter(name => /^index-.*\.js$/.test(name))
    .map(name => fs.readFileSync(path.join(assets, name), 'utf8')).find(source => source.includes('lowest renders'));
  const coreName = bundle.match(/SlotCore:(\w+)/)[1], helperName = bundle.match(/standardHookPropName:(\w+)/)[1];
  const statements = parse(bundle, { ecmaVersion: 'latest', sourceType: 'module' }).body;
  const first = statements.find(node => node.type === 'FunctionDeclaration' && node.id.name === helperName);
  const last = statements.find(node => node.type === 'VariableDeclaration' && node.declarations.some(d => d.id.name === coreName));
  const SlotCore = vm.runInNewContext(bundle.slice(first.start, last.end) + ';' + coreName, { queueMicrotask });
  // 用真实槽位注册表验证最终渲染者，不能仅断言插件提交了注册参数。
  for (const nativeFirst of [true, false]) {
    const core = new SlotCore(), slot = 'conversation.chat.text-interaction', disposers = [];
    const rootOff = core.register({ name: 'root', children: { [slot]: { kind: 'keyed', scope: 'session' } } }, () => null);
    const native = () => null;
    let nativeOff;
    if (nativeFirst) nativeOff = core.register({ name: slot, key: 'quote' }, native);
    client.apply({ effect: fn => { const off = fn(); disposers.push(off); return off; },
      slots: { inject: (_, fn) => fn(), register: (options, component) => options.name === slot ? core.register(options, component) : () => {} },
      sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
      sidebarRight: { registerCloseHandler: () => () => {} }, resources: { register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
    if (!nativeFirst) nativeOff = core.register({ name: slot, key: 'quote' }, native);
    const entries = core.entriesOfSlot(slot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].component.name, 'SelectionActions', '原生引用按钮遮住了插件菜单');
    for (const off of disposers.reverse()) off?.();
    assert.equal(core.entriesOfSlot(slot)[0].component, native, '卸载后应恢复原生引用按钮');
    nativeOff(); rootOff();
  }
  const { buildForkSeed } = await import('@deepseek-ai/dsh-session');
  const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
  const plugin = await import(pathToFileURL(path.join(root, 'index.mjs')));
  const { createTemporaryManager } = await import(pathToFileURL(path.join(root, 'temporary.mjs')));
  hooks.deregister();
  // 验证真实 AgentLoop 的写句柄入口可以被定向绕过，其他会话仍调用真实方法。
  const writes = [], effects = [], routes = [];
  const loop = Object.create(AgentLoop.prototype);
  loop.runtime = { ctx: { get: name => name === 'sessionPersistence' ? { create: async header => { writes.push(header.id); return { close() {} }; } } : undefined } };
  const observations = new Map();
  const sample = [
    { seq: 0, type: 'turn/start', timestamp: 1, data: { turn: 0, trigger: { kind: 'user' } } },
    { seq: 1, type: 'turn/end', timestamp: 2, data: { turn: 0, status: 'completed' } }
  ];
  const host = {
    effect: fn => { const off = fn(); effects.push(off); return off; },
    connection: { fetch: { register: route => { routes.push(route); return () => {}; } } },
    agentLoop: loop, sessionController: { prompt() {}, agents: { composeAgent: async () => ({ setup() {} }), presetForObservation() {} } },
    sessionQuery: { observeSession: async id => ({ events: sample, header: { id, cwd: 'C:/example' }, [Symbol.dispose]() {} }) },
    workspaceRegistry: { list: () => [] }, agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create: async options => {
      const session = { id: options.sessionId, header: { id: options.sessionId }, inheritedEventCount: options.inheritedEventCount };
      const stored = await loop.createStoredSession(session);
      observations.set(options.sessionId, { options, stored });
      return { agent: { status: 'idle', options: options.agentOptions }, dispose: async () => {} };
    } }, logger: { warn() {} }
  };
  // 原生 buildForkSeed 负责序列化边界，测试中不自行复制 DSH 的实现。
  const manager = createTemporaryManager(host, buildForkSeed);
  const temporary = await manager.create({ sourceId: 'source', requestId: 'host-check-request' });
  assert.equal(observations.get(temporary.id).stored, undefined);
  assert.equal(writes.length, 0);
  const saved = await manager.save(temporary.id);
  assert.deepEqual(writes, [saved.savedId]);
  assert.deepEqual(temporary.hiddenTurns, [0]);
  await manager.close(temporary.id); await manager.dispose();
  plugin.apply(host);
  assert.deepEqual(routes.map(r => r.path).sort(), ['close', 'create', 'info', 'save'].map(op => '/api/selection-chat/' + op).sort());
  for (const off of effects.reverse()) await off?.();
  const ctx = new Context();
  try {
    const fiber = await ctx.plugin(plugin);
    await fiber.dispose();
    console.log(JSON.stringify({ ok: true, plugin: pkg.name, version: pkg.version, dsh: version,
      checks: ['真实 Cordis 加载及认证路由注册和卸载', '真实 SlotCore：两种加载顺序选中插件菜单、卸载恢复原生按钮', '真实 insertQuote：换行、完整原文、焦点、禁用及提交阶段', '真实 AgentLoop：临时无日志、保存恢复持久化；原生 fork seed'],
      limits: ['未执行真实浏览器渲染', '未新建真实会话或发送消息；界面由用户手动验收'] }));
  } finally { await ctx.fiber.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
