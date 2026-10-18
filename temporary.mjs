import { randomUUID } from 'node:crypto';

export const TEMP_PREFIX = 'selectionchat-temp-';

// 仅截取已完成轮次，避免把主对话正在执行的工具状态复制到侧栏。
export function completedBoundary(events) {
  const last = events.findLast(e => e.type === 'turn/end');
  if (!last) throw Error('请等待主对话完成至少一轮后再打开侧边聊天。');
  let boundary = last.seq;
  for (const event of events.slice(boundary + 1)) {
    if (event.type === 'turn/start' || event.type === 'user/message' && event.surfaceOp === 'append' || event.type === 'agent/inbox/spliced') break;
    boundary = event.seq;
  }
  return boundary;
}

function patchMethod(target, key, make) {
  const original = target[key], descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (typeof original !== 'function') throw Error('DSH 临时会话接口不兼容：' + key);
  const wrapped = make(original);
  Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapped });
  return () => {
    if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapped) return;
    if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];
  };
}

export function createTemporaryManager(ctx, buildForkSeed) {
  const records = new Map(), requests = new Map(), creating = new Set();
  let stopped = false;
  // 宿主 0.2.1 没有 ephemeral 参数；只跳过本插件预登记 ID 的写句柄获取。
  // 未保存会话完全驻留内存，不删除、不修改任何既有会话文件。
  const restoreStorage = patchMethod(ctx.agentLoop, 'createStoredSession', original => function(session, ...args) {
    if (creating.has(session.id)) return Promise.resolve(undefined);
    return original.call(this, session, ...args);
  });
  const restorePrompt = patchMethod(ctx.sessionController, 'prompt', original => function(request, ...args) {
    const record = records.get(request.sessionId);
    if (record && record.state !== 'temporary') throw Error('侧边聊天正在保存或关闭，请稍后重试。');
    if (!record) return original.call(this, request, ...args);
    // 覆盖图片上传/请求接纳的异步窗口，避免保存快照漏掉刚提交的问题。
    record.admissions = (record.admissions || 0) + 1;
    try { return Promise.resolve(original.call(this, request, ...args)).finally(() => record.admissions--); }
    catch (error) { record.admissions--; throw error; }
  });
  const view = r => ({ id: r.id, sourceId: r.sourceId, workspaceId: r.workspaceId, cwd: r.cwd,
    hiddenTurns: r.hiddenTurns, state: r.state, savedId: r.savedId });
  const requireRecord = id => {
    const r = records.get(id);
    if (!r) throw Error('临时侧边聊天已结束或 DSH 已重启，请重新划词打开。');
    return r;
  };
  const compose = preset => ctx.sessionController.agents.composeAgent(preset);
  const closeRecord = async r => {
    if (r.operation) { await r.operation.catch(() => {}); if (r.state === 'closed') return; }
    r.state = 'closing';
    r.operation = (async () => {
      try {
        // dispose 使用原生取消与收尾，只作用于本插件持有的临时 AgentHandle。
        await r.handle.dispose(); r.state = 'closed'; r.handle = undefined;
      } catch (error) { r.state = 'close-failed'; throw error; }
    })();
    try { await r.operation; } finally { r.operation = undefined; }
  };
  return {
    async create({ sourceId, requestId }) {
      if (stopped) throw Error('插件正在关闭。');
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) throw Error('无效的创建请求标识。');
      if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 200) throw Error('无效的来源会话。');
      const old = requests.get(requestId);
      if (old) { if (old.sourceId !== sourceId) throw Error('创建请求的来源不一致。'); return old.promise; }
      const promise = (async () => {
        const observation = await ctx.sessionQuery.observeSession(sourceId);
        try {
          const boundary = completedBoundary(observation.events), seed = buildForkSeed(observation.events, boundary);
          const composition = await compose(ctx.sessionController.agents.presetForObservation(observation));
          const source = records.get(sourceId);
          const workspace = ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(sourceId));
          const id = TEMP_PREFIX + randomUUID();
          const record = { id, sourceId, cwd: observation.header.cwd, workspaceId: workspace?.id ?? source?.workspaceId,
            hiddenTurns: [...new Set(seed.filter(e => Number.isSafeInteger(e.data?.turn)).map(e => e.data.turn))], state: 'temporary',
            preset: composition.agentPreset, inheritedEventCount: boundary + 1 };
          creating.add(id);
          try {
            record.handle = await ctx.agents.create({ sessionId: id, seed, inheritedEventCount: boundary + 1,
              meta: { ...(record.cwd ? { cwd: record.cwd } : {}), parentSession: sourceId, isSeeded: true,
                ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}) },
              agentOptions: ctx.agentDefaultModel.currentSelection(), setup: composition.setup });
            records.set(id, record);
            if (stopped) { await closeRecord(record); throw Error('插件已关闭。'); }
            return view(record);
          } finally { creating.delete(id); }
        } finally { observation[Symbol.dispose](); }
      })();
      requests.set(requestId, { sourceId, promise });
      return promise;
    },
    info(id) {
      if (records.has(id)) return view(records.get(id));
      if (typeof id !== 'string' || id.startsWith(TEMP_PREFIX)) return view(requireRecord(id));
      // 旧版分支和保存后的长期会话只读识别继承边界，不纳入临时清理名单。
      return (async () => {
        const observation = await ctx.sessionQuery.observeSession(id);
        try {
          const marker = observation.events.findLast(e => e.type === 'session/end-seed' && e.data?.inherited === true);
          return { id, state: 'saved', cwd: observation.header.cwd,
            hiddenTurns: marker ? [...new Set(observation.events.filter(e => e.seq < marker.seq && Number.isSafeInteger(e.data?.turn)).map(e => e.data.turn))] : [] };
        } finally { observation[Symbol.dispose](); }
      })();
    },
    async save(id) {
      const r = requireRecord(id);
      if (r.savedId && r.state === 'saved') return view(r);
      if (r.state === 'saving') return r.operation;
      if (!['temporary', 'save-failed'].includes(r.state)) throw Error('该临时聊天正在关闭或已关闭。');
      if (r.admissions || r.handle.agent.status === 'running' || r.handle.agent.inbox?.hasPending) throw Error('请先等待回答和消息提交完成或点击停止，再保存侧边聊天。');
      r.state = 'saving';
      r.operation = (async () => {
        try {
          const workspace = r.workspaceId ? ctx.workspaceRegistry.list().find(w => w.id === r.workspaceId) : undefined;
          if (r.workspaceId && !workspace) throw Error('原文件目录分组已不存在，请恢复该目录后重试保存。');
          if (!r.savedId) {
            const observation = await ctx.sessionQuery.observeSession(r.id);
            try {
              const composition = await compose(r.preset);
              const savedId = 'session-' + randomUUID();
              const handle = await ctx.agents.create({ sessionId: savedId, seed: observation.events,
                inheritedEventCount: r.inheritedEventCount,
                meta: { ...(r.cwd ? { cwd: r.cwd } : {}), parentSession: r.sourceId, isSeeded: true,
                  ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}) },
                agentOptions: Object.fromEntries(['provider', 'model', 'reasoningEffort', 'maxTokens']
                  .filter(key => r.handle.agent.options[key] !== undefined).map(key => [key, r.handle.agent.options[key]])), setup: composition.setup });
              r.savedId = savedId;
              // 保存副本属于长期会话；关闭临时标签不会处置这个句柄。
              r.savedHandle = handle;
            } finally { observation[Symbol.dispose](); }
          }
          if (workspace) await workspace.attachSession(r.savedId);
          r.state = 'saved'; return view(r);
        } catch (error) { r.state = r.savedId ? 'save-failed' : 'temporary'; throw error; }
      })();
      try { return await r.operation; } finally { r.operation = undefined; }
    },
    async close(id) {
      const r = records.get(id);
      // 幂等关闭只接受本插件前缀；旧版长期分支和普通聊天绝不进入删除路径。
      if (!r) { if (typeof id === 'string' && id.startsWith(TEMP_PREFIX)) return { ok: true }; throw Error('拒绝关闭非本插件临时会话。'); }
      if (r.state !== 'closed') await closeRecord(r);
      return { ok: true };
    },
    async dispose() {
      stopped = true;
      await Promise.allSettled([...requests.values()].map(r => r.promise));
      const outcomes = await Promise.allSettled([...records.values()].filter(r => r.state !== 'closed').map(closeRecord));
      restorePrompt(); restoreStorage();
      for (const outcome of outcomes) if (outcome.status === 'rejected') ctx.logger.warn('临时侧边聊天清理失败：' + outcome.reason.message);
    }
  };
}
