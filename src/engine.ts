import type { Action, Condition, Runtime, StoryNode, Work } from "./schema";
import { makeItem, safeMedia } from "./schema";

// 紧急联络人双手机：dispatch 可携带设备映射（缺省 = 单设备，行为与旧版完全一致）
export type DispatchCtx = {
  devices?: Record<string, Runtime>;
  activeDevice?: string;
  phase?: string; // "parallel" 时对玩家手机的 message/notification 落 overlay
};
export function testCondition(c: Condition, s: Runtime): boolean {
  const [scope, ...rest] = c.key.split(":");
  const key = rest.join(":");
  const lists: Record<string, string[]> = {
    visited: s.visited,
    read: s.read,
    clue: s.clues,
    unlocked: s.unlocked,
    completed: s.completed,
  };
  const actual =
    scope === "ui"
      ? s.ui?.[rest[0]]?.[rest.slice(1).join(":")]
      : scope === "change"
        ? s.changes?.[key] // 紧急联络人：跨轮次累积改变（<nodeId> 或 <nodeId>.<subKey>）
        : scope === "memory"
          ? s.memory?.includes(key)
            ? true
            : undefined
          : lists[scope]
            ? lists[scope].includes(key)
            : s.variables[c.key];
  switch (c.op) {
    case "eq":
      return actual === c.value;
    case "neq":
      return actual !== c.value;
    case "gt":
      return typeof actual === "number" && actual > Number(c.value);
    case "lt":
      return typeof actual === "number" && actual < Number(c.value);
    case "includes":
      return String(actual ?? "").includes(String(c.value));
  }
}
function apply(a: Action, s: Runtime, w: Work, ctx?: DispatchCtx) {
  // 双手机路由：动作声明 device 且不等于当前交互设备 → 落到目标设备 runtime
  if (a.device && ctx?.devices && ctx.activeDevice && a.device !== ctx.activeDevice) {
    const t = ctx.devices[a.device];
    if (!t) return;
    // 平行/最终世界期间玩家手机的消息、通知与来电属于平行记录 → 进 overlay，不污染现实池
    if (
      (ctx.phase === "parallel" || ctx.phase === "final") &&
      a.device === "player" &&
      (a.type === "message" || a.type === "notification" || a.type === "call")
    ) {
      t.overlay ??= { messages: {}, notifications: [] };
      if (a.type === "message") {
        // 跨设备消息发送者 = 发起设备的机主；"@player" = 以玩家本人身份发出（去信，落入与李柱延的会话）
        const isPlayerSend = a.sender === "@player";
        const other =
          ctx.activeDevice === "juyeon"
            ? w.phones?.juyeon?.phone.owner ?? w.phone.owner
            : w.phone.owner;
        const sender = isPlayerSend
          ? w.phones?.player?.phone.owner ?? other
          : a.sender ??
            (ctx.activeDevice === "juyeon"
              ? w.phones?.juyeon?.phone.owner ?? w.phone.owner
              : w.phone.owner);
        // 消息时间：显式声明优先，否则取发起设备的剧情时钟
        const at = a.time || [s.date, s.time].filter(Boolean).join(" ");
        const media = a.media ? safeMedia(a.media) : "";
        t.overlay.messages[a.key] = [
          ...(t.overlay.messages[a.key] ?? []),
          makeItem({
            id: `event-${a.key}-${t.overlay.messages[a.key]?.length ?? 0}`,
            title: isPlayerSend ? other : sender, // 会话名 = 聊天对象
            sender,
            body: String(a.value),
            ...(at ? { time: at } : {}),
            ...(media ? { kind: "image", media } : {}),
            ...(isPlayerSend ? { outgoing: true } : {}),
            timeline: "parallel",
          }),
        ];
        // 平行对话镜像进对方手机（李柱延手机）的同一会话——他手里那台也能看着对话展开；
        // 他的手机视角：机主来信 = outgoing，玩家来信 = incoming，线程标题 = 玩家名
        const mirror = ctx.devices?.juyeon;
        if (mirror && mirror !== t) {
          mirror.overlay ??= { messages: {}, notifications: [] };
          const jSender = isPlayerSend
            ? w.phones?.player?.phone.owner ?? other
            : a.sender ??
              (w.phones?.juyeon?.phone.owner ?? w.phone.owner);
          mirror.overlay.messages[a.key] = [
            ...(mirror.overlay.messages[a.key] ?? []),
            makeItem({
              id: `event-mirror-${a.key}-${mirror.overlay.messages[a.key]?.length ?? 0}`,
              title: w.phones?.player?.phone.owner ?? other, // 会话 = 与玩家
              sender: jSender,
              body: String(a.value),
              ...(at ? { time: at } : {}),
              ...(media ? { kind: "image", media } : {}),
              ...(!isPlayerSend ? { outgoing: true } : {}),
              timeline: "parallel",
            }),
          ];
        }
      } else if (a.type === "call") {
        // 平行世界的来电：真实振铃落在玩家手机，通知留痕进 overlay
        t.incomingCall = {
          caller: String(a.value),
          target: a.key,
          status: "ringing",
        };
        t.overlay.notifications.push(`${String(a.value)} 来电`);
      } else t.overlay.notifications.push(String(a.value));
      return;
    }
    apply(a, t, w);
    return;
  }
  switch (a.type) {
    case "date":
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(a.value))) s.date = String(a.value);
      break;
    case "variable":
      s.variables[a.key] = a.value;
      break;
    case "unlock":
      if (!s.unlocked.includes(a.key)) s.unlocked.push(a.key);
      break;
    case "hide":
      if (!s.hidden.includes(a.key)) s.hidden.push(a.key);
      break;
    case "notification":
      s.notifications.push(String(a.value));
      break;
    case "call":
      s.notifications.push(`${String(a.value)} 来电`);
      s.incomingCall = {
        caller: String(a.value),
        target: a.key,
        status: "ringing",
      };
      break;
    case "wallpaper":
      // 紧急联络人：设备切换时更换壁纸（存入变量，Phone.tsx 读取）
      s.variables.__wallpaper = String(a.value);
      break;
    case "clue":
      if (!s.clues.includes(a.key)) s.clues.push(a.key);
      break;
    case "time":
      s.time = String(a.value);
      s.clockRemainderMs = 0;
      break;
    case "ending":
      if (!s.endings.includes(String(a.value))) s.endings.push(String(a.value));
      break;
    case "choice":
      if (!s.choices.some((c) => c.target === a.key))
        s.choices.push({ label: String(a.value), target: a.key });
      break;
    case "message":
      s.messages[a.key] = [
        ...(s.messages[a.key] ?? []),
        makeItem({
          id: `event-${a.key}-${s.completed.length}-${s.messages[a.key]?.length ?? 0}`,
          title: "新消息",
          sender: w.phone.owner,
          body: String(a.value),
        }),
      ];
      break;
  }
}
function runQueue(
  w: Work,
  s: Runtime,
  event: string,
  target: string,
  queue: string[],
  resuming = new Set<string>(),
  ctx?: DispatchCtx,
) {
  const seen = new Set<string>();
  let steps = 0;
  while (queue.length && steps++ < 200) {
    const id = queue.shift()!;
    const n = w.nodes.find((n) => n.id === id);
    if (!n || seen.has(id) || (n.once && s.completed.includes(id))) continue;
    seen.add(id);
    const conditions = n.conditions.map((c) => testCondition(c, s));
    const pass =
      n.logic === "or"
        ? conditions.some(Boolean)
        : n.logic === "not"
          ? !conditions.every(Boolean)
          : conditions.every(Boolean);
    if (!pass) continue;
    if (n.type === "delay" && !resuming.has(id)) {
      s.scheduled ??= [];
      if (!s.scheduled.some((t) => t.nodeId === id))
        s.scheduled.push({
          nodeId: id,
          due: (s.elapsedMs ?? 0) + (n.delayMs ?? 1000),
        });
      s.trace.push(`delay:${n.delayMs ?? 1000}ms → ${n.label}`);
      continue;
    }
    if (!s.completed.includes(id)) s.completed.push(id);
    s.trace.push(`${event}:${target} → ${n.label}`);
    for (const a of n.actions) {
      const previous =
        a.type === "variable"
          ? s.variables[a.key]
          : a.type === "time"
            ? s.time
            : undefined;
      apply(a, s, w, ctx);
      if (a.type === "variable" && previous !== s.variables[a.key])
        queue.push(
          ...w.nodes
            .filter(
              (n) =>
                n.event === "variable" && (!n.target || n.target === a.key),
            )
            .map((n) => n.id),
        );
      if (a.type === "time" && previous !== s.time)
        queue.push(
          ...w.nodes
            .filter(
              (n) => n.event === "time" && (!n.target || n.target === s.time),
            )
            .map((n) => n.id),
        );
    }
    if (
      n.type === "ending" &&
      !n.actions.some((a) => a.type === "ending") &&
      !s.endings.includes(n.label)
    )
      s.endings.push(n.label);
    if (n.type === "choice") {
      for (const id of n.next)
        if (!s.choices.some((c) => c.target === id))
          s.choices.push({
            label: w.nodes.find((n) => n.id === id)?.label ?? id,
            target: id,
          });
    } else queue.push(...n.next);
  }
  s.trace = s.trace.slice(-100);
  return s;
}
export function dispatch(
  w: Work,
  previous: Runtime,
  event: string,
  target = "",
  ctx?: DispatchCtx,
): Runtime {
  const s = structuredClone(previous);
  if (event === "choose") s.choices = [];
  // 门控延时推进：玩家点 › 后从这里继续执行 awaiting 节点（resuming 使其跳过再次计时）
  if (event === "advance" && s.awaiting) {
    const id = s.awaiting;
    s.awaiting = undefined;
    return runQueue(w, s, event, target, [id], new Set([id]), ctx);
  }
  if (event === "openApp" && !s.visited.includes(target))
    s.visited.push(target);
  if (event === "read" && !s.read.includes(target)) s.read.push(target);
  if (w.mode === "explore") return s;
  const queue = w.nodes
    .filter(
      (n) =>
        (n.type === "start" && event === "start") ||
        (n.event === event && (!n.target || n.target === target)),
    )
    .map((n) => n.id);
  return runQueue(w, s, event, target, queue, new Set(), ctx);
}
export function advance(
  w: Work,
  previous: Runtime,
  milliseconds: number,
  ctx?: DispatchCtx,
): Runtime {
  const s = structuredClone(previous);
  const delta = Number.isFinite(milliseconds)
    ? Math.max(0, Math.min(milliseconds, 86400000))
    : 0;
  const end = (s.elapsedMs ?? 0) + delta;
  s.elapsedMs ??= 0;
  s.clockRemainderMs ??= 0;
  s.scheduled ??= [];
  let resumes = 0;
  while (true) {
    s.scheduled.sort((a, b) => a.due - b.due);
    const due =
      w.mode !== "explore" && resumes < 200 ? s.scheduled[0] : undefined;
    const clockAt = s.elapsedMs + 60000 - s.clockRemainderMs;
    const next = Math.min(
      end,
      clockAt,
      due ? Math.max(s.elapsedMs, due.due) : Infinity,
    );
    s.clockRemainderMs += next - s.elapsedMs;
    s.elapsedMs = next;
    if (s.clockRemainderMs >= 60000) {
      s.clockRemainderMs -= 60000;
      const match = s.time.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const value = (Number(match[1]) * 60 + Number(match[2]) + 1) % 1440;
        s.time =
          String(Math.floor(value / 60)).padStart(2, "0") +
          ":" +
          String(value % 60).padStart(2, "0");
        if (w.mode !== "explore")
          runQueue(
            w,
            s,
            "time",
            s.time,
            w.nodes
              .filter(
                (n) => n.event === "time" && (!n.target || n.target === s.time),
              )
              .map((n) => n.id),
            new Set(),
            ctx,
          );
      }
    }
    if (due && due.due <= s.elapsedMs) {
      s.scheduled.splice(s.scheduled.indexOf(due), 1);
      resumes++;
      // 门控延时：计时到后不自动执行，标记 awaiting 等玩家点 ›（advance 事件）再继续
      if (w.nodes.find((n) => n.id === due.nodeId)?.gate) {
        s.awaiting = due.nodeId;
        continue;
      }
      runQueue(w, s, "timer", due.nodeId, [due.nodeId], new Set([due.nodeId]), ctx);
      continue;
    }
    if (s.elapsedMs >= end) break;
  }
  return s;
}
export function choose(w: Work, s: Runtime, id: string, ctx?: DispatchCtx) {
  const node = w.nodes.find((n) => n.id === id);
  if (!node || !s.choices.some((c) => c.target === id)) return s;
  return dispatch(
    {
      ...w,
      nodes: w.nodes.map((n) =>
        n.id === id ? { ...n, event: "choose", target: id } : n,
      ),
    },
    s,
    "choose",
    id,
    ctx,
  );
}
export function validateGraph(nodes: StoryNode[]) {
  const errors: string[] = [];
  for (const n of nodes) {
    for (const id of n.next)
      if (!nodes.some((x) => x.id === id))
        errors.push(`${n.label} 引用了不存在的节点 ${id}`);
    if (n.next.includes(n.id))
      errors.push(`${n.label} 存在自环（运行时会阻止循环）`);
  }
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    nodes.find((n) => n.id === id)?.next.forEach(visit);
  };
  nodes
    .filter((n) => n.type === "start" || n.event)
    .forEach((n) => visit(n.id));
  nodes
    .filter((n) => n.type !== "comment" && !reachable.has(n.id))
    .forEach((n) => errors.push(`${n.label} 不可达`));
  return errors;
}
export function visible(
  item: { id: string; hidden: boolean; unlock: string },
  s: Runtime,
) {
  return (
    !s.hidden.includes(item.id) &&
    (!item.hidden || s.unlocked.includes(item.id)) &&
    (!item.unlock ||
      testCondition({ key: item.unlock, op: "eq", value: true }, s))
  );
}
