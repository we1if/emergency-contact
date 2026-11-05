/*
 * 紧急联络人：开场引导层（框架外呈现，不改动手机 UI）
 * 开场第三人称旁白（剧本原文）→ 两个隐藏问答（路线 A/B/C/D）→ 可选称呼
 * 答案写入 localStorage，由 Phone.tsx 注入 runtime 变量；引擎内保留同逻辑问答作为重开/测试回退。
 */
import { useState, type CSSProperties } from "react";
import type { Work } from "./schema";
import { initialRuntime, type Runtime } from "./schema";

const KEY = "ec_intro_v1";
export type IntroAnswers = {
  q1: boolean;
  q2: boolean;
  route: string;
  name: string;
};

export function readIntroAnswers(): IntroAnswers | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as IntroAnswers) : null;
  } catch {
    return null;
  }
}

/* 从头开始：清空开场问答记录（存档由调用方清除） */
export function resetIntro() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/* 游玩次数（跨存档持久，保证 A 线隐藏结局仅第一次游玩可触发） */
export function readPlaythrough(): number {
  try {
    return Number(localStorage.getItem("ec_playthrough") || 0) || 0;
  } catch {
    return 0;
  }
}
export function bumpPlaythrough() {
  try {
    localStorage.setItem("ec_playthrough", String(readPlaythrough() + 1));
  } catch {
    /* ignore */
  }
}

export function computeRoute(q1: boolean, q2: boolean) {
  if (q1 && !q2) return "A";
  if (q1 && q2) return "B";
  if (!q1 && q2) return "C";
  return "D";
}

/* 把开场里玩家自定义的称呼应用到作品数据（{player} 占位，幂等） */
export function applyPlayerName(work: Work) {
  const a = readIntroAnswers();
  const name = a?.name?.trim() || "你";
  work.phone.owner = name;
  for (const items of Object.values(work.data))
    for (const i of items) {
      if (i.title.includes("{player}"))
        i.title = i.title.replaceAll("{player}", name);
      if (i.body.includes("{player}"))
        i.body = i.body.replaceAll("{player}", name);
      if (i.sender.includes("{player}"))
        i.sender = i.sender.replaceAll("{player}", name);
    }
}

/* 首次进入/开场完成后创建的新 runtime：注入问答结果 */
export function freshStart(work: Work): Runtime {
  const rt = initialRuntime(work);
  const a = readIntroAnswers();
  rt.variables = {
    ...rt.variables,
    playthrough: readPlaythrough(),
  };
  if (a)
    rt.variables = {
      ...rt.variables,
      q1: a.q1,
      q2: a.q2,
      route: a.route,
      intro_done: true,
    };
  return rt;
}

const PARAS = [
  "你和李柱延已经相恋八年。\n你们在巴黎相遇。那座城市见证了你们故事的开始，也成为你们共同记忆中最特别的地方。\n从那以后，你们去过很多次巴黎。春天、夏天、秋天、冬天，你们在那里留下了许多照片，走过熟悉的街道，也一次次回到最初相遇的地方。\n八年里，巴黎始终是你们两个人之间的一部分。",
  "直到2026年4月。\n一次再普通不过的争吵，让你们之间出现了裂痕。没有正式的分手，也没有郑重的告别。只是后来，谁都没有再主动联系谁。\n最初，你们都以为只是需要一点时间。\n一天、一个星期、一个月。\n消息停在了最后一次对话，电话也再没有拨通过。你们就这样从彼此的生活里慢慢退了出去。\n没有人真正说过结束，但八年的关系，似乎也就这样停在了那个春天。",
  "今年，你们原本约定好，圣诞节再去一次巴黎。\n只是这一次，你们没有一起出发。\n现在是2026年圣诞节。\n距离你们上一次联系，已经过去了八个月。",
];

export function Intro({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0); // 0-2 旁白 · 3 Q1 · 4 Q2 · 5 称呼
  const [q1, setQ1] = useState<boolean | null>(null);
  const [q2, setQ2] = useState<boolean | null>(null);
  const [name, setName] = useState("");

  const outer: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "#000",
    color: "#d8d9de",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    cursor: "pointer",
    fontFamily: "'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif",
  };
  const box: CSSProperties = {
    maxWidth: 420,
    padding: "0 36px",
    textAlign: "center",
  };
  const para: CSSProperties = {
    fontSize: 16,
    lineHeight: 2.1,
    whiteSpace: "pre-line",
    animation: "fadein 1s",
  };
  const qText: CSSProperties = {
    fontSize: 20,
    fontWeight: 300,
    marginBottom: 36,
    lineHeight: 1.8,
  };
  const opt: CSSProperties = {
    display: "block",
    width: "100%",
    margin: "14px 0",
    padding: "13px",
    border: "1px solid #2c2c33",
    borderRadius: 26,
    background: "none",
    color: "#a8abb5",
    fontSize: 16,
    cursor: "pointer",
    fontFamily: "inherit",
  };
  const input: CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    background: "#101014",
    border: "1px solid #2c2c33",
    borderRadius: 10,
    color: "#e8e8ea",
    fontSize: 15,
    textAlign: "center",
    outline: "none",
    fontFamily: "inherit",
  };
  const hint: CSSProperties = {
    position: "fixed",
    bottom: 22,
    width: "100%",
    textAlign: "center",
    color: "#3a3d46",
    fontSize: 11,
  };

  const finish = (n: string) => {
    if (q1 === null || q2 === null) return;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        q1,
        q2,
        route: computeRoute(q1, q2),
        name: n,
      } satisfies IntroAnswers),
    );
    onDone();
  };

  return (
    <div
      style={outer}
      onClick={() => {
        if (step < PARAS.length) setStep(step + 1);
      }}
    >
      <div style={box}>
        {step < PARAS.length && (
          <>
            <div style={para}>{PARAS[step]}</div>
            <div style={hint}>轻点屏幕继续</div>
          </>
        )}
        {step === 3 && (
          <div onClick={(e) => e.stopPropagation()}>
            <div style={qText}>你对他还有留恋吗？</div>
            <button style={opt} onClick={() => { setQ1(true); setStep(4); }}>
              是
            </button>
            <button style={opt} onClick={() => { setQ1(false); setStep(4); }}>
              否
            </button>
          </div>
        )}
        {step === 4 && (
          <div onClick={(e) => e.stopPropagation()}>
            <div style={qText}>在这段断联期间，你有对别人心动过吗？</div>
            <button style={opt} onClick={() => { setQ2(true); setStep(5); }}>
              是
            </button>
            <button style={opt} onClick={() => { setQ2(false); setStep(5); }}>
              否
            </button>
          </div>
        )}
        {step === 5 && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ textAlign: "center" }}
          >
            <div style={{ ...qText, fontSize: 16, color: "#8b8e98" }}>
              {"在你的手机响起之前——你想被怎样称呼？（可以留空）"}
            </div>
            <input
              style={input}
              maxLength={12}
              value={name}
              placeholder="你"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") finish(name);
              }}
            />
            <button
              style={{ ...opt, marginTop: 24 }}
              onClick={() => finish(name)}
            >
              开始
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
