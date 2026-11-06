import { initialRuntime, type Work } from "../schema";
import { dispatch, advance, choose, visible } from "../engine";
import {
  initialGame,
  dispatchGame,
  chooseGame,
  advanceGame,
  recordChange,
  enterParallel,
  exitParallel,
  enterFinal,
  finalReady,
  type GameRuntime,
  type DeviceId,
} from "../game/dual";
import type { Story } from "./compiler";

/** 单设备路径：原有行为不变 */
function runSingle(story: Story, work: Work) {
  const errors: string[] = [];
  if (work.nodes.some((n) => n.type !== "comment") && !story.tests.length)
    errors.push("tests: 至少提供一个通关路径");
  const reached = new Set<string>();
  for (const t of story.tests) {
    let state = dispatch(work, initialRuntime(work), "start");
    const unlocked = new Set<string>();
    for (const [i, step] of t.steps.entries()) {
      const at = `tests.${story.tests.indexOf(t)}.steps.${i}`;
      if (step.password !== undefined) {
        const item = Object.values(work.data)
          .flat()
          .find((x) => x.id === step.target);
        if (!item || item.password !== step.password) {
          errors.push(at + ": 密码不正确");
          continue;
        }
        unlocked.add(item.id);
      }
      if (step.event === "read") {
        const item = Object.values(work.data)
          .flat()
          .find((x) => x.id === step.target);
        if (
          !item ||
          !visible(item, state) ||
          (item.password && !unlocked.has(item.id))
        ) {
          errors.push(at + ": 内容不可读或未解密");
          continue;
        }
      }
      if (step.choose) {
        if (!state.choices.some((c) => c.target === step.choose))
          errors.push(at + ": 选项不可达");
        state = choose(work, state, step.choose);
      }
      if (step.advanceMs !== undefined)
        state = advance(work, state, step.advanceMs);
      if (step.event) state = dispatch(work, state, step.event, step.target);
    }
    if (!state.endings.includes(t.ending))
      errors.push(t.name + ": 未到达结局 " + t.ending);
    else reached.add(t.ending);
    for (const id of t.expectUnlocked)
      if (!state.unlocked.includes(id)) errors.push(t.name + ": 未解锁 " + id);
  }
  for (const n of work.nodes.filter((n) => n.type === "ending")) {
    const ending = String(
      n.actions.find((a) => a.type === "ending")?.value || n.label,
    );
    if (!reached.has(ending))
      errors.push(
        "events." +
          work.nodes.indexOf(n) +
          ": 结局没有可通过的测试路径: " +
          ending,
      );
  }
  return errors;
}

/**
 * 双手机路径：initialGame + dispatchGame/chooseGame；每步可声明 device。
 * advanceMs 同时推进两台设备（各自的心跳/延时独立结算）。
 * 测试步骤直接驱动游戏层的进入/退出/改变收割（与 DualStage 消费约定一致）。
 */
function runDual(story: Story, work: Work) {
  const errors: string[] = [];
  if (!story.tests.length) errors.push("tests: 至少提供一个通关路径");
  const reached = new Set<string>();
  for (const t of story.tests) {
    let g: GameRuntime = initialGame(work);
    // 测试注入变量（等价于 Intro 注入的 q1/q2/route/playthrough）
    for (const d of ["player", "juyeon"] as const)
      Object.assign(g[d].variables, t.vars);
    g = dispatchGame(work, g, "start", "", "player");
    for (const [i, step] of t.steps.entries()) {
      const at = `tests.${story.tests.indexOf(t)}.steps.${i}`;
      const device: DeviceId = step.device || "player";
      if (step.event === "parallelEnter" && step.target) {
        enterParallel(work, g, step.target);
        continue;
      }
      if (step.event === "parallelExit") {
        exitParallel(work, g);
        continue;
      }
      if (step.event === "changeDone" && step.target) {
        recordChange(g, step.target, step.target);
        continue;
      }
      if (step.event === "finalEnter") {
        enterFinal(g);
        g = dispatchGame(work, g, "finalEnter", "", "juyeon");
        continue;
      }
      if (step.choose) {
        if (!g[device].choices.some((c) => c.target === step.choose)) {
          errors.push(at + ": 选项不可达");
          continue;
        }
        g = chooseGame(work, g, step.choose, device);
      }
      if (step.advanceMs !== undefined) {
        advanceGame(work, g, "player", step.advanceMs);
        advanceGame(work, g, "juyeon", step.advanceMs);
      }
      if (step.event) g = dispatchGame(work, g, step.event, step.target, device);
      // 复刻游戏层约定：剧情写入 __change_done 后收割 __res_* 进累积集合
      const changeFlag = g.player.variables.__change_done || g.juyeon.variables.__change_done;
      if (changeFlag) {
        const nodeId = String(changeFlag);
        g.player.variables.__change_done = false;
        g.juyeon.variables.__change_done = false;
        recordChange(g, nodeId, nodeId);
      }
    }
    const endings = [...g.player.endings, ...g.juyeon.endings];
    if (!endings.includes(t.ending))
      errors.push(t.name + ": 未到达结局 " + t.ending);
    else reached.add(t.ending);
    for (const id of t.expectUnlocked) {
      // 双手机：unlock 字段的条件项（change: 等）不进 unlocked 数组，按可见性判定
      const item = [...Object.values(work.phones!.player.data), ...Object.values(work.phones!.juyeon.data)]
        .flat()
        .find((x) => x.id === id);
      const ok =
        (item && (visible(item, g.player) || visible(item, g.juyeon))) ||
        g.player.unlocked.includes(id) ||
        g.juyeon.unlocked.includes(id);
      if (!ok) errors.push(t.name + ": 未解锁 " + id);
    }
  }
  for (const n of work.nodes.filter((n) => n.type === "ending")) {
    const ending = String(
      n.actions.find((a) => a.type === "ending")?.value || n.label,
    );
    if (!reached.has(ending))
      errors.push(
        "events." +
          work.nodes.indexOf(n) +
          ": 结局没有可通过的测试路径: " +
          ending,
      );
  }
  return errors;
}

export function testStory(story: Story, work: Work) {
  return work.phones ? runDual(story, work) : runSingle(story, work);
}
