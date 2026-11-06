/**
 * 紧急联络人 · 双手机游戏层
 *
 * 玩家手机 = 现实时间线锚点（2026-12-25 15:00，进入平行世界后时钟继续走，退出恢复锚点）
 * 李柱延手机 = 持久的平行世界设备（从不重建、从不清空；五轮是同一条可能性线上
 *   依次点亮的五个历史节点，切换节点只动时间焦点和可见记录，不动底层数据）
 *
 * 累积式改变：completedChanges 跨轮次持久；记录的是选择的实际事件结果（results），
 * 不只是"点没点过"，供后续节点条件分支（change:<nodeId>.<subKey>）和隐藏结局判定使用。
 *
 * 保留的约定变量（剧情侧写入）：
 *   __res_<subKey>  改变节点上剧情写入的结果事实，recordChange 时收割进 ChangeRecord
 *   __final         隐藏结局世界的标记
 * 保留的剧情事件（游戏层派发，剧情节点监听）：
 *   parallelEnter(target=节点id)  进入平行世界前一刻（游戏层已建快照）
 *   parallelExit(target=节点id)   恢复现实锚点后（剧情在此重现航司来电等）
 */
import type { Item, Runtime, Work } from "../schema";
import { initialRuntime } from "../schema";
import { dispatch, advance, choose } from "../engine";

export type DeviceId = "player" | "juyeon";
export type Phase = "reality" | "parallel" | "transition" | "final";

export interface ChangeRecord {
  nodeId: string; // 哪个历史节点
  round: number; // 哪一轮改的
  choiceId: string; // 玩家选了什么
  results: Record<string, string | number | boolean>; // 该选择的实际事件结果
}

export interface OverlayArchive {
  round: number;
  messages: Record<string, Item[]>;
  notifications: string[];
}

export interface WorldState {
  phase: Phase;
  round: number; // 0 = 尚未进入过平行世界；进入后 1..5
  currentNode: string; // 当前节点 id（剧情定）
  completedChanges: ChangeRecord[]; // 累积式改变集合，跨轮次持久
  playerMemory: string[]; // 玩家经历并记住的内容标记
  archives: OverlayArchive[]; // 历轮平行记录归档（可回看，不是重入入口）
  anchor: { date: string; time: string }; // 现实时间锚点，由玩家手机设备配置声明
  snapshot?: Runtime; // 进入平行世界时的玩家手机现实态快照
}

export interface GameRuntime {
  player: Runtime;
  juyeon: Runtime;
  world: WorldState;
}

// ---------- 设备视图 ----------

/** 从 work.phones 抽出单台设备的 Work 视图（节点/变量共享，phone/apps/data 各自独立） */
export function deviceWork(work: Work, id: DeviceId): Work {
  if (!work.phones) return work;
  const d = work.phones[id];
  return { ...work, phone: d.phone, apps: d.apps, data: d.data };
}

// ---------- 初始化 ----------

export function initialGame(work: Work, startVariables?: Runtime["variables"]): GameRuntime {
  const player = initialRuntime(deviceWork(work, "player"));
  const juyeon = initialRuntime(deviceWork(work, "juyeon"));
  player.deviceId = "player";
  juyeon.deviceId = "juyeon";
  if (startVariables) {
    Object.assign(player.variables, startVariables);
    Object.assign(juyeon.variables, startVariables);
  }
  const world: WorldState = {
    phase: "reality",
    round: 0,
    currentNode: "",
    completedChanges: [],
    playerMemory: [],
    archives: [],
    anchor: {
      date: deviceWork(work, "player").phone.date ?? "",
      time: deviceWork(work, "player").phone.time,
    },
  };
  const game: GameRuntime = { player, juyeon, world };
  mirrorWorld(game);
  return game;
}

// ---------- 跨轮次镜像 ----------

/** 把累积改变/记忆镜像进两台设备的 runtime，供 change:/memory: 条件作用域读取 */
export function mirrorWorld(game: GameRuntime) {
  const changes: Record<string, string | number | boolean> = {};
  for (const c of game.world.completedChanges) {
    changes[c.nodeId] = true;
    for (const [k, v] of Object.entries(c.results))
      changes[`${c.nodeId}.${k}`] = v;
  }
  for (const rt of [game.player, game.juyeon]) {
    rt.changes = changes;
    rt.memory = [...game.world.playerMemory];
  }
}

// ---------- 事件派发 ----------

/**
 * 在指定设备上派发事件；跨设备动作（action.device）路由到另一台 runtime。
 * 两边内容/时间/逻辑一致由同一个节点保证——同一时刻写两侧，构造上不可能矛盾。
 */
export function dispatchGame(
  work: Work,
  game: GameRuntime,
  event: string,
  target = "",
  device: DeviceId = "player",
): GameRuntime {
  const devices: Record<string, Runtime> = {
    player: structuredClone(game.player),
    juyeon: structuredClone(game.juyeon),
  };
  const result = dispatch(work, devices[device], event, target, {
    devices,
    activeDevice: device,
    phase: game.world.phase,
  });
  devices[device] = result;
  game.player = devices.player;
  game.juyeon = devices.juyeon;
  return game;
}

/** 在指定设备上推进时钟（各设备独立时间状态；跨设备动作照常路由到另一台 runtime） */
export function advanceGame(
  work: Work,
  game: GameRuntime,
  device: DeviceId,
  milliseconds: number,
): GameRuntime {
  const ctx = {
    devices: { player: game.player, juyeon: game.juyeon },
    activeDevice: device,
    phase: game.world.phase,
  };
  if (device === "player") {
    game.player = advance(work, game.player, milliseconds, ctx);
  } else {
    game.juyeon = advance(work, game.juyeon, milliseconds, ctx);
  }
  return game;
}

/** 在指定设备上做出选项选择（复用引擎 choose 的节点重接线，跨设备动作照常路由） */
export function chooseGame(
  work: Work,
  game: GameRuntime,
  id: string,
  device: DeviceId = "player",
): GameRuntime {
  const devices: Record<string, Runtime> = {
    player: structuredClone(game.player),
    juyeon: structuredClone(game.juyeon),
  };
  const ctx = {
    devices,
    activeDevice: device,
    phase: game.world.phase,
  };
  const result = choose(deviceWork(work, device), devices[device], id, ctx);
  devices[device] = result;
  game.player = devices.player;
  game.juyeon = devices.juyeon;
  return game;
}

// ---------- 进入 / 退出平行世界 ----------

/**
 * 进入第 N 轮平行世界：
 * 1. 快照玩家手机现实态（恢复锚点用，平行期间对玩家手机的现实池零污染）
 * 2. phase = parallel，记录轮次与当前节点
 * 3. 派发 parallelEnter 事件（剧情在此点亮李柱延手机的时间焦点与新记录）
 */
export function enterParallel(
  work: Work,
  game: GameRuntime,
  nodeId: string,
): GameRuntime {
  if (game.world.phase !== "reality") return game;
  game.world.snapshot = structuredClone(game.player);
  game.world.phase = "parallel";
  game.world.round += 1;
  game.world.currentNode = nodeId;
  game.player.overlay = { messages: {}, notifications: [] };
  game.juyeon.variables.__in_world = true; // 防重入：平行世界内不再触发进入事件
  return dispatchGame(work, game, "parallelEnter", nodeId, "juyeon");
}

/**
 * 退出平行世界（黑屏转场后调用）：
 * 1. overlay 归档（可回看的经历痕迹，不是重入入口）
 * 2. 玩家手机 = 快照原样恢复 → 时间必然回到锚点（不是拨回去，是回到进入前的现实）
 * 3. 李柱延手机不动（持久设备，记录全保留）
 * 4. 派发 parallelExit 事件（剧情在此重现航司来电 + 亮起下一节点的锁屏）
 */
export function exitParallel(work: Work, game: GameRuntime): GameRuntime {
  if (game.world.phase !== "parallel") return game;
  const overlay = game.player.overlay;
  if (
    overlay &&
    (overlay.notifications.length ||
      Object.values(overlay.messages).some((m) => m.length))
  )
    game.world.archives.push({
      round: game.world.round,
      messages: structuredClone(overlay.messages),
      notifications: [...overlay.notifications],
    });
  if (game.world.snapshot) {
    game.player = game.world.snapshot;
    delete game.world.snapshot;
  }
  game.player.overlay = undefined;
  game.world.phase = "reality";
  game.juyeon.variables.__in_world = false;
  game.player.deviceId = "player";
  mirrorWorld(game);
  return dispatchGame(work, game, "parallelExit", game.world.currentNode, "player");
}

// ---------- 累积改变与记忆 ----------

/**
 * 记录一次成功改变：从李柱延手机 runtime 收割 __res_<subKey> 结果事实，
 * 加入 completedChanges（跨轮次持久，不重置），并镜像进两台设备。
 */
export function recordChange(
  game: GameRuntime,
  nodeId: string,
  choiceId: string,
): ChangeRecord {
  const results: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(game.juyeon.variables))
    if (k.startsWith("__res_")) results[k.slice(6)] = v;
  const record: ChangeRecord = {
    nodeId,
    round: game.world.round,
    choiceId,
    results,
  };
  game.world.completedChanges.push(record);
  // 收割后清掉本轮 __res_*，避免历史轮次的结果污染后续 ChangeRecord
  for (const k of Object.keys(results))
    delete game.juyeon.variables[`__res_${k}`];
  mirrorWorld(game);
  return record;
}

export function noteMemory(game: GameRuntime, marker: string) {
  if (!game.world.playerMemory.includes(marker))
    game.world.playerMemory.push(marker);
  mirrorWorld(game);
}

// ---------- 隐藏结局 ----------

/** 触发条件：第一次游玩（playthrough==0）+ A 线（留恋且无他心动）+ 五条累积改变全部完成 */
export function finalReady(game: GameRuntime, playthrough: number): boolean {
  return (
    playthrough === 0 &&
    game.player.variables.route === "A" &&
    game.world.completedChanges.length >= 5
  );
}

/** 进入最终隐藏结局世界：独立状态，五个改变全部作为既成前提 */
export function enterFinal(game: GameRuntime): GameRuntime {
  game.world.phase = "final";
  game.juyeon.variables.__final = true;
  game.player.variables.__final = true;
  return game;
}

// ---------- 持久化 ----------

/** 存档形状校验（GameRuntime 是纯 JSON 结构）；非双手机存档返回 null */
export function reviveGame(saved: unknown): GameRuntime | null {
  const g = saved as GameRuntime;
  if (
    !g ||
    typeof g !== "object" ||
    !g.player ||
    !g.juyeon ||
    !g.world ||
    !g.world.anchor ||
    !Array.isArray(g.world.completedChanges)
  )
    return null;
  return g;
}
