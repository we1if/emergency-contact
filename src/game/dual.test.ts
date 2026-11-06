import { describe, it, expect } from "vitest";
import { createWork } from "../demo";
import type { Work, StoryNode } from "../schema";
import {
  initialGame,
  deviceWork,
  dispatchGame,
  advanceGame,
  enterParallel,
  exitParallel,
  recordChange,
  noteMemory,
  finalReady,
  enterFinal,
  reviveGame,
} from "./dual";

const basePhone = {
  owner: "我",
  passcode: "",
  wallpaper: "sage",
  theme: "light" as const,
  time: "15:00",
  battery: 80,
  network: "5G",
  notifications: true,
};

function dualWork(): Work {
  const w = createWork("紧急联络人机制测试");
  w.mode = "story";
  w.phone = { ...basePhone, date: "2026-12-25", time: "15:00" };
  const apps = [{ id: "kakao", name: "KakaoTalk", installed: true, visible: true, dock: true, folder: "", icon: "" }];
  w.phones = {
    player: { phone: { ...w.phone }, apps, data: {} },
    juyeon: {
      phone: { ...basePhone, owner: "李柱延", date: "2026-04-08", time: "21:36" },
      apps,
      data: {},
    },
  };
  const node = (n: Partial<StoryNode>): StoryNode => ({
    id: n.id ?? "",
    label: n.id ?? "",
    type: "event",
    event: "",
    target: "",
    conditions: [],
    logic: "and",
    actions: [],
    next: [],
    once: true,
    x: 0,
    y: 0,
    ...n,
  });
  w.nodes = [
    // 进入平行世界：李柱延手机时间焦点切到历史时刻
    node({
      id: "ec-enter",
      event: "parallelEnter",
      target: "node-call",
      actions: [{ type: "time", key: "", value: "21:36", device: "juyeon" }],
    }),
    // 改变节点：玩家在李柱延手机上回拨 —— 同一节点写两台设备
    node({
      id: "call-back",
      event: "callback",
      target: "call-back",
      actions: [
        // 本机（李柱延手机）：拨出记录
        { type: "message", key: "kakao", value: "回拨记录：已拨出" },
        // 玩家手机：对应的已接通记录（平行记录 → overlay）
        {
          type: "message",
          key: "kakao",
          value: "通话记录：已接通 12:36",
          device: "player",
        },
        {
          type: "notification",
          key: "kakao",
          value: "KakaoTalk：李柱延",
          device: "player",
        },
        // 结果事实（recordChange 收割）
        { type: "variable", key: "__res_callStatus", value: "connected" },
      ],
    }),
    // 第二轮节点：条件 = 第一轮改变已完成（累积式）
    node({
      id: "node-2",
      event: "callback2",
      target: "node-2",
      conditions: [{ key: "change:node-call", op: "eq", value: true }],
      actions: [{ type: "variable", key: "__res_ticket", value: "confirmed" }],
    }),
    // 返回现实：航司来电重现（同一锚点）
    node({
      id: "ec-exit",
      event: "parallelExit",
      target: "node-call",
      actions: [{ type: "call", key: "call-airline", value: "航空公司", device: "player" }],
    }),
  ];
  return w;
}

describe("dual-phone state", () => {
  it("gives each phone an independent clock", () => {
    const g = initialGame(dualWork());
    expect(g.player.time).toBe("15:00");
    expect(g.player.date).toBe("2026-12-25");
    expect(g.juyeon.time).toBe("21:36");
    expect(g.juyeon.date).toBe("2026-04-08");
    advanceGame(dualWork(), g, "player", 60000);
    expect(g.player.time).toBe("15:01");
    expect(g.juyeon.time).toBe("21:36"); // 李柱延手机不受玩家手机时钟影响
  });

  it("routes a choice on juyeon's phone to both devices consistently", () => {
    const w = dualWork();
    const g = enterParallel(w, initialGame(w), "node-call");
    expect(g.world.phase).toBe("parallel");
    expect(g.world.round).toBe(1);
    dispatchGame(w, g, "callback", "call-back", "juyeon");
    // 李柱延手机：本机记录（他的视角）
    expect(g.juyeon.messages.kakao.some((i) => i.body.includes("已拨出"))).toBe(true);
    // 玩家手机：对应记录进 overlay（平行记录），发送者 = 李柱延
    const routed = g.player.overlay?.messages.kakao ?? [];
    expect(routed.some((i) => i.body.includes("已接通 12:36"))).toBe(true);
    expect(routed.every((i) => i.timeline === "parallel")).toBe(true);
    expect(routed.every((i) => i.sender === "李柱延")).toBe(true);
    expect(g.player.overlay?.notifications).toContain("KakaoTalk：李柱延");
    // 现实池零污染
    expect(g.player.messages.kakao ?? []).toHaveLength(0);
    expect(g.player.notifications).toHaveLength(0);
  });

  it("restores the reality anchor (15:00) after exiting the parallel world", () => {
    const w = dualWork();
    const g = initialGame(w);
    g.player.notifications.push("电话：航空公司 来电"); // 现实中已发生
    enterParallel(w, g, "node-call");
    dispatchGame(w, g, "callback", "call-back", "juyeon");
    advanceGame(w, g, "player", 120000); // 平行世界期间现实时钟继续走
    expect(g.player.time).toBe("15:02");
    exitParallel(w, g);
    expect(g.world.phase).toBe("reality");
    // 回到同一现实锚点：不是拨回去，是恢复进入前的现实态
    expect(g.player.time).toBe("15:00");
    expect(g.player.date).toBe("2026-12-25");
    expect(g.player.elapsedMs).toBeLessThan(60000);
    // 现实记录原样保留，平行记录已归档
    expect(g.player.notifications).toContain("电话：航空公司 来电");
    expect(g.player.overlay).toBeUndefined();
    expect(g.player.messages.kakao ?? []).toHaveLength(0);
    expect(g.world.archives).toHaveLength(1);
    expect(g.world.archives[0].round).toBe(1);
    expect(
      g.world.archives[0].messages.kakao.some((i) => i.body.includes("已接通")),
    ).toBe(true);
    // parallelExit 事件派发：航司来电在同一锚点重现（不是第二通电话）
    expect(g.player.incomingCall?.caller).toBe("航空公司");
    // 李柱延手机不重建：他的记录还在
    expect(g.juyeon.messages.kakao.length).toBeGreaterThan(0);
  });

  it("accumulates changes across rounds (cumulative, not independent worlds)", () => {
    const w = dualWork();
    const g = initialGame(w);
    enterParallel(w, g, "node-call");
    dispatchGame(w, g, "callback", "call-back", "juyeon");
    recordChange(g, "node-call", "call-back");
    expect(g.world.completedChanges).toHaveLength(1);
    expect(g.world.completedChanges[0].results.callStatus).toBe("connected");
    // 结果事实镜像进两台设备，供后续节点条件引用
    expect(g.juyeon.changes?.["node-call"]).toBe(true);
    expect(g.juyeon.changes?.["node-call.callStatus"]).toBe("connected");
    expect(g.player.changes?.["node-call"]).toBe(true);
    exitParallel(w, g);
    // 第二轮：进入更早节点，第一轮改变仍然生效（条件通过，动作执行）
    enterParallel(w, g, "node-2");
    expect(g.world.round).toBe(2);
    dispatchGame(w, g, "callback2", "node-2", "juyeon");
    expect(g.juyeon.variables.__res_ticket).toBe("confirmed");
    recordChange(g, "node-2", "node-2");
    expect(g.world.completedChanges).toHaveLength(2);
    expect(g.juyeon.changes?.["node-2.ticket"]).toBe("confirmed");
  });

  it("does not run the next node before its change is completed", () => {
    const w = dualWork();
    const g = enterParallel(w, initialGame(w), "node-2");
    dispatchGame(w, g, "callback2", "node-2", "juyeon");
    expect(g.juyeon.variables.__res_ticket).toBeUndefined();
  });

  it("keeps memory markers across rounds", () => {
    const w = dualWork();
    const g = initialGame(w);
    noteMemory(g, "saw-the-draft");
    // memory 不依赖轮次，直接镜像进两台设备
    expect(g.player.memory).toContain("saw-the-draft");
    expect(g.juyeon.memory).toContain("saw-the-draft");
  });

  it("gates the final hidden world on playthrough, route and all five changes", () => {
    const w = dualWork();
    const g = initialGame(w);
    g.player.variables.route = "A";
    for (let i = 0; i < 4; i++)
      g.world.completedChanges.push({
        nodeId: `n${i}`,
        round: i + 1,
        choiceId: `c${i}`,
        results: {},
      });
    expect(finalReady(g, 0)).toBe(false);
    g.world.completedChanges.push({ nodeId: "n4", round: 5, choiceId: "c4", results: {} });
    expect(finalReady(g, 0)).toBe(true);
    expect(finalReady(g, 1)).toBe(false); // 第二次游玩不再触发隐藏结局
    g.player.variables.route = "B"; // B 线五改全成也不进入隐藏结局
    expect(finalReady(g, 0)).toBe(false);
    enterFinal(g);
    expect(g.world.phase).toBe("final");
    expect(g.juyeon.variables.__final).toBe(true);
    expect(g.player.variables.__final).toBe(true);
  });

  it("survives save/load roundtrip and rejects non-dual saves", () => {
    const g = initialGame(dualWork());
    const restored = reviveGame(JSON.parse(JSON.stringify(g)));
    expect(restored?.world.anchor.time).toBe("15:00");
    expect(restored?.juyeon.deviceId).toBe("juyeon");
    expect(reviveGame({})).toBeNull();
    expect(reviveGame(undefined)).toBeNull();
  });

  it("keeps device views pointing at their own phone config", () => {
    const w = dualWork();
    expect(deviceWork(w, "player").phone.owner).toBe("我");
    expect(deviceWork(w, "juyeon").phone.owner).toBe("李柱延");
    expect(deviceWork(w, "juyeon").nodes).toBe(w.nodes); // 节点共享
    const single = createWork();
    expect(deviceWork(single, "player")).toBe(single); // 单设备作品不受影响
  });
});
