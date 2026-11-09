/**
 * 紧急联络人 · 双手机舞台（整个界面 = 舞台，开场旁白/黑屏转场/结尾都在这一层，
 * 不在任何一部手机屏幕内）
 *
 * 布局：玩家手机 + 李柱延手机并列；当前交互设备亮屏，另一部熄屏（保留锁屏时间，
 * 点击可切换焦点）。熄屏不等于不存在，也不等于内容被删除。
 *
 * 剧情约定变量（游戏层消费，消费后清除）：
 *   __enter_node（juyeon，reality 阶段） 进入平行世界：值 = 节点 id
 *   __round_over（juyeon，parallel 阶段） 本轮再次分开剧情结束 → 黑屏转场 → 回现实
 * 剧情约定事件：
 *   changeDone(target=节点id) 本轮改变完成 → 游戏层收割 __res_* 进 completedChanges
 */
import { useEffect, useRef, useState } from "react";
import { Phone } from "../Phone";
import { Intro, applyPlayerName, freshStart, readIntroAnswers, bumpPlaythrough, resetIntro } from "../Intro";
import { db } from "../persistence";
import type { Runtime, Work } from "../schema";
import {
  initialGame,
  deviceWork,
  dispatchGame,
  chooseGame,
  advanceGame,
  enterParallel,
  exitParallel,
  recordChange,
  finalReady,
  enterFinal,
  reviveGame,
  type GameRuntime,
  type DeviceId,
} from "./dual";
import "./dual.css";

/** 称呼替换覆盖双设备数据（{player} 占位，幂等；李柱延手机机主固定为他本人） */
function applyPlayerNameDual(work: Work) {
  applyPlayerName(work); // 根 phone.owner 与单设备 data 已处理
  if (!work.phones) return;
  const a = readIntroAnswers();
  const name = a?.name?.trim() || "你";
  work.phones.player.phone.owner = name;
  work.phones.juyeon.phone.owner = "李柱延";
  for (const d of [work.phones.player, work.phones.juyeon])
    for (const items of Object.values(d.data))
      for (const i of items)
        for (const k of ["title", "body", "sender"] as const)
          if (i[k].includes("{player}"))
            i[k] = i[k].replaceAll("{player}", name);
}

export function DualStage({ work }: { work: Work }) {
  const [game, setGame] = useState<GameRuntime | null>(null);
  const [introDone, setIntroDone] = useState(() => !!readIntroAnswers());
  const [active, setActive] = useState<DeviceId>("player");
  const [transition, setTransition] = useState<"" | "enter" | "exit">("");
  // 节奏控制：round_over 后世界保持可探索，点 › 才回现实（awaitExit）；旁白层 ‹ › 翻段
  const [awaitExit, setAwaitExit] = useState(false);
  const [review, setReview] = useState(false);
  const [viewIdx, setViewIdx] = useState(-1);
  const narrLogRef = useRef<string[]>([]);
  const gameRef = useRef<GameRuntime | null>(null);
  gameRef.current = game;
  const booted = useRef(false);
  const relicFocused = useRef(false);
  // 旁白段落历史（‹ 回看）；viewIdx = -1 表示跟随最新一段
  const narrNow = game
    ? game.juyeon.variables.__narration
      ? String(game.juyeon.variables.__narration)
      : game.player.variables.__narration
        ? String(game.player.variables.__narration)
        : ""
    : "";
  useEffect(() => {
    if (narrNow && narrLogRef.current[narrLogRef.current.length - 1] !== narrNow) {
      narrLogRef.current = [...narrLogRef.current, narrNow];
      setViewIdx(-1);
    }
  }, [narrNow]);
  const playerWork = deviceWork(work, "player");
  const juyeonWork = deviceWork(work, "juyeon");

  // 存档恢复（GameRuntime 与单机 Runtime 共用一个存档槽，结构不同互不冲突）
  useEffect(() => {
    let live = true;
    void db.saves
      .get(work.id)
      .then((saved) => {
        if (!live) return;
        const g = saved ? reviveGame(saved.state) : null;
        if (g && g.player.revision === work.updatedAt) {
          applyPlayerNameDual(work);
          setGame(g);
        } else if (readIntroAnswers()) {
          startNew();
        }
      })
      .catch(() => {
        if (readIntroAnswers()) startNew();
      });
    return () => {
      live = false;
    };
  }, [work.id]);

  // 存档持久化
  useEffect(() => {
    if (game)
      void db.saves.put({ id: work.id, state: game as never }).catch(() => {});
  }, [game, work.id]);

  // 心跳：玩家手机（现实锚点续流）与李柱延手机（平行世界的延时节点依赖他的时钟）都推进
  useEffect(() => {
    if (!game) return;
    const t = setInterval(() => {
      const g = gameRef.current;
      if (!g) return;
      advanceGame(work, g, "player", 1000);
      advanceGame(work, g, "juyeon", 1000);
      setGame({ ...g });
    }, 1000);
    return () => clearInterval(t);
  }, [game !== null, work.id]);

  function startNew() {
    if (booted.current) return;
    booted.current = true;
    applyPlayerNameDual(work);
    const vars = freshStart(work).variables;
    const g = dispatchGame(work, initialGame(work, vars), "start", "", "player");
    setGame({ ...g });
  }

  /** 每次事件派发后检查剧情约定变量（进入/退出平行世界、改变收割）——两台设备都查，容错 */
  function afterDispatch(g: GameRuntime) {
    const jv = g.juyeon.variables;
    const pv = g.player.variables;
    // 改变完成：剧情写入 __change_done = 节点 id → 收割 __res_* 进累积集合
    const changeFlag = jv.__change_done || pv.__change_done;
    if (changeFlag) {
      const nodeId = String(changeFlag);
      jv.__change_done = false;
      pv.__change_done = false;
      recordChange(g, nodeId, nodeId);
    }
    if (
      g.world.phase === "reality" &&
      !jv.__in_world &&
      (jv.__enter_node || pv.__enter_node)
    ) {
      const nodeId = String(jv.__enter_node || pv.__enter_node);
      jv.__enter_node = false;
      pv.__enter_node = false;
      // 引导提示完成使命：黑屏进入平行世界，提示条与 App 红点一并消失
      jv.__hint_app = "";
      jv.__hint_text = "";
      pv.__hint_app = "";
      pv.__hint_text = "";
      setTransition("enter");
      setActive("juyeon");
      setTimeout(() => {
        enterParallel(work, g, nodeId);
        setTransition("");
        setGame({ ...g });
      }, 1400);
      return;
    }
    if (g.world.phase === "parallel" && (jv.__round_over || pv.__round_over)) {
      jv.__round_over = false;
      pv.__round_over = false;
      // 不自动黑屏：世界保持可探索，玩家点右侧 › 才回到现实
      setAwaitExit(true);
      return;
    }
    // 另一部设备来电时自动亮屏（亮屏提醒）
    if (g.player.incomingCall && active !== "player") setActive("player");
    if (g.juyeon.incomingCall && active !== "juyeon") setActive("juyeon");
    // 遗物交接完成：镜头交给他的手机（只切一次，之后不抢焦点）
    if (pv.__relic && !relicFocused.current) {
      relicFocused.current = true;
      setActive("juyeon");
    }
  }

  const handleEvent = (device: DeviceId, ev: string, target: string) => {
    const g = gameRef.current;
    if (!g) return;
    if (ev === "choose") {
      chooseGame(work, g, target, device);
    } else {
      // 来电按钮的状态变更先于事件派发（与单机行为一致）
      if (ev === "callAnswered" && g[device].incomingCall)
        g[device] = {
          ...g[device],
          incomingCall: { ...g[device].incomingCall!, status: "answered" },
        };
      if (
        (ev === "callDeclined" || ev === "callEnded") &&
        g[device].incomingCall
      )
        g[device] = { ...g[device], incomingCall: null };
      dispatchGame(work, g, ev, target, device);
    }
    // 改变收割：剧情在改变完成后派发 changeDone(target=节点 id)
    if (ev === "changeDone")
      recordChange(g, target || g.world.currentNode, target || g.world.currentNode);
    setGame({ ...g });
    afterDispatch(g);
  };

  const syncDevice = (device: DeviceId) => (s: Runtime) => {
    const g = gameRef.current;
    if (!g) return;
    g[device] = s;
    setGame({ ...g });
  };

  /** 玩家点 ›：从门控延时处继续（世界保持可见，节奏由玩家控制） */
  const advanceGate = () => {
    const g = gameRef.current;
    if (!g) return;
    const device: DeviceId = g.juyeon.awaiting ? "juyeon" : "player";
    dispatchGame(work, g, "advance", "", device);
    setGame({ ...g });
    afterDispatch(g);
  };

  /** 玩家点 ›（round_over 之后）：黑屏转场 → 回到现实锚点 */
  const doExit = () => {
    const g = gameRef.current;
    if (!g) return;
    setAwaitExit(false);
    setTransition("exit");
    setTimeout(() => {
      exitParallel(work, g); // 恢复锚点 + parallelExit 事件（航司来电重现）
      setActive("player");
      if (finalReady(g, Number(g.player.variables.playthrough ?? 1))) {
        enterFinal(g);
        dispatchGame(work, g, "finalEnter", "", "juyeon");
      }
      setTransition("");
      setGame({ ...g });
    }, 1600);
  };

  if (!introDone)
    return (
      <div className="dual-stage">
        <Intro
          onDone={() => {
            setIntroDone(true);
            startNew();
          }}
        />
      </div>
    );

  if (!game)
    return (
      <div className="dual-stage">
        <p className="dual-loading">正在恢复进度…</p>
      </div>
    );

  const dimPlayer = active !== "player";
  const dimJuyeon = active !== "juyeon";
  // 遗物交接（__relic）之前：只有玩家手机，李柱延手机尚未进入故事
  const relic = !!game.player.variables.__relic;
  // 引导：下一轮入口已解锁但玩家还没回到他的手机——未聚焦设备呼吸光晕提示切换
  const juyeonHint =
    game.world.phase === "reality" && !!game.juyeon.variables.__hint_app;
  const doneCount = game.world.completedChanges.length;

  return (
    <div className={`dual-stage phase-${game.world.phase} ${relic ? "" : "single"}`}>
      {/* 进度指示：五个瞬间，点亮一个是一个（只表达轮数，不暗示结局） */}
      {relic && game.world.phase !== "final" && (
        <div
          className="dual-progress"
          role="status"
          aria-label={`已完成 ${doneCount} / 5`}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={
                i < doneCount
                  ? "done"
                  : i === doneCount && game.world.phase === "parallel"
                    ? "now"
                    : ""
              }
            />
          ))}
        </div>
      )}
      <div
        className={`dual-device device-player ${active === "player" ? "active" : ""}`}
        onClick={() => {
          // 只在设备未激活时切换；点击已激活设备内部时不得覆盖剧情的焦点切换
          if (active !== "player") setActive("player");
        }}
      >
        <Phone
          work={playerWork}
          runtime={game.player}
          onRuntime={syncDevice("player")}
          onEvent={(e, t) => handleEvent("player", e, t)}
          dimmed={dimPlayer && relic && !game.player.incomingCall}
          archives={game.world.archives}
        />
      </div>
      {relic && (
        <div
          className={`dual-device device-juyeon ${active === "juyeon" ? "active" : ""} ${juyeonHint && active !== "juyeon" ? "hint-glow" : ""}`}
          onClick={() => {
            if (active !== "juyeon") setActive("juyeon");
          }}
        >
          <Phone
            work={juyeonWork}
            runtime={game.juyeon}
            onRuntime={syncDevice("juyeon")}
            onEvent={(e, t) => handleEvent("juyeon", e, t)}
            dimmed={dimJuyeon && !game.juyeon.incomingCall}
          />
        </div>
      )}
      {/* 全局选择层：岔路口属于整个故事，不属于某一部手机（不遮挡手机内容，可先探索再决定） */}
      {(() => {
        const choiceDevice: DeviceId | null = game.juyeon.choices.length
          ? "juyeon"
          : game.player.choices.length
            ? "player"
            : null;
        if (!choiceDevice || transition || narrNow || review) return null;
        return (
          <div className="dual-choice">
            <span className="dual-choice-eyebrow">你会如何选择？</span>
            {game[choiceDevice].choices.map((c) => (
              <button
                key={c.target}
                onClick={() => handleEvent(choiceDevice, "choose", c.target)}
              >
                {c.label}
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        );
      })()}
      {/* 全局转场层：黑屏，不属于任何一部手机 */}
      {transition && (
        <div className={`dual-transition ${transition}`}>
          <span className="dual-transition-mark">
            {transition === "enter" ? "…" : "…"}
          </span>
        </div>
      )}
      {/* 全局结局层：结局属于整个界面，不属于任何一部手机 */}
      {(() => {
        const endings = game.player.endings.length
          ? game.player.endings
          : game.juyeon.endings;
        if (!endings.length) return null;
        return (
          <div className="dual-narration dual-ending">
            <small>ENDING</small>
            <p>{endings[endings.length - 1]}</p>
            <button
              onClick={() => {
                bumpPlaythrough();
                resetIntro();
                void db.saves.delete(work.id);
                location.reload();
              }}
            >
              重新开始
            </button>
          </div>
        );
      })()}
      {/* 全局旁白层：转场文字出现在整个界面，不在手机屏幕内；‹ 回看上一段 / › 前进或继续 */}
      {(() => {
        const narrDevice: DeviceId | null = narrNow
          ? game.juyeon.variables.__narration
            ? "juyeon"
            : "player"
          : null;
        if (!narrDevice || review) return null;
        const log = narrLogRef.current;
        const idx = viewIdx < 0 ? log.length - 1 : viewIdx;
        const text = log[idx] ?? narrNow;
        return (
          <>
            <div className="dual-narration">
              <p key={idx}>{text}</p>
            </div>
            <button
              className="dual-step dual-step-left"
              aria-label="回看上一段"
              disabled={idx <= 0}
              onClick={() => setViewIdx(idx - 1)}
            >
              ‹
            </button>
            <button
              className="dual-step dual-step-right"
              aria-label={idx < log.length - 1 ? "下一段" : "继续"}
              onClick={() => {
                if (idx < log.length - 1) setViewIdx(idx + 1);
                else handleEvent(narrDevice, "narrationDone", "");
              }}
            >
              ›
            </button>
          </>
        );
      })()}
      {/* 门控延时：世界保持可探索，玩家点 › 才推进下一步 */}
      {game.juyeon.awaiting || game.player.awaiting ? (
        !transition &&
        !narrNow && (
          <button
            className="dual-step dual-step-right"
            aria-label="继续"
            onClick={advanceGate}
          >
            ›
          </button>
        )
      ) : null}
      {/* 本轮结束：世界保持可探索，点 › 回到现实；‹ 回看旁白 */}
      {awaitExit && !narrNow && !transition && !review && (
        <>
          {narrLogRef.current.length > 0 && (
            <button
              className="dual-step dual-step-left"
              aria-label="回看旁白"
              onClick={() => setReview(true)}
            >
              ‹
            </button>
          )}
          <button
            className="dual-step dual-step-right"
            aria-label="回到现实"
            onClick={doExit}
          >
            ›
          </button>
        </>
      )}
      {/* 旁白回看层：‹ › 翻段，› 到最后一段时关闭 */}
      {review &&
        (() => {
          const log = narrLogRef.current;
          const idx = viewIdx < 0 ? log.length - 1 : viewIdx;
          return (
            <>
              <div className="dual-narration">
                <p key={idx}>{log[idx]}</p>
              </div>
              <button
                className="dual-step dual-step-left"
                aria-label="上一段"
                disabled={idx <= 0}
                onClick={() => setViewIdx(idx - 1)}
              >
                ‹
              </button>
              <button
                className="dual-step dual-step-right"
                aria-label={idx < log.length - 1 ? "下一段" : "关闭回看"}
                onClick={() => {
                  if (idx < log.length - 1) setViewIdx(idx + 1);
                  else setReview(false);
                }}
              >
                ›
              </button>
            </>
          );
        })()}
    </div>
  );
}
