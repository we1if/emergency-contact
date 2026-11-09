import { z } from "zod";
export const uid = () => crypto.randomUUID();
// 紧急联络人：记录所属时间线（现实记录不受平行世界影响；平行记录随轮次归档）
export const timelineSchema = z.enum(["reality", "parallel"]).default("reality");
export const itemSchema = z.object({
  id: z.string(),
  title: z.string().max(1000),
  body: z.string().max(200000),
  richText: z.string().max(400000).default(""),
  meta: z.record(z.string().max(60), z.string().max(2000)).default({}),
  time: z.string(),
  sender: z.string(),
  avatar: z.string().default(""),
  kind: z
    .enum([
      "text",
      "image",
      "audio",
      "video",
      "file",
      "transfer",
      "call",
      "order",
      "note",
      "post",
      "event",
    ])
    .default("text"),
  media: z.string().default(""),
  hidden: z.boolean().default(false),
  unlock: z.string().default(""),
  password: z.string().default(""),
  folder: z.string().default(""),
  favorite: z.boolean().default(false),
  outgoing: z.boolean().default(false),
  read: z.boolean().default(false),
  likes: z.number().default(0),
  comments: z.array(z.string()).default([]),
  timeline: timelineSchema,
});
export type Item = z.infer<typeof itemSchema>;
export const conditionSchema = z.object({
  key: z.string(),
  op: z.enum(["eq", "neq", "gt", "lt", "includes"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type Condition = z.infer<typeof conditionSchema>;
export const actionSchema = z.object({
  type: z.enum([
    "date",
    "variable",
    "unlock",
    "hide",
    "notification",
    "message",
    "time",
    "ending",
    "choice",
    "clue",
    "call",
    "wallpaper",
  ]),
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  // 紧急联络人双手机：动作可指定落到哪台设备（缺省 = 当前交互设备，行为不变）
  device: z.enum(["player", "juyeon"]).optional(),
  // message 动作跨设备路由时的发送者（"@player" = 以玩家本人身份发出）
  sender: z.string().max(60).optional(),
  // message 动作的显式时间戳与图片附件（跨设备记录与李柱延侧 curated 记录保持一致）
  time: z.string().max(24).optional(),
  media: z.string().optional(),
});
export type Action = z.infer<typeof actionSchema>;
export const nodeSchema = z.object({
  delayMs: z.number().int().min(0).max(86400000).optional(),
  id: z.string(),
  label: z.string(),
  type: z.enum([
    "start",
    "event",
    "condition",
    "action",
    "choice",
    "delay",
    "ending",
    "comment",
  ]),
  event: z.string(),
  target: z.string(),
  conditions: z.array(conditionSchema),
  logic: z.enum(["and", "or", "not"]).default("and"),
  actions: z.array(actionSchema),
  next: z.array(z.string()),
  once: z.boolean(),
  // 紧急联络人：门控延时——计时到后不自动执行，停下等玩家点全局 › 再继续（探索节奏由玩家控制）
  gate: z.boolean().optional(),
  x: z.number(),
  y: z.number(),
});
export type StoryNode = z.infer<typeof nodeSchema>;
// 紧急联络人双手机：phone/apps/data 抽为可复用 schema（单设备作品行为不变）
const phoneConfigSchema = z.object({
  owner: z.string(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  passcode: z.string().max(12),
  wallpaper: z.string(),
  theme: z.enum(["light", "dark"]),
  time: z.string(),
  battery: z.number().min(0).max(100),
  network: z.string(),
  notifications: z.boolean(),
});
const appsSchema = z
  .array(
    z.object({
      id: z.string(),
      name: z.string(),
      installed: z.boolean().default(true),
      visible: z.boolean(),
      dock: z.boolean(),
      folder: z.string(),
      icon: z.string(),
    }),
  )
  .max(100);
const dataSchema = z.record(z.string(), z.array(itemSchema).max(20000));
export const workSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000),
  category: z.string(),
  cover: z.string(),
  updatedAt: z.number(),
  phone: phoneConfigSchema,
  apps: appsSchema,
  data: dataSchema,
  // 双手机模式：player = 玩家（现实时间线锚点），juyeon = 李柱延（平行世界持久设备）
  phones: z
    .object({
      player: z.object({
        phone: phoneConfigSchema,
        apps: appsSchema,
        data: dataSchema,
      }),
      juyeon: z.object({
        phone: phoneConfigSchema,
        apps: appsSchema,
        data: dataSchema,
      }),
    })
    .optional(),
  nodes: z.array(nodeSchema).max(2000),
  variables: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
  mode: z.enum(["explore", "story", "mixed"]),
});
export type Work = z.infer<typeof workSchema>;
export type UiValue = string | number | boolean | string[];
export type Runtime = {
  date?: string;
  elapsedMs?: number;
  clockRemainderMs?: number;
  scheduled?: { nodeId: string; due: number }[];
  incomingCall?: {
    caller: string;
    target: string;
    status: "ringing" | "answered";
  } | null;
  ui?: Record<string, Record<string, UiValue>>;
  workId: string;
  revision: number;
  variables: Record<string, string | number | boolean>;
  visited: string[];
  read: string[];
  clues: string[];
  unlocked: string[];
  hidden: string[];
  completed: string[];
  notifications: string[];
  endings: string[];
  choices: { label: string; target: string }[];
  messages: Record<string, Item[]>;
  time: string;
  trace: string[];
  // 双手机扩展：设备标识 + 平行世界记录浮层（玩家手机在平行世界期间的对应记录）
  deviceId?: string;
  overlay?: {
    messages: Record<string, Item[]>;
    notifications: string[];
  };
  // 跨轮次镜像（由游戏层维护，条件作用域 change:/memory: 读取）
  changes?: Record<string, string | number | boolean>;
  memory?: string[];
  // 门控延时：计时已到、等待玩家点 › 推进的节点 id（advance 事件消费）
  awaiting?: string;
};
export function initialRuntime(w: Work): Runtime {
  return {
    date: w.phone.date,
    elapsedMs: 0,
    clockRemainderMs: 0,
    scheduled: [],
    incomingCall: null,
    ui: {},
    workId: w.id,
    revision: w.updatedAt,
    variables: { ...w.variables },
    visited: [],
    read: [],
    clues: [],
    unlocked: [],
    hidden: [],
    completed: [],
    notifications: [],
    endings: [],
    choices: [],
    messages: {},
    time: w.phone.time,
    trace: [],
  };
}
export function makeItem(partial: Partial<Item> = {}): Item {
  return itemSchema.parse({
    id: uid(),
    title: "新内容",
    body: "在这里写下故事…",
    time: "2026-09-01 08:30",
    sender: "小林",
    ...partial,
  });
}
export function validateWork(input: unknown): Work {
  return workSchema.parse(input);
}
export function safeMedia(value: string) {
  return /^data:(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp3|wav|ogg|webm|mp4)|video\/(mp4|webm));base64,[a-zA-Z0-9+/=\s]+$/.test(
    value,
  )
    ? value
    : "";
}
